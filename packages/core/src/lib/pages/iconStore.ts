/** Device-local page icon overrides (NP-PG-01). No React/query imports: the data hooks use it too. */
import { create } from "zustand";

/** An icon is a short emoji string; anything else is ignored. */
export const pageIconOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= 32 ? value : null;

/**
 * An override bridges the moment between "this client changed the icon" and "the
 * sidebar tree has been re-read". It is NOT a second source of truth (review M3):
 *  - a failed write clears it (`pageIconWriteFailed`) — the old icon comes back;
 *  - once the write is confirmed (`pageIconWriteConfirmed`), the first tree read
 *    that completes afterwards replaces it (`reconcilePageIcons`), whether the
 *    tree agrees or not (someone else may have changed the icon again).
 */
interface Override { icon: string | null; /** When the write was confirmed; null while it is in flight. */ confirmedAt: number | null }
interface IconOverrides {
  icons: Record<string, Override>;
  set: (noteId: string, icon: string | null) => void;
  confirm: (noteId: string, at: number) => void;
  drop: (noteIds: string[]) => void;
}
const useIconOverrides = create<IconOverrides>((set) => ({
  icons: {},
  set: (noteId, icon) => set((s) => ({ icons: { ...s.icons, [noteId]: { icon, confirmedAt: null } } })),
  confirm: (noteId, at) => set((s) => (s.icons[noteId] ? { icons: { ...s.icons, [noteId]: { ...s.icons[noteId]!, confirmedAt: at } } } : s)),
  drop: (noteIds) => set((s) => {
    if (!noteIds.some((id) => id in s.icons)) return s;
    const icons = { ...s.icons };
    for (const id of noteIds) delete icons[id];
    return { icons };
  }),
}));

/** This client just changed (or removed) a page's icon; the write is on its way. */
export function notePageIconChanged(noteId: string, icon: unknown): void {
  useIconOverrides.getState().set(noteId, pageIconOf(icon));
}
/** The icon write was refused or lost: show what the server has. */
export function pageIconWriteFailed(noteId: string): void {
  useIconOverrides.getState().drop([noteId]);
}
/** The icon write landed: the next tree read is the truth. */
export function pageIconWriteConfirmed(noteId: string, now = Date.now()): void {
  useIconOverrides.getState().confirm(noteId, now);
}
/** A tree read completed at `treeReadAt`: drop every override whose write was confirmed before it. */
export function reconcilePageIcons(treeReadAt: number): void {
  const { icons, drop } = useIconOverrides.getState();
  const done = Object.entries(icons).filter(([, o]) => o.confirmedAt !== null && treeReadAt > o.confirmedAt).map(([id]) => id);
  if (done.length) drop(done);
}

/** The override for one page: `undefined` = none (use the tree's). */
export function usePageIconOverride(noteId: string | null | undefined): string | null | undefined {
  return useIconOverrides((s) => (noteId && s.icons[noteId] ? s.icons[noteId]!.icon : undefined));
}
/** Tests. */
export const pageIconOverrides = () => useIconOverrides.getState().icons;
