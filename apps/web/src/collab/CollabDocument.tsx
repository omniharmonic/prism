import type { Note } from "@prism/core";
import { CollabDoc } from "./CollabDoc";

/**
 * In-app live collaborative editor (the CollabDocument seam impl). The web/PWA
 * main app renders this instead of the plain autosave editor for every
 * collab-capable note, so edits sync in real time across every session — this
 * browser, another browser, a phone — with no refresh.
 */
export function CollabDocument({ noteId }: { noteId: string; note: Note }) {
  return <CollabDoc noteId={noteId} embedded />;
}

/**
 * On the web/PWA, real-time editing is universal: any collab-capable note (Canvas
 * only passes those ids) renders live. We no longer gate on "is it shared" — the
 * whole point is that a note doesn't have to be shared to be live across your own
 * devices. Sharing only controls who *else* can connect.
 */
export function useLiveCollab(noteId: string): boolean {
  return !!noteId;
}
