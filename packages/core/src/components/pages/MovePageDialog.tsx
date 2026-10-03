import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Folder, Home, Search, X } from "lucide-react";
import { useVaultTree } from "../../app/hooks/useParachute";
import { isProtectedPath, isUnder, leafName, pageTitle, parentOf } from "../../lib/pages/model";
import { usePageActions } from "../../lib/pages/usePageActions";
import type { PageRef } from "../../lib/pages/store";
import { MoveAccessNotice, useMoveAccessCheck } from "../sharing/MoveAccessNotice";
import "./pages.css";

interface Destination {
  path: string;
  label: string;
  crumb: string;
  kind: "page" | "folder" | "root";
}

/** Every place a page can move to: top level, each page (nest inside) and each folder. */
export function moveDestinations(entries: Array<{ path: string | null }>, page: PageRef): Destination[] {
  const pages = new Set<string>();
  const folders = new Set<string>();
  for (const e of entries) {
    if (!e.path) continue;
    pages.add(e.path);
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const self = page.path ?? "";
  const current = self ? parentOf(self) : null;
  const ok = (p: string) => p !== self && !isUnder(p, self) && p !== current && p !== "vault" && !isProtectedPath(p);
  const crumb = (p: string) => parentOf(p).replace(/^vault\/?/, "").split("/").filter(Boolean).join(" / ");
  const out: Destination[] = [];
  if (current !== "" && current !== "vault") out.push({ path: "", label: "Top level", crumb: "Workspace", kind: "root" });
  for (const p of new Set([...pages, ...folders])) {
    if (!ok(p)) continue;
    out.push({ path: p, label: pages.has(p) ? pageTitle(p) : leafName(p), crumb: crumb(p), kind: pages.has(p) ? "page" : "folder" });
  }
  return out.sort((a, b) => (a.kind === "root" ? -1 : b.kind === "root" ? 1 : a.path.localeCompare(b.path)));
}

/** "Move to…" picker: search every page and folder, then move the page (and its sub-pages) there. */
export function MovePageDialog({ page, onClose }: { page: PageRef; onClose: () => void }) {
  const { data: tree, isLoading } = useVaultTree();
  const actions = usePageActions();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    node?.showModal();
    input.current?.focus();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  // Callers without the path (command bar, top bar) get it from the tree.
  const located = useMemo(() => (page.path ? page : { ...page, path: tree?.find((t) => t.id === page.id)?.path ?? null }), [page, tree]);
  const all = useMemo(() => moveDestinations(tree ?? [], located), [tree, located]);
  const q = query.trim().toLowerCase();
  const visible = (q ? all.filter((d) => d.path.toLowerCase().includes(q) || d.label.toLowerCase().includes(q)) : all).slice(0, 60);
  // NP-CO-09: a move that changes who can open the page is confirmed first.
  const accessCheck = useMoveAccessCheck();
  const [confirm, setConfirm] = useState<Destination | null>(null);
  const choose = async (d: Destination, confirmed = false) => {
    if (pending) return;
    setPending(true);
    if (!confirmed && (await accessCheck(located.id, d.path))) {
      setPending(false);
      setConfirm(d);
      return;
    }
    const outcome = await actions.move(located, { parent: d.path });
    setPending(false);
    // A partial move closes too: the toast reports it and offers "Finish move".
    if (outcome) onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="page-dialog"
      aria-labelledby="move-page-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div className="page-dialog-inner">
        <div className="page-dialog-head">
          <div className="min-w-0">
            <h2 id="move-page-title">Move “{page.title}”</h2>
            <p>Its sub-pages move with it. Links to it keep working.</p>
          </div>
          <button type="button" className="page-dialog-close focus-ring" aria-label="Close move" disabled={pending} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label className="page-dialog-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            aria-label="Find a page or folder"
            role="combobox"
            aria-expanded="true"
            aria-controls="move-page-results"
            aria-activedescendant={visible[active] ? `move-dest-${active}` : undefined}
            placeholder="Move to a page or folder…"
            value={query}
            disabled={pending}
            onChange={(e) => {
              setQuery(e.target.value);
              setConfirm(null);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
              }
              if (e.key === "Enter" && visible[active]) {
                e.preventDefault();
                void choose(visible[active]);
              }
            }}
          />
        </label>
        <div id="move-page-results" role="listbox" aria-label="Destinations" className="page-dialog-list">
          {isLoading && <p className="page-dialog-empty">Loading pages…</p>}
          {!isLoading && !visible.length && (
            <div className="page-dialog-empty">
              <strong>No matching pages or folders</strong>
              Try another name.
            </div>
          )}
          {visible.map((d, i) => (
            <button
              key={d.path || "__root"}
              id={`move-dest-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className="page-dialog-row focus-ring"
              disabled={pending}
              onMouseEnter={() => setActive(i)}
              onClick={() => void choose(d)}
            >
              {d.kind === "root" ? <Home size={15} /> : d.kind === "page" ? <FileText size={15} /> : <Folder size={15} />}
              <span className="min-w-0 flex-1">
                <span className="label block">{d.label}</span>
                {d.crumb && <span className="crumb block">{d.crumb}</span>}
              </span>
            </button>
          ))}
        </div>
        {confirm && !pending && (
          <div className="page-dialog-foot page-move-confirm" style={{ display: "grid", gap: 8 }}>
            <MoveAccessNotice noteId={located.id} parentPath={confirm.path} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="focus-ring" style={{ minHeight: 36, padding: "0 12px", borderRadius: 8, border: "1px solid var(--glass-border)", background: "transparent", color: "var(--text-primary)", font: "inherit", cursor: "pointer" }} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="focus-ring" style={{ minHeight: 36, padding: "0 12px", borderRadius: 8, border: "1px solid var(--color-accent)", background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)", font: "inherit", fontWeight: 600, cursor: "pointer" }} onClick={() => void choose(confirm, true)}>
                Move to {confirm.label} anyway
              </button>
            </div>
          </div>
        )}
        {pending && <div className="page-dialog-foot" role="status">Moving…</div>}
      </div>
    </dialog>
  );
}
