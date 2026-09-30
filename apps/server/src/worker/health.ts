/**
 * Source health + staleness alerts (Architecture v2, WP0.5).
 *
 * WHY: ingest can stop with nothing saying so. A pipeline that is broken and one
 * that is idle look identical in the log, and the desktop-owned sources (email,
 * calendar, skill runs) are invisible to this process entirely.
 *
 * Two kinds of source:
 *   - SERVER sources (matrix, clickup, fireflies, fathom, index): the scheduler
 *     reports each run's outcome through `recordSourceOutcome` (called from
 *     `noteIngestOutcome`, the single writer of ingest state). This module owns
 *     the last-success / last-error / streak registry.
 *   - DESKTOP sources (email, calendar, skills): not observable here, so
 *     freshness is INFERRED from the vault — the newest note of each kind
 *     (`limit` small, `order_by=updated_at`), cached for WORKER_DESKTOP_PROBE_MS.
 *     Caveat: this measures "newest note", so a genuinely quiet inbox reads as
 *     stale; thresholds are therefore tunable / disableable per source.
 *
 * Status: disabled (not configured / no data ever) | failing (streak >=
 * WORKER_FAIL_STREAK) | stale (nothing succeeded within the threshold) | ok.
 * Alerts fire ONCE per episode on entry to stale/failing (email to OWNER_EMAIL
 * + a vault `alert` note) and once more on recovery. The alerted flag persists
 * in the worker cursor table so a restart mid-episode does not re-alert.
 * Error text is scrubbed and truncated before it leaves this module.
 */
import { config } from "../config";
import { getVaultRegistry, getWorkerCursor, setWorkerCursor } from "../db";
import { getSecret, secretsConfigured } from "../secrets";
import { vaultClient } from "../parachute";
import { sendEmail } from "../auth/email";

export type SourceStatus = "ok" | "stale" | "failing" | "disabled";
export type SourceKind = "server" | "desktop";

export interface SourceHealth {
  name: string;
  kind: SourceKind;
  vaultId: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  failureStreak: number;
  staleAfterMs: number;
  status: SourceStatus;
}

interface Rec {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  streak: number;
}

const BOOT_AT = Date.now();
const records = new Map<string, Rec>();
const key = (vaultId: string, source: string) => `${vaultId}:${source}`;

/** Strip anything secret-shaped and cap the length. Errors can echo URLs/headers. */
export function scrubError(msg: string): string {
  return msg
    .replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/((?:token|key|secret|password|authorization)["']?\s*[=:]\s*)["']?[^\s"',;&]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Called by the scheduler after every run of a source. */
export function recordSourceOutcome(vaultId: string, source: string, err: Error | null, now = Date.now()): void {
  const k = key(vaultId, source);
  const r = records.get(k) ?? { lastSuccessAt: null, lastErrorAt: null, lastError: null, streak: 0 };
  if (err) {
    r.streak++;
    r.lastErrorAt = now;
    r.lastError = scrubError(err.message);
  } else {
    r.streak = 0;
    r.lastSuccessAt = now;
  }
  records.set(k, r);
}

export function resetSourceHealth(): void {
  records.clear();
  desktopCache = null;
  desktopProbing = null;
}

/** Pure status computation. `lastSuccessAt` null = never observed since boot. */
export function computeStatus(o: {
  configured: boolean;
  lastSuccessAt: number | null;
  streak: number;
  staleAfterMs: number;
  now: number;
  baselineAt: number;
  failStreak?: number;
}): SourceStatus {
  if (!o.configured) return "disabled";
  if (o.streak >= (o.failStreak ?? config.workerFailStreak)) return "failing";
  if (o.staleAfterMs > 0 && o.now - (o.lastSuccessAt ?? o.baselineAt) > o.staleAfterMs) return "stale";
  return "ok";
}

// ── desktop-owned sources, inferred from the vault ──────────────────────────

interface DesktopSpec {
  name: "email" | "calendar" | "skills";
  tag: string;
  pathPrefix?: string;
  accept?: (n: { metadata?: Record<string, unknown> | null }) => boolean;
}
const DESKTOP: DesktopSpec[] = [
  { name: "email", tag: "email", pathPrefix: "vault/messages/email/" },
  { name: "calendar", tag: "meeting", pathPrefix: "vault/meetings/", accept: (n) => !!n.metadata?.calendarEventId },
  { name: "skills", tag: "agent-dispatch" },
];

interface VaultNoteLike {
  path?: string | null;
  metadata?: Record<string, unknown> | null;
  updatedAt?: string | null;
  createdAt?: string;
}
interface DesktopProbe {
  newestAt: number | null;
  error: string | null;
  streak: number;
}
let desktopCache: { at: number; byName: Map<string, DesktopProbe> } | null = null;
let desktopProbing: Promise<void> | null = null;

export type Lister = (o: { tags: string[]; pathPrefix?: string; limit: number; orderBy: "updated_at" }) => Promise<VaultNoteLike[]>;

/** Newest updatedAt for one desktop source. The list params are best-effort
 *  server-side (limit/order_by/path_prefix); results are re-filtered and re-maxed
 *  client-side so a vault that ignores them still yields a correct answer. */
async function newestNoteAt(spec: DesktopSpec, list: Lister): Promise<number | null> {
  const notes = await list({ tags: [spec.tag], pathPrefix: spec.pathPrefix, limit: spec.accept ? 10 : 1, orderBy: "updated_at" });
  let newest: number | null = null;
  for (const n of notes) {
    if (spec.pathPrefix && !(n.path ?? "").startsWith(spec.pathPrefix)) continue;
    if (spec.accept && !spec.accept(n)) continue;
    const t = Date.parse(n.updatedAt ?? n.createdAt ?? "");
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

async function probeDesktop(list: Lister, now: number): Promise<void> {
  const prev = desktopCache?.byName;
  const byName = new Map<string, DesktopProbe>();
  for (const spec of DESKTOP) {
    const before = prev?.get(spec.name);
    try {
      byName.set(spec.name, { newestAt: await newestNoteAt(spec, list), error: null, streak: 0 });
    } catch (e) {
      // A failed probe keeps the last known freshness; it never makes a source look fresh.
      byName.set(spec.name, { newestAt: before?.newestAt ?? null, error: scrubError((e as Error).message), streak: (before?.streak ?? 0) + 1 });
    }
  }
  desktopCache = { at: now, byName };
}

/** Refresh the desktop probe if the cache is older than WORKER_DESKTOP_PROBE_MS.
 *  Concurrent callers share one in-flight probe. */
async function ensureDesktop(list: Lister | undefined, now: number): Promise<void> {
  if (desktopCache && now - desktopCache.at < config.workerDesktopProbeMs) return;
  if (!desktopProbing) {
    const l: Lister = list ?? ((o) => vaultClient().listNotes(o) as Promise<VaultNoteLike[]>);
    desktopProbing = probeDesktop(l, now).finally(() => {
      desktopProbing = null;
    });
  }
  await desktopProbing;
}

// ── snapshot ─────────────────────────────────────────────────────────────────

const SERVER_SOURCES = ["matrix", "clickup", "fireflies", "fathom"] as const;

function iso(t: number | null): string | null {
  return t === null ? null : new Date(t).toISOString();
}

export async function getSourceHealth(opts: { now?: number; list?: Lister } = {}): Promise<SourceHealth[]> {
  const now = opts.now ?? Date.now();
  const out: SourceHealth[] = [];

  for (const entry of getVaultRegistry()) {
    for (const src of SERVER_SOURCES) {
      const r = records.get(key(entry.id, src));
      const configured = secretsConfigured() && !!getSecret(entry.id, config.ownerEmail, src);
      const interval = src === "clickup" ? config.clickupIntervalMs : src === "fathom" ? config.fathomIntervalMs : 1;
      const staleAfterMs = interval <= 0 ? 0 : config.workerStaleMs[src];
      out.push({
        name: entry.id === "primary" ? src : `${src}@${entry.id}`,
        kind: "server",
        vaultId: entry.id,
        lastSuccessAt: iso(r?.lastSuccessAt ?? null),
        lastError: r?.lastError ?? null,
        failureStreak: r?.streak ?? 0,
        staleAfterMs,
        status: computeStatus({ configured, lastSuccessAt: r?.lastSuccessAt ?? null, streak: r?.streak ?? 0, staleAfterMs, now, baselineAt: BOOT_AT }),
      });
    }
  }
  {
    const r = records.get(key("primary", "index"));
    const staleAfterMs = config.indexIntervalMs > 0 ? config.indexIntervalMs * 3 : 0;
    out.push({
      name: "index",
      kind: "server",
      vaultId: "primary",
      lastSuccessAt: iso(r?.lastSuccessAt ?? null),
      lastError: r?.lastError ?? null,
      failureStreak: r?.streak ?? 0,
      staleAfterMs,
      status: computeStatus({ configured: config.indexIntervalMs > 0, lastSuccessAt: r?.lastSuccessAt ?? null, streak: r?.streak ?? 0, staleAfterMs, now, baselineAt: BOOT_AT }),
    });
  }

  await ensureDesktop(opts.list, now);
  for (const spec of DESKTOP) {
    const p = desktopCache?.byName.get(spec.name);
    const staleAfterMs = config.workerStaleMs[spec.name];
    const newest = p?.newestAt ?? null;
    out.push({
      name: spec.name,
      kind: "desktop",
      vaultId: "primary",
      lastSuccessAt: iso(newest),
      lastError: p?.error ?? null,
      failureStreak: p?.streak ?? 0,
      staleAfterMs,
      // No note of this kind ever → the source was never set up; nothing to alert on.
      status: computeStatus({ configured: newest !== null, lastSuccessAt: newest, streak: p?.streak ?? 0, staleAfterMs, now, baselineAt: BOOT_AT }),
    });
  }
  return out;
}

// ── alerts (once per episode) ────────────────────────────────────────────────

export interface AlertDeps {
  send: (to: string, subject: string, html: string, devLine?: string) => Promise<unknown>;
  writeNote: (n: { path: string; content: string; tags: string[]; metadata: Record<string, unknown> }) => Promise<unknown>;
  getFlag: (vaultId: string, name: string) => string | null;
  setFlag: (vaultId: string, name: string, v: string) => void;
}

const defaultDeps: AlertDeps = {
  send: (to, subject, html, dev) => sendEmail(to, subject, html, dev),
  writeNote: (n) => vaultClient().createNote(n),
  getFlag: (v, name) => getWorkerCursor(v, name),
  setFlag: (v, name, val) => setWorkerCursor(v, name, val),
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function describe(h: SourceHealth, now: number): string {
  const since = h.lastSuccessAt ? `last success ${Math.round((now - Date.parse(h.lastSuccessAt)) / 60_000)} min ago` : "no success observed since server start";
  const err = h.lastError ? ` Last error: ${h.lastError}.` : "";
  return `${h.name} is ${h.status} (${since}; ${h.failureStreak} consecutive failure(s); threshold ${Math.round(h.staleAfterMs / 60_000)} min).${err}`;
}

/**
 * Evaluate transitions and alert. Safe to call every tick: the persisted flag
 * makes it idempotent within an episode. Never throws (alerting must not break
 * the worker). Returns what it did, for tests.
 */
export async function evaluateAlerts(
  health: SourceHealth[],
  opts: { now?: number; deps?: Partial<AlertDeps>; force?: boolean } = {},
): Promise<{ alerted: string[]; recovered: string[] }> {
  const res = { alerted: [] as string[], recovered: [] as string[] };
  if (!config.workerAlertsEnabled && !opts.force) return res;
  const now = opts.now ?? Date.now();
  const deps = { ...defaultDeps, ...opts.deps };
  for (const h of health) {
    try {
      const fk = `health-alerted:${h.name}`;
      const alerted = deps.getFlag(h.vaultId, fk) === "1";
      const bad = h.status === "stale" || h.status === "failing";
      if (bad && !alerted) {
        deps.setFlag(h.vaultId, fk, "1"); // claim first: a slow send must not double-fire
        res.alerted.push(h.name);
        await notify(deps, h, now, false);
      } else if (!bad && alerted) {
        deps.setFlag(h.vaultId, fk, "0");
        if (h.status === "ok") {
          res.recovered.push(h.name);
          await notify(deps, h, now, true);
        } // "disabled" just closes the episode silently
      }
    } catch (e) {
      console.warn(`[health] alert for ${h.name} failed: ${scrubError((e as Error).message)}`);
    }
  }
  return res;
}

async function notify(deps: AlertDeps, h: SourceHealth, now: number, recovered: boolean): Promise<void> {
  const text = recovered ? `${h.name} has recovered.` : describe(h, now);
  const subject = recovered ? `[Prism] ${h.name} recovered` : `[Prism] ${h.name} is ${h.status}`;
  console[recovered ? "log" : "warn"](`[health] ${recovered ? "RECOVERED" : "ALERT"} ${text}`);
  const d = new Date(now).toISOString();
  const stamp = d.slice(0, 10) + "-" + d.slice(11, 16).replace(":", "");
  await deps
    .writeNote({
      path: `vault/agent/alerts/${stamp}-${h.name.replace(/[^a-z0-9]+/gi, "-")}${recovered ? "-recovered" : ""}`,
      content: `# ${subject}\n\n${text}\n\nSource kind: ${h.kind}. Generated by the Prism server worker health check.\n`,
      tags: ["alert"],
      metadata: { source: h.name, status: recovered ? "recovered" : h.status, kind: h.kind, at: d },
    })
    .catch((e: Error) => console.warn(`[health] alert note for ${h.name} failed: ${scrubError(e.message)}`));
  if (config.ownerEmail) {
    await deps
      .send(config.ownerEmail, subject, `<p>${esc(text)}</p>`, text)
      .catch((e: Error) => console.warn(`[health] alert email for ${h.name} failed: ${scrubError(e.message)}`));
  }
}

/** One scheduler pass: snapshot + alerts. Isolated — never throws. */
export async function runHealthCheckOnce(): Promise<void> {
  if (!config.workerAlertsEnabled) return; // status stays available on demand via GET /acl/workers
  try {
    await evaluateAlerts(await getSourceHealth());
  } catch (e) {
    console.warn("[health] check failed:", scrubError((e as Error).message));
  }
}
