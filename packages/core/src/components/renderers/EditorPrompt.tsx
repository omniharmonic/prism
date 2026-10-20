import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Bookmark as BookmarkIcon, Image as ImageIcon, Link2, PlayCircle, Unlink } from "lucide-react";
import { EDITOR_PROMPT_EVENT, imageAddress, webAddress, type EditorPromptKind, type EditorPromptRequest } from "../../lib/tiptap/editorPrompt";
import { editorUnfurler, insertLinkBlock } from "../../lib/tiptap/UrlPaste";
import { safeWebUrl } from "../../lib/media/embeds";
import { normalizeLink } from "./SelectionActions";
import { useCoarsePointer } from "./KeyboardToolbar";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import "./editor-blocks.css";
import "./FormattingBar.css";

const COPY: Record<EditorPromptKind, { title: string; placeholder: string; submit: string; invalid: string; icon: React.ReactNode }> = {
  image: { title: "Image address", placeholder: "https://…", submit: "Insert image", invalid: "Enter the image’s web address (https://…).", icon: <ImageIcon size={15} aria-hidden="true" /> },
  embed: { title: "Link to embed", placeholder: "YouTube, Vimeo, Loom, Figma, Google Docs, Spotify…", submit: "Embed", invalid: "Enter a web address (https://…).", icon: <PlayCircle size={15} aria-hidden="true" /> },
  bookmark: { title: "Link for the bookmark", placeholder: "https://…", submit: "Add bookmark", invalid: "Enter a web address (https://…).", icon: <BookmarkIcon size={15} aria-hidden="true" /> },
  link: { title: "Link address", placeholder: "Paste or type a link…", submit: "Apply", invalid: "Use a web, mail or page link.", icon: <Link2 size={15} aria-hidden="true" /> },
};

/**
 * The in-app address field behind Embed, Web bookmark, Image from URL and the toolbar's Link /
 * Image (see `lib/tiptap/editorPrompt.ts` for why it is not `window.prompt`). Mounted once per
 * editor, plain and live. Desktop: a small popover under the caret. Touch / phone: docked on the
 * keyboard like the comment composer (`.prism-docked-composer`). Enter applies, Esc cancels and
 * puts the caret back where it was; nothing is inserted on cancel or on an address that fails
 * the same rules the old prompts used.
 */
export function EditorPrompt({ editor }: { editor: Editor }) {
  const [request, setRequest] = useState<EditorPromptRequest | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const range = useRef<{ from: number; to: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const fieldId = useId();
  const errorId = useId();
  const coarse = useCoarsePointer();
  const phone = useIsMobile();
  const docked = coarse || phone;

  // Requests arrive on the editor's own element; the place is tracked from that moment on.
  useEffect(() => {
    let dom: HTMLElement;
    try { dom = editor.view.dom; } catch { return; }
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ request: EditorPromptRequest; handled: boolean }>).detail;
      if (!detail?.request) return;
      detail.handled = true;
      range.current = { from: detail.request.from, to: detail.request.to };
      setValue(detail.request.value ?? "");
      setError("");
      setRequest(detail.request);
    };
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; mapping: { map: (pos: number, assoc?: number) => number } } }) => {
      const r = range.current;
      if (!r || !transaction.docChanged) return;
      if (r.from === r.to) { const at = transaction.mapping.map(r.from, 1); range.current = { from: at, to: at }; return; }
      const from = transaction.mapping.map(r.from, 1);
      range.current = { from, to: Math.max(from, transaction.mapping.map(r.to, -1)) };
    };
    const onDestroy = () => { range.current = null; setRequest(null); };
    dom.addEventListener(EDITOR_PROMPT_EVENT, onRequest);
    editor.on("transaction", onTransaction);
    editor.on("destroy", onDestroy);
    return () => {
      dom.removeEventListener(EDITOR_PROMPT_EVENT, onRequest);
      editor.off("transaction", onTransaction);
      editor.off("destroy", onDestroy);
    };
  }, [editor]);

  // The field takes the caret in the same task as the tap that opened it (a phone keeps its keyboard up).
  useLayoutEffect(() => {
    if (!request) return;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [request]);

  /** The tracked place, clamped to the document as it is now. */
  const place = useCallback(() => {
    const size = editor.state.doc.content.size;
    const r = range.current ?? { from: editor.state.selection.from, to: editor.state.selection.to };
    const from = Math.max(0, Math.min(r.from, size));
    return { from, to: Math.max(from, Math.min(r.to, size)) };
  }, [editor]);

  const close = useCallback((restore: boolean) => {
    const at = editor.isDestroyed ? null : place();
    range.current = null;
    setRequest(null);
    if (restore && at) {
      // The caret returns NOW (TipTap's own focus waits a frame): a phone keeps its keyboard up, and
      // what is typed straight after Esc goes into the page.
      try { editor.view.focus(); editor.chain().setTextSelection(at).focus(undefined, { scrollIntoView: false }).run(); } catch { editor.commands.focus(); }
    }
  }, [editor, place]);

  // A press outside the field cancels it (the press itself decides where the focus goes).
  useEffect(() => {
    if (!request) return;
    const onDown = (event: PointerEvent) => { if (!form.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [request, close]);

  if (!request) return null;
  const copy = COPY[request.kind];

  const submit = () => {
    if (editor.isDestroyed) return close(false);
    const at = place();
    const kind = request.kind;
    if (kind === "link") {
      if (!value.trim() && request.value) return removeLink();
      const href = normalizeLink(value);
      if (!href) return setError(copy.invalid);
      const chain = editor.chain().focus().setTextSelection(at);
      if (at.from === at.to && editor.state.doc.resolve(at.from).marks().some((m) => m.type.name === "link")) chain.extendMarkRange("link").setLink({ href }).run();
      else if (at.from === at.to) chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
      else chain.setLink({ href }).run();
      range.current = null; setRequest(null);
      return;
    }
    if (kind === "image") {
      const src = imageAddress(value);
      if (!src) return setError(copy.invalid);
      editor.chain().focus().setTextSelection(at.from).setImage({ src }).run();
      range.current = null; setRequest(null);
      return;
    }
    // Embed / bookmark: the same rule as a pasted link (`safeWebUrl`); an address no embed
    // provider recognises becomes a bookmark, exactly as before.
    const url = safeWebUrl(webAddress(value));
    if (!url) return setError(copy.invalid);
    editor.chain().focus().setTextSelection(at.from).run();
    if (!insertLinkBlock(editor, url, kind, editorUnfurler(editor))) return setError(copy.invalid);
    range.current = null; setRequest(null);
  };
  const removeLink = () => {
    const at = place();
    editor.chain().focus().setTextSelection(at).extendMarkRange("link").unsetLink().run();
    range.current = null; setRequest(null);
  };

  let style: React.CSSProperties | undefined;
  if (!docked) {
    let coords: { left: number; bottom: number } | null = null;
    try { coords = editor.view.coordsAtPos(place().to); } catch { coords = null; }
    const width = Math.min(360, window.innerWidth - 16);
    const left = coords ? coords.left : (window.innerWidth - width) / 2;
    const top = coords ? coords.bottom + 8 : window.innerHeight * 0.2;
    style = { position: "fixed", zIndex: 70, width, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - 150)) };
  }

  return createPortal(
    <form
      ref={form}
      role="dialog"
      aria-label={copy.title}
      noValidate
      className={docked ? "prism-editor-prompt prism-docked-composer" : "prism-editor-prompt"}
      data-kind={request.kind}
      style={style}
      onSubmit={(event) => { event.preventDefault(); submit(); }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }}
    >
      <label htmlFor={fieldId} className="prism-editor-prompt-label">{copy.icon}{copy.title}</label>
      <div className="prism-editor-prompt-row">
        <input
          id={fieldId}
          ref={input}
          type="text"
          inputMode="url"
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={copy.placeholder}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => { setValue(event.target.value); setError(""); }}
        />
        {request.kind === "link" && request.value && (
          <button type="button" className="prism-editor-prompt-icon focus-ring" aria-label="Remove link" title="Remove link" onClick={removeLink}><Unlink size={15} aria-hidden="true" /></button>
        )}
      </div>
      {error && <p id={errorId} role="alert" className="prism-editor-prompt-error">{error}</p>}
      <div className="prism-editor-prompt-actions">
        <button type="button" className="focus-ring" onClick={() => close(true)}>Cancel</button>
        <button type="submit" className="prism-editor-prompt-primary focus-ring">{copy.submit}</button>
      </div>
    </form>,
    document.body,
  );
}
