/**
 * Open a database row without leaving the database (Notion's side peek and
 * center peek). The peek renders the row note through the SAME pipeline as a
 * tab — the live collaborative editor when the shell provides one, else the
 * note's registered renderer with the normal autosave — so the title,
 * properties (PropertyBar) and body edit exactly as on the full page.
 *
 * Esc closes it (unless an inner popover/editor consumed the key first); the
 * database underneath is never unmounted, so its scroll position is kept and
 * focus returns to the row that opened it.
 */
import { Suspense, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Maximize2, PanelRight, Square, X } from "lucide-react";
import { useNote, useUpdateNote } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { reviewMode } from "../../lib/governance/review";
import { isLocked } from "../../lib/pages/model";
import { noteLinkTitle } from "../../lib/wikilinks";
import { getRenderer } from "../renderers/Registry";
import { RendererBoundary } from "../layout/RendererBoundary";
import { useCollabDocumentSeam } from "../../data/CollabDocumentContext";
import type { OpenMode } from "./config";

const COLLAB_TYPES = new Set(["document", "task", "code", "spreadsheet", "canvas"]);

export function RowPeek({ noteId, mode, onMode, onClose, canSetMode }: {
  noteId: string;
  mode: Exclude<OpenMode, "page">;
  /** Switch layout (or "page" = open as a full page and close the peek). */
  onMode: (m: OpenMode) => void;
  onClose: () => void;
  canSetMode: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);
  const { data: note, isLoading, isError } = useNote(noteId);
  const { mutate: updateNote } = useUpdateNote();
  const collab = useCollabDocumentSeam();
  const contentType = note ? inferContentType(note) : null;
  const locked = isLocked(note);
  const live = collab.useLiveCollab(note && contentType && COLLAB_TYPES.has(contentType) ? note.id : "") && !!note && reviewMode(note) !== "propose" && !locked;
  const Renderer = contentType ? getRenderer(contentType) : null;
  const onSave = useCallback((content: string) => { if (note) updateNote({ id: note.id, content }); }, [note, updateNote]);
  const onMeta = useCallback((metadata: Record<string, unknown>) => { if (note) updateNote({ id: note.id, metadata }); }, [note, updateNote]);

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const back = returnTo.current;
    return () => { if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A popover (portaled to <body>) handles its own Escape first.
      if (document.querySelector(".db-popover")) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = note ? noteLinkTitle(note) : "Page";
  const openFull = () => {
    if (note) useUIStore.getState().openTab(note.id, title, contentType ?? "document");
    onClose();
  };
  const body = (
    <div className={`db-peek db-peek-${mode}`} role="dialog" aria-modal={mode === "center" || undefined} aria-label={`${title} (${mode === "side" ? "side peek" : "center peek"})`}>
      <div ref={panel} tabIndex={-1} className="db-peek-panel">
        <header className="db-peek-head">
          <button type="button" className="db-icon-btn" aria-label="Close peek" title="Close (Esc)" onClick={onClose}><X size={16} /></button>
          <div className="db-peek-modes" role="group" aria-label="Open pages in">
            <button type="button" className="db-icon-btn" aria-pressed={mode === "side"} title="Side peek" aria-label="Side peek" onClick={() => onMode("side")}><PanelRight size={15} /></button>
            <button type="button" className="db-icon-btn" aria-pressed={mode === "center"} title="Center peek" aria-label="Center peek" onClick={() => onMode("center")}><Square size={15} /></button>
            <button type="button" className="db-icon-btn" title="Full page" aria-label="Full page" onClick={() => { if (canSetMode) onMode("page"); openFull(); }}><Maximize2 size={15} /></button>
          </div>
          <button type="button" className="db-ghost" onClick={openFull}>Open as page</button>
        </header>
        <div className="db-peek-body">
          {isLoading ? <p className="db-state" role="status">Loading page…</p>
            : isError || !note ? <div className="db-state" role="alert"><h2>This page can’t be opened</h2><p>It may have been moved, removed, or your access changed.</p></div>
            : live ? (
              <RendererBoundary key={note.id}><collab.CollabDocument noteId={note.id} note={note} /></RendererBoundary>
            ) : Renderer ? (
              <RendererBoundary key={note.id}>
                <Suspense fallback={<p className="db-state" role="status">Loading page…</p>}>
                  <Renderer note={note} onSave={locked ? undefined : onSave} onMetadataChange={locked ? undefined : onMeta} readOnly={locked || undefined} />
                </Suspense>
              </RendererBoundary>
            ) : null}
        </div>
      </div>
      {mode === "center" && <div className="db-peek-scrim" aria-hidden="true" onClick={onClose} />}
    </div>
  );
  return typeof document === "undefined" ? body : createPortal(body, document.body);
}
