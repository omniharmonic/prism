/**
 * `GET /api/search` — full-text search with filters and match offsets
 * (NP-SR-03 highlighting, NP-SR-04 filters). Mounted in `api.ts` BEFORE the
 * owner short-circuit so owners and non-owners get the same shape; it replaces
 * the old non-owner-only handler (same params, same `Note[]` body, plus
 * `_matches` per row).
 *
 * Query: `q` (≤200 chars, required), `limit` (1–100, default 50), `title=1`
 * (match titles only), `type=document,database` (inferContentType), `tag=a,b`
 * (all required), `author=<email>|me` (the CREATOR, `prism_creator`), `editor=me|<email>`
 * (the LAST EDITOR: the account's opaque writer-stamp id against `prism_last_writer`;
 * signed-in users only, anyone but an admin may only say `me`),
 * `after`/`before` (YYYY-MM-DD or ISO, inclusive), `date=created` (default:
 * updated), `lean=1` (drop `content` from rows; the snippet still comes back).
 *
 * Security: every row passes `effectiveCaps(...).has("view")` (owner/admin:
 * all), trashed pages are excluded, the private-note rule applies through the
 * same caps. Filters run AFTER the view filter, so a filter can only narrow
 * what the caller can already read and no count/total is returned. One vault
 * call per request (≤100 rows, identical in-flight queries coalesced); snippets
 * read ≤20 KB per note through a linear scanner; per-actor rate limit
 * `SEARCH_RATE_PER_MINUTE` (owner 600, others 120).
 */
import { Hono, type Context } from "hono";
import { vaultClient, VaultError, type Note } from "../parachute";
import { resolveActor, type Actor } from "../auth/actor";
import { effectiveCaps, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import { consumeRateLimit } from "../middleware/ratelimit";
import { forViewer } from "../sharing";
import { writerIdFor } from "../writer-stamp";
import { isTrashed } from "@prism/core/pages";
import { inferContentType } from "@prism/core/content-types";
import { hasFilters, matchesFilters, MAX_QUERY_LENGTH, parseSearchFilters, queryTerms, searchMatches } from "@prism/core/search";

export const searchApi = new Hono();

const ref = (n: Note): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  path: n.path ?? null, // page-subtree grants (wave 2D)
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
});
const actorSubject = (a: Actor): string | null => (a.kind === "user" ? a.email : a.kind === "link" ? a.capabilityId : null);
const capsFor = (actor: Actor, note: NoteRef): Set<Cap> =>
  effectiveCaps(actor.grants, note, roleFloor(actor.role), actorSubject(actor));

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const FETCH_MAX = 100;
/** Identical in-flight searches (same vault, query, size) share ONE vault call — a
 *  debounced keystroke from several tabs/devices must not queue N full-text scans.
 *  Only the raw vault rows are shared; every caller is permission-filtered after. */
const inFlight = new Map<string, Promise<Note[]>>();
function sharedVaultSearch(vaultId: string, q: string, limit: number): Promise<Note[]> {
  const key = JSON.stringify([vaultId, q, limit]);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = vaultClient(vaultId).search(q, [], limit).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/**
 * What this route can filter by — so a client can tell a server that knows `editor=` from an
 * older one that would silently ignore it (and hide the control instead of misleading).
 * `identity` = the caller is a signed-in account ("created / edited by me" mean something).
 */
searchApi.get("/search/filters", (c: Context) => {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return c.json({ error: "unauthorized" }, 401);
  return c.json({ filters: ["author", "editor"], identity: actor.kind === "user" });
});

searchApi.get("/search", async (c: Context) => {
  const actor = resolveActor(c);
  const admin = roleAtLeast(actor.role, "admin");
  const who = actor.kind === "user" ? `u:${actor.email}` : actor.kind === "link" ? `l:${actor.capabilityId}` : `anon:${c.req.header("x-forwarded-for") ?? "local"}`;
  const wait = consumeRateLimit(`search:${who}`, envInt("SEARCH_RATE_PER_MINUTE", admin ? 600 : 120), 60_000);
  if (wait !== null) {
    c.header("Retry-After", String(wait));
    return c.json({ error: "rate_limited", retryAfter: wait }, 429);
  }
  const q = (c.req.query("q") ?? c.req.query("search") ?? "").trim();
  if (q.length > MAX_QUERY_LENGTH) return c.json({ error: "bad_request", detail: "query_too_long" }, 400);
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 50;
  if (!q) return c.json([]);
  const filters = parseSearchFilters((name) => c.req.query(name));
  // `author=me` = the signed-in account; a link or anon caller has no "me".
  if (filters.author === "me") {
    if (actor.kind !== "user") return c.json([]);
    filters.author = actor.email.toLowerCase();
  }
  // Someone else's address would be an oracle for who created a page (emails are
  // not shown to non-admins): a non-admin may only filter by their own.
  if (filters.author && !admin && (actor.kind !== "user" || filters.author !== actor.email.toLowerCase())) return c.json([]);
  // `editor` = who last edited. The stamp is an opaque id (writer-stamp.ts), so the address is turned
  // into that id here. Signed-in users only; anyone but an admin may only ask about themselves (no
  // oracle for who edited a page), and a raw stamp id from a client is never honoured.
  if (filters.editor) {
    if (actor.kind !== "user") return c.json([]);
    const who = filters.editor === "me" ? actor.email.toLowerCase() : filters.editor;
    if (!who.includes("@") || (!admin && who !== actor.email.toLowerCase())) return c.json([]);
    filters.editor = writerIdFor(who);
  }
  const lean = c.req.query("lean") === "1";
  const terms = queryTerms(q);
  // Filters and the view filter both narrow after the vault answers, so ask for
  // more than we return — but never more than 100 rows (the vault returns bodies).
  const fetchLimit = Math.min(FETCH_MAX, admin && !hasFilters(filters) ? limit : limit * 4);
  let results: Note[];
  try {
    results = await sharedVaultSearch(actor.vaultId, q, fetchLimit);
  } catch (e) {
    if (e instanceof VaultError) return c.json({ error: "vault_error", status: e.status }, 502);
    return c.json({ error: "server_error" }, 500);
  }
  const stamp = actor.kind === "user" && !admin;
  const out: Array<Record<string, unknown>> = [];
  for (const n of results) {
    if (out.length >= limit) break;
    if (!n || typeof n.id !== "string" || isTrashed(n)) continue;
    let caps: Set<Cap> | null = null;
    if (!admin) {
      caps = capsFor(actor, ref(n));
      if (!caps.has("view")) continue;
    }
    if (!matchesFilters(n, filters, terms, (note) => inferContentType(note as Note))) continue;
    // A non-admin never receives attribution keys or a creator email (2D review M3/M-B).
    const row: Record<string, unknown> = { ...(admin ? n : forViewer(actor, n)), _matches: searchMatches(n, terms) };
    if (lean) delete row.content;
    if (stamp && caps) row._caps = [...caps];
    out.push(row);
  }
  return c.json(out);
});
