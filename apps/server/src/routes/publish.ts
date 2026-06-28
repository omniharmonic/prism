/**
 * Public publication router (mounted at /p by the integrator).
 *
 * This is the anonymous, read-only path: there is NO actor cookie/capability —
 * we synthesize an anon actor whose grants are exactly the "anyone" grant(s) the
 * owner created for the publication's tag at publish time. From there it reuses
 * the SAME authorization spine as the gateway (api.ts): effectiveLevel is the
 * only guard; the publication's tag merely NARROWS what we fetch.
 *
 * It NEVER calls proxyToVault and never exposes the vault token — it only calls
 * vault.* helpers AFTER an effectiveLevel >= "view" check, and the single-note
 * route additionally requires the note to actually carry the publication's tag
 * (defense-in-depth: a reader must not pull an arbitrary note id by guessing).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import { vault, VaultError, type Note } from "../parachute";
import type { Actor } from "../auth/actor";
import { getPublicationBySlug, grantsForResource, type Publication } from "../db";
import { effectiveLevel, atLeast, type NoteRef } from "../permissions";
import { pathInPrefix } from "../paths";
import { config } from "../config";
import { verifyPassword } from "../auth/password";

export const publish = new Hono();

const ref = (n: Note): NoteRef => ({ id: n.id, tags: n.tags ?? [] });

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
 * effectiveLevel/tag-membership checks — never a replacement for them.
 */
function unlocked(c: Context, pub: Publication): boolean {
  if (!pub.password_hash) return true;
  return verifyUnlock(pub.id, getCookie(c, unlockCookieName(pub.id)));
}

/**
 * Synthetic anon actor for a publication. Its grants are ONLY the "anyone"
 * grant(s) (subject_type='anyone', resource_type='tag', resource=tag,
 * level='view') the owner created at publish time. We deliberately FILTER OUT
 * any user-/link-/peer-scoped grants that also happen to sit on the same tag —
 * an anonymous visitor must never inherit a specific person's higher (edit/own)
 * grant. (Defense-in-depth: today every /api/p route only needs `view`, but this
 * keeps the anon actor from ever computing a level above what `anyone` allows.)
 */
function publicationActor(pub: Publication): Actor {
  return {
    kind: "anon",
    isOwner: false,
    grants: grantsForResource(pub.resource_type, pub.resource).filter((g) => g.subject_type === "anyone"),
  };
}

/**
 * The note set this publication exposes.
 *
 * - `tag` pubs: notes under the publication's tag, filtered to
 *   effectiveLevel >= "view" against the anon actor's grants. Mirrors
 *   `visibleNotes` in api.ts — tag scoping only narrows; effectiveLevel is the
 *   authoritative guard.
 * - `path` pubs: notes whose `path` is inside the publication's prefix. The
 *   path-membership predicate (evaluated on the vault's OWN `path` field) is the
 *   authoritative, read-only, view-level guard — grants/effectiveLevel play no
 *   part. We fetch all notes and filter in-process because Parachute's `?path=`
 *   is an exact match, not a prefix filter; publish.ts must guarantee prefix
 *   membership itself regardless.
 */
async function publicationNotes(pub: Publication, includeContent: boolean): Promise<Note[]> {
  if (pub.resource_type === "path") {
    const notes = await vault.listNotes({ includeContent });
    return notes.filter((n) => pathInPrefix(n.path, pub.resource));
  }
  const actor = publicationActor(pub);
  const notes = await vault.listNotes({ tags: [pub.resource], includeContent });
  return notes.filter((n) => atLeast(effectiveLevel(actor.grants, ref(n), false), "view"));
}

/** First non-empty heading/line of the content → text; fallback "Untitled". */
function deriveTitle(content: string | null | undefined): string {
  for (const raw of (content ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    return line.replace(/^#+\s*/, "").trim() || "Untitled";
  }
  return "Untitled";
}

/** Title for the nav list, where content isn't fetched (cheap). Prefer the
 *  content heading when present, else the note's path basename (sans extension),
 *  else "Untitled". */
function navTitle(note: Note): string {
  if (note.content && note.content.trim()) return deriveTitle(note.content);
  const base = (note.path ?? "").split("/").pop() ?? "";
  const cleaned = base.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  return cleaned || "Untitled";
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

  if (!locked) {
    let notes: Note[];
    try {
      notes = await publicationNotes(pub, false);
    } catch (e) {
      return vaultErr(c, e);
    }

    nav = notes.map((n) => ({
      id: n.id,
      title: navTitle(n),
      path: n.path,
      tags: n.tags ?? [],
    }));

    homeNoteId = pub.home_note_id ?? nav[0]?.id ?? null;
    homeTitle = homeNoteId ? nav.find((n) => n.id === homeNoteId)?.title : undefined;
  }

  return c.json({
    slug: pub.id,
    title: pub.title || homeTitle || pub.resource,
    template: pub.template,
    theme: pub.theme ? (JSON.parse(pub.theme) as unknown) : null,
    homeNoteId,
    passwordRequired,
    notes: nav,
  });
});

// 1b. Graph — built ONLY from the publication's own note set. Nodes are the
//     in-set notes; edges are wikilinks ([[target]]) whose target resolves to
//     ANOTHER in-set note. Any wikilink that points outside the set is dropped,
//     so no private/out-of-publication node or edge can ever appear.
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Strip a path to its basename without extension, lowercased. */
function pathKey(path: string | null | undefined): string {
  const base = (path ?? "").split("/").pop() ?? "";
  return base.replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();
}

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

  // Nodes: the authoritative in-set list. ids only ever come from here.
  const nodes = notes.map((n) => ({ id: n.id, title: navTitle(n) }));

  // Resolver: maps various wikilink target forms → an in-set note id. ONLY
  // in-set notes populate it, so a target that resolves at all is in-set.
  const byKey = new Map<string, string>();
  const put = (key: string | null | undefined, id: string) => {
    const k = (key ?? "").trim();
    if (k) byKey.set(k.toLowerCase(), id);
  };
  for (const n of notes) {
    byKey.set(n.id, n.id); // exact id (case-sensitive)
    put(n.path, n.id); // full path
    put(pathKey(n.path), n.id); // path basename sans extension
    put(deriveTitle(n.content), n.id); // derived title
  }

  const resolve = (target: string): string | undefined => {
    const raw = target.trim();
    if (byKey.has(raw)) return byKey.get(raw); // exact id
    const lower = raw.toLowerCase();
    if (byKey.has(lower)) return byKey.get(lower);
    return byKey.get(pathKey(raw)); // treat as a path → basename
  };

  // Edges: in-set → in-set only. De-duplicated.
  const seen = new Set<string>();
  const edges: { source: string; target: string }[] = [];
  for (const n of notes) {
    const content = n.content ?? "";
    for (const m of content.matchAll(WIKILINK_RE)) {
      const target = (m[1] ?? "").split("|")[0] ?? ""; // drop |display
      const resolved = resolve(target);
      // Anti-leak rule: emit only when target resolves to an in-set id
      // (resolver is built from in-set notes only) and isn't a self-loop.
      if (!resolved || resolved === n.id) continue;
      const key = `${n.id} ${resolved}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: n.id, target: resolved });
    }
  }

  return c.json({ nodes, edges });
});

// 2. Single note (read-only). Served only if it is part of the publication set:
//    - tag pubs: effectiveLevel >= "view" AND it carries the publication's tag;
//    - path pubs: its `path` is inside the publication's prefix.
//    Either way an out-of-set id is forbidden (no id-guessing into private notes).
publish.get("/:slug/notes/:id", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub || isExpired(pub)) return c.json({ error: "not_found" }, 404);
  if (pub.password_hash && !unlocked(c, pub)) return c.json({ error: "locked" }, 401);

  let note: Note;
  try {
    note = await vault.getNote(c.req.param("id"));
  } catch (e) {
    return vaultErr(c, e);
  }

  const tags = note.tags ?? [];
  const allowed =
    pub.resource_type === "path"
      ? pathInPrefix(note.path, pub.resource)
      : tags.includes(pub.resource) &&
        atLeast(effectiveLevel(publicationActor(pub).grants, ref(note), false), "view");
  if (!allowed) return c.json({ error: "forbidden" }, 403);

  return c.json({
    id: note.id,
    content: note.content,
    path: note.path,
    tags,
    metadata: note.metadata,
    title: deriveTitle(note.content),
  });
});
