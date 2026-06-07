import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { Note } from "../lib/types";

/**
 * Seam that lets a shell make the main-app editor live-collaborative for SHARED
 * notes. The web shell provides a Hocuspocus-backed editor + a hook that reports
 * whether a note is shared; the Canvas swaps to it when so. The default never
 * triggers collab (so desktop / unprovided shells keep the plain editor), which
 * also keeps unshared notes on the offline-capable autosave path.
 */
export interface CollabDocumentSeam {
  /** Hook: does this note have collaborators (grants/links) → render live editor?
   *  Must be a real hook (called unconditionally by Canvas). */
  useIsShared: (noteId: string) => boolean;
  /** The live collaborative document editor for a note. */
  CollabDocument: ComponentType<{ noteId: string; note: Note }>;
}

const DEFAULT: CollabDocumentSeam = {
  useIsShared: () => false,
  CollabDocument: () => null,
};

const Ctx = createContext<CollabDocumentSeam>(DEFAULT);

export function CollabDocumentProvider({
  value,
  children,
}: {
  value: CollabDocumentSeam;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCollabDocumentSeam(): CollabDocumentSeam {
  return useContext(Ctx);
}
