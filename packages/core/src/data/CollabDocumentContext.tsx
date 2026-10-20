import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { Note } from "../lib/types";

/**
 * Seam that lets a shell make the main-app editor live-collaborative. A shell that
 * provides it routes editing through the real-time layer (Hocuspocus) so every
 * session — this browser, another browser, a phone — sees edits instantly with no
 * refresh. The web + desktop shells connect to the Prism Server and go live for ALL
 * collab-capable notes (not just shared ones), which is what makes real-time a
 * universal property. The default never triggers collab (unprovided shells keep the
 * offline autosave editor).
 */
export interface CollabDocumentSeam {
  /** Hook: should this note render in the live collaborative editor? Canvas only
   *  passes ids for collab-capable kinds (document/code/spreadsheet/canvas), so a
   *  shell can simply return true to make those notes always live.
   *  Must be a real hook (called unconditionally by Canvas). */
  useLiveCollab: (noteId: string) => boolean;
  /** The live collaborative document editor for a note. */
  CollabDocument: ComponentType<{ noteId: string; note: Note }>;
}

const DEFAULT: CollabDocumentSeam = {
  useLiveCollab: () => false,
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
