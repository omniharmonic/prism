/**
 * The permission gateway. Every route resolves the actor, then either serves
 * the owner the full vault or a non-owner ONLY what their grants allow — never
 * the vault token, never a note they lack at least "view" on. The vault proxy
 * (which holds the token) is reached only after authorization passes here.
 *
 * Non-owner reads are bounded two ways: list/search start from the actor's
 * granted tags (+ per-note grants), then a final effectiveLevel filter is the
 * authoritative guard (so a tag query can never leak a note the level math
 * rejects). Writes check the effective level for the specific note.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { resolveVaultEntry } from "../db";
import { vault, vaultClient, VaultError, VaultConflictError, type Note } from "../parachute";
import { resolveActor, type Actor } from "../auth/actor";
import { effectiveLevel, atLeast, grantedTags, type NoteRef } from "../permissions";
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
 * (individually granted notes), then filtered to effectiveLevel >= view.
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
  return [...collected.values()].filter((n) =>
    atLeast(effectiveLevel(actor.grants, ref(n), roleFloor(actor.role), actorSubject(actor)), "view"),
  );
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
  if (!atLeast(level, "view")) return c.json({ error: "forbidden" }, 403);
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
  const canCreate =
    actor.kind === "user" &&
    atLeast(effectiveLevel(actor.grants, slice, roleFloor(actor.role), subject), "edit");
  if (!canCreate) {
    return c.json({ error: "forbidden", reason: "create requires edit on the target tag/folder" }, 403);
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
  const level = effectiveLevel(actor.grants, ref(note), roleFloor(actor.role), actorSubject(actor));
  if (!atLeast(level, "edit")) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    content?: string;
    metadata?: Record<string, unknown>;
    path?: string;
    if_updated_at?: string;
  }>();
  try {
    // Non-owners may change content/metadata only; path (and tags, never here)
    // stay owner-controlled so a collaborator can't reorganize or re-scope.
    const updated = await vc.updateNote(id, {
      content: body.content,
      metadata: body.metadata,
      path: roleAtLeast(actor.role, "admin") ? body.path : undefined,
      ifUpdatedAt: body.if_updated_at ?? note.updatedAt ?? undefined,
    });
    return c.json(updated);
  } catch (e) {
    return vaultErr(c, e);
  }
});

api.delete("/notes/:id", async (c) => {
  const actor = resolveActor(c);
  if (!roleAtLeast(actor.role, "admin")) return c.json({ error: "forbidden" }, 403);
  try {
    await vaultClient(actor.vaultId).deleteNote(c.req.param("id"));
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
  return c.json(
    results.filter((n) => atLeast(effectiveLevel(actor.grants, ref(n), roleFloor(actor.role), actorSubject(actor)), "view")),
  );
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
