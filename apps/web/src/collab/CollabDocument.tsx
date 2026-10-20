import { type Note, containerTitle, useWikilinkNavigate } from "@prism/core/shell";
import { CollabDoc } from "./CollabDoc";
import { isOwner } from "../config";
import { useLinkNotes } from "./linkNotes";

/**
 * In-app live collaborative editor (the CollabDocument seam impl). The web/PWA
 * main app renders this instead of the plain autosave editor for every
 * collab-capable note, so edits sync in real time across every session — this
 * browser, another browser, a phone — with no refresh.
 */
export function CollabDocument({ noteId, note }: { noteId: string; note: Note }) {
  // In-app: clicking a [[wikilink]] opens the target note in a tab. The `[[`
  // SUGGEST dropdown surfaces vault note names, so it's owner-only — a signed-in
  // collaborator editing a shared doc gets navigation but no suggestions.
  const navigate = useWikilinkNavigate();
  // The suggest lists read the sidebar's tree (names, paths, titles, aliases), never the
  // whole vault with every body.
  const notes = useLinkNotes();
  return (
    <CollabDoc
      noteId={noteId}
      embedded
      // The shell's note follows /api/events: a rename made elsewhere reaches the open document's title.
      pagePath={note.id === noteId ? note.path ?? null : undefined}
      // (The stored title, else — for a container-named page, `<folder>/PROJECT` — the name it is shown by.)
      pageTitle={note.id === noteId ? (typeof note.metadata?.title === "string" && note.metadata.title.trim() ? note.metadata.title : containerTitle(note.path, note.metadata)) : null}
      onWikilinkNavigate={navigate}
      wikilinkNotes={isOwner() ? notes : undefined}
    />
  );
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
