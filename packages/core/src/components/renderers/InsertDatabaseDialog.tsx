import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useVaultTree } from "../../app/hooks/useParachute";
import { addLinkedView, createInlineDatabase } from "../database/DatabaseBlock";
import { readDatabaseConfig, VIEW_LABELS } from "../database/config";
import { insertDatabaseBlock, type DatabaseInsertRequest } from "../../lib/tiptap/databaseView";
import "./editor-blocks.css";

const TAG = /^[A-Za-z0-9][A-Za-z0-9_/-]{0,63}$/;

/**
 * The picker behind the slash menu's database items.
 *  - "new": name a tag → a database note is created as a sub-page of this page
 *    (`createInlineDatabase`) and embedded.
 *  - "linked": pick an existing database → a view is added to it (`addLinkedView`,
 *    CAS) when the reader may edit it, else its first view is embedded as-is.
 * The block is inserted only after the server answered; failures insert nothing.
 */
export function InsertDatabaseDialog({ editor, request, hostPath, onClose }: { editor: Editor; request: DatabaseInsertRequest; hostPath: string | null | undefined; onClose: () => void }) {
  const client = useVaultClient();
  const { data: tree } = useVaultTree();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const label = VIEW_LABELS[request.type];
  const databases = useMemo(() => {
    const q = value.trim().toLowerCase();
    return (tree ?? [])
      .filter((n) => (n.metadata as Record<string, unknown> | null)?.prism_type === "database" || (n as { prismType?: string }).prismType === "database")
      .map((n) => ({ id: n.id, name: (n.path ?? n.id).split("/").pop()!.replace(/\.[^.]+$/, "") }))
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .slice(0, 50);
  }, [tree, value]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); editor.commands.focus(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editor]);

  const finish = (attrs: { noteId: string; viewId: string | null }) => {
    if (!insertDatabaseBlock(editor, request.pos, attrs)) setError("This page is no longer editable here, so the database was not added.");
    else onClose();
  };
  const createNew = async () => {
    const tag = value.trim();
    if (!TAG.test(tag)) { setError("Use a tag name: letters, numbers, - or _ (for example “task”)."); return; }
    setBusy(true); setError("");
    try {
      finish(await createInlineDatabase(client, { path: hostPath ?? null }, { tag, type: request.type }));
    } catch {
      setError("Couldn't create the database. Nothing was added.");
    } finally { setBusy(false); }
  };
  const link = async (id: string) => {
    setBusy(true); setError("");
    try {
      const db = await client.getNote(id, { fresh: true });
      const config = readDatabaseConfig(db.metadata);
      if (!config) { setError("That page is not a database."); return; }
      try {
        finish(await addLinkedView(client, db, config, request.type));
      } catch {
        // No edit access to the database (or it changed): embed one of its existing views.
        const existing = config.views.find((v) => v.type === request.type) ?? config.views[0];
        finish({ noteId: db.id, viewId: existing?.id ?? null });
      }
    } catch {
      setError("Couldn't open that database.");
    } finally { setBusy(false); }
  };

  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.25)" }} onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={request.mode === "new" ? `New ${label.toLowerCase()} database` : "Link a database"} className="prism-db-insert glass-elevated">
        <h2>{request.mode === "new" ? `New ${label.toLowerCase()}` : `Linked ${label.toLowerCase()} of a database`}</h2>
        {request.mode === "new" ? (
          <form onSubmit={(e) => { e.preventDefault(); void createNew(); }}>
            <label htmlFor="prism-db-insert-tag">Rows are pages tagged</label>
            <input id="prism-db-insert-tag" ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} placeholder="task" autoComplete="off" spellCheck={false} disabled={busy} />
            <div className="prism-db-insert-actions">
              <button type="button" className="focus-ring" onClick={onClose}>Cancel</button>
              <button type="submit" className="prism-db-insert-primary focus-ring" disabled={busy || !value.trim()}>{busy ? "Creating…" : "Create database"}</button>
            </div>
          </form>
        ) : (
          <>
            <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Search databases…" aria-label="Search databases" autoComplete="off" disabled={busy} />
            <ul role="listbox" aria-label="Databases">
              {databases.map((d) => (
                <li key={d.id}><button type="button" role="option" aria-selected="false" className="focus-ring" disabled={busy} onClick={() => void link(d.id)}>{d.name}</button></li>
              ))}
              {!databases.length && <li className="prism-db-insert-empty">No databases found.</li>}
            </ul>
            <div className="prism-db-insert-actions"><button type="button" className="focus-ring" onClick={onClose}>Cancel</button></div>
          </>
        )}
        {error && <p role="alert" className="prism-db-insert-error">{error}</p>}
      </div>
    </>,
    document.body,
  );
}
