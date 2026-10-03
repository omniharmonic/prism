/**
 * The body of an OPEN page as its editor holds it, for a copy ("Save as template").
 * A live (collaborative) page has no REST copy worth trusting — the vault lags the
 * document by the store debounce — so the copy is taken from the editor state.
 *
 * What a copy must not carry: review state. Text that is only a pending SUGGESTED
 * insertion is left out, a suggested deletion keeps its text (nothing was deleted
 * yet), and comment anchors are dropped (their threads stay with the original).
 */
import type { Editor } from "@tiptap/react";

type Json = { type?: string; text?: string; marks?: Array<{ type: string }>; content?: Json[]; [k: string]: unknown };

const REVIEW_MARKS = new Set(["deletion", "comment"]);

export function withoutReviewState(node: Json): Json | null {
  const marks = node.marks;
  if (marks?.some((m) => m.type === "insertion")) return null;
  let out: Json = node;
  if (marks?.some((m) => REVIEW_MARKS.has(m.type))) {
    const kept = marks.filter((m) => !REVIEW_MARKS.has(m.type));
    const { marks: _dropped, ...rest } = node;
    out = kept.length ? { ...rest, marks: kept } : rest;
  }
  if (!out.content) return out;
  return { ...out, content: out.content.map(withoutReviewState).filter((n): n is Json => n !== null) };
}

/** The editor's document as HTML, without suggestion and comment marks. */
export async function editorBodyForCopy(editor: Editor): Promise<string> {
  // Loaded on demand: an editor exists, so its chunk is already here (never on the boot path).
  const { getHTMLFromFragment } = await import("@tiptap/core");
  const clean = withoutReviewState(editor.getJSON() as Json) ?? { type: "doc", content: [] };
  const doc = editor.schema.nodeFromJSON(clean);
  return getHTMLFromFragment(doc.content, editor.schema);
}
