/**
 * Inline + linked database blocks: a database view embedded inside a page.
 *
 * The editor owns the node (collab schema, group 2B); this is the database side.
 * The node is an ATOM `databaseView` with attrs `{noteId, viewId?}`, serialized
 * as `<div data-prism-database="<noteId>" data-view="<viewId>"></div>`, and its
 * NodeView renders `renderDatabaseBlock(noteId, viewId)`.
 *
 * - A LINKED view embeds an existing database note (by id) — every block of it
 *   is the same rows, edited through the same per-field CAS writes.
 * - A NEW inline database is a database note created as a sub-page of the host
 *   page (`createInlineDatabase`), then embedded the same way.
 *
 * The block reads the database note through the VaultClient seam like any tab,
 * so permissions are the gateway's: a viewer who cannot view the database sees
 * "unavailable" (never its title or rows); view changes save to the database
 * note only for people who may edit it (else they stay in this tab).
 */
import "./database.css";
import { lazy, Suspense } from "react";
import { useNote } from "../../app/hooks/useParachute";
import type { Note } from "../../lib/types";
import type { VaultClient } from "../../data/VaultClient";
import { inferContentType } from "../../lib/schemas/content-types";
import { safeTitleLeaf } from "../../lib/database/schema";
// Lazy: the database page stays out of the main bundle until a block renders.
const DatabasePage = lazy(() => import("./DatabaseRenderer").then((m) => ({ default: m.DatabasePage })));
import { defaultConfig, newViewId, VIEW_LABELS, type DatabaseConfig, type ViewType } from "./config";

/** Strict note-id shape (never a path/title alias). */
const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function DatabaseBlock({ noteId, viewId, readOnly }: { noteId: string; viewId?: string | null; readOnly?: boolean }) {
  const valid = NOTE_ID.test(noteId);
  const { data: note, isLoading, isError } = useNote(valid ? noteId : null);
  if (!valid) return <div className="db-block-state" role="note">This database link is not valid.</div>;
  if (isLoading) return <div className="db-block-state" role="status">Loading database…</div>;
  if (isError || !note) return <div className="db-block-state" role="note">This database is unavailable. It may have moved, or you may not have access.</div>;
  if (inferContentType(note) !== "database") return <div className="db-block-state" role="note">This block points at a page that is not a database.</div>;
  return (
    <div className="db-block" contentEditable={false} data-prism-database={note.id} data-view={viewId ?? undefined}>
      <Suspense fallback={<div className="db-block-state" role="status">Loading database…</div>}>
        <DatabasePage key={`${note.id}:${viewId ?? ""}`} note={note} readOnly={readOnly} embedded={{ viewId: viewId ?? undefined }} />
      </Suspense>
    </div>
  );
}

/** What the editor's `databaseView` NodeView renders. */
export function renderDatabaseBlock(noteId: string, viewId?: string | null, opts: { readOnly?: boolean } = {}) {
  return <DatabaseBlock noteId={noteId} viewId={viewId} readOnly={opts.readOnly} />;
}

/** The HTML the editor stores for a block (also what `parseDatabaseBlock` reads). */
export function databaseBlockHtml(noteId: string, viewId?: string | null): string {
  const esc = (s: string) => s.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<div data-prism-database="${esc(noteId)}"${viewId ? ` data-view="${esc(viewId)}"` : ""}></div>`;
}

/** Read the attrs back from a stored element (`parseHTML` of the node). */
export function parseDatabaseBlock(el: Element): { noteId: string; viewId: string | null } | null {
  const noteId = el.getAttribute("data-prism-database") ?? "";
  if (!NOTE_ID.test(noteId)) return null;
  const v = el.getAttribute("data-view");
  return { noteId, viewId: v && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : null };
}

/**
 * "/table view", "/board view"… with a NEW database: create a database note as a
 * sub-page of the host page over `tag`, starting with one view of `type`.
 * Returns the block attrs for the editor to insert.
 */
export async function createInlineDatabase(client: Pick<VaultClient, "createNote">, host: Pick<Note, "path">, opts: { tag: string; type?: ViewType; title?: string }): Promise<{ noteId: string; viewId: string }> {
  const type = opts.type ?? "table";
  const viewId = newViewId();
  const config: DatabaseConfig = { ...defaultConfig(opts.tag), views: [{ id: viewId, name: VIEW_LABELS[type], type }] };
  const title = opts.title?.trim() || `${opts.tag} database`;
  const base = (host.path ?? "").replace(/\.[^./]+$/, "");
  const n = await client.createNote({
    content: "",
    path: `${base ? `${base}/` : ""}${safeTitleLeaf(title)}`,
    tags: [],
    metadata: { title, prism_type: "database", prism_database: config },
  });
  return { noteId: n.id, viewId };
}

/**
 * "/linked view of database": add a view of `type` to an EXISTING database (so
 * the block keeps its own filter/sort/layout), CAS against `db.updatedAt`.
 * Returns the block attrs. A caller who cannot edit the database embeds an
 * existing view instead (`{noteId, viewId: <one of its views>}`).
 */
export async function addLinkedView(client: Pick<VaultClient, "updateNote">, db: Pick<Note, "id" | "updatedAt" | "metadata">, config: DatabaseConfig, type: ViewType, name?: string): Promise<{ noteId: string; viewId: string }> {
  const viewId = newViewId();
  const next: DatabaseConfig = { ...config, views: [...config.views, { id: viewId, name: (name?.trim() || `${VIEW_LABELS[type]} (linked)`).slice(0, 80), type }] };
  await client.updateNote(db.id, { metadata: { prism_database: next }, ifUpdatedAt: db.updatedAt ?? undefined });
  return { noteId: db.id, viewId };
}
