/**
 * Gmail → vault ingest, server-side (Architecture v2 WP1.2). The port of the
 * desktop's `services/email_sync.rs` (+ the `gog` Gmail client it uses), so email
 * keeps flowing with no desktop running.
 *
 * CONVERGENCE CONTRACT — the desktop has been writing these notes for months and
 * other code reads them (the email renderer, message triage, briefings, the
 * health probe), so the note shape is the desktop's, byte-for-byte:
 *   - one note per Gmail thread, tagged `email`;
 *   - path `vault/messages/email/<rust-sanitized subject>-<last 6 chars of threadId>`;
 *   - content `# <subject>\n\n` then per message `**From:** … \n**Date:** …\n\n<body>\n\n---\n\n`
 *     (bodies trimmed, capped at 20 000 bytes + `…\n\n*(truncated)*`);
 *   - metadata { type, platform, threadId, from, subject, date, labels, isUnread,
 *     messageCount, lastMessageAt (epoch ms, same date parsing) } — PATCH merges
 *     it, so keys other writers added survive;
 *   - the sender's person note linked `email-from`.
 * An existing thread is found by `metadata.threadId` across the FULL email set
 * (the desktop only looked at 500 notes, so an older thread re-appearing was
 * duplicated), with the desktop's exact path as the second key.
 *
 * What changed vs the desktop (all in the direction of fewer vault writes):
 *   - creates carry `if_exists: "update"` → a create can never 409;
 *   - the person link rides in the same write as the note (`links`), instead of
 *     a GET-links + PATCH pair per message;
 *   - a thread whose metadata, body size and person link are all unchanged is
 *     NOT rewritten (the desktop PATCHed every thread every pass, and on vault
 *     ≥0.7.9 each such PATCH is a history version);
 *   - person lookup is the index in worker/people.ts (the create→409 storm fix).
 *
 * Cadence mirrors the desktop: first pass per process `in:inbox newer_than:14d`
 * (max 100, the body backfill), then `in:inbox newer_than:3h` (max 30), every
 * GMAIL_INTERVAL_MS (3 min). Gated by GMAIL_SYNC_ENABLED (default off) — the
 * desktop and the server must never both run it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IfExists, Note, NoteLinkInput } from "../parachute";
import { PeopleIndex, rustSanitizePath, type PeopleVault } from "./people";
import { resolveGog } from "./googledocs";

const execFileP = promisify(execFile);

// ── gog (the co-located Google CLI, same auth the desktop uses) ─────────────

/** Runs gog with args; returns stdout. Tests inject a fake — never the real CLI. */
export type GogRunner = (args: string[]) => Promise<string>;

export function defaultGogRunner(gogBin: string = resolveGog()): GogRunner {
  return async (args) => {
    const { stdout } = await execFileP(gogBin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    return stdout;
  };
}

export class GmailClient {
  constructor(
    private account: string,
    private run: GogRunner = defaultGogRunner(),
  ) {}

  /** `gog gmail messages search <q> --max N --include-body --account A --json`
   *  (clients/google.rs gmail_list_threads — identical argv). */
  async searchMessages(query: string, max: number): Promise<unknown> {
    const out = await this.run(["gmail", "messages", "search", query, "--max", String(max), "--include-body", "--account", this.account, "--json"]);
    try {
      return JSON.parse(out.trim() || "{}");
    } catch (e) {
      throw new Error(`gog gmail messages search: unparseable output (${(e as Error).message})`);
    }
  }
}

// ── pure helpers (ports of email_sync.rs) ────────────────────────────────────

export interface GmailMessage {
  id?: string;
  threadId?: string;
  date?: string;
  from?: string;
  subject?: string;
  labels?: string[];
  body?: string;
}

/** gog returns `{messages:[…]}` (or `{threads:[…]}`, or a bare array). */
export function extractMessages(data: unknown): GmailMessage[] {
  if (Array.isArray(data)) return data as GmailMessage[];
  const d = (data ?? {}) as { messages?: unknown; threads?: unknown };
  const arr = Array.isArray(d.messages) ? d.messages : Array.isArray(d.threads) ? d.threads : [];
  return arr as GmailMessage[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function extractEmailAddress(s: string): string {
  const a = s.indexOf("<");
  const b = s.indexOf(">");
  if (a >= 0 && b >= 0) return s.slice(a + 1, b);
  return s.trim();
}

export function extractDisplayName(s: string): string {
  const a = s.indexOf("<");
  if (a >= 0) {
    const name = s.slice(0, a).trim().replace(/^"+|"+$/g, "");
    if (name) return name;
  }
  const e = s.trim();
  return e.includes("@") ? (e.split("@")[0] ?? "") : e;
}

/**
 * gog's three date shapes → epoch ms (0 when none matches), as the desktop:
 * naive "YYYY-MM-DD HH:MM[:SS]" is read as UTC (checked FIRST — JS Date.parse
 * would read it as local time), then RFC 3339, then RFC 2822.
 */
export function parseEmailDateToMillis(date: string): number {
  const s = date.trim();
  if (!s) return 0;
  const naive = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (naive) {
    const [, y, mo, d, h, mi, se] = naive;
    return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, se ? +se : 0);
  }
  const rfc3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
  const rfc2822 = /^([A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(:\d{2})?\s+([+-]\d{4}|[A-Za-z]{1,5})$/;
  if (rfc3339.test(s) || rfc2822.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

const BODY_CAP_BYTES = 20_000;

/** Cut to at most `max` UTF-8 bytes on a character boundary. */
function truncateBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back off a continuation byte
  return buf.subarray(0, end).toString("utf8");
}

/** Group by threadId (falling back to the message id, then "unknown"), keeping
 *  gog's order — the first message of a group is the thread's representative. */
export function groupThreads(messages: GmailMessage[]): Map<string, GmailMessage[]> {
  const out = new Map<string, GmailMessage[]>();
  for (const m of messages) {
    const tid = str(m.threadId) ?? str(m.id) ?? "unknown";
    const g = out.get(tid);
    if (g) g.push(m);
    else out.set(tid, [m]);
  }
  return out;
}

export interface ThreadNote {
  threadId: string;
  path: string;
  content: string;
  metadata: Record<string, unknown>;
  from: string;
}

/** The note the desktop writes for a thread — content, metadata and path. */
export function buildThreadNote(threadId: string, msgs: GmailMessage[]): ThreadNote {
  const first = msgs[0] ?? {};
  const subject = str(first.subject) ?? "No Subject";
  const from = str(first.from) ?? "Unknown";
  const date = str(first.date) ?? "";
  const labels = Array.isArray(first.labels) ? first.labels.filter((l): l is string => typeof l === "string") : [];
  let content = `# ${subject}\n\n`;
  for (const m of msgs) {
    const mf = str(m.from) ?? "Unknown";
    const md = str(m.date) ?? "";
    const body = str(m.body) ?? "";
    content += `**From:** ${mf}  \n**Date:** ${md}\n\n`;
    if (body) {
      const t = body.trim();
      content += Buffer.byteLength(t, "utf8") > BODY_CAP_BYTES ? `${truncateBytes(t, BODY_CAP_BYTES)}…\n\n*(truncated)*` : t;
      content += "\n\n";
    }
    content += "---\n\n";
  }
  const metadata: Record<string, unknown> = {
    type: "email",
    platform: "email",
    threadId,
    from,
    subject,
    date,
    labels,
    isUnread: labels.includes("UNREAD"),
    messageCount: msgs.length,
    lastMessageAt: parseEmailDateToMillis(date),
  };
  // Last 6 CHARS of the thread id (gmail ids are ASCII hex, so == the Rust byte slice).
  const suffix = threadId.length > 6 ? threadId.slice(-6) : threadId;
  return { threadId, path: `vault/messages/email/${rustSanitizePath(subject)}-${suffix}`, content, metadata, from };
}

// ── ingest ───────────────────────────────────────────────────────────────────

export const EMAIL_FROM = "email-from";

export interface GmailVault extends PeopleVault {
  listNotes(opts: { tags?: string[]; includeLinks?: boolean }): Promise<Note[]>;
  createNote(p: {
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    links?: NoteLinkInput[];
    ifExists?: IfExists;
  }): Promise<Note & { existed?: boolean }>;
  updateNote(id: string, p: { content?: string; metadata?: Record<string, unknown>; links?: { add?: NoteLinkInput[] } }): Promise<Note>;
}

export interface GmailIngestResult {
  messages: number;
  threads: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  peopleCreated: number;
  linked: number;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Byte size the vault reports on a lean list (`byteSize`), when present. */
const byteSizeOf = (n: Note): number | null => {
  const v = (n as unknown as { byteSize?: unknown }).byteSize;
  if (typeof v === "number") return v;
  return typeof n.content === "string" && n.content ? Buffer.byteLength(n.content, "utf8") : null;
};

function unchanged(note: Note, t: ThreadNote, personId: string | null): boolean {
  const md = note.metadata ?? {};
  for (const [k, v] of Object.entries(t.metadata)) if (!sameJson(md[k], v)) return false;
  if (byteSizeOf(note) !== Buffer.byteLength(t.content, "utf8")) return false;
  if (!personId) return true;
  // Links unknown (vault/fake without include_links) → treat as missing and write.
  if (!Array.isArray(note.links)) return false;
  return note.links.some((l) => l.sourceId === note.id && l.targetId === personId && l.relationship === EMAIL_FROM);
}

/**
 * One pass: fetch → group by thread → upsert one note per thread → link sender.
 * One bad thread never aborts the pass (it is counted in `failed`).
 */
export async function ingestGmail(
  client: Pick<GmailClient, "searchMessages">,
  vault: GmailVault,
  opts: { query: string; max: number; log?: (line: string) => void },
): Promise<GmailIngestResult> {
  const res: GmailIngestResult = { messages: 0, threads: 0, created: 0, updated: 0, unchanged: 0, failed: 0, peopleCreated: 0, linked: 0 };
  const messages = extractMessages(await client.searchMessages(opts.query, opts.max));
  res.messages = messages.length;
  if (!messages.length) return res;

  // The FULL email set, lean (no bodies) + links: dedupe must see every thread.
  const existing = await vault.listNotes({ tags: ["email"], includeLinks: true });
  const byThread = new Map<string, Note>();
  const byPath = new Map<string, Note>();
  for (const n of existing) {
    const tid = n.metadata?.threadId;
    if (typeof tid === "string" && !byThread.has(tid)) byThread.set(tid, n);
    if (n.path && !byPath.has(n.path)) byPath.set(n.path, n);
  }
  let people: PeopleIndex | null = null;

  for (const [threadId, msgs] of groupThreads(messages)) {
    res.threads++;
    try {
      const t = buildThreadNote(threadId, msgs);

      // Sender → person (desktop: display name + address, platform "email").
      let personId: string | null = null;
      const name = extractDisplayName(t.from);
      if (name) {
        people ??= await PeopleIndex.load(vault);
        const before = people.created;
        const addr = extractEmailAddress(t.from);
        const p = await people
          // Only a real address is a lookup key / stored channel ("Unknown" is not).
          .findOrCreate(vault, name, { email: addr.includes("@") ? addr : null, platform: "email" })
          .catch((e) => {
            opts.log?.(`person for thread ${threadId} failed: ${String(e)}`);
            return null;
          });
        personId = p?.id ?? null;
        res.peopleCreated += people.created - before;
      }
      const links = personId ? [{ target: personId, relationship: EMAIL_FROM }] : undefined;

      const known = byThread.get(threadId) ?? byPath.get(t.path);
      if (known) {
        if (unchanged(known, t, personId)) {
          res.unchanged++;
          continue;
        }
        await vault.updateNote(known.id, { content: t.content, metadata: t.metadata, ...(links ? { links: { add: links } } : {}) });
        res.updated++;
      } else {
        const note = await vault.createNote({
          content: t.content,
          path: t.path,
          metadata: t.metadata,
          tags: ["email"],
          ...(links ? { links } : {}),
          ifExists: "update", // lost a race (e.g. the desktop still running)? merge — never 409
        });
        if (note.existed) {
          res.updated++;
          const other = note.metadata?.threadId;
          if (typeof other === "string" && other !== threadId)
            opts.log?.(`path ${t.path} already held thread ${other}; merged thread ${threadId} into it`);
        } else res.created++;
        byThread.set(threadId, note);
        if (note.path) byPath.set(note.path, note);
      }
      if (personId) res.linked++;
    } catch (e) {
      res.failed++;
      opts.log?.(`thread ${threadId} failed: ${String(e)}`);
    }
  }
  return res;
}
