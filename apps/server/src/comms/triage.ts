// Triage status of a conversation, derived from its vault `message-thread` note tags.
//
// SINGLE SOURCE OF TRUTH: packages/core/src/lib/messages/triage.ts (`threadStatus`, `NEEDS_ATTENTION`,
// `THREAD_STATUS_ORDER`). The server package does not import @prism/core, so the two tiny pure pieces
// the projection needs are mirrored here; test/comms-triage.test.ts pins them against the same
// precedence cases. Change both together.

/** Statuses a person may set, in precedence order (core `TRIAGE_TAGS`). */
const TRIAGE_TAGS = ["handled", "urgent", "action-required", "informational", "low", "social", "triaged"] as const;
const TRIAGE_FAILED_TAG = "triage-failed";

export type CommsStatus = typeof TRIAGE_TAGS[number] | "triage-failed" | "unclassified";

/** Display order (core `THREAD_STATUS_ORDER`). */
export const COMMS_STATUSES: readonly CommsStatus[] = [
  "urgent", "action-required", "unclassified", "triage-failed", "informational", "low", "social", "triaged", "handled",
];

/** "Needs attention" = these together (core `NEEDS_ATTENTION`). */
export const NEEDS_ATTENTION: readonly CommsStatus[] = ["urgent", "action-required"];

export const isCommsStatus = (s: string): s is CommsStatus => (COMMS_STATUSES as readonly string[]).includes(s);

/** Precedence: a person's or the classifier's verdict wins over the failure marker; nothing → unclassified. */
export function commsStatus(tags: readonly string[] | null | undefined): CommsStatus {
  const set = tags ?? [];
  const tag = TRIAGE_TAGS.find((t) => set.includes(t));
  if (tag) return tag;
  return set.includes(TRIAGE_FAILED_TAG) ? "triage-failed" : "unclassified";
}

// ── Setting a status (sprint Task 9: the row's Status swipe) ─────────────────
// Mirrors core `TRIAGE_TAGS` / `statusChange` (packages/core/src/lib/messages/triage.ts);
// test/comms-thread-actions.test.ts pins the same cases. Change both together.

/** Statuses a person may SET. */
export type SettableStatus = typeof TRIAGE_TAGS[number];
export const SETTABLE_STATUSES: readonly SettableStatus[] = TRIAGE_TAGS;
export const isSettableStatus = (s: unknown): s is SettableStatus => typeof s === "string" && (TRIAGE_TAGS as readonly string[]).includes(s);

const NEEDS_TRIAGE_TAG = "needs-triage";
const CLASSIFICATION_TAGS: readonly string[] = [...TRIAGE_TAGS, TRIAGE_FAILED_TAG, NEEDS_TRIAGE_TAG];

/** The ONE tag change that moves a note to `next` (core `statusChange`): add and remove in one write. */
export function statusChange(tags: readonly string[] | null | undefined, next: SettableStatus): { add: string[]; remove: string[] } {
  const current = tags ?? [];
  const remove = current.filter((t) => CLASSIFICATION_TAGS.includes(t) && t !== next && !(t === "triaged" && next !== "triaged"));
  return { add: current.includes(next) ? [] : [next], remove };
}
