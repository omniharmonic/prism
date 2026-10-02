import { useCallback, useSyncExternalStore } from "react";

// Only unsent text. No tokens, automatic sends, or migration of unscoped drafts.
const values = new Map<string, string>();
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function read(key: string, persistent: boolean): string {
  if (!values.has(key)) {
    try { values.set(key, persistent ? localStorage.getItem(key) ?? "" : ""); }
    catch { values.set(key, ""); }
  }
  return values.get(key)!;
}

/** A draft follows its conversation and authenticated audience across panel mounts. */
export function useScopedDraft(namespace: string, scope: string | null, conversation: string) {
  // Unresolved audiences remain memory-only and must be remounted when resolved.
  const key = `prism:${namespace}-draft:v1:${JSON.stringify([scope, conversation])}`;
  const text = useSyncExternalStore(subscribe, () => read(key, !!scope), () => "");
  const error = useSyncExternalStore(subscribe, () => errors.get(key) ?? "", () => "");
  const setText = useCallback((next: string) => {
    values.set(key, next);
    let persisted = true;
    try {
      if (!scope) throw new Error("unresolved audience");
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
      errors.delete(key);
    } catch {
      persisted = false;
      errors.set(key, "This draft is only held in this window. Keep it open or copy the text before leaving.");
    }
    listeners.forEach((listener) => listener());
    return persisted;
  }, [key, scope]);
  // Read at commit time, so another mounted view cannot lose an attachment.
  const updateText = useCallback((updater: (current: string) => string) => {
    const current = read(key, !!scope);
    const next = updater(current);
    return next === current ? !errors.has(key) : setText(next);
  }, [key, scope, setText]);
  const clearIfUnchanged = useCallback((sentText: string) => {
    // A second view may have edited the same draft while this send was pending.
    if (read(key, !!scope) === sentText) setText("");
  }, [key, scope, setText]);
  return { text, setText, updateText, clearIfUnchanged, error };
}
