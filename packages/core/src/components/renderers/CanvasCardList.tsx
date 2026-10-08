import { useCallback, useRef, useState, type RefObject } from "react";
import type { Note } from "../../lib/types";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { findNoteElement } from "./canvas-cards";
import { ExternalLink, FileText, List, X } from "lucide-react";

export interface CanvasCard {
  id: string;
  title: string;
  path: string;
}
export function canvasCards(elements: readonly any[]): CanvasCard[] {
  const cards = new Map<string, CanvasCard>();
  for (const el of elements) {
    const id = el.customData?.prismNoteId;
    if (el.type !== "rectangle" || el.isDeleted || typeof id !== "string")
      continue;
    const path =
      typeof el.customData?.prismNotePath === "string"
        ? el.customData.prismNotePath
        : "";
    const label =
      typeof el.customData?.prismTitle === "string"
        ? el.customData.prismTitle
        : "";
    cards.set(id, {
      id,
      path,
      title: label || path.split("/").pop() || "Untitled card",
    });
  }
  return [...cards.values()];
}
export function CanvasCardList({
  cards,
  onOpen,
  onFocus,
  onClose,
}: {
  cards: CanvasCard[];
  onOpen: (id: string) => Promise<void>;
  onFocus: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(50);
  const rows = cards.filter((c) =>
    `${c.title} ${c.path}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const button =
    "focus-ring flex min-h-control items-center gap-2 rounded-lg px-3 py-1.5 text-sm hover:bg-[var(--glass-hover)] disabled:opacity-40";
  async function open(id: string) {
    if (busy) return;
    setBusy(id);
    setError("");
    try {
      await onOpen(id);
    } catch {
      setError("This note is unavailable or your access changed.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <aside
      aria-label="Notes on canvas"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="prism-canvas-drawer absolute inset-0 z-20 flex min-w-0 flex-col border-r border-[var(--glass-border)] bg-[var(--bg-surface)] sm:static sm:w-80 sm:shrink-0"
    >
      <header className="flex items-center justify-between gap-2 p-3">
        <h2 className="text-sm font-medium">
          Notes on canvas · {cards.length}
        </h2>
        <button
          type="button"
          className={button}
          aria-label="Close card list"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="px-4 pb-3">
        <p className="mb-3 text-xs text-[var(--text-muted)]">
          Card titles are saved copies. Opening a note checks your current
          access.
        </p>
        <input
          autoFocus
          aria-label="Find a card"
          placeholder="Find a card…"
          className="focus-ring min-h-control w-full rounded-lg border border-[var(--glass-border)] bg-transparent px-3 text-base"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(50);
          }}
        />
      </div>
      {error && (
        <p role="alert" className="px-4 pb-3 text-sm">
          {error}
        </p>
      )}
      <ul className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {rows.slice(0, limit).map((c) => (
          <li key={c.id} className="prism-canvas-list-card border-t border-[var(--glass-border)] py-2">
            <div className="prism-canvas-card-heading px-2 py-1"><FileText aria-hidden="true" size={17} className="prism-canvas-note-icon"/><div>
              <p className="break-words text-sm font-medium">{c.title}</p>
              <p className="break-all text-xs text-[var(--text-muted)]">
                {c.path}
              </p>
            </div></div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                className={button}
                onClick={() => onFocus(c.id)}
                aria-label={`Find ${c.title} on canvas`}
              >
                Find on canvas
              </button>
              <button
                type="button"
                className={button}
                disabled={!!busy}
                onClick={() => void open(c.id)}
                aria-label={`Open ${c.title}`}
              >
                <ExternalLink size={14} />
                {busy === c.id ? "Opening…" : "Open note"}
              </button>
            </div>
          </li>
        ))}
        {!rows.length && (
          <li className="p-3 text-sm text-[var(--text-muted)]">
            No matching cards
          </li>
        )}
        {rows.length > limit && (
          <li>
            <button
              type="button"
              className={button}
              onClick={() => setLimit((v) => v + 50)}
            >
              Show more cards
            </button>
          </li>
        )}
      </ul>
    </aside>
  );
}

/** Identical navigation for collaborative and saved scenes, including viewers. */
export function useCanvasCardNavigation(
  apiRef: RefObject<{
    getSceneElements: () => readonly any[];
    scrollToContent: (elements?: readonly any[]) => void;
  } | null>,
  read: (id: string) => Promise<Note>,
  closePicker: () => void,
) {
  const [showCards, setShowCards] = useState(false);
  const [cards, setCards] = useState<CanvasCard[]>([]);
  const button = useRef<HTMLButtonElement>(null);
  const updateCards = useCallback((elements: readonly any[]) => {
    const next = canvasCards(elements);
    setCards((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, []);
  const close = () => {
    setShowCards(false);
    button.current?.focus();
  };
  const cardList = showCards ? (
    <CanvasCardList
      cards={cards}
      onClose={close}
      onOpen={async (id) => {
        const note = await read(id);
        const title =
          (typeof note.metadata?.title === "string" && note.metadata.title) ||
          note.path?.split("/").pop() ||
          "Untitled";
        useUIStore.getState().openTab(note.id, title, inferContentType(note));
      }}
      onFocus={(id) => {
        const api = apiRef.current;
        const element = api && findNoteElement(api.getSceneElements(), id);
        if (element) api.scrollToContent([element]);
        close();
      }}
    />
  ) : null;
  const browseCards = (
    <button
      ref={button}
      type="button"
      aria-expanded={showCards}
      className="focus-ring flex min-h-control items-center gap-2 rounded-lg px-3 py-1.5 text-xs hover:bg-[var(--glass-hover)]"
      onClick={() => {
        setShowCards((v) => !v);
        closePicker();
      }}
    >
      <List aria-hidden="true" size={15}/>Browse cards
    </button>
  );
  return {
    updateCards,
    cardList,
    browseCards,
    close: () => setShowCards(false),
  };
}
