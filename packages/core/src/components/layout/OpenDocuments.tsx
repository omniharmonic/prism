import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Search,
  X,
} from "lucide-react";
import { useUIStore } from "../../app/stores/ui";

/** A keyboard/touch alternative to scrolling and dragging the desktop tab strip. */
export function OpenDocuments() {
  const { openTabs, activeTabId, setActiveTab, closeTab, reorderTabs } =
    useUIStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const filtered = openTabs.filter((tab) =>
    tab.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!node || !rect) return;
      node.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 100)}px`;
      node.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
      node.style.maxHeight = `${Math.max(80, window.innerHeight - rect.bottom - 24)}px`;
    };
    position();
    node?.showModal();
    search.current?.focus();
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      node?.close();
      trigger.current?.focus({ preventScroll: true });
    };
  }, [open]);
  const move = (id: string, direction: -1 | 1, control: HTMLButtonElement) => {
    const index = openTabs.findIndex((tab) => tab.id === id);
    const target = openTabs[index + direction];
    if (!target) return;
    reorderTabs(id, target.id);
    requestAnimationFrame(() => {
      if (control.isConnected && control.disabled)
        control.parentElement
          ?.querySelector<HTMLButtonElement>(
            "button[aria-current], button:first-child",
          )
          ?.focus();
    });
    setAnnouncement(
      `${openTabs[index].title} moved to position ${index + direction + 1} of ${openTabs.length}.`,
    );
  };
  return (
    <>
      <button
        ref={trigger}
        className="interactive focus-ring flex shrink-0 items-center gap-1 px-2"
        style={{
          height: 32,
          color: "var(--text-secondary)",
          fontSize: "var(--text-xs)",
        }}
        aria-label={`Open documents (${openTabs.length})`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Open documents"
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
      >
        <span>{openTabs.length} {openTabs.length === 1 ? "tab" : "tabs"}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <dialog
          ref={dialog}
          aria-labelledby="open-documents-title"
          className="p-0 backdrop:bg-transparent"
          style={{
            position: "fixed",
            margin: 0,
            left: "auto",
            width: 420,
            maxWidth: "calc(100vw - 16px)",
            border: "1px solid var(--glass-border)",
            borderRadius: 12,
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            boxShadow: "0 16px 48px rgba(0,0,0,.2)",
            overflow: "hidden",
          }}
          onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled)",
              ),
            ).filter((node) => node.getClientRects().length);
            if (!controls.length) return;
            event.preventDefault();
            const index = controls.indexOf(
              document.activeElement as HTMLElement,
            );
            controls[
              (index + (event.shiftKey ? -1 : 1) + controls.length) %
                controls.length
            ]?.focus();
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              maxHeight: "inherit",
            }}
          >
            <div className="flex shrink-0 items-center justify-between px-4 pt-2">
              <h2 id="open-documents-title" className="text-sm font-medium">
                Open documents{" "}
                <span style={{ color: "var(--text-muted)" }}>
                  · {openTabs.length}
                </span>
              </h2>
              <button
                className="interactive focus-ring flex h-11 w-11 items-center justify-center"
                aria-label="Close open documents"
                onClick={() => setOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <label
              className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-lg border px-3"
              style={{
                borderColor: "var(--glass-border)",
                color: "var(--text-muted)",
              }}
            >
              <Search size={16} />
              <input
                ref={search}
                aria-label="Find an open document"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find an open document…"
                className="min-w-0 flex-1 bg-transparent outline-none"
                style={{
                  height: 44,
                  color: "var(--text-primary)",
                  fontSize: 14,
                }}
              />
            </label>
            <ul
              className="m-0 min-h-0 list-none overflow-y-auto p-2"
              aria-label="Open document list"
            >
              {filtered.map((tab) => {
                const index = openTabs.findIndex((item) => item.id === tab.id);
                const active = tab.id === activeTabId;
                return (
                  <li
                    key={tab.id}
                    data-document-id={tab.noteId}
                    className="flex items-center rounded-lg"
                    style={{
                      background: active ? "var(--surface-active)" : undefined,
                    }}
                  >
                    <button
                      className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-3 text-left"
                      style={{ minHeight: 44 }}
                      aria-label={`Open ${tab.title}`}
                      aria-current={active ? "page" : undefined}
                      onClick={() => {
                        setActiveTab(tab.id);
                        setOpen(false);
                      }}
                    >
                      <span
                        className="flex w-4 shrink-0 justify-center"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {active ? <Check size={15} /> : null}
                      </span>
                      <span
                        className="min-w-0 break-words"
                        style={{
                          fontSize: "var(--text-sm)",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {tab.title}
                        {tab.isDirty && (
                          <span
                            className="ml-2 text-xs"
                            style={{ color: "var(--text-muted)" }}
                          >
                            Unsaved
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      className="interactive focus-ring flex h-11 w-11 shrink-0 items-center justify-center disabled:opacity-30"
                      aria-label={`Move ${tab.title} earlier`}
                      title="Move earlier"
                      disabled={index === 0}
                      onClick={(event) => move(tab.id, -1, event.currentTarget)}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      className="interactive focus-ring flex h-11 w-11 shrink-0 items-center justify-center disabled:opacity-30"
                      aria-label={`Move ${tab.title} later`}
                      title="Move later"
                      disabled={index === openTabs.length - 1}
                      onClick={(event) => move(tab.id, 1, event.currentTarget)}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      className="interactive focus-ring flex h-11 w-11 shrink-0 items-center justify-center"
                      aria-label={`Close ${tab.title}`}
                      title="Close document"
                      onClick={() => {
                        closeTab(tab.id);
                        setAnnouncement(`${tab.title} closed.`);
                        search.current?.focus();
                      }}
                    >
                      <X size={15} />
                    </button>
                  </li>
                );
              })}
              {!filtered.length && (
                <li
                  className="px-3 py-6 text-center text-sm"
                  style={{ color: "var(--text-muted)" }}
                >
                  {openTabs.length
                    ? "No open documents match."
                    : "No documents open."}
                </li>
              )}
            </ul>
            <p
              className="m-0 shrink-0 border-t px-4 py-3 text-xs"
              style={{
                borderColor: "var(--glass-border)",
                color: "var(--text-muted)",
              }}
            >
              Reorder here, or use Alt + Shift + ← / → on a tab.
            </p>
            <span className="sr-only" role="status">
              {announcement}
            </span>
          </div>
        </dialog>
      )}
    </>
  );
}
