import { useSyncExternalStore } from "react";

/**
 * NP-OF-04 seam: "Available offline" pages. The host (web: IndexedDB read
 * cache + prefetcher in apps/web/src/offline/availableOffline.ts) registers an
 * implementation; shells without one (desktop) show no toggle.
 */
export interface OfflineAvailability {
  isAvailable(noteId: string): boolean;
  setAvailable(noteId: string, on: boolean): void;
  subscribe(listener: () => void): () => void;
}

let impl: OfflineAvailability | null = null;
const hostListeners = new Set<() => void>();

export function setOfflineAvailability(next: OfflineAvailability | null): void {
  impl = next;
  hostListeners.forEach((fn) => fn());
}

export function useOfflineAvailability(noteId: string | null): { supported: boolean; available: boolean; toggle: () => void } {
  const available = useSyncExternalStore(
    (notify) => {
      hostListeners.add(notify);
      const off = impl?.subscribe(notify);
      return () => { hostListeners.delete(notify); off?.(); };
    },
    () => !!(noteId && impl?.isAvailable(noteId)),
    () => false,
  );
  return {
    supported: !!impl && !!noteId,
    available,
    toggle: () => { if (impl && noteId) impl.setAvailable(noteId, !impl.isAvailable(noteId)); },
  };
}
