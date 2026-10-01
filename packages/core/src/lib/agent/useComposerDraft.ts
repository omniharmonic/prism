import { useCallback, useSyncExternalStore } from "react";

// Only unsent text. No tokens, automatic sends, or migration of unscoped drafts.
const values = new Map<string, string>();
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function read(key: string): string {
  if (!values.has(key)) {
    try { values.set(key, localStorage.getItem(key) ?? ""); }
    catch { values.set(key, ""); }
  }
  return values.get(key)!;
}

/** A draft follows its conversation and authenticated audience across panel mounts. */
export function useComposerDraft(scope: string | null, conversation: string) {
  // Unresolved audiences remain memory-only and must be remounted when resolved.
  const key = `prism:agent-draft:v1:${JSON.stringify([scope, conversation])}`;
  const text = useSyncExternalStore(subscribe, () => read(key), () => "");
  const error = useSyncExternalStore(subscribe, () => errors.get(key) ?? "", () => "");
  const setText = useCallback((next: string) => {
    values.set(key, next);
    try {
      if (!scope) throw new Error("unresolved audience");
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
      errors.delete(key);
    } catch {
      errors.set(key, "This draft is only held in this window. Keep it open or copy the text before leaving.");
    }
    listeners.forEach((listener) => listener());
  }, [key, scope]);
  const clearIfUnchanged = useCallback((sentText: string) => {
    // A second view may have edited the same draft while this send was pending.
    if (read(key) === sentText) setText("");
  }, [key, setText]);
  return { text, setText, clearIfUnchanged, error };
}
