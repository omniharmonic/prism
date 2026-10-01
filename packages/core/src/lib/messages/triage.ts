/** A partial tag mutation must still place a thread in exactly one section. */
export const TRIAGE_TAGS = ["handled", "urgent", "action-required", "informational", "low", "social", "triaged"] as const;
export type ThreadStatus = typeof TRIAGE_TAGS[number] | "unclassified";
export function threadStatus(tags: readonly string[] | null | undefined): ThreadStatus {
  return TRIAGE_TAGS.find((tag) => tags?.includes(tag)) ?? "unclassified";
}
export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = {
  handled: "Handled", urgent: "Urgent", "action-required": "Action required", informational: "Informational",
  low: "Low priority", social: "Social", triaged: "Reviewed", unclassified: "Needs triage",
};
