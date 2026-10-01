/**
 * Semantic-search + indexing routes. Mounted under /api BEFORE the main gateway
 * so they are NOT swallowed by the owner→vault passthrough (the vault has no
 * semantic endpoint). Authorization is enforced here exactly as in the gateway:
 *
 *  - GET  /api/search/semantic   any actor; non-admins get results filtered to
 *                                notes on which they hold the `view` CAP (same
 *                                guard as the gateway's /notes + /search).
 *  - POST /api/index/notes       OWNER only — the Rust indexer feeds chunks here.
 *  - POST /api/index/rebuild     OWNER only — pull the vault and (re)embed.
 *  - DEL  /api/index/notes/:id   OWNER only.
 *  - GET  /api/index/status      OWNER only.
 *
 * PRIMARY VAULT ONLY. The `embeddings` table (rag/store.ts) has no vault column
 * and is fed exclusively from the primary vault (the worker sweep + the desktop
 * indexer), and `semanticSearch` hydrates hits through the primary client. So a
 * request bound to any other vault (X-Prism-Vault, or a capability link whose
 * grants live in another vault) is refused with 409 on EVERY route here — never
 * answered from the primary's index. Without that, a member of vault B holding a
 * grant on tag T would see primary-vault notes tagged T (grants are matched by
 * tag name, not vault), and an admin of vault B could write or wipe the primary
 * index. Clients fall back to plain full-text search on the refusal
 * (useVaultSearch). A per-vault index is a schema migration, deliberately
 * deferred.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { resolveActor } from "../auth/actor";
import { effectiveCaps, type NoteRef } from "../permissions";
import { resolveVaultEntry } from "../db";
import { roleAtLeast, roleFloor } from "../roles";
import type { Note } from "../parachute";
import { semanticSearch, indexNote, deindexNote, reindexAll, stats } from "../rag/service";

export const rag = new Hono();

/** The only vault the semantic index covers (see header). */
export const ragVaultId = (): string => resolveVaultEntry().id;

// Refuse every RAG route for a request bound to a non-primary vault — BEFORE any
// index read or write. The actor's vaultId is the same one the gateway uses
// (header for sessions, the grant's own vault for capability links).
rag.use("/search/semantic", primaryVaultOnly);
rag.use("/index/*", primaryVaultOnly);
async function primaryVaultOnly(c: Context, next: () => Promise<void>) {
  if (resolveActor(c).vaultId !== ragVaultId()) {
    return c.json(
      { error: "semantic_index_primary_only", reason: "semantic search indexes the primary vault only" },
      409,
    );
  }
  await next();
}

// Carries creator + visibility so semantic search honors private-to-creator:
// another member's private note must not surface in a non-creator's results.
const ref = (n: Note): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
});
const subjectOf = (a: ReturnType<typeof resolveActor>): string | null =>
  a.kind === "user" ? a.email : a.kind === "link" ? a.capabilityId : null;
const ownerOnly = (c: Context) => roleAtLeast(resolveActor(c).role, "admin");

rag.get("/search/semantic", async (c) => {
  const actor = resolveActor(c);
  const q = c.req.query("q") ?? c.req.query("search") ?? "";
  const requestedLimit = Number(c.req.query("limit") ?? 20);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return c.json({ error: "bad_request" }, 400);
  const limit = Math.min(requestedLimit, 100);
  let hits;
  try {
    hits = await semanticSearch(q, limit, (note) => roleAtLeast(actor.role, "admin") || effectiveCaps(actor.grants, ref(note), roleFloor(actor.role), subjectOf(actor)).has("view"));
  } catch {
    return c.json({ error: "search_error" }, 502);
  }
  // Shape mirrors /notes entries, plus score + snippet for ranked display.
  return c.json(
    hits.map((h) => ({ ...h.note, _score: h.score, _snippet: h.snippet })),
  );
});

rag.post("/index/notes", async (c) => {
  if (!ownerOnly(c)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ notes?: Array<{ id: string; content: string }>; force?: boolean }>();
  if (!Array.isArray(body.notes)) return c.json({ error: "bad_request" }, 400);
  const results = [];
  for (const n of body.notes) {
    if (typeof n?.id !== "string") continue;
    try {
      results.push(await indexNote(n.id, n.content ?? "", body.force));
    } catch {
      results.push({ noteId: n.id, status: "error" as const, chunks: 0 });
    }
  }
  return c.json({ results });
});

rag.delete("/index/notes/:id", (c) => {
  if (!ownerOnly(c)) return c.json({ error: "forbidden" }, 403);
  deindexNote(c.req.param("id"));
  return c.json({ ok: true });
});

rag.post("/index/rebuild", async (c) => {
  if (!ownerOnly(c)) return c.json({ error: "forbidden" }, 403);
  const force = c.req.query("force") === "true";
  try {
    return c.json(await reindexAll({ force }));
  } catch {
    return c.json({ error: "vault_error" }, 502);
  }
});

rag.get("/index/status", (c) => {
  if (!ownerOnly(c)) return c.json({ error: "forbidden" }, 403);
  return c.json(stats());
});
