import { Extension, InputRule, type Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  deleteTopBlocks,
  duplicateSelectionBlock,
  duplicateTopBlocks,
  moveSelectionBlockIn,
  moveTopBlockIn,
  selectionStart,
  structuralEditsAllowed,
  topBlockAt,
  topLevelBlocks,
} from "./blockCommands";
import { looksLikeMarkdown, markdownPasteRefusal, markdownToPasteHtml, normalizePastedTodos, sliceToMarkdown } from "./markdownClipboard";
import { editorNotice } from "./notice";

/**
 * Editor depth shared by the plain and the live editor (wave 4A). View-only: no
 * schema, so the server never loads it.
 *
 *  - Block selection (NP-ED-06/01): Esc selects the caret's block (or every block
 *    a text range touches); ↑/↓ move it, Shift+↑/↓ extend it, Enter returns to
 *    the text, Backspace/Delete remove the blocks, ⌘⇧↑/↓ move them, ⌘D duplicates.
 *    One block is a real NodeSelection; several are a text range + this plugin's
 *    range (so copy/cut stay native) drawn with `prism-block-selected`.
 *  - ⌘↵ checks a to-do / flips a toggle.
 *  - ⌘K with a text selection opens the link editor (no selection → quick find,
 *    handled by the shell); ⌘⇧H highlights with the last used colour (NP-ED-05/18).
 *  - ⌘Z right after a Markdown conversion gives the typed characters back (NP-ED-04);
 *    `>>` + space makes a toggle.
 *  - Clipboard (NP-ED-21): checkbox lists paste as to-dos, plain-text Markdown
 *    pastes as blocks, a copy carries Markdown in text/plain.
 */

export interface BlockRange { anchor: number; head: number }
export const blockSelectionKey = new PluginKey<BlockRange | null>("blockSelection");

/** The selected top-level block range (indices, inclusive), or null. */
export function blockSelectionRange(state: EditorState): { from: number; to: number; count: number } | null {
  const range = blockSelectionKey.getState(state);
  if (!range) return null;
  const from = Math.min(range.anchor, range.head);
  const to = Math.max(range.anchor, range.head);
  return { from, to, count: to - from + 1 };
}

function selectionFor(tr: Transaction, anchor: number, head: number): Transaction {
  const blocks = topLevelBlocks(tr.doc);
  const max = blocks.length - 1;
  const a = Math.max(0, Math.min(anchor, max));
  const h = Math.max(0, Math.min(head, max));
  const lo = blocks[Math.min(a, h)];
  const hi = blocks[Math.max(a, h)];
  if (a === h && NodeSelection.isSelectable(lo.node)) tr.setSelection(NodeSelection.create(tr.doc, lo.pos));
  else tr.setSelection(TextSelection.between(tr.doc.resolve(lo.pos), tr.doc.resolve(hi.pos + hi.node.nodeSize)));
  return tr.setMeta(blockSelectionKey, { anchor: a, head: h });
}

/** Select top-level blocks `anchor`…`head` as blocks. */
export function selectBlocks(view: { state: EditorState; dispatch: (tr: Transaction) => void }, anchor: number, head = anchor): void {
  view.dispatch(selectionFor(view.state.tr, anchor, head).scrollIntoView());
}

const LAST_HIGHLIGHT_KEY = "prism:editor:last-highlight";
let lastHighlight: string | null | undefined;
/** The highlight ⌘⇧H applies: the colour last picked in the toolbar (null = the default yellow mark). */
export function lastHighlightColor(): string | null {
  if (lastHighlight === undefined) {
    try { lastHighlight = localStorage.getItem(LAST_HIGHLIGHT_KEY); } catch { lastHighlight = null; }
  }
  return lastHighlight ?? null;
}
export function rememberHighlightColor(color: string | null): void {
  lastHighlight = color;
  try { if (color) localStorage.setItem(LAST_HIGHLIGHT_KEY, color); else localStorage.removeItem(LAST_HIGHLIGHT_KEY); } catch { /* memory only */ }
}

// ── ⌘Z after a Markdown conversion ───────────────────────────────────────────
// TipTap's own `undoInputRule` reads state that the very next transaction clears —
// and converting the LAST block always has a next transaction (the trailing-node
// rule appends an empty paragraph in the same dispatch). This tracker keeps the
// rule's transform together with those appended transactions, so one ⌘Z can take
// all of it back and re-insert the typed character.
interface RuleUndo { rule: { transform: Transaction; from: number; to: number; text?: string }; appended: Transaction[] }
const ruleUndoKey = new PluginKey<RuleUndo | null>("inputRuleUndo");

function undoLastInputRule(view: { state: EditorState; dispatch: (tr: Transaction) => void }): boolean {
  const stored = ruleUndoKey.getState(view.state);
  if (!stored) return false;
  const tr = view.state.tr;
  try {
    for (const t of [...stored.appended].reverse()) for (let j = t.steps.length - 1; j >= 0; j--) tr.step(t.steps[j].invert(t.docs[j]));
    const undo = stored.rule.transform;
    for (let j = undo.steps.length - 1; j >= 0; j--) tr.step(undo.steps[j].invert(undo.docs[j]));
    const { from, to, text } = stored.rule;
    if (text) tr.replaceWith(from, to, view.state.schema.text(text, tr.doc.resolve(from).marks()));
    else tr.delete(from, to);
  } catch {
    return false; // the document moved on in a way the steps no longer fit: ordinary undo
  }
  view.dispatch(tr.setMeta(ruleUndoKey, null));
  return true;
}

/** The selection toolbar listens for this on the editor DOM and opens its link field. */
export const EDIT_LINK_EVENT = "prism:edit-link";
/** Fired on the editor DOM by ⌘K with the CARET inside a link: the link card (LinkCard) takes keyboard focus. */
export const LINK_CARD_FOCUS_EVENT = "prism:link-card-focus";

function decorating(editor: Editor): boolean {
  const storage = editor.storage as unknown as Record<string, { suggesting?: boolean; active?: boolean } | undefined>;
  return editor.isEditable && !storage.suggestionMode?.suggesting && !storage.commentOnly?.active;
}

const EDITOR_POPUPS = ".slash-menu, .editor-menu, .prism-mention-menu, .prism-emoji-menu, .prism-paste-menu, .prism-link-card, [role='listbox'][aria-label='Link to a document'], .prism-find-bar:focus-within";
/**
 * Escape belongs to a popup only when it is one of the EDITOR's own (slash, `[[`,
 * `@`, paste-as, block / colour menus) and actually on screen — never to some
 * unrelated listbox or menu mounted elsewhere in the app.
 */
function popupOpen(): boolean {
  if (typeof document === "undefined") return false;
  for (const el of Array.from(document.querySelectorAll(EDITOR_POPUPS))) if ((el as HTMLElement).getClientRects().length > 0) return true;
  return false;
}
/**
 * Inside a row peek (database side / centre peek) Escape closes the peek on the
 * FIRST press — it is a transient layer, and nothing there is "selected as a
 * block" by Escape. ProseMirror itself calls preventDefault on every Escape typed
 * in an editor, and the peek ignores keys that were already used, so from inside
 * the editor the peek never saw Escape: hand it one that is unused (the focus
 * leaves the editor first, so it is not ours any more).
 */
function inPeek(editor: Editor): boolean {
  try { return !!editor.view.dom.closest(".db-peek"); } catch { return false; }
}
function passEscapeToPeek(editor: Editor): void {
  setTimeout(() => {
    try { (editor.view.dom as HTMLElement).blur(); } catch { /* unmounted */ }
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  }, 0);
}

export const EditorKeys = Extension.create({
  name: "editorKeys",
  // Above Highlight (Mod-Shift-h), the history keymap (Mod-z) and list keymaps (Mod-Enter).
  priority: 1100,

  addInputRules() {
    return [
      // `>>` + space → a toggle (Typography's » is switched off for this).
      new InputRule({
        find: /^>>\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.depth !== 1 || $from.parent.type.name !== "paragraph" || !state.schema.nodes.toggle) return null;
          const tr = state.tr.delete(range.from, range.to);
          const start = $from.before(1);
          const block = tr.doc.nodeAt(start);
          if (!block) return null;
          const n = state.schema.nodes;
          const toggle = n.toggle.create(block.attrs.blockColor ? { blockColor: block.attrs.blockColor } : null, [n.toggleSummary.create(null, block.content), n.paragraph.create()]);
          tr.replaceWith(start, start + block.nodeSize, toggle);
          tr.setSelection(TextSelection.near(tr.doc.resolve(start + 2)));
          return undefined;
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const editor = this.editor;
    const range = () => blockSelectionRange(editor.state);
    const structural = () => structuralEditsAllowed(editor);

    const step = (dir: -1 | 1, extend: boolean) => () => {
      const current = blockSelectionKey.getState(editor.state);
      if (!current) return false;
      const max = editor.state.doc.childCount - 1;
      const head = Math.max(0, Math.min(current.head + dir, max));
      selectBlocks(editor.view, extend ? current.anchor : head, head);
      return true;
    };

    const move = (dir: -1 | 1) => () => {
      if (!structural()) return false;
      const r = range();
      if (!r) { moveSelectionBlockIn(editor, dir); return true; }
      const to = dir === -1 ? r.from - 1 : r.to + 2;
      if (to < 0 || to > editor.state.doc.childCount) return true;
      if (moveTopBlockIn(editor, r.from, to, r.count)) selectBlocks(editor.view, r.from + dir, r.to + dir);
      return true;
    };

    const remove = () => {
      const r = range();
      if (!r || !structural()) return false;
      const tr = deleteTopBlocks(editor.state, r.from, r.count);
      if (tr) editor.view.dispatch(tr.scrollIntoView());
      return true;
    };

    return {
      Escape: () => {
        if (popupOpen()) return false;
        if (inPeek(editor)) { passEscapeToPeek(editor); return true; }
        if (!structural() || range()) return false;
        const { doc, selection } = editor.state;
        const first = topBlockAt(doc, selectionStart(doc, selection.from, selection.to));
        const last = topBlockAt(doc, Math.max(selection.from, selection.to - (selection.empty ? 0 : 1)));
        if (!first || !last) return false;
        selectBlocks(editor.view, first.index, last.index);
        return true;
      },
      ArrowUp: step(-1, false),
      ArrowDown: step(1, false),
      "Shift-ArrowUp": step(-1, true),
      "Shift-ArrowDown": step(1, true),
      Enter: () => {
        const r = range();
        if (!r) return false;
        const block = topLevelBlocks(editor.state.doc)[blockSelectionKey.getState(editor.state)!.head];
        if (!block) return false;
        const $pos = editor.state.doc.resolve(Math.min(block.pos + block.node.nodeSize - 1, editor.state.doc.content.size));
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near($pos, -1)).scrollIntoView());
        return true;
      },
      Backspace: remove,
      Delete: remove,
      "Mod-Shift-ArrowUp": move(-1),
      "Mod-Shift-ArrowDown": move(1),
      "Mod-d": () => {
        if (!structural()) return false;
        const r = range();
        if (r) {
          const tr = duplicateTopBlocks(editor.state, r.from, r.count);
          if (tr) editor.view.dispatch(selectionFor(tr, r.from + r.count, r.to + r.count).scrollIntoView());
          return true;
        }
        const tr = duplicateSelectionBlock(editor.state);
        if (tr) editor.view.dispatch(tr);
        return true; // never the browser's "bookmark this page"
      },
      "Mod-Enter": () => {
        if (!editor.isEditable) return false;
        const { $from } = editor.state.selection;
        for (let d = $from.depth; d >= 1; d--) {
          const node = $from.node(d);
          if (node.type.name === "taskItem") {
            if (!structural()) return false;
            editor.view.dispatch(editor.state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked }));
            return true;
          }
          if (node.type.name === "toggle") {
            const dom = editor.view.nodeDOM($from.before(d));
            if (dom instanceof HTMLElement) dom.dispatchEvent(new CustomEvent("prism:toggle-open"));
            return true;
          }
        }
        return false;
      },
      "Mod-k": () => {
        const { selection } = editor.state;
        const linkType = editor.schema.marks.link;
        // The caret inside a link: move into its card (Open / Edit / Remove). Tab walks on, Esc comes back.
        if (linkType && selection instanceof TextSelection && selection.empty && editor.isEditable
          && (linkType.isInSet(selection.$from.marks()) || (selection.$from.nodeAfter && linkType.isInSet(selection.$from.nodeAfter.marks)))) {
          editor.view.dom.dispatchEvent(new CustomEvent(LINK_CARD_FOCUS_EVENT));
          return true;
        }
        if (!(selection instanceof TextSelection) || selection.empty || !decorating(editor) || !linkType) return false; // → quick find
        editor.view.dom.dispatchEvent(new CustomEvent(EDIT_LINK_EVENT));
        return true;
      },
      "Mod-Shift-h": () => {
        if (!decorating(editor) || !editor.schema.marks.highlight) return true; // never a stray mark, never the browser's history
        const color = lastHighlightColor();
        return editor.chain().focus().toggleHighlight(color ? { color } : undefined).run() || true;
      },
      // Right after a Markdown conversion ⌘Z gives the typed characters back; otherwise ordinary undo.
      "Mod-z": () => undoLastInputRule(editor.view),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    let pastingMarkdown = false; // view.pasteHTML re-enters handlePaste with the parsed slice
    let plainPasteAt = 0;
    return [
      new Plugin<RuleUndo | null>({
        key: ruleUndoKey,
        state: {
          init: () => null,
          apply(tr, prev, _old, state) {
            const explicit = tr.getMeta(ruleUndoKey);
            if (explicit !== undefined) return explicit as RuleUndo | null;
            for (const plugin of state.plugins) {
              const rule = (plugin.spec as { isInputRules?: boolean }).isInputRules ? tr.getMeta(plugin) : null;
              if (rule?.transform) return { rule, appended: [] };
            }
            if (prev && tr.getMeta("appendedTransaction") && !tr.selectionSet) return tr.docChanged ? { ...prev, appended: [...prev.appended, tr] } : prev;
            return tr.docChanged || tr.selectionSet ? null : prev;
          },
        },
      }),
      new Plugin<BlockRange | null>({
        key: blockSelectionKey,
        state: {
          init: () => null,
          apply(tr, prev) {
            const meta = tr.getMeta(blockSelectionKey) as BlockRange | null | undefined;
            if (meta !== undefined) return meta;
            return tr.docChanged || tr.selectionSet ? null : prev;
          },
        },
        props: {
          decorations(state) {
            const r = blockSelectionRange(state);
            if (!r) return null;
            const blocks = topLevelBlocks(state.doc).slice(r.from, r.to + 1);
            return DecorationSet.create(state.doc, blocks.map((b) => Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: "prism-block-selected" })));
          },
          transformPastedHTML: (html) => normalizePastedTodos(html),
          clipboardTextSerializer: (slice) => sliceToMarkdown(slice),
          handleKeyDown(_view: EditorView, event: KeyboardEvent) {
            // ⌘⇧V / Ctrl+Shift+V = paste as plain text: never converted.
            if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v") plainPasteAt = Date.now();
            return false;
          },
          handlePaste(view: EditorView, event: ClipboardEvent) {
            const data = event.clipboardData;
            if (pastingMarkdown || !data || data.files?.length || data.getData("text/html")) return false;
            if (Date.now() - plainPasteAt < 1000) { plainPasteAt = 0; return false; }
            const text = data.getData("text/plain");
            const { $from, $to } = view.state.selection;
            // Never inside code (block or inline mark): Markdown there is source.
            const inCode = $from.parent.type.spec.code || $to.parent.type.spec.code || $from.marks().some((m) => m.type.spec.code);
            if (!text || inCode || !editor.isEditable) return false;
            const refusal = markdownPasteRefusal(text);
            if (refusal) { editorNotice(refusal, "status"); return false; }
            if (!looksLikeMarkdown(text)) return false;
            // A single bare URL belongs to the URL paste menu.
            if (text.length < 2100 && text.indexOf("\n") === -1 && text.indexOf(" ") === -1 && (text.startsWith("http://") || text.startsWith("https://"))) return false;
            pastingMarkdown = true;
            try { view.pasteHTML(markdownToPasteHtml(text), event); } finally { pastingMarkdown = false; }
            return true;
          },
        },
      }),
    ];
  },
});

/** Is a block selection active? (The selection toolbar stays out of its way.) */
export function blockSelectionActive(state: EditorState): boolean {
  return !!blockSelectionKey.getState(state);
}

/** Placeholder text per empty block (NP-ED-25). `emptyDoc` is the hint for a wholly empty document. */
export function editorPlaceholder(emptyDoc: string) {
  return {
    includeChildren: true,
    showOnlyCurrent: true,
    placeholder: ({ editor, node, pos }: { editor: Editor; node: { type: { name: string }; attrs: Record<string, unknown> }; pos: number }) => {
      if (editor.isEmpty) return emptyDoc;
      if (node.type.name === "heading") return `Heading ${node.attrs.level ?? 1}`;
      if (node.type.name === "toggleSummary") return "Toggle";
      if (node.type.name === "codeBlock") return "";
      let parent = "";
      try { parent = editor.state.doc.resolve(pos).parent.type.name; } catch { /* stale position */ }
      if (parent === "taskItem") return "To-do";
      if (parent === "listItem") return "List";
      if (parent === "blockquote") return "Quote";
      if (parent === "tableCell" || parent === "tableHeader") return "";
      return "Type '/' for commands";
    },
  };
}
