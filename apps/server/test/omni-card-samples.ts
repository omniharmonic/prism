import { cardVersion, getCard } from "../src/omni/cards";
/** Made-up card input shared by the card tests. Every name and address is invented. */
export const cardInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sourceKey: "mail1",
  sourceRevision: "2026-10-15T10:00:00Z",
  kind: "email",
  headline: "Sam asks whether you can review the grant budget before Friday",
  context: [{ text: "You have Thu 2–4 free", source: "calendar" }, { text: "Grant deadline is Fri 5pm", source: "proj1" }],
  ask: "Review the budget sheet and reply with comments",
  urgency: "this-week",
  options: [
    { id: "a", label: "Say yes, Thursday afternoon", plan: "Reply confirming Thursday afternoon", produces: ["email-reply"],
      draft: { kind: "email-reply", payload: { noteId: over.sourceKey ?? "mail1", expectTo: ["sam@example.com"], body: "Hi Sam,\n\nThursday afternoon works. I'll send comments by 4.\n\nBenjamin" } } },
    { id: "b", label: "Ask to push to Monday", plan: "Reply proposing Monday instead", produces: ["email-reply"] },
  ],
  recommended: "a",
  itemRefs: ["mail1"],
  ...over,
});
/** A card publish (hook body): the input plus its evidence at the same revision. */
export const cardPublish = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const input = cardInput(over);
  return { ...input, evidence: [{ sourceId: input.sourceKey, revision: input.sourceRevision }], ...("evidence" in over ? { evidence: over.evidence } : {}) };
};

/** The version a device that just loaded the card would send with choose / instruct ("0"×16 for an unknown card). */
export function seenVersion(owner: string, id: string): string {
  const c = getCard(owner, id);
  return c ? cardVersion(c) : "0".repeat(16);
}
