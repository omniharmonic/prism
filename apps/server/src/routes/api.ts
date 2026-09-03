/**
 * The permission gateway. Every route resolves the actor, then either serves
 * the owner the full vault or a non-owner ONLY what their grants allow — never
 * the vault token, never a note they lack at least "view" on. The vault proxy
 * (which holds the token) is reached only after authorization passes here.
 *
 * Non-owner reads are bounded two ways: list/search start from the actor's
 * granted tags (+ per-note grants), then a final capability filter is the
 * authoritative guard (so a tag query can never leak a note the permission math
 * rejects). Writes check the CAPS the actor holds on the specific note — for a
 * grant that carries no explicit caps those are exactly its level's expansion,
 * so the pre-caps behavior is unchanged (see permissions.ts).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { resolveVaultEntry } from "../db";
import { vault, vaultClient, VaultError, VaultConflictError, type Note } from "../parachute";
import { resolveActor, type Actor } from "../auth/actor";
import { effectiveLevel, effectiveCaps, grantedTags, type Cap, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";

export const api = new Hono();

const ref = (n: Note): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
});

/** The grant subject of an actor (for the private-note creator check). */
const actorSubject = (a: Actor): string | null =>
  a.kind === "user" ? a.email : a.kind === "link" ? a.capabilityId : null;

/**
 * The actor's capabilities on a note (P1). Same inputs as `effectiveLevel` — for
 * a grant that carries no explicit caps it is exactly that level's expansion, so
 * routing a check through caps never changes the answer for existing grants.
 */
const capsFor = (actor: Actor, note: NoteRef): Set<Cap> =>
  effectiveCaps(actor.grants, note, roleFloor(actor.role), actorSubject(actor));

const can = (actor: Actor, note: NoteRef, cap: Cap): boolean => capsFor(actor, note).has(cap);

/**
 * Transparent proxy to the vault for the OWNER only. Forwards the exact path,
 * query, method, and body with the server-held token, so the owner's web app
 * works identically to the direct client — minus the token, which never leaves
 * this process. Non-owners never reach this (they hit the allowlisted routes
 * below, or the final 403 catch-all).
 */
async function proxyToVault(c: Context) {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/api/, "");
  // Phase-1 multi-vault: the owner may bind a request to a specific vault via the
  // `X-Prism-Vault` header (an id from the registry). No header → the primary
  // entry → byte-for-byte the previous single-vault behavior. Only the owner
  // passthrough is vault-aware; non-owner routes stay on the primary (Phase 2).
  const entry = resolveVaultEntry(c.req.header("x-prism-vault"));
  const target = `${entry.url}/vault/${entry.vault}/api${path}${url.search}`;
  const method = c.req.method;
  const headers: Record<string, string> = { Authorization: `Bearer ${entry.token}` };
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    init.body = await c.req.text();
  }
  const resp = await fetch(target, init);
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: { "Content-Type": resp.headers.get("content-type") ?? "application/json" },
  });
}

// Owner short-circuit: full vault access, token-free. Registered before the
// authorized routes so the owner bypasses per-note filtering entirely.
api.use("*", async (c, next) => {
  if (roleAtLeast(resolveActor(c).role, "admin")) return proxyToVault(c);
  await next();
});

function vaultErr(c: Context, e: unknown) {
  // Optimistic-concurrency conflict: pass the vault's status + current state
  // through so the client can rebase, instead of collapsing it to a 502. (Checked
  // before VaultError since VaultConflictError extends it.)
  if (e instanceof VaultConflictError) {
    return c.json({ error: "conflict", status: e.status, current: e.body }, e.status === 428 ? 428 : 409);
  }
  if (e instanceof VaultError) {
    if (e.status === 404) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "vault_error", status: e.status }, 502);
  }
  return c.json({ error: "server_error" }, 500);
}

/**
 * Notes a non-owner may see: union of (notes under each granted tag) and
 * (individually granted notes), then filtered to "holds the `view` cap".
 * Per-tag queries (not a single multi-tag query) avoid AND/OR ambiguity in the
 * vault's tag filter.
 */
async function visibleNotes(actor: Actor, includeContent: boolean): Promise<Note[]> {
  const vc = vaultClient(actor.vaultId); // read from the actor's OWN vault, not the primary
  const collected = new Map<string, Note>();
  for (const tag of grantedTags(actor.grants)) {
    for (const n of await vc.listNotes({ tags: [tag], includeContent })) {
      collected.set(n.id, n);
    }
  }
  for (const g of actor.grants.filter((x) => x.resource_type === "note")) {
    if (collected.has(g.resource)) continue;
    try {
      collected.set(g.resource, await vc.getNote(g.resource));
    } catch {
      /* granted note may have been deleted — skip */
    }
  }
  return [...collected.values()].filter((n) => can(actor, ref(n), "view"));
}

api.get("/health", async (c) => c.json({ vault: await vault.health() }));

api.get("/notes", async (c) => {
  const actor = resolveActor(c);
  const includeContent = c.req.query("include_content") === "true";
  if (roleAtLeast(actor.role, "admin")) {
    const limit = Number(c.req.query("limit") ?? 50000);
    return c.json(await vault.listNotes({ includeContent, limit }));
  }
  return c.json(await visibleNotes(actor, includeContent));
});

api.get("/notes/:id", async (c) => {
  const actor = resolveActor(c);
  let note: Note;
  try {
    note = await vaultClient(actor.vaultId).getNote(c.req.param("id"));
  } catch (e) {
    return vaultErr(c, e);
  }
  const level = effectiveLevel(actor.grants, ref(note), roleFloor(actor.role), actorSubject(actor));
  // Read gate on the `view` CAP: for a level-only grant this is exactly
  // atLeast(level, "view"); a caps grant that omits `view` (e.g. ["create"])
  // correctly reads nothing even though its ladder projection floors at "view".
  if (!can(actor, ref(note), "view")) return c.json({ error: "forbidden" }, 403);
  return c.json({ ...note, _level: level });
});

api.post("/notes", async (c) => {
  const actor = resolveActor(c);
  // Owners/admins are short-circuited to the passthrough upstream; this handler
  // runs for members/guests/links. A signed-in MEMBER may create — but only
  // inside a tag/folder they can already EDIT, so a create can't smuggle a note
  // into an area they lack access to. Guests/links/anon cannot create.
  const body = await c.req.json<{
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }>();
  const subject = actorSubject(actor);
  const slice: NoteRef = { id: "<new>", tags: body.tags ?? [] };
  // The `create` CAP on the target tag slice. `edit` expands to include create,
  // so every pre-caps edit grant still creates exactly as before; a caps grant can
  // now say "may add notes here" WITHOUT conferring edit on what is already there.
  const canCreate = actor.kind === "user" && capsFor(actor, slice).has("create");
  if (!canCreate) {
    return c.json({ error: "forbidden", reason: "create requires the create capability on the target tag/folder" }, 403);
  }
  // Stamp the creator (private-to-creator + audit). A member can't forge it — we
  // overwrite any client-supplied prism_creator with the authenticated subject.
  const metadata = { ...(body.metadata ?? {}), ...(subject ? { prism_creator: subject } : {}) };
  try {
    return c.json(await vaultClient(actor.vaultId).createNote({ ...body, metadata }));
  } catch (e) {
    return vaultErr(c, e);
  }
});

api.patch("/notes/:id", async (c) => {
  const actor = resolveActor(c);
  const id = c.req.param("id");
  const vc = vaultClient(actor.vaultId);
  let note: Note;
  try {
    note = await vc.getNote(id);
  } catch (e) {
    return vaultErr(c, e);
  }
  const noteRef = ref(note);
  const caps = capsFor(actor, noteRef);

  const body = await c.req.json<{
    content?: string;
    metadata?: Record<string, unknown>;
    path?: string;
    add_tags?: string[];
    remove_tags?: string[];
    if_updated_at?: string;
  }>();

  const strings = (x: unknown): string[] =>
    Array.isArray(x) ? [...new Set(x.filter((t): t is string => typeof t === "string" && t.length > 0))] : [];
  const addTags = strings(body.add_tags);
  const removeTags = strings(body.remove_tags);
  const wantsContent = body.content !== undefined || body.metadata !== undefined;
  const wantsTags = addTags.length > 0 || removeTags.length > 0;
  const wantsPath = body.path !== undefined;
  // `organize` is what unlocks a note's PATH (previously admin-only). Admins never
  // reach this handler — they short-circuit to the passthrough — but the role check
  // is kept so the rule reads as organize-OR-admin.
  const canPath = caps.has("organize") || roleAtLeast(actor.role, "admin");

  // CONTENT/METADATA need `edit` (what "edit level" has always meant). A request
  // that only REORGANIZES — tags, or a path the actor may set — does not; organize
  // alone suffices. A path change the actor may NOT make still falls through to the
  // edit check, so it stays silently dropped for an editor (pre-caps behavior) and
  // 403s for anyone weaker instead of echoing the note back. An empty body keeps
  // the old contract and is treated as a content write.
  const needsEdit = wantsContent || (!wantsTags && !(wantsPath && canPath));
  if (needsEdit && !caps.has("edit")) return c.json({ error: "forbidden" }, 403);

  // TAGS need `organize`. Retagging re-scopes a note, so it is a distinct power
  // from editing its body — an editor cannot move a note between folders.
  if (wantsTags && !caps.has("organize")) {
    return c.json({ error: "forbidden", reason: "changing tags requires the organize capability" }, 403);
  }

  // ── anti-escalation for `organize` ─────────────────────────────────────────
  // (a) ADDING a tag must not smuggle the note into a scope the actor has no
  //     standing in: each added tag must be one where they hold `create` or
  //     `organize` (via a tag or vault grant — evaluated against a synthetic ref
  //     carrying just that tag). Otherwise a lone organize grant on one folder
  //     could push notes into every other folder in the vault.
  // (b) REMOVING a tag may only name a tag the note actually carries, and must
  //     not drop the actor's OWN effective access below `view` — otherwise they
  //     orphan the note out of their own reach (an irreversible foot-gun, and a
  //     way to make a note invisible to everyone whose access came via that tag).
  if (addTags.length) {
    const forbidden = addTags.filter((t) => {
      const slice = capsFor(actor, { id: "<retag>", tags: [t] });
      return !(slice.has("create") || slice.has("organize"));
    });
    if (forbidden.length) {
      return c.json(
        { error: "forbidden", reason: `cannot add tags outside your scope: ${forbidden.join(", ")}`, tags: forbidden },
        403,
      );
    }
  }
  const current = new Set(note.tags ?? []);
  if (removeTags.length) {
    const missing = removeTags.filter((t) => !current.has(t));
    if (missing.length) {
      return c.json({ error: "bad_request", reason: `note does not carry: ${missing.join(", ")}`, tags: missing }, 400);
    }
    const after = new Set(current);
    for (const t of removeTags) after.delete(t);
    for (const t of addTags) after.add(t);
    const post = capsFor(actor, { ...noteRef, tags: [...after] });
    if (!post.has("view")) {
      return c.json(
        { error: "bad_request", reason: "removing those tags would drop your own access to this note" },
        400,
      );
    }
  }

  try {
    // Non-owners may change content/metadata (with `edit`) and path/tags (with
    // `organize`). A path change without organize is dropped, not rejected —
    // the pre-caps behavior for an editor who sends one.
    const wantsWrite = wantsContent || (canPath && wantsPath) || (!wantsTags && !wantsPath);
    let updated = note;
    if (wantsWrite) {
      updated = await vc.updateNote(id, {
        content: body.content,
        metadata: body.metadata,
        path: canPath ? body.path : undefined,
        ifUpdatedAt: body.if_updated_at ?? note.updatedAt ?? undefined,
      });
    }
    if (wantsTags) {
      // Separate vault calls (the REST tag ops are add/remove deltas). Remove
      // first so an add wins on an overlapping name; re-read for the final shape.
      if (removeTags.length) await vc.removeTags(id, removeTags);
      if (addTags.length) await vc.addTags(id, addTags);
      updated = await vc.getNote(id);
    }
    return c.json(updated);
  } catch (e) {
    return vaultErr(c, e);
  }
});

api.delete("/notes/:id", async (c) => {
  const actor = resolveActor(c);
  // Admins/owners short-circuit to the passthrough (they can delete anything);
  // this handler runs for members/guests/links. A member may delete ONLY their
  // own note (prism_creator) and only with edit+ on it — never someone else's
  // note by default (that's an admin action). 2.4b.
  const vc = vaultClient(actor.vaultId);
  const id = c.req.param("id");
  let note;
  try {
    note = await vc.getNote(id);
  } catch (e) {
    return vaultErr(c, e);
  }
  const subject = actorSubject(actor);
  const noteRef = ref(note);
  const caps = capsFor(actor, noteRef);
  const isCreator = !!subject && noteRef.creator === subject;
  // Either path suffices: the pre-caps rule (your OWN note, with edit on it), or
  // the explicit `delete` cap — the composable way to say "may clean up this
  // folder" without also handing over ownership of it.
  if (!((isCreator && caps.has("edit")) || caps.has("delete"))) {
    return c.json(
      { error: "forbidden", reason: "delete requires being the note's creator with edit access, or the delete capability" },
      403,
    );
  }
  try {
    await vc.deleteNote(id);
  } catch (e) {
    return vaultErr(c, e);
  }
  return c.json({ ok: true });
});

api.get("/search", async (c) => {
  const actor = resolveActor(c);
  const q = c.req.query("q") ?? c.req.query("search") ?? "";
  const limit = Number(c.req.query("limit") ?? 50);
  let results: Note[];
  try {
    results = await vaultClient(actor.vaultId).search(q, [], limit);
  } catch (e) {
    return vaultErr(c, e);
  }
  if (roleAtLeast(actor.role, "admin")) return c.json(results);
  return c.json(results.filter((n) => can(actor, ref(n), "view")));
});

api.get("/tags", async (c) => {
  const actor = resolveActor(c);
  let tags: Array<{ tag: string; count: number }>;
  try {
    tags = await vaultClient(actor.vaultId).getTags();
  } catch (e) {
    return vaultErr(c, e);
  }
  if (roleAtLeast(actor.role, "admin")) return c.json(tags);
  const allowed = new Set(grantedTags(actor.grants));
  return c.json(tags.filter((t) => allowed.has(t.tag)));
});

// Non-owner catch-all: any /api path not authorized above is denied. (Owners
// never reach here — they short-circuit to proxyToVault in the middleware.)
api.all("/*", (c) => c.json({ error: "forbidden" }, 403));
