/**
 * Bulk actions over selected database rows (Notion's multi-select bar):
 * edit one property on every selected row, duplicate, or move to Trash — each
 * with ONE Undo.
 *
 * - Edit = one batched write (`POST /api/properties/batch`): every row is its
 *   own compare-and-set against the value the person saw, so a row changed
 *   elsewhere is reported (never overwritten) while the others are written.
 *   Undo writes the previous values back with the same CAS (expect = the new
 *   value), so it never clobbers an edit made after the bulk change.
 * - Trash goes through the pages API (`trashPage`, restorable); Undo restores.
 * - Duplicate copies body + properties (≤ 50 rows); Undo moves the copies to Trash.
 */
import { useEffect, useRef, useState } from "react";
import { Copy, Pencil, Trash2, Undo2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { useBatchPropertyWriter } from "../../lib/database/hooks";
import { noteTitle, type QueryRow } from "../../lib/database/query";
import { isSystemKey, propertyValue, type PropertyDef } from "../../lib/database/schema";
import type { PropertyBatchResult } from "../../lib/database/wire";
import { Popover } from "./Popover";
import { PropertyValue } from "./PropertyValue";
import { rowPath } from "./config";
import { copyFilesNotice } from "../../lib/pages/model";

export interface UndoAction {
  label: string;
  run: () => Promise<string>;
}

const REASONS: Record<string, string> = {
  conflict: "changed elsewhere",
  forbidden: "you can’t edit it",
  locked: "it is locked",
  not_found: "it is no longer available",
  structured_value: "its value is structured and is kept as it is",
};
const describe = (failed: Array<{ title: string; error: string }>) =>
  failed.slice(0, 3).map((f) => `${f.title} (${REASONS[f.error] ?? "not saved"})`).join(", ") + (failed.length > 3 ? ` and ${failed.length - 3} more` : "");

export function BulkBar({ rows, props, dbPath, canEditRow, canCreate, onDone, onClear }: {
  rows: QueryRow[];
  /** May the caller create pages here (duplicate)? */
  canCreate: boolean;
  props: PropertyDef[];
  dbPath: string | null;
  canEditRow: (r: QueryRow) => boolean;
  /** Report the outcome + the Undo for it. */
  onDone: (message: string, undo: UndoAction | null) => void;
  onClear: () => void;
}) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const batch = useBatchPropertyWriter();
  const editAnchor = useRef<HTMLButtonElement>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [field, setField] = useState<string>("");
  const [busy, setBusy] = useState(false);
  /** What a long bulk action is doing right now ("Duplicating 21 of 50…"), or "". */
  const [progress, setProgress] = useState("");
  /** Stops a running bulk duplicate: checked before each row and each wait; aborted on unmount. */
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);
  const editable = props.filter((p) => !p.system && !isSystemKey(p.key));
  const def = editable.find((p) => p.key === field) ?? editable[0];
  const titleOf = new Map(rows.map((r) => [r.id, noteTitle(r)]));
  const refresh = () => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "vault" && (q.queryKey[1] === "notes" || q.queryKey[1] === "tree") });
  };

  const summarize = (results: PropertyBatchResult[], skipped: QueryRow[], verb: string) => {
    const ok = results.filter((r) => r.ok).length;
    const failed = [
      ...results.filter((r): r is Extract<PropertyBatchResult, { ok: false }> => !r.ok).map((r) => ({ title: titleOf.get(r.id) ?? "A page", error: r.error })),
      ...skipped.map((r) => ({ title: noteTitle(r), error: "forbidden" })),
    ];
    return failed.length ? `${verb} ${ok} of ${ok + failed.length}. Not changed: ${describe(failed)}.` : `${verb} ${ok} ${ok === 1 ? "page" : "pages"}.`;
  };

  async function applyEdit(d: PropertyDef, next: unknown) {
    const targets = rows.filter(canEditRow);
    const skipped = rows.filter((r) => !canEditRow(r));
    const before = new Map(targets.map((r) => [r.id, propertyValue(r, d.key) ?? null]));
    const results = await batch(targets.map((r) => ({ id: r.id, set: { [d.key]: next }, expect: { [d.key]: before.get(r.id) }, updatedAt: r.updatedAt })));
    const written = results.filter((r) => r.ok).map((r) => r.id);
    setEditOpen(false);
    onDone(summarize(results, skipped, `Updated ${d.label} on`), written.length ? {
      label: `Undo ${d.label} change`,
      run: async () => {
        const back = await batch(written.map((id) => ({ id, set: { [d.key]: before.get(id) ?? null }, expect: { [d.key]: next } })));
        const n = back.filter((r) => r.ok).length;
        return n === written.length ? `Restored ${d.label} on ${n} ${n === 1 ? "page" : "pages"}.` : `Restored ${n} of ${written.length}; the others changed again since.`;
      },
    } : null);
  }

  async function trash() {
    if (!client.trashPage || busy) return;
    setBusy(true);
    const done: string[] = [];
    const failed: Array<{ title: string; error: string }> = [];
    for (const r of rows) {
      try {
        await client.trashPage(r.id);
        done.push(r.id);
      } catch (e) {
        failed.push({ title: noteTitle(r), error: /\b403\b/.test(String((e as Error).message)) ? "forbidden" : /\b423\b/.test(String((e as Error).message)) ? "locked" : "error" });
      }
    }
    setBusy(false);
    refresh();
    onClear();
    onDone(failed.length ? `Moved ${done.length} of ${rows.length} to Trash. Not moved: ${describe(failed)}.` : `Moved ${done.length} ${done.length === 1 ? "page" : "pages"} to Trash.`, done.length && client.restoreFromTrash ? {
      label: "Undo move to Trash",
      run: async () => {
        let n = 0;
        for (const id of done) {
          try { await client.restoreFromTrash!(id); n++; } catch { /* reported below */ }
        }
        refresh();
        return n === done.length ? `Restored ${n} ${n === 1 ? "page" : "pages"}.` : `Restored ${n} of ${done.length}. Open Trash to restore the rest.`;
      },
    } : null);
  }

  async function duplicate() {
    if (busy) return;
    setBusy(true);
    const made: string[] = [];
    const failed: Array<{ title: string; error: string }> = [];
    let filesMissed = 0;
    let keptPrivate = 0;
    const picked = rows.slice(0, 50);
    /** One row through the server route. The server allows a limited number per minute and
     *  one at a time: a 429 / "busy" is WAITED out (its Retry-After, ≤ 65 s, a few times)
     *  and the SAME request is sent again — never a new copy, never a generic failure. */
    const ctrl = new AbortController();
    stop.current = ctrl;
    /** Seconds this batch may spend WAITING for the server in all; past it the batch stops. */
    let waitLeft = 300;
    let stopped = false;
    const pause = (seconds: number) => new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); ctrl.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, seconds * 1000);
      ctrl.signal.addEventListener("abort", done);
    });
    const viaRoute = async (id: string, request: { requestId: string; confirmShared: boolean }, label: string) => {
      for (;;) {
        try {
          return await client.duplicatePage!(id, request);
        } catch (e) {
          const err = e as { status?: number; code?: string; body?: { retryAfter?: unknown } };
          const wait = err.status === 429 || err.code === "busy" ? Math.min(65, Math.max(1, Number(err.body?.retryAfter) || 5)) : 0;
          if (!wait) throw e;
          if (ctrl.signal.aborted || wait > waitLeft) { stopped = true; throw e; }
          waitLeft -= wait;
          setProgress(`${label} — waiting for the server (${wait} s)`);
          await pause(wait);
          if (ctrl.signal.aborted) { stopped = true; throw e; }
          setProgress(label);
        }
      }
    };
    let attempted = 0;
    for (const [index, r] of picked.entries()) {
      if (ctrl.signal.aborted || stopped) { stopped = true; break; }
      attempted++;
      const label = `Duplicating ${index + 1} of ${picked.length}…`;
      if (picked.length > 1) setProgress(label);
      try {
        // The server route (NP-PG-18): permissions, sub-pages, links and files in one
        // retryable request per row. A shell or server without it copies the row here.
        if (client.duplicatePage) {
          const request = { requestId: `dup-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`).replace(/-/g, "")}`, confirmShared: true };
          try {
            let result = await viaRoute(r.id, request, label);
            // Partly copied (a row with many sub-pages): the same request finishes it.
            for (let i = 0; !result.ok && i < 5; i++) result = await viaRoute(r.id, request, label);
            made.push(result.id);
            keptPrivate += result.privateKept + result.sharingKept;
            if (!result.ok) failed.push({ title: noteTitle(r), error: "error" });
            let missed = result.filesFailed > 0;
            for (const id of result.filesPending) if (copyFilesNotice(client.copyAttachments ? await client.copyAttachments(id).catch(() => null) : null)) missed = true;
            if (missed) filesMissed++;
            continue;
          } catch (e) {
            const status = (e as { status?: number }).status;
            const code = (e as { code?: string }).code;
            if (!(status === 405 || status === 501 || (status === 404 && code !== "not_found"))) throw e;
          }
        }
        const src = await client.getNote(r.id, { fresh: true });
        const meta: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(src.metadata ?? {})) if (!isSystemKey(k) || k === "icon" || k === "cover") meta[k] = v;
        // A copy of a private page stays private to the same person (review M2):
        // dropping prism_visibility would publish it to the whole workspace.
        if (src.metadata?.prism_visibility === "private") {
          meta.prism_visibility = "private";
          if (typeof src.metadata.prism_creator === "string") meta.prism_creator = src.metadata.prism_creator;
        }
        const title = `${noteTitle(r)} (copy)`;
        const n = await client.createNote({ content: src.content ?? "", path: rowPath(dbPath, `${title} ${Date.now().toString(36).slice(-4)}`), tags: (src.tags ?? []).filter((t) => t !== "prism-trashed"), metadata: { ...meta, title } });
        made.push(n.id);
        // Each copy gets its own files (wave 3); a failure leaves the row, never the batch.
        if (client.copyAttachments && ((src.content ?? "").includes("/api/attachments/") || JSON.stringify(meta).includes("/api/attachments/"))) {
          if (copyFilesNotice(await client.copyAttachments(n.id).catch(() => null))) filesMissed++;
        }
      } catch {
        // Stopped (by the person, or the batch's waiting budget ran out) while the server
        // had not taken this row: it was not copied, and it is not an error either.
        if (stopped) { attempted--; break; }
        failed.push({ title: noteTitle(r), error: "error" });
      }
    }
    stop.current = null;
    const notTried = picked.length - attempted;
    setBusy(false);
    setProgress("");
    refresh();
    onClear();
    const capped = (rows.length > 50 ? " Only the first 50 were duplicated." : "") + (keptPrivate ? ` ${keptPrivate} ${keptPrivate === 1 ? "copy is" : "copies are"} private to you.` : "") + (filesMissed ? ` Some files were not copied on ${filesMissed} ${filesMissed === 1 ? "page" : "pages"}.` : "");
    const halted = notTried ? ` Stopped — ${notTried} ${notTried === 1 ? "page was" : "pages were"} not copied.` : "";
    onDone((failed.length || notTried ? `Duplicated ${made.length} of ${picked.length}.${failed.length ? ` Not copied: ${describe(failed)}.` : ""}` : `Duplicated ${made.length} ${made.length === 1 ? "page" : "pages"}.`) + halted + capped, made.length && client.trashPage ? {
      label: "Undo duplicate",
      run: async () => {
        let n = 0;
        for (const id of made) {
          try { await client.trashPage!(id); n++; } catch { /* reported below */ }
        }
        refresh();
        return `Moved ${n} ${n === 1 ? "copy" : "copies"} to Trash.`;
      },
    } : null);
  }

  const editableCount = rows.filter(canEditRow).length;
  return (
    <div className="db-bulk" role="toolbar" aria-label="Selected pages">
      <span className="db-bulk-count" aria-live="polite">{progress || `${rows.length} selected`}</span>
      {progress && <button type="button" className="db-control" onClick={() => stop.current?.abort()}>Stop</button>}
      {editable.length > 0 && editableCount > 0 && (
        <button ref={editAnchor} type="button" className="db-control" aria-haspopup="dialog" aria-expanded={editOpen} disabled={busy} onClick={() => setEditOpen((o) => !o)}><Pencil size={13} aria-hidden="true" /> Edit property</button>
      )}
      {canCreate && <button type="button" className="db-control" disabled={busy} onClick={() => void duplicate()}><Copy size={13} aria-hidden="true" /> Duplicate</button>}
      {client.trashPage && <button type="button" className="db-control db-danger" disabled={busy} onClick={() => void trash()}><Trash2 size={13} aria-hidden="true" /> Move to Trash</button>}
      <button type="button" className="db-icon-btn" aria-label="Clear selection" onClick={onClear}><X size={14} /></button>
      <Popover anchor={editAnchor} open={editOpen} onClose={() => setEditOpen(false)} label="Edit property on selected pages" width={320}>
        {def && (
          <div className="db-settings">
            <label className="db-field">
              <span>Property</span>
              <select aria-label="Property to edit" value={def.key} onChange={(e) => setField(e.target.value)}>
                {editable.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </label>
            <div className="db-field">
              <span>Set {editableCount} {editableCount === 1 ? "page" : "pages"} to</span>
              <PropertyValue key={def.key} def={def} value={null} variant="panel" onCommit={(next) => applyEdit(def, next)} />
            </div>
            {editableCount < rows.length && <p className="db-pop-empty">{rows.length - editableCount} selected {rows.length - editableCount === 1 ? "page is" : "pages are"} read-only for you and will be skipped.</p>}
          </div>
        )}
      </Popover>
    </div>
  );
}

/** The single Undo toast for the last bulk action. */
export function UndoToast({ message, undo, onUndone, onDismiss }: { message: string; undo: UndoAction | null; onUndone: (msg: string) => void; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="db-toast" role="status">
      <span>{message}</span>
      {undo && (
        <button type="button" className="db-ghost" disabled={busy} onClick={() => {
          setBusy(true);
          void undo.run().then(onUndone).catch(() => onUndone("Undo failed. Check the pages and try again.")).finally(() => setBusy(false));
        }}><Undo2 size={13} aria-hidden="true" /> {busy ? "Undoing…" : "Undo"}</button>
      )}
      <button type="button" className="db-icon-btn" aria-label="Dismiss" onClick={onDismiss}><X size={13} /></button>
    </div>
  );
}
