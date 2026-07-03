import { Mark } from "@tiptap/core";

/**
 * Suggested-edit marks (isomorphic — no DOM). These live in the SHARED collab
 * schema so suggestions sync via Yjs and survive the server's HTML↔Yjs
 * round-trip. The suggest-mode *behavior* (intercepting typing/deletes) is
 * client-only and lives in ./suggestions.
 *
 * Per-attribute parseHTML matters: without it TipTap looks for a literal
 * `user` attribute, so attribution was silently LOST on every HTML⇄schema
 * round-trip (server persist, reload). `data-user`/`data-color` are the wire
 * format, mirrored in renderHTML.
 */

export const InsertionMark = Mark.create({
  name: "insertion",
  inclusive: true,
  addAttributes() {
    return {
      user: { default: null, parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute("data-user") || null },
      color: { default: "#22c55e", parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute("data-color") || "#22c55e" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-suggestion='insert']" }];
  },
  renderHTML({ mark }) {
    const color = (mark.attrs.color as string) || "#22c55e";
    return [
      "span",
      {
        "data-suggestion": "insert",
        "data-user": mark.attrs.user ?? "",
        "data-color": color,
        style: `color:${color};text-decoration:underline;text-decoration-color:${color};`,
      },
      0,
    ];
  },
});

export const DeletionMark = Mark.create({
  name: "deletion",
  inclusive: true,
  addAttributes() {
    return {
      user: { default: null, parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute("data-user") || null },
      color: { default: "#ef4444", parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute("data-color") || "#ef4444" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-suggestion='delete']" }];
  },
  renderHTML({ mark }) {
    const color = (mark.attrs.color as string) || "#ef4444";
    return [
      "span",
      {
        "data-suggestion": "delete",
        "data-user": mark.attrs.user ?? "",
        "data-color": color,
        style: `color:${color};text-decoration:line-through;text-decoration-color:${color};`,
      },
      0,
    ];
  },
});

/** The suggestion marks, to splice into the shared schema. */
export function suggestionMarks() {
  return [InsertionMark, DeletionMark];
}
