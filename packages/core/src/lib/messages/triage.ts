/**
 * The ONE classification model of a conversation (message thread or email). Every surface —
 * the Messages filter chips, the per-row chip, the thread's status control — reads it from here:
 * labels, order and tone live nowhere else.
 *
 * A note carries tags written by the classifier (`message-classify`: an importance tag + `triaged`,
 * or `triage-failed` when it gave up), by a person (the thread status control: any of these, plus
 * `handled`), and cleared by ingest (a new message strips the classifier's tags so the thread is
 * classified again). A partial tag mutation must still place a thread in exactly one status.
 */

/** Statuses a person may SET (the thread status control), in precedence order. */
export const TRIAGE_TAGS = ["handled", "urgent", "action-required", "informational", "low", "social", "triaged"] as const;
export type TriageTag = typeof TRIAGE_TAGS[number];
/** The classifier's dead-letter tag: it never retries a note that carries it (until it is removed). */
export const TRIAGE_FAILED_TAG = "triage-failed";
/** An explicit "please classify" marker some writers use; read as "Needs triage", never ignored. */
export const NEEDS_TRIAGE_TAG = "needs-triage";

export type ThreadStatus = TriageTag | "triage-failed" | "unclassified";

/** Precedence: a person's or the classifier's verdict wins over the failure marker; nothing → unclassified. */
export function threadStatus(tags: readonly string[] | null | undefined): ThreadStatus {
  const set = tags ?? [];
  const tag = TRIAGE_TAGS.find((t) => set.includes(t));
  if (tag) return tag;
  return set.includes(TRIAGE_FAILED_TAG) ? "triage-failed" : "unclassified";
}

/** Sentence case everywhere (w16). */
export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = {
  handled: "Handled", urgent: "Urgent", "action-required": "Action required", informational: "Informational",
  low: "Low priority", social: "Social", triaged: "Reviewed", "triage-failed": "Couldn’t classify", unclassified: "Needs triage",
};

/** Display order of the filter chips: what needs you first, then the quiet ones, then the done ones. */
export const THREAD_STATUS_ORDER: readonly ThreadStatus[] = [
  "urgent", "action-required", "unclassified", "triage-failed", "informational", "low", "social", "triaged", "handled",
];

/** Visual tone of a status (mapped to tokens in CSS — never a colour here). */
export type StatusTone = "danger" | "warning" | "pending" | "failed" | "neutral" | "done";
export const THREAD_STATUS_TONE: Record<ThreadStatus, StatusTone> = {
  urgent: "danger", "action-required": "warning", unclassified: "pending", "triage-failed": "failed",
  informational: "neutral", low: "neutral", social: "neutral", triaged: "done", handled: "done",
};

/**
 * Every tag that says something about classification. Setting a status removes all of them except
 * the new one (and keeps `triaged`, the classifier's "processed" marker, when a specific verdict is set).
 */
const CLASSIFICATION_TAGS: readonly string[] = [...TRIAGE_TAGS, TRIAGE_FAILED_TAG, NEEDS_TRIAGE_TAG];

/** The ONE tag change that moves a note to `next` — add and remove, applied in a single write. */
export function statusChange(tags: readonly string[] | null | undefined, next: TriageTag): { add: string[]; remove: string[] } {
  const current = tags ?? [];
  const remove = current.filter((t) => CLASSIFICATION_TAGS.includes(t) && t !== next && !(t === "triaged" && next !== "triaged"));
  return { add: current.includes(next) ? [] : [next], remove };
}

/** Send a thread back to the classifier: drop the failure marker (the next hourly run picks it up). */
export function retryClassification(tags: readonly string[] | null | undefined): { add: string[]; remove: string[] } {
  return { add: [], remove: (tags ?? []).filter((t) => t === TRIAGE_FAILED_TAG) };
}

/**
 * Milliseconds of the last ACTUAL message (never the note's own `updatedAt`, which moves on any
 * metadata/triage edit). Writers store epoch ms (ingest) or an ISO string (routines); anything
 * unreadable is 0.
 */
export function lastMessageTime(metadata: Record<string, unknown> | null | undefined): number {
  const raw = metadata?.lastMessageAt;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === "string") {
    const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** The slice of a VaultClient a status write needs. */
interface TagWriter {
  changeTags?(id: string, change: { add: string[]; remove: string[] }, options?: { member?: boolean }): Promise<void>;
  addTags(id: string, tags: string[]): Promise<void>;
  removeTags(id: string, tags: string[]): Promise<void>;
}

/**
 * Apply a tag change as ONE write where the shell can (`changeTags`); otherwise add first, then
 * remove (a partial failure then leaves a visible classification, never an untagged thread).
 */
export async function writeTagChange(
  client: TagWriter,
  note: { id: string; _caps?: readonly string[] },
  change: { add: string[]; remove: string[] },
): Promise<void> {
  if (!change.add.length && !change.remove.length) return;
  if (client.changeTags) return client.changeTags(note.id, change, { member: !!note._caps });
  if (change.add.length) await client.addTags(note.id, change.add);
  if (change.remove.length) await client.removeTags(note.id, change.remove);
}
