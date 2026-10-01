import { useScopedDraft } from "../drafts/useScopedDraft";

/** Retains existing agent keys while sharing scoped draft behavior. */
export function useComposerDraft(scope: string | null, conversation: string) {
  return useScopedDraft("agent", scope, conversation);
}
