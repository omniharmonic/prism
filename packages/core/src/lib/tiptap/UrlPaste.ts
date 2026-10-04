import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { structuralEditsAllowed } from "./blockCommands";
import { embedFor, safeWebUrl } from "../media/embeds";
import { pageIdFromUrl } from "./prismLinks";
import { newMentionUid } from "./MentionNode";

/**
 * Paste a bare URL (NP-ED-14): it lands as a link immediately (so nothing is
 * lost if the user ignores the menu), and a small menu offers to turn it into
 * a Mention (link titled with the page's title), keep it as a URL, a Bookmark
 * card, or an Embed when the URL is on the embed allowlist.
 *
 * NP-ED-18: a link to one of OUR pages (`<app origin>/page/<id>`, see
 * `prismLinks.pageIdFromUrl`) lands as a page MENTION chip instead, and the menu
 * offers to make it a plain URL. No schema change: the existing `mention` node.
 *
 * The plugin tracks the pasted range through later edits; any typing or a
 * selection move away dismisses the offer (the link stays).
 */
export interface UrlPasteState {
  url: string; from: number; to: number;
  /** Set when the URL named a Prism page and landed as a PAGE MENTION chip (NP-ED-18): the note id. The menu then offers "URL" instead. */
  page?: string;
}
export const urlPasteKey = new PluginKey<UrlPasteState | null>("urlPaste");

export interface UnfurlResult {
  url: string;
  title?: string | null;
  description?: string | null;
  siteName?: string | null;
  image?: string | null;
  favicon?: string | null;
}
export type Unfurler = (url: string) => Promise<UnfurlResult>;

export interface UrlPasteOptions {
  onStateChange?: (state: UrlPasteState | null) => void;
  /** Host link-preview fetcher (GET /api/unfurl). Read by the paste menu and the slash menu. */
  unfurl?: Unfurler;
}

/** The unfurler the host configured on this editor, if any. */
export function editorUnfurler(editor: Editor | null): Unfurler | undefined {
  return (editor?.extensionManager.extensions.find((e) => e.name === "urlPaste")?.options as UrlPasteOptions | undefined)?.unfurl;
}

/** One http(s) URL and nothing else (no spaces/newlines), ≤ 2048 chars. */
export function pastedUrl(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t || t.length > 2048 || /\s/.test(t) || !/^https?:\/\//i.test(t)) return null;
  return safeWebUrl(t);
}

export const UrlPaste = Extension.create<UrlPasteOptions>({
  name: "urlPaste",
  addOptions() {
    return { onStateChange: undefined, unfurl: undefined };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    return [
      new Plugin<UrlPasteState | null>({
        key: urlPasteKey,
        state: {
          init: () => null,
          apply(tr, prev) {
            const meta = tr.getMeta(urlPasteKey) as { set?: UrlPasteState; clear?: boolean } | undefined;
            if (meta?.clear) return null;
            if (meta?.set) return meta.set;
            if (!prev) return null;
            // Any other edit (typing, remote change touching the range) or moving the caret dismisses.
            if (tr.docChanged) {
              const from = tr.mapping.map(prev.from, 1);
              const to = tr.mapping.map(prev.to, -1);
              if (to - from !== prev.to - prev.from) return null;
              if (tr.getMeta("y-sync$") || tr.getMeta("addToHistory") === false) return { ...prev, from, to };
              return null;
            }
            if (tr.selectionSet && tr.selection.from !== prev.to) return null;
            return prev;
          },
        },
        view: () => ({
          update(view, prevState) {
            const next = urlPasteKey.getState(view.state) ?? null;
            const before = urlPasteKey.getState(prevState) ?? null;
            if (next !== before) options.onStateChange?.(next);
          },
        }),
        props: {
          handlePaste(view, event) {
            if (!structuralEditsAllowed(editor)) return false;
            if (event.clipboardData?.files?.length) return false;
            const url = pastedUrl(event.clipboardData?.getData("text/plain"));
            if (!url) return false;
            const { state } = view;
            const $from = state.selection.$from;
            if ($from.parent.type.spec.code || !$from.parent.isTextblock) return false;
            const link = state.schema.marks.link;
            if (!link) return false;
            // Over selected text the URL LINKS that text (NP-ED-18); nothing is replaced, no menu.
            if (!state.selection.empty) {
              const { from: a, to: b, $from: $a, $to: $b } = state.selection;
              if (!$a.sameParent($b)) return false;
              view.dispatch(state.tr.addMark(a, b, link.create({ href: url })).scrollIntoView());
              return true;
            }
            const from = state.selection.from;
            // One of OUR page links (same origin, strict id) becomes a page mention chip: it stores the
            // id only, and resolves its title through each reader's own access ("No access" otherwise).
            const pageId = pageIdFromUrl(url);
            const mention = state.schema.nodes.mention;
            if (pageId && mention) {
              const chip = mention.create({ kind: "page", id: pageId, label: null, date: null, reminder: null, uid: newMentionUid() });
              const tr = state.tr.replaceSelectionWith(chip, false);
              tr.setMeta(urlPasteKey, { set: { url, from, to: from + chip.nodeSize, page: pageId } });
              view.dispatch(tr.scrollIntoView());
              return true;
            }
            const tr = state.tr.replaceSelectionWith(state.schema.text(url, [link.create({ href: url })]), false);
            const to = from + url.length;
            tr.setMeta(urlPasteKey, { set: { url, from, to } });
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});

export function dismissUrlPaste(editor: Editor): void {
  if (urlPasteKey.getState(editor.state)) editor.view.dispatch(editor.state.tr.setMeta(urlPasteKey, { clear: true }));
}

/** Does the pasted range still hold exactly the URL (or, for a page link, its mention chip)? */
function rangeHolds(editor: Editor, s: UrlPasteState): boolean {
  try {
    if (s.page) {
      const node = editor.state.doc.nodeAt(s.from);
      return node?.type.name === "mention" && node.attrs.kind === "page" && node.attrs.id === s.page && s.to - s.from === node.nodeSize;
    }
    return editor.state.doc.textBetween(s.from, s.to, "") === s.url;
  } catch {
    return false;
  }
}

/**
 * Replace the pasted link with a block (bookmark/embed): if its paragraph holds
 * only the URL, the paragraph becomes the block; otherwise the URL text is
 * removed and the block goes right after the paragraph. One transaction.
 */
export function convertPastedUrl(editor: Editor, s: UrlPasteState, type: "bookmark" | "embed", attrs: Record<string, unknown> = {}): boolean {
  if (s.page || !rangeHolds(editor, s) || !structuralEditsAllowed(editor)) return false;
  const { state } = editor;
  const nodeType = state.schema.nodes[type];
  if (!nodeType) return false;
  const $from = state.doc.resolve(s.from);
  const parent = $from.parent;
  const block = nodeType.create({ url: s.url, ...attrs });
  const tr = state.tr;
  if (parent.textContent.trim() === s.url && $from.depth >= 1) {
    const start = $from.before($from.depth);
    tr.replaceWith(start, start + parent.nodeSize, block);
  } else {
    const after = $from.after($from.depth);
    tr.insert(after, block);
    tr.delete(s.from, s.to);
  }
  tr.setMeta(urlPasteKey, { clear: true });
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** "Paste as → URL" after a page link became a mention: put the link back in place of the chip. */
export function urlInsteadOfMention(editor: Editor, s: UrlPasteState): boolean {
  if (!s.page || !rangeHolds(editor, s) || !structuralEditsAllowed(editor)) return false;
  const link = editor.state.schema.marks.link;
  if (!link) return false;
  const tr = editor.state.tr.replaceWith(s.from, s.to, editor.state.schema.text(s.url, [link.create({ href: s.url })]));
  tr.setMeta(urlPasteKey, { clear: true });
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Replace the pasted URL's TEXT with a title, keeping the link (a "mention" of the page). */
export function titlePastedUrl(editor: Editor, s: UrlPasteState, title: string): boolean {
  if (s.page || !rangeHolds(editor, s) || !structuralEditsAllowed(editor)) return false;
  const link = editor.state.schema.marks.link;
  const text = title.trim().slice(0, 300);
  if (!text || !link) return false;
  const tr = editor.state.tr.replaceWith(s.from, s.to, editor.state.schema.text(text, [link.create({ href: s.url })]));
  tr.setMeta(urlPasteKey, { clear: true });
  editor.view.dispatch(tr);
  return true;
}

/** Fill a bookmark's preview once the unfurl returns (the first matching card without a title). */
export function applyUnfurl(editor: Editor, url: string, data: UnfurlResult): void {
  if (editor.isDestroyed || !structuralEditsAllowed(editor)) return;
  let at: number | null = null;
  editor.state.doc.descendants((n, pos) => {
    if (at !== null) return false;
    if (n.type.name === "bookmark" && n.attrs.url === url && !n.attrs.title) at = pos;
    return true;
  });
  if (at === null) return;
  const node = editor.state.doc.nodeAt(at)!;
  const attrs = {
    ...node.attrs,
    title: data.title?.slice(0, 300) || null,
    description: data.description?.slice(0, 600) || null,
    siteName: data.siteName?.slice(0, 120) || null,
    image: data.image ?? null,
    favicon: data.favicon ?? null,
  };
  editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, attrs));
}

/** Insert a bookmark (or an embed, when allowlisted and asked for) for `raw` at the selection. */
export function insertLinkBlock(editor: Editor, raw: string, type: "bookmark" | "embed", unfurl?: Unfurler): boolean {
  const url = safeWebUrl(raw);
  if (!url) return false;
  const kind = type === "embed" && embedFor(url) ? "embed" : "bookmark";
  const { $from } = editor.state.selection;
  const empty = $from.depth >= 1 && $from.parent.isTextblock && $from.parent.content.size === 0;
  const from = empty ? $from.before($from.depth) : $from.after(Math.max(1, $from.depth));
  const to = empty ? $from.after($from.depth) : from;
  editor.chain().focus().insertContentAt({ from, to }, { type: kind, attrs: { url } }).run();
  if (kind === "bookmark" && unfurl) void unfurl(url).then((d) => applyUnfurl(editor, url, d)).catch(() => {});
  return true;
}
