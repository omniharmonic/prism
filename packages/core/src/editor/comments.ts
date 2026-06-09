import { useEffect, useState } from "react";
import * as Y from "yjs";
import type { Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

/**
 * Inline comments. The anchor is the `comment` mark (shared schema); the thread
 * data lives in a Yjs Map `comments` so it syncs live and persists with the doc
 * (the server's onStoreDocument saves the whole Y.Doc to SQLite). Each thread is
 * a Y.Map { id, quote, resolved, comments: Y.Array } — nested Y types make
 * concurrent replies conflict-free.
 */

export interface CommentItem {
  author: string;
  color: string;
  text: string;
  createdAt: number;
}
export interface Thread {
  id: string;
  quote: string;
  resolved: boolean;
  comments: CommentItem[];
}

const root = (ydoc: Y.Doc) => ydoc.getMap<Y.Map<unknown>>("comments");

function snapshot(ydoc: Y.Doc): Thread[] {
  const out: Thread[] = [];
  root(ydoc).forEach((t) => {
    const comments = (t.get("comments") as Y.Array<CommentItem> | undefined)?.toArray() ?? [];
    out.push({
      id: String(t.get("id") ?? ""),
      quote: String(t.get("quote") ?? ""),
      resolved: !!t.get("resolved"),
      comments,
    });
  });
  // unresolved first, then by first-comment time
  return out.sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    return (a.comments[0]?.createdAt ?? 0) - (b.comments[0]?.createdAt ?? 0);
  });
}

/** Live thread list for the sidebar. */
export function useThreads(ydoc: Y.Doc): Thread[] {
  const [threads, setThreads] = useState<Thread[]>(() => snapshot(ydoc));
  useEffect(() => {
    const m = root(ydoc);
    const update = () => setThreads(snapshot(ydoc));
    m.observeDeep(update);
    update();
    return () => m.unobserveDeep(update);
  }, [ydoc]);
  return threads;
}

export function createThread(ydoc: Y.Doc, id: string, quote: string, first: CommentItem): void {
  ydoc.transact(() => {
    const t = new Y.Map<unknown>();
    t.set("id", id);
    t.set("quote", quote);
    t.set("resolved", false);
    const arr = new Y.Array<CommentItem>();
    arr.push([first]);
    t.set("comments", arr);
    root(ydoc).set(id, t);
  });
}

export function addReply(ydoc: Y.Doc, id: string, c: CommentItem): void {
  const t = root(ydoc).get(id);
  if (!t) return;
  (t.get("comments") as Y.Array<CommentItem>).push([c]);
}

export function setResolved(ydoc: Y.Doc, id: string, resolved: boolean): void {
  const t = root(ydoc).get(id);
  if (t) t.set("resolved", resolved);
}

/** Apply a comment mark to the current selection + open a thread. Works even
 *  when the editor is read-only (dispatched programmatically). Returns the id,
 *  or null if there's no text selected. */
export function commentOnSelection(
  editor: Editor,
  ydoc: Y.Doc,
  user: { name: string; color: string },
  text: string,
): string | null {
  const { from, to } = editor.state.selection;
  return commentOnRange(editor, ydoc, user, text, from, to);
}

/** Comment on an explicit range — used by the selection bubble, which captures
 *  the range up front so moving focus to the composer can't lose it. */
export function commentOnRange(
  editor: Editor,
  ydoc: Y.Doc,
  user: { name: string; color: string },
  text: string,
  from: number,
  to: number,
): string | null {
  if (from === to) return null;
  const id = `c-${Date.now().toString(36)}-${from}`;
  const quote = editor.state.doc.textBetween(from, to, " ").slice(0, 200);
  const markType = editor.schema.marks.comment;
  if (!markType) return null;
  const tr = editor.state.tr.addMark(from, to, markType.create({ id, resolved: false }));
  editor.view.dispatch(tr);
  createThread(ydoc, id, quote, { author: user.name, color: user.color, text, createdAt: stamp() });
  return id;
}

let counter = 0;
/** Monotonic-ish timestamp without Date.now coupling to render (fine at runtime). */
function stamp(): number {
  return Date.now() + counter++;
}

/**
 * Comment-only guard: lets a reader select text and add comments, but blocks any
 * content edits (typing, deletes, paste, drop). Used for the comment level so a
 * read-only doc is still annotatable.
 */
export const CommentOnly = Extension.create<{ active: boolean }>({
  name: "commentOnly",
  addOptions() {
    return { active: false };
  },
  addStorage() {
    return { active: this.options.active };
  },
  addProseMirrorPlugins() {
    const ext = this;
    const block = () => ext.storage.active;
    return [
      new Plugin({
        props: {
          handleTextInput: () => block(),
          handlePaste: () => block(),
          handleDrop: () => block(),
          handleKeyDown: (_view, event) => {
            if (!block()) return false;
            // allow navigation/selection keys; block anything that edits
            const editing =
              event.key === "Backspace" ||
              event.key === "Delete" ||
              event.key === "Enter" ||
              (event.key.length === 1 && !event.metaKey && !event.ctrlKey);
            return editing;
          },
        },
      }),
    ];
  },
});
