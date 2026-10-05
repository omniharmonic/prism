import React, { Suspense, useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import type { EmojiClickData, EmojiStyle, SkinTones, Theme } from "emoji-picker-react";
import { dismissEmojiSuggest, type EmojiSuggestState } from "./EmojiSuggest";
import { emojiChar, emojiSet, emojiTone, onEmojiSetChange, rememberEmoji, rememberEmojiTone, searchEmoji, type EmojiEntry } from "./emojiData";
import { describeEditorPopup } from "./popupAria";
import "./emoji.css";

// The full picker (and its megabyte of UI + data) loads only when somebody opens it.
const LazyEmojiPicker = React.lazy(() => import("emoji-picker-react"));
const FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/** Lowest y a popup may reach: the visible viewport, less the phone keyboard toolbar when it is up. */
function bottomLimit(): number {
  const vv = window.visualViewport;
  let limit = vv ? Math.min(window.innerHeight, vv.offsetTop + vv.height) : window.innerHeight;
  const bar = document.querySelector(".keyboard-toolbar");
  if (bar) { const top = bar.getBoundingClientRect().top; if (top > 0) limit = Math.min(limit, top); }
  return limit;
}

function insertEmoji(editor: Editor, from: number, to: number, char: string): void {
  const view = editor.view;
  const size = view.state.doc.content.size;
  view.dispatch(view.state.tr.insertText(char, Math.min(from, size), Math.min(to, size)).scrollIntoView());
  view.focus();
}

/**
 * The inline emoji list (`:` + two characters) and the full picker (`/emoji`).
 * Same listbox contract as the `@` menu: focus stays in the text, the active
 * option is named through `aria-activedescendant`.
 */
export function EmojiMenu({ editor, state, picker, onClosePicker }: { editor: Editor; state: EmojiSuggestState; picker: boolean; onClosePicker: () => void }) {
  const id = useId();
  const set = useSyncExternalStore(onEmojiSetChange, emojiSet, emojiSet);
  const items = useMemo(() => (state.active ? searchEmoji(state.query, 8, set) : []), [state.active, state.query, set]);
  const signature = `${state.from}:${state.query}`;
  const [sel, setSel] = useState({ signature: "", index: 0 });
  const index = sel.signature === signature ? Math.min(sel.index, Math.max(0, items.length - 1)) : 0;
  const visible = state.active && items.length > 0 && !editor.isDestroyed;

  const choose = useCallback((entry: EmojiEntry) => {
    insertEmoji(editor, state.from, state.to, emojiChar(entry));
    rememberEmoji(entry.u);
  }, [editor, state.from, state.to]);

  useEffect(() => {
    if (!visible) return;
    const el = editor.view.dom;
    const undescribe = describeEditorPopup(el, id, `${id}-${index}`);
    const keydown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const next = (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        setSel({ signature, index: next });
        document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.metaKey && !e.ctrlKey && items[index]) {
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(items[index]!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismissEmojiSuggest(editor, state.from);
        editor.view.dispatch(editor.state.tr); // re-run the trigger → closes; the typed text stays
      }
    };
    el.addEventListener("keydown", keydown, true);
    return () => { el.removeEventListener("keydown", keydown, true); undescribe(); };
  }, [editor, visible, id, index, items, choose, signature, state.from]);

  let list: React.ReactNode = null;
  if (visible) {
    let coords: { left: number; top: number; bottom: number } | null = null;
    try { coords = editor.view.coordsAtPos(Math.min(state.to, editor.state.doc.content.size)); } catch { coords = null; }
    if (coords) {
      const limit = bottomLimit();
      const width = Math.min(300, window.innerWidth - 16);
      const height = Math.min(items.length * 40 + 8, 328, Math.max(120, limit - 16));
      const top = coords.bottom + height + 6 > limit ? Math.max(8, coords.top - height - 6) : coords.bottom + 6;
      list = (
        <div id={id} role="listbox" aria-label="Emoji" className="prism-emoji-menu glass-elevated"
          style={{ left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)), top, width, maxHeight: height }}>
          {items.map((entry, i) => (
            <button key={entry.u} id={`${id}-${i}`} type="button" role="option" aria-selected={i === index} tabIndex={-1}
              className="prism-emoji-option" data-emoji={entry.c}
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (i !== index) setSel({ signature, index: i }); }} onClick={() => choose(entry)}>
              <span className="prism-emoji-glyph" aria-hidden="true" style={{ fontFamily: FONT }}>{emojiChar(entry)}</span>
              <span className="prism-emoji-name">:{entry.s[0] ?? entry.k[0]}:</span>
            </button>
          ))}
        </div>
      );
    }
  }
  return <>{list}{picker && !editor.isDestroyed && <EmojiPicker editor={editor} onClose={onClosePicker} />}</>;
}

/** The full picker at the caret. Picks insert at the selection; the skin tone chosen here is remembered. */
function EmojiPicker({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [place] = useState(() => {
    let coords = { left: 80, top: 80, bottom: 100 };
    try { coords = editor.view.coordsAtPos(editor.state.selection.from); } catch { /* keep the default */ }
    const limit = bottomLimit();
    const width = Math.min(336, window.innerWidth - 16);
    const height = Math.min(400, Math.max(240, limit - 16));
    const top = coords.bottom + height + 6 > limit ? Math.max(8, coords.top - height - 6) : coords.bottom + 6;
    return { left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)), top, width, height };
  });
  const isLight = document.documentElement.classList.contains("light");
  const close = useCallback(() => { onClose(); if (!editor.isDestroyed) editor.view.focus(); }, [onClose, editor]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);
  return (
    <>
      <div className="prism-emoji-picker-backdrop" onMouseDown={(e) => { e.preventDefault(); close(); }} />
      <div className="prism-emoji-picker" role="dialog" aria-label="Emoji picker" style={{ left: place.left, top: place.top }}>
        <Suspense fallback={<div className="prism-emoji-picker-loading" style={{ width: place.width, height: 200 }}>Loading emoji…</div>}>
          <LazyEmojiPicker
            onEmojiClick={(d: EmojiClickData) => {
              rememberEmojiTone(String(d.activeSkinTone));
              rememberEmoji(d.unified);
              const { from, to } = editor.state.selection;
              onClose();
              insertEmoji(editor, from, to, d.emoji);
            }}
            defaultSkinTone={(emojiTone() ?? "neutral") as SkinTones}
            emojiStyle={"native" as EmojiStyle}
            theme={(isLight ? "light" : "dark") as Theme}
            lazyLoadEmojis
            autoFocusSearch
            width={place.width}
            height={place.height}
            previewConfig={{ showPreview: false }}
            searchPlaceHolder="Search emoji"
          />
        </Suspense>
      </div>
    </>
  );
}
