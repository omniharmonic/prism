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
import { vault, VaultError, type Note } from "../parachute";
import type { Actor } from "../auth/actor";
import { getPublicationBySlug, grantsForResource, type Publication } from "../db";
import { effectiveLevel, atLeast, type NoteRef } from "../permissions";

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

/**
 * Synthetic anon actor for a publication. Its grants are the "anyone" grant(s)
 * (subject_type='anyone', resource_type='tag', resource=tag, level='view') the
 * owner created for this publication's resource — these authorize the tag.
 */
function publicationActor(pub: Publication): Actor {
  return {
    kind: "anon",
    isOwner: false,
    grants: grantsForResource(pub.resource_type, pub.resource),
  };
}

/**
 * The note set this publication exposes: notes under the publication's tag,
 * filtered to effectiveLevel >= "view" against the anon actor's grants. Mirrors
 * `visibleNotes` in api.ts — tag scoping only narrows; effectiveLevel is the
 * authoritative guard.
 */
async function publicationNotes(pub: Publication, includeContent: boolean): Promise<Note[]> {
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

// 1. Manifest.
publish.get("/:slug", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub || isExpired(pub)) return c.json({ error: "not_found" }, 404);

  let notes: Note[];
  try {
    notes = await publicationNotes(pub, false);
  } catch (e) {
    return vaultErr(c, e);
  }

  const nav: NavNote[] = notes.map((n) => ({
    id: n.id,
    title: navTitle(n),
    path: n.path,
    tags: n.tags ?? [],
  }));

  const homeNoteId = pub.home_note_id ?? nav[0]?.id ?? null;
  const homeTitle = homeNoteId ? nav.find((n) => n.id === homeNoteId)?.title : undefined;

  return c.json({
    slug: pub.id,
    title: pub.title || homeTitle || pub.resource,
    template: pub.template,
    theme: pub.theme ? (JSON.parse(pub.theme) as unknown) : null,
    homeNoteId,
    passwordRequired: !!pub.password_hash,
    notes: nav,
  });
});

// 2. Single note (read-only). Served only if it is part of the publication set:
//    effectiveLevel >= "view" AND it carries the publication's tag.
publish.get("/:slug/notes/:id", async (c) => {
  const pub = getPublicationBySlug(c.req.param("slug"));
  if (!pub || isExpired(pub)) return c.json({ error: "not_found" }, 404);

  let note: Note;
  try {
    note = await vault.getNote(c.req.param("id"));
  } catch (e) {
    return vaultErr(c, e);
  }

  const actor = publicationActor(pub);
  const tags = note.tags ?? [];
  const inPublication =
    pub.resource_type === "tag" && tags.includes(pub.resource);
  const allowed = inPublication && atLeast(effectiveLevel(actor.grants, ref(note), false), "view");
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
