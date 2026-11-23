/**
 * Finding a conversation by what was said in it. Hermes holds the transcripts; its API lists
 * sessions by title only, so the gateway keeps its own full-text index of each thread's words
 * (what the person typed and what Omni answered: no tool rows, no model-only scaffolding).
 *
 *   omni_thread_text        FTS5: one row per thread, its transcript as plain text.
 *   omni_thread_text_state  what was indexed (Hermes' message count + last activity), so a
 *                           sweep re-reads only threads that moved.
 *
 * Kept fresh two ways: when a turn here ends (the thread just changed), and a background sweep
 * over Hermes' recent sessions (threads that moved elsewhere: Telegram, routines, the Hermes
 * desktop; and the first backfill). The same reads refresh the thread's cached `auto_title`,
 * the name Hermes' titler gave it. Index failures are logged and never reach a turn or a list.
 */
import { db } from "../db";
import { hermes, HermesError, type HermesMessage, type HermesSession } from "./hermes-client";
import { getThread, setAutoTitle } from "./store";
import { onTurnEnded } from "./turns";
import { publishNotice } from "./bus";
import { omniConfig } from "./config";

db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS omni_thread_text USING fts5(thread_id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS omni_thread_text_state (
  thread_id TEXT PRIMARY KEY,
  message_count INTEGER,
  last_active REAL,
  indexed_at INTEGER NOT NULL
);
`);

/** Hermes returns at most this many of a session's newest messages; older ones are not indexed. */
const MESSAGES_READ = 500;
/** A transcript past this is cut from the front: the newest words are the ones kept. */
const BODY_MAX_CHARS = 400_000;
/** Threads one sweep re-reads (the first backfill takes a few sweeps). */
const SWEEP_BATCH = 40;
const SWEEP_EVERY_MS = 5 * 60_000;
const FIRST_SWEEP_MS = 20_000;

const q = {
  del: db.prepare("DELETE FROM omni_thread_text WHERE thread_id = ?"),
  ins: db.prepare("INSERT INTO omni_thread_text (thread_id, body) VALUES (?, ?)"),
  state: db.prepare("SELECT message_count, last_active FROM omni_thread_text_state WHERE thread_id = ?"),
  setState: db.prepare(
    "INSERT INTO omni_thread_text_state (thread_id, message_count, last_active, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET message_count = excluded.message_count, last_active = excluded.last_active, indexed_at = excluded.indexed_at",
  ),
  delState: db.prepare("DELETE FROM omni_thread_text_state WHERE thread_id = ?"),
  search: db.prepare(
    "SELECT thread_id AS id, snippet(omni_thread_text, 1, '', '', '…', 14) AS snippet FROM omni_thread_text WHERE omni_thread_text MATCH ? ORDER BY rank LIMIT ?",
  ),
};

/** On unless `OMNI_THREAD_INDEX=0` (the test env turns it off so turns make no extra Hermes reads). */
const enabled = (): boolean => process.env.OMNI_THREAD_INDEX !== "0";

/** The `[Prism notes referenced …]` line the gateway appends to a message: ids, not words. */
const NOTES_SUFFIX = /\n*\[Prism notes referenced \(read them with your Prism tools\): [^\]]*\]\s*$/;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
}

/** The words of a transcript: user and assistant text only, oldest first. */
export function transcriptText(messages: HermesMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (!m || m.display_kind === "hidden" || (m.role !== "user" && m.role !== "assistant")) continue;
    const t = textOf(m.content).replace(NOTES_SUFFIX, "").trim();
    if (t && t !== "(empty)") parts.push(t);
  }
  const body = parts.join("\n\n");
  return body.length > BODY_MAX_CHARS ? body.slice(body.length - BODY_MAX_CHARS) : body;
}

function forget(id: string): void {
  db.transaction(() => {
    q.del.run(id);
    q.delState.run(id);
  })();
}

/** Keep Hermes' name for a thread the gateway has a row for; tell the app when it changed. */
function noteTitle(s: HermesSession): void {
  const title = typeof s.title === "string" ? s.title.replace(/\s+/g, " ").trim() : "";
  if (!title || !getThread(s.id)) return;
  if (setAutoTitle(s.id, title)) publishNotice({ type: "thread", id: s.id, op: "titled" });
}

/**
 * Re-read one thread from Hermes and index it. `session` saves the lookup when the caller
 * already has it (a sweep's list row). A session Hermes no longer has is dropped from the index.
 */
export async function indexThread(id: string, session?: HermesSession): Promise<void> {
  let s = session;
  try {
    s ??= await hermes.getSession(id);
    noteTitle(s);
    const messages = await hermes.getMessages(id, { limit: MESSAGES_READ, timeoutMs: 30_000 });
    const body = transcriptText(messages);
    db.transaction(() => {
      q.del.run(id);
      if (body) q.ins.run(id, body);
      q.setState.run(id, s!.message_count ?? messages.length, s!.last_active ?? null, Date.now());
    })();
  } catch (e) {
    if (e instanceof HermesError && e.code === "not_found") return forget(id);
    throw e;
  }
}

/** Has this session moved since it was indexed? */
function stale(s: HermesSession): boolean {
  const r = q.state.get(s.id) as { message_count: number | null; last_active: number | null } | undefined;
  return !r || r.message_count !== (s.message_count ?? null) || r.last_active !== (s.last_active ?? null);
}

/** One pass over Hermes' recent sessions: index up to `batch` that moved. Returns how many. */
export async function sweepThreadIndex(batch = SWEEP_BATCH): Promise<number> {
  const { sessions } = await hermes.listSessions({ limit: 200 });
  let n = 0;
  for (const s of sessions) {
    if (n >= batch) break;
    if (!s?.id || !stale(s)) continue;
    try {
      await indexThread(s.id, s);
    } catch {
      console.error("[omni] thread index: could not read a session; the next sweep retries it");
    }
    n++;
  }
  return n;
}

/** FTS5 query from what the person typed: every word must appear, each as a word prefix. */
export function ftsQuery(text: string): string | null {
  const words = text.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12);
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

/** Threads whose words match, best first, each with the passage that matched. */
export function searchThreadText(text: string, limit = 100): Map<string, string> {
  const match = ftsQuery(text);
  if (!match) return new Map();
  const rows = q.search.all(match, limit) as Array<{ id: string; snippet: string }>;
  return new Map(rows.map((r) => [r.id, r.snippet.replace(/\s+/g, " ").trim()]));
}

// ── keeping it fresh ────────────────────────────────────────────────────────

const pending = new Map<string, Promise<void>>();
/** Re-index a thread after its turn ended (serialised per thread; failures logged). */
export function refreshThreadSoon(id: string): Promise<void> {
  const prev = pending.get(id) ?? Promise.resolve();
  const next = prev
    .then(() => indexThread(id))
    .catch(() => console.error("[omni] thread index: could not refresh a thread after its turn"))
    .finally(() => {
      if (pending.get(id) === next) pending.delete(id);
    });
  pending.set(id, next);
  return next;
}
/** For tests: every refresh started so far has settled. */
export async function threadIndexSettled(): Promise<void> {
  while (pending.size) await Promise.all([...pending.values()]);
}

onTurnEnded((threadId, status) => {
  if (status === "interrupted" || !enabled() || !omniConfig.enabled()) return;
  void refreshThreadSoon(threadId);
});

let timer: ReturnType<typeof setInterval> | null = null;
let first: ReturnType<typeof setTimeout> | null = null;
let sweeping = false;
function sweepOnce(): void {
  if (sweeping) return;
  sweeping = true;
  void sweepThreadIndex()
    .catch(() => console.error("[omni] thread index sweep failed; it runs again later"))
    .finally(() => {
      sweeping = false;
    });
}
/** Start the background sweep (idempotent; off when `OMNI_THREAD_INDEX=0`). */
export function startThreadIndexer(): boolean {
  if (timer || !enabled()) return !!timer;
  first = setTimeout(sweepOnce, FIRST_SWEEP_MS);
  first.unref();
  timer = setInterval(sweepOnce, SWEEP_EVERY_MS);
  timer.unref();
  return true;
}
export function stopThreadIndexer(): void {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = timer = null;
}
export function resetThreadIndexForTests(): void {
  db.exec("DELETE FROM omni_thread_text; DELETE FROM omni_thread_text_state;");
  pending.clear();
}
