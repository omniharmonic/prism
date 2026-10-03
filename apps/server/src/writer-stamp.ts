/**
 * Writer stamp — `metadata.prism_last_writer` (Notion's "Last edited by").
 *
 * STORED VALUE (review H1): an OPAQUE, stable subject id — `u_<16 hex>` =
 * HMAC-SHA256(SESSION_SECRET, "prism-writer-v1:" + lowercased email) — or
 * `"link"` for an anyone-with-link capability (never its grant id). Never an
 * email: the stamp travels wherever metadata does (version history, exports a
 * future path forgets to filter). Beside it, `prism_last_write_at` (ISO) records
 * when the stamp was made.
 *
 * RESOLUTION: `resolveWriter()` turns the stamp into a display name (users.name,
 * else the email) — only on paths that serve SIGNED-IN viewers of the note
 * (`/api/query` for user actors). It answers null when the account is unknown
 * OR when the note was written again after the stamp (`updatedAt` more than
 * `STALE_MS` past `prism_last_write_at`): a collab store, an ingest worker, the
 * desktop or an agent wrote last, and the stamp must not contradict "Last edited
 * time" (review L4). Rotating SESSION_SECRET orphans old stamps (they resolve to
 * null) — harmless.
 *
 * STAMPED BY:
 *   - routes/api.ts   non-owner POST /notes + PATCH /notes/:id (content/metadata
 *                     writes only), and the owner passthrough's POST /notes +
 *                     PATCH /notes/:id JSON bodies that carry content or metadata
 *   - routes/databases.ts  POST /properties/:id, /properties/batch, CSV import
 *   NOT stamped: collab stores, ingest workers, trash/move routes.
 *
 * NEVER EXPOSED to capability links, the public site, GitHub frontmatter or
 * vault mirrors (`stripIdentity`), together with `prism_creator`.
 */
import { createHmac } from "node:crypto";
import type { Actor } from "./auth/actor";
import { config } from "./config";
import { db } from "./db";

export const WRITER_KEY = "prism_last_writer";
export const WRITER_AT_KEY = "prism_last_write_at";
/** A later write than this past the stamp means someone/something else wrote last. */
const STALE_MS = 10_000;

/** The opaque, stable subject id for an account email. */
export function writerIdFor(email: string): string {
  return `u_${createHmac("sha256", config.sessionSecret || "prism-writer-unkeyed").update(`prism-writer-v1:${email.trim().toLowerCase()}`).digest("hex").slice(0, 16)}`;
}

/** The stamp value for an actor, or null when there is no human writer to name. */
export function writerOf(actor: Actor | null | undefined): string | null {
  if (!actor) return null;
  if (actor.kind === "user") return writerIdFor(actor.email);
  if (actor.kind === "link") return "link";
  return null;
}

const stampPair = (who: string) => ({ [WRITER_KEY]: who, [WRITER_AT_KEY]: new Date().toISOString() });

/** `metadata` with the writer stamp applied (a copy; the input is untouched). */
export function stampMetadata(metadata: Record<string, unknown> | undefined | null, actor: Actor | null | undefined): Record<string, unknown> | undefined {
  const who = writerOf(actor);
  if (!who) return metadata ?? undefined;
  return { ...(metadata ?? {}), ...stampPair(who) };
}

/** True when JSON.parse lost precision somewhere (an integer beyond 2^53). */
function hasUnsafeNumber(v: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof v === "number") return Number.isInteger(v) && !Number.isSafeInteger(v);
  if (Array.isArray(v)) return v.some((x) => hasUnsafeNumber(x, depth + 1));
  if (v && typeof v === "object") return Object.values(v).some((x) => hasUnsafeNumber(x, depth + 1));
  return false;
}

/**
 * Stamp a raw JSON request body (the owner passthrough forwards bodies as text).
 * Only a single-note object body that WRITES content or metadata is touched
 * (review M4: a tag-/path-only PATCH stays byte-for-byte, so no metadata
 * validation is triggered on legacy notes). A body JSON.parse cannot represent
 * exactly (an integer beyond 2^53) passes through unstamped rather than being
 * re-serialised with a changed number.
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
  if (b.content === undefined && b.metadata === undefined) return text;
  const meta = b.metadata;
  if (meta !== undefined && (meta === null || typeof meta !== "object" || Array.isArray(meta))) return text;
  if (hasUnsafeNumber(b)) return text;
  b.metadata = { ...((meta as Record<string, unknown> | undefined) ?? {}), ...stampPair(who) };
  return JSON.stringify(b);
}

/**
 * Display names for every known account, keyed by subject id (for one request).
 * `allowEmail` (owners/admins ONLY) falls back to the email for an account with
 * no display name; for everyone else such an account is simply absent — a
 * non-admin viewer never learns an email from a writer stamp (review M-A).
 */
export function writerNames(allowEmail = false): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.prepare("SELECT email, name FROM users").all() as Array<{ email: string; name: string | null }>;
  for (const r of rows) {
    const name = (r.name ?? "").trim();
    if (name && (allowEmail || name.toLowerCase() !== r.email.toLowerCase())) out.set(writerIdFor(r.email), name);
    else if (allowEmail) out.set(writerIdFor(r.email), r.email);
  }
  if (allowEmail && config.ownerEmail && !out.has(writerIdFor(config.ownerEmail))) out.set(writerIdFor(config.ownerEmail), config.ownerEmail);
  return out;
}

/** The display value of a note's stamp, or null (unknown / stale / absent). */
export function resolveWriter(metadata: Record<string, unknown> | null | undefined, updatedAt: string | null | undefined, names: Map<string, string>): string | null {
  const v = metadata?.[WRITER_KEY];
  if (typeof v !== "string") return null;
  const at = Date.parse(String(metadata?.[WRITER_AT_KEY] ?? ""));
  const up = Date.parse(updatedAt ?? "");
  if (Number.isFinite(at) && Number.isFinite(up) && up - at > STALE_MS) return null;
  if (v === "link") return "Guest (link)";
  return names.get(v) ?? null;
}

export { IDENTITY_KEYS, stripIdentity } from "./identity-keys";
