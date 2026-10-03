import { readerPresentationTheme } from "../publication-presentation";
import { stripIdentity } from "../writer-stamp";
import { publicationGraph, publicationMap, geometryOf, geoOf } from "../publication-projections";
/**
 * Public publication router (mounted at /p by the integrator).
 *
 * This is the anonymous, read-only path: there is NO actor cookie/capability —
 * we synthesize an anon actor whose grants are exactly the "anyone" grant(s) the
 * owner created for the publication's tag at publish time. From there it reuses
 * the SAME authorization spine as the gateway (api.ts): effectiveCaps is the
 * only guard; the publication's tag merely NARROWS what we fetch.
 *
 * It NEVER calls proxyToVault and never exposes the vault token — it only calls
 * vault.* helpers AFTER a `view`-cap (canPublicView) check, and the single-note
 * route additionally requires the note to actually carry the publication's tag
 * (defense-in-depth: a reader must not pull an arbitrary note id by guessing).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import { VaultError, type Note } from "../parachute";
import { getPublicationBySlug, excludedNoteIds, publicationVaultId, type Publication } from "../db";
import { pathPublicationIncludes } from "../paths";
import { config } from "../config";
import { publicationActor, canPublicView, pubVault, publicationNotes, deriveTitle, navTitle } from "../publication-content";
export { canPublicView } from "../publication-content";
import { verifyPassword } from "../auth/password";
import { servableAttachment, attachmentOwningNote, serveAttachment } from "./attachments";
import { consumeRateLimit, rateLimitClientKey } from "../middleware/ratelimit";

export const publish = new Hono();

/** Local equivalent of api.ts `vaultErr` (not exported there): 404 → 404, else 502/500. */
function vaultErr(c: Context, e: unknown) {
  if (e instanceof VaultError) {
    if (e.status === 404) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "vault_error", status: e.status }, 502);
  }
  return c.json({ error: "server_error" }, 500);
}

/** A publication is expired (and so treated as not found) once past expires_at. */
const isExpired = (pub: Publication): boolean =>
  pub.expires_at != null && pub.expires_at < Date.now();

// ── Password gate (optional, per-publication) ──────────────────────────────
// A password-protected publication ships an HMAC-signed "unlock" cookie once the
// visitor proves the password. The cookie is per-slug (`pub_<slug>`), httpOnly,
// and signed over {slug, exp} with CAPABILITY_SECRET — mirroring auth/capability
// (body.sig, base64url). No db lookup is needed to verify it; it merely proves
// "this slug was unlocked, not yet expired". The password itself is checked
// (scrypt, constant-time) by verifyPassword against pub.password_hash.

const UNLOCK_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const unlockCookieName = (slug: string): string => `pub_${slug}`;

const signUnlockBody = (body: string): string =>
  createHmac("sha256", config.capabilitySecret).update(body).digest("base64url");

/** Signed unlock token for a slug: `base64url({slug,exp}).hmac`. */
function signUnlock(slug: string): string {
  const body = Buffer.from(
    JSON.stringify({ slug, exp: Date.now() + UNLOCK_TTL_MS }),
  ).toString("base64url");
  return `${body}.${signUnlockBody(body)}`;
}

/** Verify an unlock token belongs to `slug` and hasn't expired. */
function verifyUnlock(slug: string, token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = signUnlockBody(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  let claims: { slug?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (claims.slug !== slug) return false;
  if (typeof claims.exp !== "number" || claims.exp < Date.now()) return false;
  return true;
}

/**
 * Whether the request may see this publication's contents: an open (no-password)
 * publication is always unlocked; a password-gated one requires a valid
 * `pub_<slug>` unlock cookie. This is an ADDITIONAL gate layered on top of the
 * view-cap/tag-membership checks — never a replacement for them.
 */
function unlocked(c: Context, pub: Publication): boolean {
  if (!pub.password_hash) return true;
  return verifyUnlock(pub.id, getCookie(c, unlockCookieName(pub.id)));
}

interface NavNote {
  id: string;
  title: string;
  path: string | null;
  tags: string[];
}

// 0. Unlock: exchange the publication password for a signed `pub_<slug>` cookie.
//    Returns a generic 401 on a bad password (no account/secret enumeration).
publish.post("/:slug/auth", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub || isExpired(pub)) return c.json({ error: "not_found" }, 404);

  let body: { password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const password = typeof body.password === "string" ? body.password : "";

  if (!pub.password_hash || !verifyPassword(password, pub.password_hash)) {
    return c.json({ error: "invalid_password" }, 401);
  }

  setCookie(c, unlockCookieName(pub.id), signUnlock(pub.id), {
    httpOnly: true,
    secure: config.appOrigin.startsWith("https"),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(UNLOCK_TTL_MS / 1000),
  });
  return c.json({ ok: true });
});

// 1. Manifest. The slug/title/template/passwordRequired identity is always
//    returned so the client can render the unlock prompt; but when the
//    publication is password-gated AND not unlocked we withhold the nav
//    (notes: [], homeNoteId: null) so a locked site never leaks its structure.
publish.get("/:slug", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub || isExpired(pub)) return c.json({ error: "not_found" }, 404);

  const passwordRequired = !!pub.password_hash;
  const locked = passwordRequired && !unlocked(c, pub);

  let nav: NavNote[] = [];
  let homeNoteId: string | null = null;
  let homeTitle: string | undefined;
  let mapFeatureCount = 0;

  if (!locked) {
    let notes: Note[];
    try {
      notes = await publicationNotes(pub, false);
    } catch (e) {
      return vaultErr(c, e);
    }

    // How many in-set notes carry real geometry (or a geo centroid) — lets the
    // client offer a Map view without fetching the (potentially large) feature
    // payload up front. Same location predicate as the /map route.
    mapFeatureCount = notes.filter(
      (n) => geometryOf(n.metadata as Record<string, unknown> | null) != null || geoOf(n.metadata as Record<string, unknown> | null) != null,
    ).length;

    nav = notes.map((n) => ({
      id: n.id,
      title: navTitle(n),
      path: n.path,
      tags: n.tags ?? [],
    }));

    // Home must be an in-set note. An unset home — or one pointing at a note
    // that's been excluded / fallen out of the set — degrades to nav[0].
    const homeInSet = pub.home_note_id && nav.some((n) => n.id === pub.home_note_id);
    homeNoteId = (homeInSet ? pub.home_note_id : nav[0]?.id) ?? null;
    homeTitle = homeNoteId ? nav.find((n) => n.id === homeNoteId)?.title : undefined;
  }

  return c.json({
    slug: pub.id,
    title: pub.title || homeTitle || pub.resource,
    template: pub.template,
    theme: readerPresentationTheme(pub.theme ? JSON.parse(pub.theme) : null, nav.map(n => n.id)),
    homeNoteId,
    passwordRequired,
    locked,
    notes: nav,
    mapFeatureCount,
  });
});

// 1b. Graph — built ONLY from the publication's own note set. Nodes are the
//     in-set notes; edges are wikilinks ([[target]]) whose target resolves to
//     ANOTHER in-set note. Any wikilink that points outside the set is dropped,
//     so no private/out-of-publication node or edge can ever appear.
publish.get("/:slug/graph", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub || isExpired(pub)) return c.json({ error: "not_found" }, 404);
  if (pub.password_hash && !unlocked(c, pub)) return c.json({ error: "locked" }, 401);

  let notes: Note[];
  try {
    notes = await publicationNotes(pub, true);
  } catch (e) {
    return vaultErr(c, e);
  }

  return c.json(publicationGraph(notes));
});

// 1c. Map — geospatial features of the publication's own note set, and NOTHING
//     else. Built from the same authoritative `publicationNotes` set as the
//     manifest/graph (excluded ids already dropped, view-cap/tag scoping
//     applied), so a private or out-of-set note's geometry can never appear.
//     Emits only what the map needs (id/title/kind/geometry/geo) — never the
//     full metadata blob.

/** The geo tags that drive a feature's color/legend bucket (mirrors the
 *  desktop MapRenderer's GEO_TAGS/kindOf). */
publish.get("/:slug/map", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub || isExpired(pub)) return c.json({ error: "not_found" }, 404);
  if (pub.password_hash && !unlocked(c, pub)) return c.json({ error: "locked" }, 401);

  let notes: Note[];
  try {
    notes = await publicationNotes(pub, false);
  } catch (e) {
    return vaultErr(c, e);
  }

  return c.json({features: publicationMap(notes)});
});

// 2. Single note (read-only). Served only if it is part of the publication set:
//    - tag pubs: the `view` cap (canPublicView) AND it carries the publication's tag;
//    - path pubs: its path is in the prefix and its visibility is not private.
//    Either way an out-of-set id is forbidden (no id-guessing into private notes).
publish.get("/:slug/notes/:id", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub || isExpired(pub)) return c.json({ error: "not_found" }, 404);
  if (pub.password_hash && !unlocked(c, pub)) return c.json({ error: "locked" }, 401);

  let note: Note;
  try {
    note = await pubVault(pub).getNote(c.req.param("id"));
  } catch (e) {
    return vaultErr(c, e);
  }

  const tags = note.tags ?? [];
  if (!inPublication(pub, note)) return c.json({ error: "forbidden" }, 403);

  return c.json({
    id: note.id,
    content: note.content,
    path: note.path,
    tags,
    // The public never learns who created or last edited a page (writer-stamp.ts).
    metadata: stripIdentity(note.metadata),
    title: deriveTitle(note.content),
  });
});

/** Is this note part of the publication's public set? (The single-note rule.)
 *  An explicitly-excluded id is treated exactly like an out-of-set id — same
 *  leak-proofing: no id-guessing into a note the owner tended away. */
function inPublication(pub: Publication, note: Note): boolean {
  if (new Set(excludedNoteIds(pub)).has(note.id)) return false;
  return pub.resource_type === "path"
    ? pathPublicationIncludes(note, pub.resource)
    : (note.tags ?? []).includes(pub.resource) && canPublicView(publicationActor(pub).grants, note);
}

const PUBLIC_ATTACHMENT_READS_PER_MINUTE = Number(process.env.PUBLIC_ATTACHMENT_READS_PER_MINUTE) || 600;

// 3. An attachment of a PUBLISHED note (wave 3). Anonymous, publication-scoped:
//    served only when (a) the publication is live and unlocked, (b) the row lives
//    in the publication's own vault, (c) its owning note is in the public set by
//    the SAME rule as the single-note route, and (d) the note's current body or
//    metadata still references this attachment id — a file removed from the page
//    is no longer public, even to someone who kept its id. Every refusal after
//    the slug/lock checks is one uniform 404. Bytes + headers come from the same
//    hardened responder as GET /api/attachments/:id.
publish.get("/:slug/attachments/:id", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub || isExpired(pub)) return c.json({ error: "not_found" }, 404);
  if (pub.password_hash && !unlocked(c, pub)) return c.json({ error: "locked" }, 401);
  const retry = consumeRateLimit(`pub-attach:${rateLimitClientKey(c)}`, PUBLIC_ATTACHMENT_READS_PER_MINUTE, 60_000);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "rate_limited", retryAfter: retry }, 429);
  }
  const row = servableAttachment(c.req.param("id"));
  if (!row || row.vault_id !== publicationVaultId(pub)) return c.json({ error: "not_found" }, 404);
  let note: Note | null;
  try {
    note = await attachmentOwningNote(row);
  } catch {
    return c.json({ error: "vault_unreachable" }, 502);
  }
  if (!note || !inPublication(pub, note)) return c.json({ error: "not_found" }, 404);
  const ref = `/api/attachments/${row.id}`;
  const referenced = (note.content ?? "").includes(ref) || JSON.stringify(note.metadata ?? {}).includes(ref);
  if (!referenced) return c.json({ error: "not_found" }, 404);
  return serveAttachment(c, row);
});
