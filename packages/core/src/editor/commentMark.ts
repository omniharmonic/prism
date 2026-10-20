import { Mark } from "@tiptap/core";

/**
 * Comment anchor mark (isomorphic — no DOM). Applied to the commented text
 * range; the thread itself lives in a Yjs Map keyed by the same id. Because it's
 * a mark in the SHARED schema, the anchor moves with concurrent edits and
 * survives the server's HTML↔Yjs round-trip. `inclusive: false` so typing at the
 * edge of a comment doesn't extend it.
 */
export const CommentMark = Mark.create({
  name: "comment",
  inclusive: false,
  excludes: "",
  addAttributes() {
    return { id: { default: null }, resolved: { default: false } };
  },
  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },
  renderHTML({ mark }) {
    const resolved = !!mark.attrs.resolved;
    return [
      "span",
      {
        "data-comment-id": mark.attrs.id ?? "",
        "data-resolved": resolved ? "true" : "false",
        style: resolved
          ? ""
          : "background: rgba(234,179,8,0.22); border-bottom: 2px solid #eab308; cursor: pointer;",
      },
      0,
    ];
  },
});

export function commentMarks() {
  return [CommentMark];
}
