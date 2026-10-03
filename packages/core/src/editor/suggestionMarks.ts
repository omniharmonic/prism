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

/** Optional provenance; legacy human marks remain readable with null IDs. */
const identityAttributes = () => Object.fromEntries(
  [["suggestionId", "data-suggestion-id"], ["actorId", "data-actor-id"], ["turnId", "data-turn-id"]].map(([name, attribute]) => [name!, {
    default: null,
    parseHTML: (element: { getAttribute(name: string): string | null }) => element.getAttribute(attribute!) || null,
  }]),
);
const identityHtml = (attrs: Record<string, unknown>) => ({
  ...(attrs.suggestionId ? { "data-suggestion-id": attrs.suggestionId } : {}),
  ...(attrs.actorId ? { "data-actor-id": attrs.actorId } : {}),
  ...(attrs.turnId ? { "data-turn-id": attrs.turnId } : {}),
});

/**
 * A suggestion renders with `text-decoration:underline|line-through` so plain HTML
 * readers see it — and the underline/strike marks parse exactly that style, so
 * every re-seed of stored HTML added a real <u>/<s> under the suggestion (not
 * round-trip stable). ProseMirror style rules cannot see the element, so the
 * suggestion's own `text-decoration-color` (which it always writes) is the
 * signal: this rule runs LAST (lowest priority) and clears those two marks.
 */
/**
 * Suggestion marks rank BEFORE the formatting marks, so their <span> renders
 * OUTSIDE <s>/<u>/<strong>…: on parse the span's style is read first (and cleared),
 * and a real <s>/<u> inside it is then added by its own tag — real formatting
 * under a suggestion survives, and the output is byte-stable.
 */
const SUGGESTION_PRIORITY = 1200;
const WINS_OVER_DECORATION = {
  style: "text-decoration-color",
  priority: 1,
  consuming: false,
  clearMark: (mark: { type: { name: string } }) => mark.type.name === "strike" || mark.type.name === "underline",
};

export const InsertionMark = Mark.create({
  name: "insertion",
  priority: SUGGESTION_PRIORITY,
  inclusive: true,
  addAttributes() {
    return {
      ...identityAttributes(),
      user: { default: null, parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute("data-user") || null },
      color: { default: "#22c55e", parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute("data-color") || "#22c55e" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-suggestion='insert']" }, WINS_OVER_DECORATION];
  },
  renderHTML({ mark }) {
    const color = (mark.attrs.color as string) || "#22c55e";
    return [
      "span",
      {
        "data-suggestion": "insert",
        "data-user": mark.attrs.user ?? "",
        "data-color": color,
        ...identityHtml(mark.attrs),
        style: `color:${color};text-decoration:underline;text-decoration-color:${color};`,
      },
      0,
    ];
  },
});

export const DeletionMark = Mark.create({
  name: "deletion",
  priority: SUGGESTION_PRIORITY,
  inclusive: true,
  addAttributes() {
    return {
      ...identityAttributes(),
      user: { default: null, parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute("data-user") || null },
      color: { default: "#ef4444", parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute("data-color") || "#ef4444" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-suggestion='delete']" }, WINS_OVER_DECORATION];
  },
  renderHTML({ mark }) {
    const color = (mark.attrs.color as string) || "#ef4444";
    return [
      "span",
      {
        "data-suggestion": "delete",
        "data-user": mark.attrs.user ?? "",
        "data-color": color,
        ...identityHtml(mark.attrs),
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
