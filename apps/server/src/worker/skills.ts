/**
 * Server skill scheduler (Architecture v2, WP1.1) — the port of the desktop's
 * `services/skill_scheduler.rs` + `services/structured_skill.rs` + the
 * `DispatchManager` routing/persistence in `services/agent_dispatch.rs`, so the
 * background `agent-skill` notes run with no desktop app.
 *
 * The vault stays the source of truth. Each `agent-skill` note carries:
 *   metadata: skillName, enabled, intervalSecs (default 3600), runAtHour,
 *             dependsOn, lastRun (RFC 3339), executionMode ("structured" |
 *             anything else = agentic), provider/model (per-skill routing
 *             override), structured {...} (structured mode config);
 *   content:  the prompt (agentic) or the classification rubric (structured).
 *
 * SEMANTICS PRESERVED from the desktop (tests pin each one):
 *   - Due: interval >= 86400 with a runAtHour → due once the LOCAL hour is past
 *     the target and it has not run on the current LOCAL date; otherwise due when
 *     `now - lastRun >= intervalSecs` (never run → due). An unparseable lastRun
 *     counts as never run.
 *   - dependsOn: a skill waits until the named skill (by skillName, enabled or
 *     not) has a lastRun on the current LOCAL date — judged against this pass's
 *     snapshot, so a dependency dispatched in the same pass unblocks next tick.
 *   - Template vars {{today}} / {{yesterday}} (UTC dates) and {{now}} (RFC 3339).
 *   - Routing (`effective_routing`): the note's non-empty provider/model override
 *     the defaults; local = provider "local"|"ollama" + a local server + a model.
 *   - lastRun = the pass's `now`, written right after a run is ACCEPTED (before it
 *     finishes), with the rest of the metadata carried over. A dispatch that could
 *     not be accepted does not touch lastRun, so the skill stays due.
 *   - Structured mode: sourceTags union (dedup by id) → drop exclude-tagged and
 *     `triage-failed` notes → shortcut labels → grammar-constrained classify with
 *     one truncated retry → label + alsoAddTags, or `triage-failed` on failure →
 *     the same summary text. A misconfigured block is a FAILED dispatch.
 *   - Structured with no local model → the rubric runs agentically on claude
 *     with the desktop's fallback prompt.
 *   - Every finished run (completed/failed, and — a parity-A change — one the
 *     owner cancelled via POST /api/agent/skills/:name/cancel) is persisted as an
 *     `agent-dispatch` + `agent-output` note at
 *     `vault/agent/dispatches/<date>/<slug>-<id8>` with the desktop's content
 *     and metadata shape (AgentActivity reads it unchanged).
 *
 * INTENTIONAL CHANGES (each documented in CLAUDE.md "Server skill scheduler"):
 *   - Agentic skills routed to a local model run on the claude runner (the
 *     desktop's own fallback when its local tool loop failed); the local MCP tool
 *     loop was not ported.
 *   - LOCAL ADMISSION GUARD before every local run: LM Studio reachable; memory
 *     under the runner's swap/free thresholds; and a model that is NOT already
 *     loaded is never JIT-loaded below SKILLS_LOAD_FREE_MIN_PCT free (the
 *     lms-guard threshold). Refused → no lastRun, no dispatch note; retried next
 *     tick; logged only when the reason changes.
 *   - Memory is re-checked between notes; a run that hits pressure (or its
 *     SKILLS_LOCAL_RUN_TIMEOUT_MS deadline) stops early and says so. An
 *     unreachable LM Studio mid-run aborts the run instead of stamping every
 *     remaining note `triage-failed`.
 *   - Writes to the skill note carry `if_updated_at` (the desktop forced them):
 *     a concurrent edit is refetched and merged once instead of clobbered.
 *   - A lastRun in the future is not due (the desktop's u64 cast made it due on
 *     every tick).
 *   - The runner LEASE: `metadata.runner: "server"` on every enabled skill the
 *     server takes over; a note pinned `runner: "desktop"` is left alone.
 *   - Default skills are not seeded (the desktop's create-only seeding stays
 *     desktop-side and never runs with disable_skill_scheduler).
 *   - Dispatch notes carry an extra `runner: "server"` metadata key.
 *   - Skills run on the PRIMARY vault only (the desktop ran on its one vault).
 *
 * Everything external is injected (`SkillsDeps`) so the whole pass is tested with
 * a fake vault, a fake LM Studio and a fake claude runner.
 */
import { roleAtLeast, workspaceRole } from "../roles";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { VaultConflictError, vaultClient, type Note } from "../parachute";
import { resolveVaultEntry } from "../db";
import {
  admissionVerdict,
  defaultMemoryProbe,
  startDispatch,
  subscribe,
  getDispatch,
  cancelDispatch,
  type Dispatch,
  type MemoryProbe,
  type MemorySample,
} from "../agent-exec";
import { profileAllowedTools } from "../agent-profiles";

// ── constants (identical to the desktop) ─────────────────────────────────────

export const SKILL_TAG = "agent-skill";
/** Per-note content cap (chars) for structured classification. */
export const MAX_NOTE_CHARS = 2500;
/** Retry cap (chars) after a failed first attempt. */
export const RETRY_NOTE_CHARS = 800;
/** Per-note classification timeout. */
export const PER_NOTE_TIMEOUT_MS = 120_000;
/** Tag for a note that could not be classified even after the retry. */
export const REVIEW_TAG = "triage-failed";
const DEFAULT_INTERVAL_SECS = 3600;

// ── injectable seams ─────────────────────────────────────────────────────────

/** The vault surface the scheduler uses (a subset of `vaultClient()`). */
export interface SkillVault {
  listNotes(opts: { tags?: string[]; limit?: number; includeContent?: boolean }): Promise<Note[]>;
  getNote(id: string): Promise<Note>;
  createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note>;
  updateNote(id: string, p: { metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note>;
  addTags(id: string, tags: string[]): Promise<void>;
}

/** What the admission guard learns from the local model server. */
export interface LocalStatus {
  reachable: boolean;
  /** true = the model is resident; false = a request would JIT-load it; null = unknown. */
  loaded: boolean | null;
  error?: string;
}

/** The local OpenAI-compatible model server (LM Studio). */
export interface LocalModel {
  status(model: string): Promise<LocalStatus>;
  /** One grammar-constrained call → parsed JSON (throws on transport/model error). */
  structured(system: string, user: string, schemaName: string, schema: unknown, model: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
}

/** A finished run, as persisted in the dispatch note. */
export interface RunResult {
  /** "cancelled" = stopped by the owner (POST /api/agent/skills/:name/cancel). */
  status: "completed" | "failed" | "cancelled";
  output: string | null;
  error: string | null;
  /** Epoch ms the run was accepted / finished. */
  startedAt: number;
  completedAt: number;
  durationSecs: number;
}

/** Hand a prompt to the claude runner (WP0.1). Returns once ACCEPTED (running or
 *  queued); `onFinish` fires once when it ends (a cancelled run reports status
 *  "cancelled"). `cancel` kills it through the run queue. Throws if the runner
 *  refuses (e.g. its queue is full). */
export type ClaudeDispatcher = (req: { skill: string; prompt: string }, onFinish: (id: string, r: RunResult) => void) => { id: string; cancel?: () => boolean };

export interface SkillsSettings {
  enabled: boolean;
  defaultProvider: string;
  localBaseUrl: string;
  localModel: string;
  swapMaxPct: number | null;
  swapMinFreeMb: number;
  freeMinPct: number;
  /** Between-notes floor while the model is already loaded and running (lower than
   *  freeMinPct: a resident 12B model alone holds a 16 GB host at ~13-20% free, so the
   *  start threshold stopped every run after a note or two). The swap floor still applies. */
  runFreeMinPct?: number;
  loadFreeMinPct: number;
  localRunTimeoutMs: number;
}

export interface SkillsDeps {
  vault: SkillVault;
  local: LocalModel;
  claude: ClaudeDispatcher;
  memoryProbe: MemoryProbe;
  now: () => Date;
  /** The desktop's chrono::Local — the server host's local time by default. */
  localParts: (d: Date) => { hour: number; day: string };
  settings: SkillsSettings;
  log: (msg: string) => void;
  /** Is this account allowed to author skills (workspace owner/admin)? Default:
   *  the primary vault's role (`workspaceRole`). Injected by tests. */
  isTrustedCreator?: (email: string) => boolean;
}

/**
 * DEFENCE IN DEPTH. A skill's body is a prompt that runs with the VAULT token, so the
 * `agent-skill` tag alone must never be enough to get one run: if any write path ever
 * lets a non-owner put that tag on a note, this is what stands between their text and
 * the vault. A skill note is run only when it lives where skills live —
 * `vault/agent/skills/<name>` (the desktop seeder and the skill builder both write
 * there; a location non-owners cannot create in or move to) — AND was not created by
 * a non-owner (`metadata.prism_creator`, which the gateway stamps on every non-owner
 * create and nobody but the owner can change; absent = written by the owner, the
 * desktop or an ingest). Returns why a note is NOT trusted, or null.
 */
export const SKILLS_PATH_PREFIX = "vault/agent/skills/";
export function untrustedSkillReason(note: Pick<Note, "path" | "metadata">, isTrustedCreator: (email: string) => boolean): string | null {
  const path = (note.path ?? "").normalize("NFC");
  if (!path.toLowerCase().startsWith(SKILLS_PATH_PREFIX) || path.length === SKILLS_PATH_PREFIX.length) return "not under vault/agent/skills/";
  const creator = note.metadata?.prism_creator;
  if (creator === undefined || creator === null || creator === "") return null;
  if (typeof creator !== "string" || !isTrustedCreator(creator.toLowerCase())) return "created by a non-owner";
  return null;
}
let lastUntrusted = 0;
const untrustedWarned = new Set<string>();
/** Skill-tagged notes the last pass refused to run (surfaced in /acl/workers). */
export const untrustedSkillCount = (): number => lastUntrusted;

// ── pure: metadata parsing + due evaluation ──────────────────────────────────

type Meta = Record<string, unknown>;

/** serde_json `as_u64`: a non-negative integer, else undefined. */
function asU64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** chrono `DateTime::parse_from_rfc3339` — strict (a full date-time WITH offset),
 *  so a bare date or garbage reads as "never run", exactly like the desktop. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
export function parseRfc3339(v: unknown): number | null {
  if (typeof v !== "string" || !RFC3339.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function defaultLocalParts(d: Date): { hour: number; day: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  return { hour: d.getHours(), day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` };
}

export interface SkillSchedule {
  enabled: boolean;
  intervalSecs: number;
  runAtHour: number | undefined;
  lastRun: number | null;
  dependsOn: string | undefined;
}

export function readSchedule(meta: Meta): SkillSchedule {
  return {
    enabled: meta.enabled === true,
    intervalSecs: asU64(meta.intervalSecs) ?? DEFAULT_INTERVAL_SECS,
    runAtHour: asU64(meta.runAtHour),
    lastRun: parseRfc3339(meta.lastRun),
    dependsOn: asStr(meta.dependsOn),
  };
}

/** Is a skill due at `now`? (check_and_dispatch's is_due, minus dependsOn.) */
export function isDue(s: SkillSchedule, now: Date, localParts: SkillsDeps["localParts"]): boolean {
  if (s.intervalSecs >= 86400 && s.runAtHour !== undefined) {
    const local = localParts(now);
    const ranToday = s.lastRun !== null && localParts(new Date(s.lastRun)).day === local.day;
    return local.hour >= s.runAtHour && !ranToday;
  }
  if (s.lastRun === null) return true;
  const elapsed = Math.floor((now.getTime() - s.lastRun) / 1000);
  return elapsed >= s.intervalSecs; // a future lastRun (elapsed < 0) is NOT due — see header
}

/** dependsOn: the named skill (any enabled state) has a lastRun on today's local date. */
export function dependencyRanToday(depName: string, skills: Note[], now: Date, localParts: SkillsDeps["localParts"]): boolean {
  const today = localParts(now).day;
  return skills.some((s) => {
    const m = s.metadata;
    if (!m || (asStr(m.skillName) ?? "") !== depName) return false;
    const lr = parseRfc3339(m.lastRun);
    return lr !== null && localParts(new Date(lr)).day === today;
  });
}

/** Resolve {{today}} / {{yesterday}} (UTC dates, like chrono::Utc) and {{now}}. */
export function resolveTemplate(prompt: string, now: Date): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return prompt
    .replaceAll("{{today}}", day(now))
    .replaceAll("{{yesterday}}", day(new Date(now.getTime() - 86_400_000)))
    .replaceAll("{{now}}", now.toISOString());
}

/** `effective_routing`: (useLocal, model). */
export function effectiveRouting(meta: Meta, s: SkillsSettings): { useLocal: boolean; model: string; provider: string } {
  const po = asStr(meta.provider);
  const mo = asStr(meta.model);
  const provider = po && po !== "" ? po : s.defaultProvider;
  const model = mo && mo !== "" ? mo : s.localModel;
  const isLocal = provider === "local" || provider === "ollama";
  return { useLocal: isLocal && s.localBaseUrl !== "" && model !== "", model, provider };
}

// ── structured skills (port of structured_skill.rs) ──────────────────────────

export interface StructuredConfig {
  sourceTags: string[];
  excludeTags: string[];
  limit: number;
  schema: unknown;
  resultField: string;
  allowedValues: string[];
  alsoAddTags: string[];
  shortcutLabels: Map<string, string>;
}

/** Parse the `structured` block; throws an Error naming the missing field. */
export function parseStructuredConfig(meta: Meta): StructuredConfig {
  const s = meta.structured;
  if (s === undefined || s === null) {
    throw new Error(
      "missing 'structured' config block (executionMode is 'structured' but no 'structured' object is set in the skill note's metadata)",
    );
  }
  const o = (typeof s === "object" ? s : {}) as Meta;
  const strArray = (k: string): string[] =>
    Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const sourceTags = strArray("sourceTags");
  if (sourceTags.length === 0) throw new Error("'structured.sourceTags' is missing or empty");
  if (!("schema" in o)) throw new Error("'structured.schema' is missing");
  const resultField = asStr(o.resultField);
  if (resultField === undefined) throw new Error("'structured.resultField' is missing");
  const shortcut = new Map<string, string>();
  if (o.shortcutLabels && typeof o.shortcutLabels === "object" && !Array.isArray(o.shortcutLabels)) {
    for (const [k, v] of Object.entries(o.shortcutLabels as Meta)) if (typeof v === "string") shortcut.set(k, v);
  }
  return {
    sourceTags,
    excludeTags: strArray("excludeTags"),
    limit: asU64(o.limit) ?? 50,
    schema: o.schema,
    resultField,
    allowedValues: strArray("allowedValues"),
    alsoAddTags: strArray("alsoAddTags"),
    shortcutLabels: shortcut,
  };
}

/** Collapse every whitespace-delimited token containing "://" to `<link>`. */
export function stripUrls(content: string): string {
  return content.replace(/\S+/g, (tok) => (tok.includes("://") ? "<link>" : tok));
}

/** Source-category labels (e.g. Gmail CATEGORY_*) from metadata.labels. */
export function sourceLabels(note: Note): string[] {
  const l = note.metadata?.labels;
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
}

export function shortcutLabel(note: Note, cfg: StructuredConfig): string | null {
  if (cfg.shortcutLabels.size === 0) return null;
  for (const label of sourceLabels(note)) {
    const v = cfg.shortcutLabels.get(label);
    if (v !== undefined && (cfg.allowedValues.length === 0 || cfg.allowedValues.includes(v))) return v;
  }
  return null;
}

/** Per-note user prompt (build_note_prompt). `cap` counts Unicode scalars. */
export function buildNotePrompt(note: Note, today: string, cap: number): string {
  const title = note.path ? (note.path.split("/").pop() ?? "Untitled") : "Untitled";
  const m = note.metadata ?? {};
  let header = `Today's date: ${today}\n`;
  if (typeof m.from === "string") header += `From: ${m.from}\n`;
  if (typeof m.date === "string") header += `Message date: ${m.date}\n`;
  const labels = sourceLabels(note);
  if (labels.length) header += `Source labels: ${labels.join(", ")}\n`;
  const body = Array.from(stripUrls(note.content ?? "")).slice(0, cap).join("");
  return `${header}Title: ${title}\n\n${body}`;
}

/** extract_json: whole string, else the first `{` … last `}` slice. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return undefined;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return undefined;
  }
}

/** Thrown when the local model server cannot be reached at all (vs. a model error). */
export class LocalUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LocalUnavailableError";
  }
}

/** Thrown when the owner cancels a run (the in-flight model request is aborted).
 *  Never a classification failure: the note in flight is left untagged. */
export class SkillCancelledError extends Error {
  constructor(msg = "cancelled by the owner") {
    super(msg);
    this.name = "SkillCancelledError";
  }
}

/** Classify one note with a truncated retry. Returns the label, or a failure
 *  reason. LocalUnavailableError / SkillCancelledError propagate (the run stops;
 *  nothing is flagged). */
async function classifyOne(
  local: LocalModel,
  rubric: string,
  cfg: StructuredConfig,
  model: string,
  note: Note,
  today: string,
  signal?: AbortSignal,
): Promise<{ ok: true; label: string } | { ok: false; reason: string }> {
  const caps = [MAX_NOTE_CHARS, RETRY_NOTE_CHARS];
  for (let i = 0; i < caps.length; i++) {
    const user = buildNotePrompt(note, today, caps[i]!);
    let json: unknown;
    try {
      if (signal?.aborted) throw new SkillCancelledError();
      json = await local.structured(rubric, user, "classification", cfg.schema, model, PER_NOTE_TIMEOUT_MS, signal);
    } catch (e) {
      if (e instanceof LocalUnavailableError || e instanceof SkillCancelledError) throw e;
      if (signal?.aborted) throw new SkillCancelledError();
      if (i + 1 === caps.length) return { ok: false, reason: (e as Error).message };
      continue; // retry truncated
    }
    const v = json && typeof json === "object" ? (json as Meta)[cfg.resultField] : undefined;
    if (typeof v === "string") {
      if (cfg.allowedValues.length === 0 || cfg.allowedValues.includes(v)) return { ok: true, label: v };
      return { ok: false, reason: `value '${v}' not in allowed list` };
    }
    return { ok: false, reason: `result field '${cfg.resultField}' missing` };
  }
  return { ok: false, reason: "classification failed" };
}

export interface StructuredRunOptions {
  /** Local date (YYYY-MM-DD) anchoring the rubric's relative-time rules. */
  today: string;
  /** Stop between notes once this epoch-ms passes. */
  deadline?: number;
  /** Re-checked between notes; a reason stops the run early. */
  pressure?: () => string | null;
  /** The owner's cancel: checked before every note AND aborts the in-flight
   *  model request. A cancelled run says so in its summary. */
  signal?: AbortSignal;
}

/** Run a structured skill end to end → the desktop's summary text. */
export async function runStructured(
  vault: SkillVault,
  local: LocalModel,
  rubric: string,
  cfg: StructuredConfig,
  model: string,
  opts: StructuredRunOptions,
): Promise<string> {
  // 1. Candidates: union across source tags, dedup by id.
  const candidates: Note[] = [];
  const seen = new Set<string>();
  for (const tag of cfg.sourceTags) {
    for (const n of await vault.listNotes({ tags: [tag], limit: cfg.limit, includeContent: true })) {
      if (!seen.has(n.id)) {
        seen.add(n.id);
        candidates.push(n);
      }
    }
  }
  // 2. Drop already-processed + already-flagged notes.
  const todo = candidates.filter((n) => {
    const tags = n.tags ?? [];
    return !tags.includes(REVIEW_TAG) && !cfg.excludeTags.some((ex) => tags.includes(ex));
  });
  const total = todo.length;
  if (total === 0) return "No unprocessed notes to classify.";

  // 3/4. Classify + apply.
  const counts = new Map<string, number>();
  let flagged = 0;
  let errors = 0;
  let processed = 0;
  let stopped: string | null = null;
  for (const note of todo) {
    if (opts.signal?.aborted) {
      stopped = "cancelled by the owner";
      break;
    }
    if (processed > 0) {
      if (opts.deadline !== undefined && Date.now() > opts.deadline) {
        stopped = "run deadline reached";
        break;
      }
      const p = opts.pressure?.() ?? null;
      if (p) {
        stopped = p;
        break;
      }
    }
    processed++;
    let label = shortcutLabel(note, cfg);
    if (label === null) {
      let r: Awaited<ReturnType<typeof classifyOne>>;
      try {
        r = await classifyOne(local, rubric, cfg, model, note, opts.today, opts.signal);
      } catch (e) {
        if (!(e instanceof SkillCancelledError)) throw e;
        processed--; // the in-flight note was not classified (and is not flagged)
        stopped = "cancelled by the owner";
        break;
      }
      if (!r.ok) {
        try {
          await vault.addTags(note.id, [REVIEW_TAG]);
          flagged++;
        } catch {
          errors++;
        }
        continue;
      }
      label = r.label;
    }
    try {
      await vault.addTags(note.id, [label, ...cfg.alsoAddTags]);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    } catch {
      errors++;
    }
  }

  // 5. Summary (the desktop's text; an early stop is appended, never silent).
  const breakdown = [...counts].map(([k, n]) => `${k}: ${n}`).sort();
  const classified = processed - flagged - errors;
  let summary = `Structured tagging complete — ${classified} of ${total} note(s) classified`;
  if (flagged > 0) summary += `, ${flagged} flagged for review (${REVIEW_TAG})`;
  if (errors > 0) summary += `, ${errors} error(s)`;
  summary += `.\n${breakdown.length ? breakdown.join(", ") : "(none)"}`;
  if (stopped) summary += `\nStopped early after ${processed} of ${total} (${stopped}); the rest are picked up next run.`;
  return summary;
}

/** The claude prompt for a structured skill with no local model (desktop fallback). */
export function structuredFallbackPrompt(rubric: string): string {
  return (
    "You are a background agent for Prism. Apply the following classification rubric to the " +
    "matching vault notes, using the parachute-vault MCP tools to read notes and to add the " +
    "resulting tags via update-note. Be idempotent — skip notes that already carry the result " +
    `tag.\n\n${rubric}`
  );
}

// ── local admission ──────────────────────────────────────────────────────────

/** Decide whether a local-model run may start now. Pure. */
export function localAdmission(
  sample: MemorySample | null,
  status: LocalStatus,
  model: string,
  s: Pick<SkillsSettings, "swapMaxPct" | "freeMinPct" | "loadFreeMinPct"> & { swapMinFreeMb?: number },
): { ok: boolean; reason: string | null } {
  if (!status.reachable) return { ok: false, reason: `local model server unreachable${status.error ? ` (${status.error})` : ""}` };
  const v = admissionVerdict(sample, s.swapMaxPct, s.freeMinPct, s.swapMinFreeMb);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (status.loaded !== true && sample?.freePct != null && sample.freePct < s.loadFreeMinPct) {
    return {
      ok: false,
      reason: `model '${model}' is not loaded and only ${sample.freePct.toFixed(0)}% memory is free (< ${s.loadFreeMinPct}%) — refusing to JIT-load it`,
    };
  }
  return { ok: true, reason: null };
}

// ── dispatch notes (persist_to_vault) ────────────────────────────────────────

export function dispatchNote(id: string, skill: string, r: RunResult): {
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  tags: string[];
} {
  const startedAt = new Date(r.startedAt).toISOString();
  const completedAt = new Date(r.completedAt).toISOString();
  const slug = skill.replaceAll(" ", "-").toLowerCase();
  const statusWord = r.status === "completed" ? "Completed" : r.status === "cancelled" ? "Cancelled" : "Failed";
  let content = `# Agent: ${skill}\n\n`;
  content += `**Status:** ${statusWord}\n`;
  content += `**Started:** ${startedAt}\n`;
  content += `**Completed:** ${completedAt}\n`;
  content += `**Duration:** ${r.durationSecs}s\n`;
  if (r.output !== null) content += `\n---\n\n${r.output}\n`;
  if (r.error !== null) content += `\n## Error\n\n${r.error}\n`;
  return {
    path: `vault/agent/dispatches/${startedAt.slice(0, 10)}/${slug}-${id.slice(0, 8)}`,
    content,
    metadata: {
      type: "agent-dispatch",
      skill,
      status: r.status,
      startedAt,
      completedAt,
      durationSecs: r.durationSecs,
      runner: "server",
    },
    tags: ["agent-dispatch", "agent-output"],
  };
}

// ── the pass ─────────────────────────────────────────────────────────────────

export interface PassResult {
  /** Skills whose run was accepted this pass (lastRun written). */
  dispatched: string[];
  /** Skills that were due but refused admission (stay due). */
  refused: Array<{ skill: string; reason: string }>;
  /** Skills leased to the server this pass. */
  leased: string[];
  /** `agent-skill` notes skipped as untrusted (wrong location or a non-owner creator). */
  untrusted: number;
  /** Local runs that finished this pass (claude runs finish asynchronously). */
  finished: Array<{ skill: string; status: RunResult["status"] }>;
}

/** Last refusal reason per skill — log on change only (no spam). */
const lastRefusal = new Map<string, string>();
const pinnedWarned = new Set<string>();
/**
 * One local-model run at a time, process-wide — shared with interactive local
 * AI (local-ai.ts), so a skill run and an inline edit never load/infer on LM
 * Studio together (security review M1). Acquire is a synchronous test-and-set
 * that returns an OWNERSHIP TOKEN; only the holder of that token can release the
 * slot. Callers acquire AFTER their (async) admission check, never before it,
 * and treat a failed acquire as "busy, try later".
 */
export type LocalSlotToken = symbol;
let localOwner: LocalSlotToken | null = null;
export function tryAcquireLocalModel(): LocalSlotToken | null {
  if (localOwner !== null) return null;
  localOwner = Symbol("local-model-run");
  return localOwner;
}
/** Release the slot — a no-op unless `token` is the current holder's. */
export function releaseLocalModel(token: LocalSlotToken | null): void {
  if (token !== null && localOwner === token) localOwner = null;
}
export const localModelBusy = (): boolean => localOwner !== null;
/** Pending async writes (claude-run dispatch notes) — awaited by tests. */
const pendingWrites = new Set<Promise<unknown>>();

function track(p: Promise<unknown>): void {
  pendingWrites.add(p);
  void p.finally(() => pendingWrites.delete(p));
}

/** Test helper: wait for every in-flight dispatch-note write. */
export async function settleSkillWrites(): Promise<void> {
  while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
}

export function _resetSkillsState(): void {
  lastRefusal.clear();
  pinnedWarned.clear();
  localOwner = null;
  pendingWrites.clear();
  runningSkills.clear();
}

// ── in-flight runs (parity A: the owner can see and cancel them) ─────────────

interface RunningSkill {
  skill: string;
  kind: "local" | "claude";
  /** The dispatch id (= the dispatch note's id suffix); for claude also the runner's id. */
  id: string;
  startedAt: number;
  model: string | null;
  /** Local runs: aborts the loop between notes AND the in-flight LM Studio request. */
  abort: AbortController | null;
  /** Claude runs: kills the process through the run queue. */
  cancel: (() => boolean) | null;
  cancelRequested: boolean;
}

/** In-flight server skill runs by RUN id (L7: a skill may have several claude
 *  runs in flight — e.g. "run now" queued while one is still running). */
const runningSkills = new Map<string, RunningSkill>();

export interface RunningSkillInfo {
  skill: string;
  kind: "local" | "claude";
  id: string;
  startedAt: string;
  model: string | null;
  cancelRequested: boolean;
}

/** What is running right now (GET /api/agent/skills/running). */
export function listRunningSkills(): RunningSkillInfo[] {
  return [...runningSkills.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => ({ skill: r.skill, kind: r.kind, id: r.id, startedAt: new Date(r.startedAt).toISOString(), model: r.model, cancelRequested: r.cancelRequested }));
}

/**
 * Cancel a running skill (POST /api/agent/skills/:skillName/cancel). A local
 * structured run stops before its next note and its in-flight LM Studio request
 * is aborted (that note stays untagged); a claude run is killed through the run
 * queue (SIGTERM, SIGKILL after the grace). Either way the run is persisted as a
 * `cancelled` dispatch note. lastRun stays as written at acceptance, so the
 * skill is NOT immediately due again.
 */
export function cancelSkillRun(skill: string): "cancelled" | "not_running" | "not_cancellable" {
  const runs = [...runningSkills.values()].filter((r) => r.skill === skill);
  if (!runs.length) return "not_running";
  let any = false;
  for (const r of runs) {
    if (!r.abort && !r.cancel) continue; // no handle (L7): reported, never pretended
    r.cancelRequested = true;
    r.abort?.abort();
    r.cancel?.();
    any = true;
  }
  return any ? "cancelled" : "not_cancellable";
}

/** Merge `patch` into a skill note's metadata with optimistic concurrency: one
 *  refetch + retry on a conflict. Returns the updated note (or null on failure). */
async function patchSkillMeta(vault: SkillVault, note: Note, patch: Meta, log: SkillsDeps["log"]): Promise<Note | null> {
  const write = (n: Note) =>
    vault.updateNote(n.id, { metadata: { ...(n.metadata ?? {}), ...patch }, ...(n.updatedAt ? { ifUpdatedAt: n.updatedAt } : {}) });
  try {
    return await write(note);
  } catch (e) {
    if (!(e instanceof VaultConflictError)) {
      log(`[skills] metadata write failed for ${note.path ?? note.id}: ${(e as Error).message}`);
      return null;
    }
    try {
      return await write(await vault.getNote(note.id));
    } catch (e2) {
      log(`[skills] metadata write failed after refetch for ${note.path ?? note.id}: ${(e2 as Error).message}`);
      return null;
    }
  }
}

async function persist(deps: SkillsDeps, id: string, skill: string, r: RunResult, onOutcome?: (r: RunResult) => void): Promise<void> {
  try {
    await deps.vault.createNote(dispatchNote(id, skill, r));
  } catch (e) {
    deps.log(`[skills] failed to persist dispatch ${id}: ${(e as Error).message}`);
  }
  onOutcome?.(r);
}

/**
 * One scheduler pass (check_and_dispatch). Never runs anything when disabled.
 * Local runs are awaited (sequentially — one at a time); claude runs are handed
 * to the runner and persisted when they finish. `onOutcome` sees every finished
 * run (health reporting).
 */
export async function runSkillsOnce(deps: SkillsDeps, onOutcome?: (r: RunResult) => void): Promise<PassResult> {
  const res: PassResult = { dispatched: [], refused: [], leased: [], untrusted: 0, finished: [] };
  if (!deps.settings.enabled) return res;

  const listed = await deps.vault.listNotes({ tags: [SKILL_TAG], limit: 100, includeContent: true });
  // Only trusted skill notes exist for the rest of the pass (run, lease, dependsOn).
  const trusted = deps.isTrustedCreator ?? defaultTrustedCreator;
  const skills = listed.filter((n) => {
    const why = untrustedSkillReason(n, trusted);
    if (!why) return true;
    res.untrusted++;
    if (!untrustedWarned.has(n.id)) {
      untrustedWarned.add(n.id);
      deps.log(`[skills] untrusted skill note ${n.id} (${n.path ?? "no path"}) skipped: ${why}`);
    }
    return false;
  });
  lastUntrusted = res.untrusted;
  const now = deps.now();

  for (let skill of skills) {
    let meta = skill.metadata;
    if (!meta) continue;
    const sched = readSchedule(meta);
    if (!sched.enabled) continue;
    const skillName = asStr(meta.skillName) ?? "unknown";

    // LEASE. A note pinned to the desktop is not ours; anything else becomes ours.
    const runner = asStr(meta.runner);
    if (runner === "desktop") {
      if (!pinnedWarned.has(skillName)) {
        pinnedWarned.add(skillName);
        deps.log(`[skills] '${skillName}' is pinned to runner "desktop" — skipping`);
      }
      continue;
    }
    if (runner !== "server") {
      const leased = await patchSkillMeta(deps.vault, skill, { runner: "server" }, deps.log);
      if (!leased) continue; // could not take the lease → don't run it this pass
      skill = leased;
      meta = leased.metadata ?? { ...meta, runner: "server" };
      res.leased.push(skillName);
    }

    if (!isDue(sched, now, deps.localParts)) continue;
    if (sched.dependsOn !== undefined && !dependencyRanToday(sched.dependsOn, skills, now, deps.localParts)) continue;

    const prompt = resolveTemplate(skill.content ?? "", now);
    const mode = asStr(meta.executionMode) ?? "agentic";
    const route = effectiveRouting(meta, deps.settings);
    const markRun = async () => {
      await patchSkillMeta(deps.vault, skill, { lastRun: now.toISOString() }, deps.log);
      res.dispatched.push(skillName);
      lastRefusal.delete(skillName);
    };

    // Structured + local model → grammar-constrained classification on LM Studio.
    if (mode === "structured" && route.useLocal) {
      const id = randomUUID();
      let cfg: StructuredConfig;
      try {
        cfg = parseStructuredConfig(meta);
      } catch (e) {
        const t = Date.now();
        const r: RunResult = { status: "failed", output: null, error: `structured skill misconfigured: ${(e as Error).message}`, startedAt: t, completedAt: t, durationSecs: 0 };
        await markRun();
        await persist(deps, id, skillName, r, onOutcome);
        res.finished.push({ skill: skillName, status: r.status });
        continue;
      }

      const verdict = await admitLocal(deps, route.model);
      // Acquire the slot AFTER the async admission (M1): someone else may have
      // taken it while we awaited LM Studio / the memory probe → defer.
      const slot = verdict.ok ? tryAcquireLocalModel() : null;
      if (!verdict.ok || !slot) {
        const reason = verdict.ok ? "another local-model run is in progress" : verdict.reason!;
        res.refused.push({ skill: skillName, reason });
        if (lastRefusal.get(skillName) !== reason) {
          lastRefusal.set(skillName, reason);
          deps.log(`[skills] '${skillName}' deferred: ${reason} (stays due; retried next tick)`);
        }
        continue;
      }

      const abort = new AbortController();
      runningSkills.set(id, { skill: skillName, kind: "local", id, startedAt: Date.now(), model: route.model, abort, cancel: null, cancelRequested: false });
      try {
        await markRun();
        const start = Date.now();
        let r: RunResult;
        try {
          const summary = await runStructured(deps.vault, deps.local, prompt, cfg, route.model, {
            today: deps.localParts(now).day,
            deadline: start + deps.settings.localRunTimeoutMs,
            pressure: () => {
              const v = admissionVerdict(safeProbe(deps.memoryProbe), deps.settings.swapMaxPct, deps.settings.runFreeMinPct ?? deps.settings.freeMinPct, deps.settings.swapMinFreeMb, 4);
              return v.ok ? null : v.reason;
            },
            signal: abort.signal,
          });
          r = finished(abort.signal.aborted ? "cancelled" : "completed", summary, null, start);
        } catch (e) {
          r = abort.signal.aborted ? finished("cancelled", null, "cancelled by the owner", start) : finished("failed", null, (e as Error).message, start);
        }
        runningSkills.delete(id);
        await persist(deps, id, skillName, r, onOutcome);
        res.finished.push({ skill: skillName, status: r.status });
      } finally {
        runningSkills.delete(id);
        releaseLocalModel(slot);
      }
      continue;
    }

    // Everything else → the WP0.1 claude runner (agentic skills; structured
    // skills with no local model get the desktop's fallback prompt).
    const claudePrompt = mode === "structured" ? structuredFallbackPrompt(prompt) : prompt;
    try {
      let ended = false;
      const h = deps.claude({ skill: skillName, prompt: claudePrompt }, (id, r) => {
        ended = true;
        runningSkills.delete(id);
        track(persist(deps, id, skillName, r, onOutcome));
      });
      if (!ended) {
        runningSkills.set(h.id, { skill: skillName, kind: "claude", id: h.id, startedAt: Date.now(), model: null, abort: null, cancel: h.cancel ?? null, cancelRequested: false });
      }
      await markRun();
    } catch (e) {
      const reason = `claude runner refused: ${(e as Error).message}`;
      res.refused.push({ skill: skillName, reason });
      if (lastRefusal.get(skillName) !== reason) {
        lastRefusal.set(skillName, reason);
        deps.log(`[skills] '${skillName}' deferred: ${reason} (stays due)`);
      }
    }
  }
  return res;
}

function finished(status: RunResult["status"], output: string | null, error: string | null, start: number): RunResult {
  const end = Date.now();
  return { status, output, error, startedAt: start, completedAt: end, durationSecs: Math.floor((end - start) / 1000) };
}

function safeProbe(p: MemoryProbe): MemorySample | null {
  try {
    return p();
  } catch {
    return null;
  }
}

export async function admitLocal(deps: Pick<SkillsDeps, "local" | "memoryProbe" | "settings">, model: string): Promise<{ ok: boolean; reason: string | null }> {
  // Advisory early-out only; the authoritative check is tryAcquireLocalModel().
  if (localModelBusy()) return { ok: false, reason: "another local-model run is in progress" };
  let status: LocalStatus;
  try {
    status = await deps.local.status(model);
  } catch (e) {
    status = { reachable: false, loaded: null, error: (e as Error).message };
  }
  return localAdmission(safeProbe(deps.memoryProbe), status, model, deps.settings);
}

// ── real implementations ────────────────────────────────────────────────────

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** LM Studio (OpenAI-compatible `/v1`) client. `status` asks LM Studio's native
 *  `/api/v0/models` whether the model is resident; a server without that API is
 *  probed via `/v1/models` for reachability only (loaded = unknown). */
export function lmStudioClient(baseUrl: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): LocalModel {
  const base = baseUrl.replace(/\/+$/, "");
  const root = base.replace(/\/v1$/, "");
  const get = async (url: string) => fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  return {
    async status(model) {
      try {
        const r = await get(`${root}/api/v0/models`);
        if (r.ok) {
          const j = (await r.json()) as { data?: Array<{ id?: string; state?: string }> };
          const m = (j.data ?? []).find((x) => x.id === model);
          return { reachable: true, loaded: m ? m.state === "loaded" : false };
        }
        const r2 = await get(`${base}/models`);
        return r2.ok ? { reachable: true, loaded: null } : { reachable: false, loaded: null, error: `HTTP ${r2.status}` };
      } catch (e) {
        return { reachable: false, loaded: null, error: (e as Error).message };
      }
    },
    async structured(system, user, schemaName, schema, model, timeoutMs, signal) {
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      };
      let resp: Response;
      try {
        resp = await fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const err = e as Error;
        if (signal?.aborted) throw new SkillCancelledError();
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          throw new Error(`local AI request timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw new LocalUnavailableError(`local AI HTTP error: ${err.message}`);
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "<no body>");
        throw new Error(`local AI returned ${resp.status}: ${Array.from(text).slice(0, 500).join("")}`);
      }
      const j = (await resp.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }> } | null;
      const msg = j?.choices?.[0]?.message;
      if (!msg) throw new Error("local AI response missing choices[0].message");
      // Reasoning models route grammar-constrained output to reasoning_content.
      const c = (msg.content ?? "").trim();
      const text = c !== "" ? c : (msg.reasoning_content ?? "").trim();
      const parsed = extractJson(text);
      if (parsed === undefined) {
        throw new Error(`structured output contained no parseable JSON; raw: ${Array.from(text).slice(0, 300).join("")}`);
      }
      return parsed;
    },
  };
}

/** The WP0.1 runner as a ClaudeDispatcher, bound to the primary vault. */
export const runnerDispatcher: ClaudeDispatcher = (req, onFinish) => {
  const d = startDispatch(resolveVaultEntry(), { prompt: req.prompt, skill: req.skill }, { allowedTools: profileAllowedTools("skill") });
  let done = false;
  const finish = (x: Dispatch) => {
    if (done || !(x.status === "done" || x.status === "error" || x.status === "cancelled")) return;
    done = true;
    unsub();
    // A cancelled run IS persisted now (parity A: the owner's Stop is recorded as
    // a `cancelled` dispatch note, with whatever output it produced).
    const start = x.startedAt;
    const end = x.endedAt ?? Date.now();
    const out = x.output.trim();
    onFinish(x.id, {
      status: x.status === "done" ? "completed" : x.status === "cancelled" ? "cancelled" : "failed",
      output: x.status === "done" || (x.status === "cancelled" && out) ? out : null,
      error: x.status === "error" ? out || x.error || "failed" : x.status === "cancelled" ? "cancelled by the owner" : null,
      startedAt: start,
      completedAt: end,
      durationSecs: Math.floor((end - (x.runStartedAt ?? start)) / 1000),
    });
  };
  const unsub = subscribe(d.id, (ev) => {
    if (ev.type === "status") finish(ev.dispatch);
  });
  finish(getDispatch(d.id) ?? d); // a spawn failure can end it before we subscribed
  return { id: d.id, cancel: () => cancelDispatch(d.id) };
};

export function settingsFromConfig(): SkillsSettings {
  return {
    enabled: config.skillsEnabled,
    defaultProvider: config.skillsDefaultProvider,
    localBaseUrl: config.skillsLocalBaseUrl,
    localModel: config.skillsLocalModel,
    swapMaxPct: config.skillsSwapMaxPct,
    swapMinFreeMb: config.skillsSwapMinFreeMb,
    freeMinPct: config.skillsFreeMinPct,
    runFreeMinPct: config.skillsRunFreeMinPct,
    loadFreeMinPct: config.skillsLoadFreeMinPct,
    localRunTimeoutMs: config.skillsLocalRunTimeoutMs,
  };
}

/** Workspace owner/admin of the primary vault (the vault skills run on). */
function defaultTrustedCreator(email: string): boolean {
  return roleAtLeast(workspaceRole(email, "primary"), "admin");
}

export function defaultSkillsDeps(): SkillsDeps {
  const settings = settingsFromConfig();
  return {
    vault: vaultClient(),
    local: lmStudioClient(settings.localBaseUrl),
    claude: runnerDispatcher,
    memoryProbe: defaultMemoryProbe,
    now: () => new Date(),
    localParts: defaultLocalParts,
    settings,
    log: (m) => console.log(m),
  };
}
