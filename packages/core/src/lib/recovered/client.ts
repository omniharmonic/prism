/**
 * "Recovered text" — the server owner's way to the text a page held when a newer
 * copy replaced typing that had not been saved (`collab_set_aside`), and to pages
 * whose live changes cannot be saved (`collab_unsaved`).
 *
 * Routes (server owner by e-mail, human origin; every read of a body is audited
 * server-side): `GET /api/admin/collab/unsaved`, `GET|DELETE
 * /api/admin/collab/set-aside/:id`, `POST /api/admin/collab/unsaved/:id/discard`.
 * Everything goes through `serverFetch`, so PWA cookie and native bearer both work;
 * the legacy desktop has no server and never calls this.
 */
import { serverFetch } from "../transport/serverFetch";
import { pageTitle } from "../pages/model";
import { serverContextHeaders } from "../import-export/client";

export interface SetAsideEntry {
  id: number;
  noteId: string;
  /** When the page's text was set aside (epoch ms). */
  at: number;
  /** `uncertain_base` | `no_base` | … (server vocabulary). */
  reason: string;
  /** document | code | spreadsheet | canvas */
  kind: string;
  /** Characters of the kept text. */
  bytes: number;
}
export interface UnsavedEntry {
  noteId: string;
  reason: string;
  /** true = the server stopped retrying: the page can never be saved as it is. */
  permanent: boolean;
  since: number;
  attempts: number;
}
export interface RecoveredList {
  setAside: SetAsideEntry[];
  unsaved: UnsavedEntry[];
}
/** Not the server owner / not signed in / an older server / no server reachable: the feature is simply not here. */
export class RecoveredUnavailable extends Error {}
export class RecoveredError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function recoveredApi(vaultHeaders: () => Record<string, string> = serverContextHeaders) {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    try {
      return await serverFetch(path, { ...init, headers: { ...vaultHeaders(), ...(init.headers as Record<string, string> | undefined) } });
    } catch {
      throw new RecoveredUnavailable("unreachable");
    }
  };
  const fail = async (r: Response, what: string): Promise<never> => {
    const body = (await r.json().catch(() => ({}))) as { error?: unknown; detail?: unknown };
    throw new RecoveredError(r.status, str(body.error) || "error", str(body.detail) || what);
  };
  return {
    async list(): Promise<RecoveredList> {
      const r = await call("/api/admin/collab/unsaved");
      if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 405) throw new RecoveredUnavailable(String(r.status));
      if (!r.ok) return fail(r, "The list could not be loaded.");
      const body = (await r.json().catch(() => null)) as { rows?: unknown; setAside?: unknown } | null;
      if (!body || typeof body !== "object") throw new RecoveredUnavailable("shape");
      const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
      const kept = Array.isArray(body.setAside) ? (body.setAside as Array<Record<string, unknown>>) : [];
      return {
        setAside: kept.filter((k) => Number.isSafeInteger(k.id) && str(k.noteId)).map((k) => ({ id: k.id as number, noteId: str(k.noteId), at: num(k.at), reason: str(k.reason), kind: str(k.kind), bytes: num(k.bytes) })),
        unsaved: rows.filter((u) => str(u.noteId)).map((u) => ({ noteId: str(u.noteId), reason: str(u.reason), permanent: u.permanent === true, since: num(u.since), attempts: num(u.attempts) })),
      };
    },
    /** The kept text of one entry. The server writes an audit row for every read. */
    async read(id: number): Promise<string> {
      const r = await call(`/api/admin/collab/set-aside/${id}`);
      if (!r.ok) return fail(r, r.status === 404 ? "This text is no longer kept." : "The text could not be loaded.");
      return str(((await r.json()) as { body?: unknown }).body);
    },
    async remove(id: number): Promise<void> {
      const r = await call(`/api/admin/collab/set-aside/${id}`, { method: "DELETE", headers: JSON_HEADERS });
      if (!r.ok && r.status !== 404) return fail(r, "The text could not be deleted.");
    },
    /** Drop a page's unsaved live changes: the page becomes the stored page again. `force` = a page the server is still retrying. */
    async discard(noteId: string, force: boolean): Promise<void> {
      const r = await call(`/api/admin/collab/unsaved/${encodeURIComponent(noteId)}/discard`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(force ? { confirm: true, force: true } : { confirm: true }) });
      if (!r.ok) return fail(r, r.status === 503 ? "The page is busy. Try again in a moment." : "The changes could not be discarded.");
    },
    /**
     * Page names for the listed ids, from the TREE projection (`GET /api/tree`: ids, paths and the
     * titles this viewer may see) — one request, and NO page body is read: a body is fetched only by
     * an explicit View of a kept text, which the server audits. An id the tree does not list
     * (deleted, purged) is absent from the answer.
     */
    async titles(ids: readonly string[]): Promise<Record<string, string>> {
      const want = new Set(ids);
      const out: Record<string, string> = {};
      if (!want.size) return out;
      try {
        const r = await call("/api/tree");
        if (!r.ok) return out;
        const rows = (await r.json()) as unknown;
        if (!Array.isArray(rows)) return out;
        for (const row of rows as Array<{ id?: unknown; path?: unknown; title?: unknown }>) {
          if (typeof row?.id !== "string" || !want.has(row.id)) continue;
          out[row.id] = str(row.title).trim() || pageTitle(str(row.path));
        }
      } catch {
        /* names are a nicety: the rows still show, by id */
      }
      return out;
    },
  };
}
export type RecoveredApi = ReturnType<typeof recoveredApi>;

/** Why the text was set aside, in words. */
export function setAsideReason(reason: string): string {
  if (reason === "uncertain_base") return "A newer copy and unsaved typing could not be merged";
  if (reason === "no_base") return "A newer copy replaced unsaved typing";
  return "A newer copy replaced unsaved changes";
}
/** Why a page's live changes are not in the stored page. */
export function unsavedReason(reason: string): string {
  if (reason === "gave_up") return "The server stopped trying to save it";
  if (/too_many_nodes|too_large|too_complex/.test(reason)) return "The page is too large or complex to save";
  if (/vault_4|rejected|413|422|400/.test(reason)) return "The vault refused the page";
  return "The page could not be saved";
}
export function sizeLabel(chars: number): string {
  if (chars < 1000) return `${chars} characters`;
  if (chars < 1_000_000) return `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)}k characters`;
  return `${(chars / 1_000_000).toFixed(1)}M characters`;
}
