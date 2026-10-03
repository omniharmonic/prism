/**
 * Note attachments (images / files / media blocks / page covers): the index
 * table + the vault I/O. Bytes live in the PARACHUTE VAULT's attachment storage
 * (`POST /storage/upload` + `POST /notes/:id/attachments`), so a vault backup
 * carries them; this module only keeps a small SQLite index
 * `prism_attachments` mapping the opaque public id (`a_…`) → the owning note,
 * the vault storage path, the sniffed type, size and display name. The id is
 * what `/api/attachments/:id` serves; access is decided per request against the
 * OWNING note (routes/attachments.ts), never by knowing the id.
 *
 * The table is created here (not in db.ts) so the module is self-contained,
 * like identity-store.ts.
 */
import { randomBytes } from "node:crypto";
import { db, resolveVaultEntry } from "./db";

db.exec(`
  CREATE TABLE IF NOT EXISTS prism_attachments (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS prism_attachments_note ON prism_attachments(vault_id, note_id);
`);
// Additive columns (idempotent): lifecycle status, the vault's own attachment-row id
// (needed to delete it), and when a row was purged / flagged.
//   status: 'live' | 'orphan_attach_failed' | 'orphan_note_deleted' | 'orphan_unreferenced' | 'deleted'
{
  const have = new Set((db.prepare("PRAGMA table_info(prism_attachments)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!have.has("status")) db.exec("ALTER TABLE prism_attachments ADD COLUMN status TEXT NOT NULL DEFAULT 'live'");
  if (!have.has("vault_attachment_id")) db.exec("ALTER TABLE prism_attachments ADD COLUMN vault_attachment_id TEXT");
  if (!have.has("deleted_at")) db.exec("ALTER TABLE prism_attachments ADD COLUMN deleted_at TEXT");
  if (!have.has("flagged_at")) db.exec("ALTER TABLE prism_attachments ADD COLUMN flagged_at TEXT");
}

export type AttachmentStatus = "live" | "orphan_attach_failed" | "orphan_note_deleted" | "orphan_unreferenced" | "deleted";

export interface AttachmentRow {
  id: string;
  vault_id: string;
  note_id: string;
  storage_path: string;
  mime: string;
  size: number;
  name: string;
  created_by: string;
  created_at: string;
  status?: AttachmentStatus;
  vault_attachment_id?: string | null;
  deleted_at?: string | null;
  flagged_at?: string | null;
}

const ID_RE = /^a_[A-Za-z0-9_-]{22}$/;
export const isAttachmentId = (s: string): boolean => ID_RE.test(s);
export const newAttachmentId = (): string => `a_${randomBytes(16).toString("base64url")}`;

export function insertAttachment(row: AttachmentRow): void {
  db.prepare(
    `INSERT INTO prism_attachments (id, vault_id, note_id, storage_path, mime, size, name, created_by, created_at, status, vault_attachment_id)
     VALUES (@id, @vault_id, @note_id, @storage_path, @mime, @size, @name, @created_by, @created_at, @status, @vault_attachment_id)`,
  ).run({ status: "live", vault_attachment_id: null, ...row });
}

/**
 * A vault upload that could not be linked to its note: the bytes exist in vault
 * storage with no attachment row (the vault's REST has no storage delete). Keep
 * a record so the owner's sweep can report it. Never served.
 */
export function recordOrphan(row: AttachmentRow): void {
  insertAttachment({ ...row, status: "orphan_attach_failed" });
}

/** Bytes counted against a quota: everything that still occupies vault storage. */
export function usedBytes(vaultId: string, noteId?: string): number {
  const r = (noteId === undefined
    ? db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM prism_attachments WHERE vault_id = ? AND status != 'deleted'").get(vaultId)
    : db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM prism_attachments WHERE vault_id = ? AND note_id = ? AND status != 'deleted'").get(vaultId, noteId)) as { n: number };
  return r.n;
}

export function setAttachmentStatus(id: string, status: AttachmentStatus): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE prism_attachments SET status = ?, deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END, flagged_at = CASE WHEN ? != 'deleted' THEN ? ELSE flagged_at END WHERE id = ?").run(status, status, now, status, now, id);
}

/** Live rows grouped for the sweep: one page of (vault, note) pairs after `cursor`. */
export function liveRowsPage(cursor: string, limit: number): { rows: AttachmentRow[]; next: string | null } {
  const notes = db
    .prepare("SELECT DISTINCT vault_id || char(0) || note_id AS k FROM prism_attachments WHERE status = 'live' AND vault_id || char(0) || note_id > ? ORDER BY k LIMIT ?")
    .all(cursor, limit + 1) as Array<{ k: string }>;
  const page = notes.slice(0, limit);
  if (!page.length) return { rows: [], next: null };
  const rows = db
    .prepare(`SELECT * FROM prism_attachments WHERE status = 'live' AND vault_id || char(0) || note_id IN (${page.map(() => "?").join(",")})`)
    .all(...page.map((p) => p.k)) as AttachmentRow[];
  return { rows, next: notes.length > limit ? page[page.length - 1]!.k : null };
}

/**
 * A note is being permanently deleted: remove its attachments from the vault
 * (the vault unlinks the stored file when no other row references it) and mark
 * our rows. Best-effort — never throws; a row whose vault delete failed (or
 * that has no vault attachment id) is kept as `orphan_note_deleted` for the sweep.
 */
export async function purgeAttachmentsForNote(vaultId: string, noteId: string, opts: { noteGone?: boolean } = {}): Promise<{ deleted: number; orphaned: number }> {
  let deleted = 0;
  let orphaned = 0;
  let rows: AttachmentRow[] = [];
  try {
    rows = db.prepare("SELECT * FROM prism_attachments WHERE vault_id = ? AND note_id = ? AND status != 'deleted'").all(vaultId, noteId) as AttachmentRow[];
  } catch {
    return { deleted, orphaned };
  }
  for (const row of rows) {
    if (opts.noteGone) {
      // ORDER (review follow-up): this runs AFTER the vault deleted the note, so a failed
      // delete never costs a page its media. The vault cascades the attachment ROWS with the
      // note but leaves the stored files, and its REST API can only unlink a file through
      // `DELETE /notes/:id/attachments/:att` — which needs the note. So every row becomes a
      // recorded orphan (`orphan_note_deleted`, storage path kept, no longer served); the
      // owner sweep reports them. Reclaiming the bytes needs vault-side support.
      try { setAttachmentStatus(row.id, "orphan_note_deleted"); } catch { /* best-effort */ }
      orphaned++;
      continue;
    }
    let ok = false;
    if (row.vault_attachment_id) {
      try {
        const { api, auth } = base(vaultId);
        const r = await fetch(`${api}/notes/${encodeURIComponent(noteId)}/attachments/${encodeURIComponent(row.vault_attachment_id)}`, {
          method: "DELETE",
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(15_000),
        });
        await r.body?.cancel().catch(() => {});
        ok = r.status === 204 || r.status === 200;
      } catch {
        ok = false;
      }
    }
    try {
      setAttachmentStatus(row.id, ok ? "deleted" : "orphan_note_deleted");
    } catch {
      /* best-effort */
    }
    if (ok) deleted++;
    else orphaned++;
  }
  return { deleted, orphaned };
}

/** A SERVABLE attachment: live (or merely flagged unreferenced — a block may come back from history). */
export function getAttachment(id: string): AttachmentRow | null {
  if (!isAttachmentId(id)) return null;
  const row = (db.prepare("SELECT * FROM prism_attachments WHERE id = ?").get(id) as AttachmentRow | undefined) ?? null;
  return row && (row.status === "live" || row.status === "orphan_unreferenced" || row.status == null) ? row : null;
}

/** Test helper. */
export function resetAttachmentsForTests(): void {
  db.exec("DELETE FROM prism_attachments");
}

/** Sanitised display name: basename only, no control chars/quotes/backslashes, ≤ 200 chars. */
export function sanitizeName(raw: unknown): string {
  let s = typeof raw === "string" ? raw : "";
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (slash >= 0) s = s.slice(slash + 1);
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0) || ch === '"' || ch === "\\" || ch === "/" || cp === 0x2028 || cp === 0x2029) continue;
    // Bidi / directional format controls: "invoice\u202Efdp.exe" must not display as "invoiceexe.pdf".
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f || cp === 0x061c) continue;
    out += ch;
  }
  out = out.trim().replace(/^\.+/, "");
  if ([...out].length > 200) out = [...out].slice(0, 200).join("");
  return out || "file";
}

/** RFC 6266 Content-Disposition with an ASCII fallback + RFC 5987 `filename*`. */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[";\\]/g, "_") || "file";
  const star = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

// ── vault I/O ───────────────────────────────────────────────────────────────

export class VaultIoError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function base(vaultId: string) {
  const e = resolveVaultEntry(vaultId);
  return { api: `${e.url}/vault/${e.vault}/api`, auth: `Bearer ${e.token}` };
}

/**
 * Upload into the vault's storage under a server-chosen file name. Takes the
 * parsed upload Blob as-is (no extra copy): the vault's `/storage/upload` only
 * accepts multipart, so the bytes are held once (the parsed request body) and
 * re-framed by fetch.
 */
export async function vaultUpload(vaultId: string, bytes: Blob, filename: string): Promise<{ path: string; size: number }> {
  const { api, auth } = base(vaultId);
  const form = new FormData();
  form.append("file", bytes, filename);
  const r = await fetch(`${api}/storage/upload`, { method: "POST", headers: { Authorization: auth }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new VaultIoError(r.status, `storage upload: ${r.status}`);
  const b = (await r.json()) as { path?: unknown; size?: unknown };
  if (typeof b.path !== "string" || !b.path) throw new VaultIoError(502, "storage upload: no path");
  return { path: b.path, size: typeof b.size === "number" ? b.size : bytes.size };
}

/** Link a stored file to a note (never auto-transcribed). */
export async function vaultAttach(vaultId: string, noteId: string, path: string, mimeType: string): Promise<{ id: string }> {
  const { api, auth } = base(vaultId);
  const r = await fetch(`${api}/notes/${encodeURIComponent(noteId)}/attachments`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ path, mimeType, transcribe: false }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new VaultIoError(r.status, `attach: ${r.status}`);
  const b = (await r.json()) as { id?: unknown };
  return { id: typeof b.id === "string" ? b.id : "" };
}

/** Stream stored bytes (single Range forwarded). The caller rebuilds every header. */
export async function vaultStorageFetch(vaultId: string, storagePath: string, range: string | null): Promise<Response> {
  const { api, auth } = base(vaultId);
  // The stored path is `<date>/<file>` written by the vault itself; encode each segment.
  const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
  const headers: Record<string, string> = { Authorization: auth };
  if (range) headers.Range = range;
  return fetch(`${api}/storage/${encoded}`, { headers });
}

/** Orphans already recorded (note deleted, or attach failed after upload): for the owner sweep. Bounded. */
export function recordedOrphans(limit = 500): { rows: Array<{ id: string; noteId: string; vaultId: string; size: number; reason: "note_deleted" | "attach_failed" }>; bytes: number; total: number } {
  const rows = db
    .prepare("SELECT id, note_id, vault_id, size, status FROM prism_attachments WHERE status IN ('orphan_note_deleted', 'orphan_attach_failed') ORDER BY flagged_at DESC, id LIMIT ?")
    .all(limit) as Array<{ id: string; note_id: string; vault_id: string; size: number; status: string }>;
  const agg = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM prism_attachments WHERE status IN ('orphan_note_deleted', 'orphan_attach_failed')").get() as { n: number; bytes: number };
  return {
    rows: rows.map((r) => ({ id: r.id, noteId: r.note_id, vaultId: r.vault_id, size: r.size, reason: r.status === "orphan_attach_failed" ? "attach_failed" as const : "note_deleted" as const })),
    bytes: agg.bytes,
    total: agg.n,
  };
}
