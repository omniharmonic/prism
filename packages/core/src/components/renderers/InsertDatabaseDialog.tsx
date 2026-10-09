import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { useQueryClient } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { useVaultTree } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { addLinkedView, createInlineDatabase } from "../database/DatabaseBlock";
import { readDatabaseConfig, VIEW_LABELS } from "../database/config";
import { insertDatabaseBlock, type DatabaseInsertRequest } from "../../lib/tiptap/databaseView";
import { NewDatabaseDialog } from "../database/NewDatabaseDialog";
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
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [existingTag, setExistingTag] = useState(false);
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
  // Full-page database (NP-DB-01): leave a link to the sub-page here and open it.
  const linkAndOpen = (made: { noteId: string; path: string | null; title: string }) => {
    if (made.path && !editor.isDestroyed) {
      const at = Math.max(0, Math.min(request.pos, editor.state.doc.content.size));
      const node = editor.state.doc.nodeAt(at);
      const link = { type: "paragraph", content: [{ type: "text", text: `[[${made.path}]]` }] };
      if (node && node.isTextblock && node.content.size === 0) editor.chain().insertContentAt({ from: at, to: at + node.nodeSize }, link).run();
      else editor.chain().insertContentAt(node ? at + node.nodeSize : editor.state.doc.content.size, link).run();
    }
    useUIStore.getState().openTab(made.noteId, made.title, "database");
    onClose();
  };
  const createNew = async () => {
    const tag = value.trim();
    if (!TAG.test(tag)) { setError("Use a tag name: letters, numbers, - or _ (for example “task”)."); return; }
    setBusy(true); setError("");
    try {
      const made = await createInlineDatabase(client, { path: hostPath ?? null }, { tag, type: request.type });
      // The new database is a page: the sidebar and "Linked view of database" list it at once,
      // not only when the events channel (or a reload) refreshes the tree.
      void queryClient.invalidateQueries({ queryKey: ["vault", "tree"] });
      if (request.mode === "page") linkAndOpen(made);
      else finish(made);
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

  // A full-page database gets its OWN tag and properties where this shell can write
  // schemas (New database, "Blank with schema"); "Use an existing tag" is the form below.
  if (request.mode === "page" && client.updateSchema && !existingTag)
    return createPortal(
      <NewDatabaseDialog folder={hostPath ?? ""} initialView={request.type} onClose={() => { onClose(); editor.commands.focus(); }}
        onUseExistingTag={() => setExistingTag(true)}
        onCreated={(note, title) => linkAndOpen({ noteId: note.id, path: note.path ?? null, title })} />,
      document.body,
    );
  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.25)" }} onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={request.mode === "page" ? "New full-page database" : request.mode === "new" ? `New ${label.toLowerCase()} database` : "Link a database"} className="prism-db-insert glass-elevated">
        <h2>{request.mode === "page" ? "New full-page database" : request.mode === "new" ? `New ${label.toLowerCase()}` : `Linked ${label.toLowerCase()} of a database`}</h2>
        {request.mode !== "linked" ? (
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
