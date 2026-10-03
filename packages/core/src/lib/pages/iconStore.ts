/** Device-local page icon overrides (NP-PG-01). No React/query imports: the data hooks use it too. */
import { create } from "zustand";

/** An icon is a short emoji string; anything else is ignored. */
export const pageIconOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= 32 ? value : null;

interface IconOverrides {
  /** `null` = removed on this client. */
  icons: Record<string, string | null>;
  set: (noteId: string, icon: string | null) => void;
}
const useIconOverrides = create<IconOverrides>((set) => ({
  icons: {},
  set: (noteId, icon) => set((s) => ({ icons: { ...s.icons, [noteId]: icon } })),
}));

/** This client just changed (or removed) a page's icon. */
export function notePageIconChanged(noteId: string, icon: unknown): void {
  useIconOverrides.getState().set(noteId, pageIconOf(icon));
}

/** The override for one page: `undefined` = none (use the tree's). */
export function usePageIconOverride(noteId: string | null | undefined): string | null | undefined {
  return useIconOverrides((s) => (noteId ? s.icons[noteId] : undefined));
}
