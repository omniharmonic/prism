/**
 * Writer stamp — `metadata.prism_last_writer` (Notion's "Last edited by").
 *
 * The gateway stamps WHO made a write on every note write it performs or
 * forwards, so database views can show and sort/filter "Last edited by" (and
 * sharing/review UIs can attribute changes) without reading vault history.
 *
 *   value  = the signed-in account's email, or "link" for an anyone-with-link
 *            capability (never the capability id: that names a grant).
 *   stamped by:
 *     - routes/api.ts   non-owner POST /notes + PATCH /notes/:id, and the owner
 *                       passthrough's POST /notes + PATCH /notes/:id JSON bodies
 *     - routes/databases.ts  POST /properties/:id, POST /properties/batch,
 *                       POST /databases/import/csv
 *   NOT stamped: collab socket stores (a Y.Doc save has many authors; the
 *   document's own history attributes them), ingest workers (no human writer),
 *   the trash/move routes (they do not change what a row says).
 *
 * The key is `prism_*`, so it is a system key everywhere: never a property,
 * never accepted from a client (`/properties` refuses `prism_*`; the stamp
 * below OVERWRITES any client-supplied value on the gateway paths).
 */
import type { Actor } from "./auth/actor";

export const WRITER_KEY = "prism_last_writer";

/** The stamp value for an actor, or null when there is no human writer to name. */
export function writerOf(actor: Actor | null | undefined): string | null {
  if (!actor) return null;
  if (actor.kind === "user") return actor.email;
  if (actor.kind === "link") return "link";
  return null;
}

/** `metadata` with the writer stamp applied (a copy; the input is untouched). */
export function stampMetadata(metadata: Record<string, unknown> | undefined | null, actor: Actor | null | undefined): Record<string, unknown> | undefined {
  const who = writerOf(actor);
  if (!who) return metadata ?? undefined;
  return { ...(metadata ?? {}), [WRITER_KEY]: who };
}

/**
 * Stamp a raw JSON request body (the owner passthrough forwards bodies as text).
 * Only a single-note object body is touched (`POST /notes` with `notes: [...]`
 * batches and anything unparseable pass through unchanged). Returns the body.
 */
export function stampJsonBody(text: string, actor: Actor | null | undefined): string {
  const who = writerOf(actor);
  if (!who || !text) return text;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return text;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.notes)) return text;
  const meta = b.metadata;
  if (meta !== undefined && (meta === null || typeof meta !== "object" || Array.isArray(meta))) return text;
  b.metadata = { ...((meta as Record<string, unknown> | undefined) ?? {}), [WRITER_KEY]: who };
  return JSON.stringify(b);
}
