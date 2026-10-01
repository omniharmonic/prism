/**
 * Tags and metadata keys an EXTERNAL source (a Notion database row, a GitHub
 * file's frontmatter) may never set on a vault note (parity B security review M4).
 * These are what the server's own schedulers, governance, publishing and ingesters
 * READ to decide what to do — a row that could tag a note `agent-skill` or stamp
 * `runner`/`enabled` would become a scheduled agent run; `governance-*` would
 * forge constitution state; `prism_visibility`/`prism_creator` would rewrite who
 * may see a note.
 */

/** Exact tags (lower-case). Every `governance-*` tag is reserved by prefix. */
export const RESERVED_TAGS = new Set([
  "agent-skill", // server skill scheduler (worker/skills.ts)
  "agent-dispatch", // dispatch / output notes the scheduler and health read
  "agent-output",
  "agent-session", // durable agent session transcripts
  "alert", // worker health alerts
  "dashboard", // dashboard layouts (client filter engine)
  "message-thread", // Matrix ingest: room → note map
  "message-archive", // Matrix rollover archives
  "email", // Gmail ingest dedupe (threadId)
  "meeting", // calendar ingest reconcile (it DELETES/cancels these)
  "calendar-archived",
  "transcript", // transcript ingesters
  "person", // people linker index (email/Matrix id → note)
  "triaged", // message-triage skill state
  "triage-failed",
  "publication",
]);

export const isReservedTag = (t: string): boolean => {
  const v = t.trim().toLowerCase();
  return RESERVED_TAGS.has(v) || v.startsWith("governance-") || v.startsWith("governance/");
};

/** Metadata keys (exact) plus every `prism_*` and `gov_*` key. */
export const RESERVED_META_KEYS = new Set([
  // skill scheduler (agent-skill notes)
  "skillName", "enabled", "intervalSecs", "runAtHour", "dependsOn", "lastRun", "executionMode",
  "provider", "model", "structured", "runner", "sourceTags", "excludeTags", "alsoAddTags", "allowlist",
  // content typing (renderer / collab kind / ingest dedupe)
  "type", "sync", "calendarEventId", "threadId", "matrixRoomId", "source_id", "event_status",
  "notion_page_id", "title",
  // dashboards
  "layout",
]);

export const isReservedMetaKey = (k: string): boolean =>
  RESERVED_META_KEYS.has(k) || k.startsWith("prism_") || k.startsWith("gov_") || k === "__proto__" || k === "constructor" || k === "prototype";
