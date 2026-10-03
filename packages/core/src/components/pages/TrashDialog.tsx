import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search, Trash2, X } from "lucide-react";
import { useDebounce } from "use-debounce";
import { useVaultClient } from "../../data/VaultClientContext";
import { listTrash, pageErrorText } from "../../lib/pages/ops";
import { usePageActions } from "../../lib/pages/usePageActions";
import type { TrashItem } from "../../lib/pages/model";
import { useSwipeActions } from "../../lib/gestures/useSwipeActions";
import { usePullToRefresh } from "../../lib/gestures/usePullToRefresh";
import "./pages.css";

const when = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Trash: search, restore, or delete for good (a second, explicit confirmation). */
export function TrashDialog({ onClose }: { onClose: () => void }) {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  const actions = usePageActions();
  const [query, setQuery] = useState("");
  const [debounced] = useDebounce(query.trim(), 200);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trash = useQuery({
    queryKey: ["vault", "trash", debounced],
    queryFn: () => listTrash(client, debounced),
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    node?.showModal();
    // Not on touch devices: focusing the field there only raises the keyboard over the list.
    if (!window.matchMedia?.("(pointer: coarse)").matches) input.current?.focus();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const act = async (item: TrashItem, kind: "restore" | "delete") => {
    setBusy(item.id);
    const page = { id: item.id, path: item.path, title: item.title };
    const ok = kind === "restore" ? await actions.restore(page) : await actions.deleteForever(page);
    setBusy(null);
    setConfirming(null);
    if (ok) await queryClient.invalidateQueries({ queryKey: ["vault", "trash"] });
  };
  const items = trash.data?.items ?? [];
  // Phone: pull the list down to refetch it; the Refresh button does the same.
  const pull = usePullToRefresh<HTMLDivElement>({ onRefresh: () => trash.refetch(), label: "Trash" });
  return (
    <dialog
      ref={dialog}
      className="page-dialog"
      aria-labelledby="trash-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="page-dialog-inner">
        <div className="page-dialog-head">
          <div className="min-w-0">
            <h2 id="trash-title">Trash</h2>
            <p>Restore a page with everything that was inside it.</p>
          </div>
          <button type="button" className="page-dialog-close focus-ring" aria-label="Refresh the Trash" title="Refresh" aria-busy={pull.refreshing || undefined} disabled={pull.refreshing} onClick={pull.refresh} style={{ marginLeft: "auto" }}>
            <RefreshCw size={16} />
          </button>
          <button type="button" className="page-dialog-close focus-ring" aria-label="Close Trash" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label className="page-dialog-search">
          <Search size={15} aria-hidden="true" />
          <input ref={input} aria-label="Search the Trash" placeholder="Search pages in Trash…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="page-dialog-list" aria-label="Pages in Trash" role="list" ref={pull.ref} style={{ overflowX: "hidden" }}>
          {pull.indicator}
          {trash.isLoading && <p className="page-dialog-empty">Loading the Trash…</p>}
          {trash.isError && (
            <div role="alert" className="page-dialog-empty">
              <strong>Couldn’t open the Trash</strong>
              {pageErrorText(trash.error, "Check your connection and try again.")}{" "}
              <button type="button" className="underline" onClick={() => void trash.refetch()}>
                Try again
              </button>
            </div>
          )}
          {trash.isSuccess && !items.length && (
            <div className="page-dialog-empty">
              <Trash2 size={22} style={{ margin: "0 auto 10px", color: "var(--text-muted)" }} aria-hidden="true" />
              <strong>{debounced ? "No matching pages" : "Trash is empty"}</strong>
              {debounced ? "Try another name." : "Pages you delete stay here until you restore them or delete them for good."}
            </div>
          )}
          {items.map((item) => (
            <TrashRow key={item.id} item={item} busy={busy === item.id} onRestore={() => void act(item, "restore")}>
              <div className="trash-row-main">
                <div className="label">{item.title}</div>
                <div className="crumb">
                  {(item.path ?? "").replace(/^vault\//, "").split("/").slice(0, -1).join(" / ") || "Workspace"}
                  {item.descendants ? ` · ${item.descendants} page${item.descendants === 1 ? "" : "s"} inside` : ""}
                  {item.trashedAt ? ` · deleted ${when(item.trashedAt)}` : ""}
                </div>
              </div>
              {confirming === item.id ? (
                <>
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Delete forever?</span>
                  <button type="button" className="trash-action focus-ring" disabled={busy === item.id} onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                  <button type="button" className="trash-action focus-ring" data-danger="true" disabled={busy === item.id} onClick={() => void act(item, "delete")}>
                    Delete forever
                  </button>
                </>
              ) : (
                <>
                  {item.canRestore && (
                    <button type="button" className="trash-action focus-ring" aria-label={`Restore ${item.title}`} disabled={busy === item.id} onClick={() => void act(item, "restore")}>
                      Restore
                    </button>
                  )}
                  {item.canDelete && (
                    <button type="button" className="trash-action focus-ring" data-danger="true" aria-label={`Delete ${item.title} permanently`} disabled={busy === item.id} onClick={() => setConfirming(item.id)}>
                      Delete
                    </button>
                  )}
                </>
              )}
            </TrashRow>
          ))}
        </div>
        {trash.data && (
          <div className="page-dialog-foot">
            {trash.data.autoPurge
              ? `Pages in the Trash are deleted for good after ${trash.data.retentionDays} days.`
              : "Pages stay in the Trash until you delete them."}
          </div>
        )}
      </div>
    </dialog>
  );
}

/**
 * One row of the Trash. Phone (touch): swipe either way to restore — the same as
 * the row's Restore button, which stays for keyboard, mouse and screen readers.
 * Deleting for good is never a swipe (it needs its explicit confirmation).
 */
function TrashRow({ item, busy, onRestore, children }: { item: TrashItem; busy: boolean; onRestore: () => void; children: React.ReactNode }) {
  const restore = item.canRestore && !busy ? { label: "Restore", run: onRestore, tone: "accent" as const } : null;
  const swipe = useSwipeActions<HTMLDivElement>({ left: restore, right: restore });
  return (
    <div ref={swipe.ref} role="listitem" className="trash-row prism-swipe-row" aria-label={item.title} style={{ position: "relative" }}>
      {swipe.hint}
      {children}
    </div>
  );
}
