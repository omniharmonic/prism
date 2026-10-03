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
}

const ID_RE = /^a_[A-Za-z0-9_-]{22}$/;
export const isAttachmentId = (s: string): boolean => ID_RE.test(s);
export const newAttachmentId = (): string => `a_${randomBytes(16).toString("base64url")}`;

export function insertAttachment(row: AttachmentRow): void {
  db.prepare(
    `INSERT INTO prism_attachments (id, vault_id, note_id, storage_path, mime, size, name, created_by, created_at)
     VALUES (@id, @vault_id, @note_id, @storage_path, @mime, @size, @name, @created_by, @created_at)`,
  ).run(row);
}

export function getAttachment(id: string): AttachmentRow | null {
  if (!isAttachmentId(id)) return null;
  return (db.prepare("SELECT * FROM prism_attachments WHERE id = ?").get(id) as AttachmentRow | undefined) ?? null;
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

/** Upload bytes into the vault's storage under a server-chosen file name. */
export async function vaultUpload(vaultId: string, bytes: Buffer, filename: string): Promise<{ path: string; size: number }> {
  const { api, auth } = base(vaultId);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), filename);
  const r = await fetch(`${api}/storage/upload`, { method: "POST", headers: { Authorization: auth }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new VaultIoError(r.status, `storage upload: ${r.status}`);
  const b = (await r.json()) as { path?: unknown; size?: unknown };
  if (typeof b.path !== "string" || !b.path) throw new VaultIoError(502, "storage upload: no path");
  return { path: b.path, size: typeof b.size === "number" ? b.size : bytes.length };
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
