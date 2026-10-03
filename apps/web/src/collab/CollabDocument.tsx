import { useMemo } from "react";
import { type Note, useWikilinkNavigate, useVaultTree } from "@prism/core";
import { CollabDoc } from "./CollabDoc";
import { isOwner } from "../config";

/**
 * In-app live collaborative editor (the CollabDocument seam impl). The web/PWA
 * main app renders this instead of the plain autosave editor for every
 * collab-capable note, so edits sync in real time across every session — this
 * browser, another browser, a phone — with no refresh.
 */
export function CollabDocument({ noteId }: { noteId: string; note: Note }) {
  // In-app: clicking a [[wikilink]] opens the target note in a tab. The `[[`
  // SUGGEST dropdown surfaces vault note names, so it's owner-only — a signed-in
  // collaborator editing a shared doc gets navigation but no suggestions.
  const navigate = useWikilinkNavigate();
  // The suggest lists need names and paths only, which the sidebar's tree already holds.
  // This used to be `useNotes()`: the WHOLE vault with every body (13–16 MB at 15k notes),
  // fetched on the first document open and again after every list invalidation (NP-PF-01/09).
  // Trade-off: a page is suggested by its path name; `metadata.title`/`aliases` that differ
  // from it are not in the tree projection and no longer match here.
  const { data: tree } = useVaultTree();
  const notes = useMemo<Note[]>(() => (tree ?? []).map((n) => ({ id: n.id, path: n.path, tags: n.tags, metadata: n.metadata, content: "", createdAt: "", updatedAt: n.updatedAt ?? null })), [tree]);
  return (
    <CollabDoc
      noteId={noteId}
      embedded
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
