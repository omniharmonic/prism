/**
 * Toggle open/closed, remembered on THIS device (NP-ED-08).
 *
 * Open state is view state: it is never an attribute of the document, never a
 * transaction, never synced (a collaborator opening a toggle does not change
 * yours). This module only remembers which toggles the reader CLOSED, in
 * localStorage, per (account + vault scope, page id, toggle identity), and closes
 * them again when the page is opened.
 *
 * Identity without block ids: a hash of the toggle's summary text + its ordinal
 * among the toggles with that same summary, in document order. Renaming a closed
 * toggle re-saves it; a collaborator inserting an identically named toggle above
 * one of yours shifts the ordinal until your next click (accepted).
 *
 * Storage: ONE key per scope, `prism:toggles:<scope>` = [[pageId, [key, …]], …],
 * least recently changed first; ≤ PAGES pages, ≤ PER_PAGE closed toggles a page.
 * Cleared at sign-out with the other device-local keys (`readCache.ts`).
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { registerToggleMemory } from "../../editor/blocks";
import { mentionNoteId } from "./MentionContext";

export const TOGGLE_MEMORY_PREFIX = "prism:toggles:";
const PAGES = 300;
const PER_PAGE = 200;
const KEY_SHAPE = /^[0-9a-z]{1,8}\.\d{1,4}$/;

type Stored = Array<[string, string[]]>;

let scope = "_";
let cache: { scope: string; pages: Stored } | null = null;

/** Which account + vault the memory belongs to (`VaultClient.scope()`); "" = not known. */
export function setToggleMemoryScope(next: string | null | undefined): void {
  const value = next ? next : "_";
  if (value !== scope) { scope = value; cache = null; }
}

function read(): Stored {
  if (cache && cache.scope === scope) return cache.pages;
  let pages: Stored = [];
  try {
    const raw = JSON.parse(localStorage.getItem(TOGGLE_MEMORY_PREFIX + scope) ?? "[]") as unknown;
    if (Array.isArray(raw)) {
      for (const row of raw.slice(-PAGES)) {
        if (!Array.isArray(row) || typeof row[0] !== "string" || !row[0] || row[0].length > 200 || !Array.isArray(row[1])) continue;
        const keys = (row[1] as unknown[]).filter((k): k is string => typeof k === "string" && KEY_SHAPE.test(k)).slice(0, PER_PAGE);
        if (keys.length) pages.push([row[0], keys]);
      }
    }
  } catch { pages = []; }
  cache = { scope, pages };
  return pages;
}

function write(pages: Stored): void {
  cache = { scope, pages };
  try {
    if (pages.length) localStorage.setItem(TOGGLE_MEMORY_PREFIX + scope, JSON.stringify(pages));
    else localStorage.removeItem(TOGGLE_MEMORY_PREFIX + scope);
  } catch { /* no storage / full: this session only */ }
}

/** The toggles this reader closed on `pageId` (identity keys). */
export function closedToggles(pageId: string): Set<string> {
  return new Set(read().find(([id]) => id === pageId)?.[1] ?? []);
}

/** Replace what is remembered for `pageId` (an empty list forgets the page). */
export function rememberClosedToggles(pageId: string, keys: string[]): void {
  const pages = read().filter(([id]) => id !== pageId);
  const kept = [...new Set(keys)].filter((k) => KEY_SHAPE.test(k)).slice(0, PER_PAGE);
  if (kept.length) pages.push([pageId, kept]);
  write(pages.slice(-PAGES));
}

/** FNV-1a (32 bit) of the summary text: short, stable, not reversible into the text. */
function hash(text: string): string {
  const s = text.trim().slice(0, 500);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** Position → identity key for every toggle of a document (one pass, cached per document). */
const KEYS = new WeakMap<PMNode, Map<number, string>>();
export function toggleKeys(doc: PMNode): Map<number, string> {
  const known = KEYS.get(doc);
  if (known) return known;
  const seen = new Map<string, number>();
  const out = new Map<number, string>();
  doc.descendants((node, pos) => {
    if (node.type.name !== "toggle") return true;
    const h = hash(node.firstChild?.textContent ?? "");
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    if (n < 10_000) out.set(pos, `${h}.${n}`);
    return true;
  });
  KEYS.set(doc, out);
  return out;
}

interface ToggleApi { isOpen(): boolean; setOpen(open: boolean): void }
interface View { getPos: () => number | undefined; api: ToggleApi }
interface Controller { views: Set<View>; timer: ReturnType<typeof setTimeout> | null }
const CONTROLLERS = new WeakMap<Editor, Controller>();

function posOf(view: View): number | null {
  try {
    const pos = view.getPos();
    return typeof pos === "number" ? pos : null;
  } catch { return null; }
}

/** Write the page's closed set from the toggles on screen. Only ever called after the READER acted. */
function persist(editor: Editor, ctl: Controller): void {
  try {
    if (editor.isDestroyed) return;
    const pageId = mentionNoteId(editor);
    if (!pageId) return;
    const keys = toggleKeys(editor.state.doc);
    const closed: string[] = [];
    for (const view of ctl.views) {
      if (view.api.isOpen()) continue;
      const pos = posOf(view);
      const key = pos === null ? undefined : keys.get(pos);
      if (key) closed.push(key);
    }
    rememberClosedToggles(pageId, closed);
  } catch { /* the editor went away */ }
}

function restore(editor: Editor, view: View): void {
  try {
    if (editor.isDestroyed || !view.api.isOpen()) return;
    const pageId = mentionNoteId(editor);
    if (!pageId) return;
    const closed = closedToggles(pageId);
    if (!closed.size) return;
    const pos = posOf(view);
    if (pos === null) return;
    const state = editor.state;
    const key = toggleKeys(state.doc).get(pos);
    if (!key || !closed.has(key)) return;
    // A toggle the reader is typing in right now (just made, just pasted) stays open.
    const node = state.doc.nodeAt(pos);
    const { from } = state.selection;
    let focused = false;
    try { focused = editor.isFocused; } catch { focused = false; }
    if (focused && node && from > pos && from < pos + node.nodeSize) return;
    view.api.setOpen(false);
  } catch { /* not ready: the toggle stays open */ }
}

registerToggleMemory({
  attach(editor, getPos, api) {
    let ctl = CONTROLLERS.get(editor);
    if (!ctl) { ctl = { views: new Set(), timer: null }; CONTROLLERS.set(editor, ctl); }
    const controller = ctl;
    const view: View = { getPos, api };
    controller.views.add(view);
    // After the views of this pass exist and the state holds them — never during the build
    // (the editor's view does not exist yet while the INITIAL document's node views are made).
    queueMicrotask(() => restore(editor, view));
    const later = () => {
      if (controller.timer) clearTimeout(controller.timer);
      controller.timer = setTimeout(() => { controller.timer = null; persist(editor, controller); }, 250);
    };
    return {
      toggled: () => persist(editor, controller),
      // A closed toggle whose summary was edited keeps its place in the memory under its new identity.
      changed: () => { if (!api.isOpen()) later(); },
      destroy: () => { controller.views.delete(view); },
    };
  },
});

if (typeof window !== "undefined") {
  // Another tab changed the memory, or the account signed out: read storage again next time.
  window.addEventListener("storage", (e) => { if (!e.key || e.key.startsWith(TOGGLE_MEMORY_PREFIX)) cache = null; });
  window.addEventListener("prism:signed-out", () => { cache = null; });
}
