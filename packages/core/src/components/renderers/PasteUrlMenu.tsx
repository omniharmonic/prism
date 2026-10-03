import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { AtSign, Link2, Bookmark as BookmarkIcon, PlayCircle } from "lucide-react";
import { embedFor } from "../../lib/media/embeds";
import {
  applyUnfurl, convertPastedUrl, dismissUrlPaste, titlePastedUrl,
  type UnfurlResult, type Unfurler, type UrlPasteState,
} from "../../lib/tiptap/UrlPaste";
import "./editor-blocks.css";

type Choice = "mention" | "url" | "bookmark" | "embed";

/**
 * The "Paste as" menu shown right after a bare URL is pasted (NP-ED-14).
 * The URL is already in the document as a link; Esc / typing / clicking away
 * keeps it that way. Keyboard: ↑/↓, Enter, Esc — the editor keeps focus.
 */
export function PasteUrlMenu({ editor, state, unfurl, onClose }: { editor: Editor; state: UrlPasteState; unfurl?: Unfurler; onClose: () => void }) {
  const listId = useId();
  const embed = useMemo(() => embedFor(state.url), [state.url]);
  const options = useMemo(() => {
    const out: Array<{ id: Choice; label: string; hint: string; icon: React.ReactNode }> = [];
    if (unfurl) out.push({ id: "mention", label: "Mention", hint: "Link with the page title", icon: <AtSign size={15} /> });
    out.push({ id: "url", label: "URL", hint: "Keep the link as pasted", icon: <Link2 size={15} /> });
    out.push({ id: "bookmark", label: "Bookmark", hint: "Card with title, description and image", icon: <BookmarkIcon size={15} /> });
    if (embed) out.push({ id: "embed", label: `Embed ${embed.label}`, hint: "Show it in the page", icon: <PlayCircle size={15} /> });
    return out;
  }, [embed, unfurl]);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.id === "url")));
  const [busy, setBusy] = useState(false);

  const choose = (id: Choice) => {
    if (id === "url") { dismissUrlPaste(editor); onClose(); return; }
    if (id === "embed") { convertPastedUrl(editor, state, "embed"); onClose(); return; }
    if (id === "bookmark") {
      const url = state.url;
      if (convertPastedUrl(editor, state, "bookmark") && unfurl) {
        void unfurl(url).then((d: UnfurlResult) => applyUnfurl(editor, url, d)).catch(() => {});
      }
      onClose();
      return;
    }
    if (id === "mention" && unfurl) {
      setBusy(true);
      void unfurl(state.url)
        .then((d) => { if (d.title) titlePastedUrl(editor, state, d.title); else dismissUrlPaste(editor); })
        .catch(() => dismissUrlPaste(editor))
        .finally(() => onClose());
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === "ArrowDown") { stop(); setActive((i) => (i + 1) % options.length); }
      else if (e.key === "ArrowUp") { stop(); setActive((i) => (i - 1 + options.length) % options.length); }
      else if (e.key === "Enter") { stop(); choose(options[active].id); }
      else if (e.key === "Escape") { stop(); dismissUrlPaste(editor); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, active, state]);

  let coords: { left: number; bottom: number };
  try { coords = editor.view.coordsAtPos(state.to); } catch { return null; }
  const width = Math.min(260, window.innerWidth - 16);
  return createPortal(
    <div
      id={listId}
      role="listbox"
      aria-label="Paste as"
      className="editor-menu prism-paste-menu"
      style={{ position: "fixed", top: Math.min(coords.bottom + 6, window.innerHeight - 220), left: Math.max(8, Math.min(coords.left, window.innerWidth - width - 8)), width, zIndex: 70 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="editor-menu-section" role="presentation">{busy ? "Fetching title…" : "Paste as"}</div>
      {options.map((o, i) => (
        <div
          key={o.id}
          role="option"
          aria-selected={i === active}
          data-active={i === active || undefined}
          className="editor-menu-item prism-paste-option"
          onMouseMove={() => setActive(i)}
          onClick={() => choose(o.id)}
        >
          <span className="slash-menu-icon" aria-hidden="true">{o.icon}</span>
          <span className="slash-menu-text">
            <span className="slash-menu-title">{o.label}</span>
            <span className="slash-menu-subtitle">{o.hint}</span>
          </span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
