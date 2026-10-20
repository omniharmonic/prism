import { useMemo, useSyncExternalStore } from "react";

export interface PropertyPresentation { visible: string[] | null; collapsed: boolean }
const memory = new Map<string, string>();
const EVENT = "prism:property-presentation";
const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  const changed = (event: StorageEvent) => {
    if (event.key === null) memory.clear();
    else memory.delete(event.key);
    notify();
  };
  window.addEventListener("storage", changed);
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener("storage", changed); };
};
/** Device-local presentation only: the authenticated audience includes user and vault. */
export function usePropertyPresentation(scope: string, noteId: string) {
  const key = scope ? `prism:property-view:${encodeURIComponent(scope)}:${encodeURIComponent(noteId)}` : null;
  const raw = useSyncExternalStore(subscribe, () => {
    try { return key ? localStorage.getItem(key) ?? memory.get(key) ?? null : null; } catch { return key ? memory.get(key) ?? null : null; }
  }, () => null);
  const value = useMemo<PropertyPresentation | null>(() => {
    try {
      if (!raw || raw.length > 16384) return null;
      const v = JSON.parse(raw);
      return (v.visible === null || (Array.isArray(v.visible) && v.visible.length <= 200 && v.visible.every((k: unknown) => typeof k === "string" && k.length <= 256))) && typeof v.collapsed === "boolean"
        ? { visible: v.visible === null ? null : [...new Set<string>(v.visible)], collapsed: v.collapsed } : null;
    } catch { return null; }
  }, [raw]);
  const save = (next: PropertyPresentation | null) => {
    if (!key) return;
    if (next) memory.set(key, JSON.stringify(next)); else memory.delete(key);
    try { if (next) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key); } catch { /* Storage unavailable: keep this scoped session usable. */ }
    window.dispatchEvent(new Event(EVENT));
  };
  return { value, save, available: !!key };
}
