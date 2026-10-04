import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getMarkRange } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { Copy, ExternalLink, FileText, Pencil, Unlink } from "lucide-react";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { noteLinkTitle } from "../../lib/wikilinks";
import { EDIT_LINK_EVENT, LINK_CARD_FOCUS_EVENT } from "../../lib/tiptap/EditorKeys";
import { linkTarget, openInNewTab, openLinkTarget, type LinkTarget } from "../../lib/tiptap/prismLinks";
import { structuralEditsAllowed } from "../../lib/tiptap/blockCommands";
import { pageLink } from "../../lib/pages/usePageActions";
import "./LinkCard.css";

/**
 * The link card (NP-ED-18): hovering a link — or putting the caret in one — shows its
 * address with Open / Edit / Remove (Open / Copy where the page cannot be edited).
 *
 *  - Only for LINK MARKS: never a `[[wikilink]]`, a mention chip, or the anchor inside
 *    a bookmark / attachment block (looked up in the document, not by class name).
 *  - It never takes focus by itself, so it cannot interrupt typing; any edit hides it.
 *    From the keyboard: ⌘K with the caret in a link moves into the card; Tab walks on
 *    (no trap); Esc closes it and returns to the text.
 *  - Open (`prismLinks.linkTarget`, the rule the inline link field enforces): a Prism page
 *    opens in the app (in a new tab where no workspace shell is mounted), an `#anchor`
 *    scrolls, every other allowed link opens in a new tab that cannot reach this window
 *    (`noopener noreferrer`). THIS window is never navigated; `javascript:` / `data:` /
 *    `vbscript:`, backslash / control-character paths and `user:pass@` URLs are never opened.
 *  - A click on a link never navigates this window. Where the page is not editable the
 *    click (tap) opens the link; where it is, it places the caret and the card shows —
 *    ⌘/Ctrl-click opens at once.
 */
interface CardState { href: string; from: number; to: number; left: number; top: number; via: "hover" | "caret" | "keys" | "focus" }

const SHOW_MS = 280;
const HIDE_MS = 220;

function linkAt(editor: Editor, pos: number): { href: string; from: number; to: number } | null {
  const type = editor.schema.marks.link;
  if (!type) return null;
  const { doc } = editor.state;
  if (pos < 0 || pos > doc.content.size) return null;
  let range: { from: number; to: number } | void;
  try { range = getMarkRange(doc.resolve(pos), type); } catch { return null; }
  if (!range) return null;
  const node = doc.nodeAt(range.from);
  const href = node?.marks.find((m) => m.type === type)?.attrs.href;
  return typeof href === "string" && href ? { href, from: range.from, to: range.to } : null;
}

/** The link mark an `<a>` in the editor DOM renders, or null (bookmark / attachment anchors, chips, wikilinks). */
function linkOfAnchor(editor: Editor, a: Element): { href: string; from: number; to: number } | null {
  if (a.closest('[data-type="mention"], .prism-mention, .wikilink')) return null;
  try {
    const pos = editor.view.posAtDOM(a, 0);
    const node = editor.state.doc.nodeAt(pos);
    if (!node?.isText) return null;
    return linkAt(editor, pos + 1) ?? linkAt(editor, pos);
  } catch {
    return null;
  }
}

function placeFor(editor: Editor, from: number, to: number): { left: number; top: number } | null {
  try {
    const a = editor.view.coordsAtPos(from);
    const b = editor.view.coordsAtPos(to, -1);
    const width = Math.min(360, window.innerWidth - 16);
    const below = Math.max(a.bottom, b.bottom) + 6;
    const top = below + 44 > window.innerHeight ? Math.max(8, Math.min(a.top, b.top) - 44) : below;
    return { left: Math.max(8, Math.min(a.left, window.innerWidth - width - 8)), top };
  } catch {
    return null;
  }
}

export function LinkCard({ editor }: { editor: Editor }) {
  const client = useOptionalVaultClient();
  const [card, setCard] = useState<CardState | null>(null);
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const state = useRef<CardState | null>(null);
  state.current = card;
  const timers = useRef<{ show?: number; hide?: number }>({});
  const overCard = useRef(false);
  // ⌘K asked for the card: focus its first action once it is on screen (never otherwise).
  const wantFocus = useRef(false);
  useEffect(() => {
    if (!card || !wantFocus.current) return;
    wantFocus.current = false;
    cardRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }, [card]);

  const openPage = (id: string) => {
    const open = (title: string, type: Parameters<ReturnType<typeof useUIStore.getState>["openTab"]>[2]) => useUIStore.getState().openTab(id, title, type);
    // No workspace shell around this editor (the share route `/collab/:id` has no tabs): the page's
    // own address, in a new tab that cannot reach this window. Never a navigation of this one.
    if (!client || !document.getElementById("workspace-document")) { openInNewTab(pageLink(id)); return; }
    // The reader's own read decides the title and type; a page they cannot see opens as "no access".
    void client.getNote(id).then((n) => open(noteLinkTitle(n), inferContentType(n)), () => open("Page", "document"));
  };
  const follow = (target: LinkTarget) => openLinkTarget(target, openPage);

  useEffect(() => {
    let dom: HTMLElement;
    try { dom = editor.view.dom; } catch { return; }
    const clear = (which: "show" | "hide") => { window.clearTimeout(timers.current[which]); timers.current[which] = undefined; };
    const show = (link: { href: string; from: number; to: number }, via: CardState["via"]) => {
      const place = placeFor(editor, link.from, link.to);
      if (!place) return;
      clear("hide");
      setCopied(false);
      setCard({ ...link, ...place, via });
    };
    const hide = () => { clear("show"); clear("hide"); setCard(null); };
    const hideSoon = () => {
      clear("show");
      if (timers.current.hide !== undefined) return;
      timers.current.hide = window.setTimeout(() => {
        timers.current.hide = undefined;
        if (overCard.current || cardRef.current?.contains(document.activeElement)) return;
        if (state.current?.via === "hover") setCard(null);
      }, HIDE_MS);
    };

    const onOver = (e: MouseEvent) => {
      if (e.buttons !== 0) return; // a drag selection is under way
      const a = (e.target as Element | null)?.closest?.("a[href]");
      const link = a && dom.contains(a) ? linkOfAnchor(editor, a) : null;
      if (!link) { if (state.current?.via === "hover") hideSoon(); else clear("show"); return; }
      clear("hide");
      const now = state.current;
      if (now && now.from === link.from && now.to === link.to) return;
      if (now && now.via !== "hover") return; // the caret's card stays where the caret is
      if (!editor.state.selection.empty) return; // the selection toolbar is up
      clear("show");
      timers.current.show = window.setTimeout(() => { timers.current.show = undefined; show(link, "hover"); }, SHOW_MS);
    };
    const onLeave = () => { if (state.current?.via === "hover") hideSoon(); else clear("show"); };

    // A click on a link never navigates this window. Listened for at the WINDOW (capture), ahead of
    // any document-level handler: the Prism Client's host script takes every http(s) anchor click it
    // finds un-handled and opens it natively — it would open our own page links outside the app, and
    // an outside link twice. Handled here first, it leaves the click alone; an outside link then
    // reaches it exactly once, through `openInNewTab`.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      const link = a && dom.contains(a) ? linkOfAnchor(editor, a) : null;
      if (!link) return;
      const handledElsewhere = e.defaultPrevented;
      e.preventDefault();
      // Someone ahead of us already took this click (an older host): do not open an outside link again.
      if (handledElsewhere && linkTarget(link.href).kind === "external") return;
      if (editor.isEditable && !(e.metaKey || e.ctrlKey)) {
        // The caret lands in the link and the card follows — also when the caret was already there
        // (no selection change to hear about).
        window.setTimeout(() => {
          const { selection } = editor.state;
          const at = selection.empty ? linkAt(editor, selection.from) : null;
          if (at && editor.isEditable) show(at, "caret");
        }, 0);
        return;
      }
      hide();
      follow(linkTarget(link.href));
    };
    // Read-only pages: a focused link opens with Enter like any link, but through the same rule.
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the card and nothing else (the editor's own Esc would select the block).
      if (e.key === "Escape" && state.current && !cardRef.current?.contains(document.activeElement)) { e.preventDefault(); e.stopImmediatePropagation(); hide(); return; }
      if (e.key !== "Enter" || editor.isEditable) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      const link = a && dom.contains(a) ? linkOfAnchor(editor, a) : null;
      if (!link) return;
      e.preventDefault();
      follow(linkTarget(link.href));
    };
    const onFocusIn = (e: FocusEvent) => {
      if (editor.isEditable) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      const link = a && dom.contains(a) ? linkOfAnchor(editor, a) : null;
      if (link) show(link, "focus");
    };
    // …and leaving the link takes that card away (unless focus went into the card itself).
    const onFocusOut = (e: FocusEvent) => {
      if (state.current?.via !== "focus" || cardRef.current?.contains(e.relatedTarget as Node | null)) return;
      hide();
    };
    const onFocusCard = () => {
      const { selection } = editor.state;
      const link = selection.empty ? linkAt(editor, selection.from) : null;
      if (!link) return;
      wantFocus.current = true;
      show(link, "keys");
    };
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; selectionSet: boolean; getMeta(key: string): unknown } }) => {
      if (transaction.docChanged) {
        // Typing (or a collaborator's edit) never fights a card — and every position may have moved, so a
        // card on screen AND one still on its way (the hover delay) both go; the next caret move or hover
        // looks the link up afresh. Edit / Remove can never act on a stale range.
        hide();
        return;
      }
      if (!transaction.selectionSet) return;
      const { selection } = editor.state;
      const link = editor.isEditable && editor.isFocused && selection.empty ? linkAt(editor, selection.from) : null;
      if (link) show(link, "caret");
      else if (state.current && state.current.via !== "hover") hide();
    };
    const onScroll = () => { if (state.current) hide(); };
    const onBlur = () => window.setTimeout(() => { if (state.current?.via === "caret" && !overCard.current && !cardRef.current?.contains(document.activeElement)) hide(); }, 0);

    dom.addEventListener("mouseover", onOver);
    dom.addEventListener("mouseleave", onLeave);
    window.addEventListener("click", onClick, true);
    dom.addEventListener("keydown", onKey, true);
    dom.addEventListener("focusin", onFocusIn);
    dom.addEventListener("focusout", onFocusOut);
    dom.addEventListener(LINK_CARD_FOCUS_EVENT, onFocusCard);
    editor.on("transaction", onTransaction);
    editor.on("blur", onBlur);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      clear("show"); clear("hide");
      dom.removeEventListener("mouseover", onOver);
      dom.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("click", onClick, true);
      dom.removeEventListener("keydown", onKey, true);
      dom.removeEventListener("focusin", onFocusIn);
      dom.removeEventListener("focusout", onFocusOut);
      dom.removeEventListener(LINK_CARD_FOCUS_EVENT, onFocusCard);
      editor.off("transaction", onTransaction);
      editor.off("blur", onBlur);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, client]);

  if (!card) return null;
  const target = linkTarget(card.href);
  // Edit / Remove only where the person may change the document itself (not comment-only, not while suggesting).
  const editable = !!editor.schema.marks.link && structuralEditsAllowed(editor);
  const close = (refocus: boolean) => { overCard.current = false; setCard(null); if (refocus) editor.commands.focus(); };
  const edit = () => {
    const { from, to } = card;
    close(false);
    editor.chain().focus().setTextSelection({ from, to }).run();
    // The selection toolbar mounts for the new selection; then its inline link field opens.
    window.setTimeout(() => { try { editor.view.dom.dispatchEvent(new CustomEvent(EDIT_LINK_EVENT)); } catch { /* editor gone */ } }, 0);
  };
  const remove = () => {
    const { from, to } = card;
    close(false);
    editor.chain().focus().setTextSelection({ from, to }).unsetLink().setTextSelection(to).run();
  };
  const copy = () => {
    void navigator.clipboard?.writeText(card.href).then(() => setCopied(true), () => setCopied(false));
  };
  const label = target.kind === "page" ? "Open page" : "Open link";

  return createPortal(
    <div
      ref={cardRef}
      role="group"
      aria-label="Link"
      className="prism-link-card"
      data-via={card.via}
      style={{ left: card.left, top: card.top }}
      onMouseEnter={() => { overCard.current = true; window.clearTimeout(timers.current.hide); timers.current.hide = undefined; }}
      onMouseLeave={() => { overCard.current = false; if (card.via === "hover" && !cardRef.current?.contains(document.activeElement)) setCard(null); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); } }}
      onBlur={(e) => { if ((card.via === "keys" || card.via === "focus") && !e.currentTarget.contains(e.relatedTarget as Node | null)) setCard(null); }}
    >
      <span className="prism-link-card-url" title={card.href}>
        {target.kind === "page" ? <FileText size={13} aria-hidden="true" /> : null}
        {target.kind === "blocked" ? "This link can’t be opened" : card.href}
      </span>
      <button type="button" className="prism-link-card-action" disabled={target.kind === "blocked"} aria-label={label} title={label}
        onMouseDown={(e) => e.preventDefault()} onClick={() => { close(false); follow(target); }}>
        <ExternalLink size={14} aria-hidden="true" /> Open
      </button>
      {editable ? <>
        <button type="button" className="prism-link-card-action" aria-label="Edit link" title="Edit link" onMouseDown={(e) => e.preventDefault()} onClick={edit}>
          <Pencil size={14} aria-hidden="true" /> Edit
        </button>
        <button type="button" className="prism-link-card-action" aria-label="Remove link" title="Remove link" onMouseDown={(e) => e.preventDefault()} onClick={remove}>
          <Unlink size={14} aria-hidden="true" /> Remove
        </button>
      </> : (
        <button type="button" className="prism-link-card-action" aria-label="Copy link" title="Copy link" onMouseDown={(e) => e.preventDefault()} onClick={copy}>
          <Copy size={14} aria-hidden="true" /> {copied ? "Copied" : "Copy"}
        </button>
      )}
      <span className="sr-only" aria-live="polite">{copied ? "Link copied" : ""}</span>
    </div>,
    document.body,
  );
}
