import { Node, mergeAttributes, type NodeViewRenderer } from "@tiptap/core";

/**
 * Inline mention chip (NP-RF-02…07) — part of the SHARED collab schema
 * (COLLAB_SCHEMA_VERSION 3). Isomorphic: nothing here touches the DOM at import
 * time, so the Prism Server builds the schema in Node.
 *
 *   person → <span data-type="mention" data-kind="person" data-id="<person note id>" data-label="Ada">@Ada</span>
 *   page   → <span data-type="mention" data-kind="page" data-id="<note id>">@page</span>
 *   date   → <span data-type="mention" data-kind="date" data-date="2026-10-03T09:00:00.000Z" data-reminder="<id>">@2026-10-03</span>
 *
 * Every chip carries a random `data-mention-uid`: the server diffs mentions by it
 * (only NEW mentions notify) and notifications deep-link to it.
 *
 * PRIVACY: a page mention stores NO title. The title is resolved at render time
 * through the reader's own permissions (a page they can't view renders as
 * "No access", never its title — stored HTML would otherwise leak it to anyone
 * who can read the containing page). Person chips keep the name the author
 * picked (it is what they typed). Emails never enter the document.
 *
 * The node view is injected by the browser (`setMentionNodeView`, MentionView);
 * the server and plain HTML consumers get `renderHTML` only.
 */
export type MentionKind = "person" | "page" | "date";
export const MENTION_KINDS: readonly MentionKind[] = ["person", "page", "date"];

export interface MentionAttrs {
  kind: MentionKind;
  id: string | null;
  label: string | null;
  date: string | null;
  reminder: string | null;
  uid: string | null;
}

let nodeView: NodeViewRenderer | null = null;
/** Browser-only: install the interactive chip (live title, hover card, date picker). */
export function setMentionNodeView(view: NodeViewRenderer | null): void {
  nodeView = view;
}

/** Random uid for a new chip (also safe in Node ≥ 19 / every browser). */
export function newMentionUid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 16);
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

/** Plain-text fallback inside the chip (what non-Prism readers and exports see). */
export function mentionFallbackText(a: Partial<MentionAttrs>): string {
  if (a.kind === "person") return `@${(a.label ?? "").trim() || "person"}`;
  if (a.kind === "date") return `@${(a.date ?? "").slice(0, 10) || "date"}`;
  return "@page";
}

type AttrSource = { getAttribute(name: string): string | null };
const str = (max: number) => (el: AttrSource, name: string) => {
  const v = el.getAttribute(name);
  return v && v.length <= max ? v : null;
};
const attr = (name: string, max: number) => ({
  default: null,
  parseHTML: (el: AttrSource) => str(max)(el, name),
});

export const MentionNode = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      kind: {
        default: "page",
        parseHTML: (el: AttrSource) => {
          const k = el.getAttribute("data-kind");
          return k && (MENTION_KINDS as readonly string[]).includes(k) ? k : "page";
        },
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-kind": String(attrs.kind ?? "page") }),
      },
      id: { ...attr("data-id", 200), renderHTML: (a: Record<string, unknown>) => (a.id ? { "data-id": String(a.id) } : {}) },
      label: { ...attr("data-label", 120), renderHTML: (a: Record<string, unknown>) => (a.label ? { "data-label": String(a.label) } : {}) },
      date: { ...attr("data-date", 40), renderHTML: (a: Record<string, unknown>) => (a.date ? { "data-date": String(a.date) } : {}) },
      reminder: { ...attr("data-reminder", 80), renderHTML: (a: Record<string, unknown>) => (a.reminder ? { "data-reminder": String(a.reminder) } : {}) },
      uid: { ...attr("data-mention-uid", 64), renderHTML: (a: Record<string, unknown>) => (a.uid ? { "data-mention-uid": String(a.uid) } : {}) },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="mention"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-type": "mention", class: "prism-mention" }, HTMLAttributes), mentionFallbackText(node.attrs as MentionAttrs)];
  },

  renderText({ node }) {
    return mentionFallbackText(node.attrs as MentionAttrs);
  },

  addNodeView() {
    return nodeView;
  },
});

/** Schema extensions for mentions (registered in collabExtensions and the plain editor). */
export function mentionExtensions() {
  return [MentionNode];
}
