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
 * Every operation binds to the authenticated actor's vault. Index generations
 * additionally bind model + chunker; hydration uses that same vault client.
 * A retired capability vault must never fall back to the primary vault.
 */
import { TRASH_TAG } from "@prism/core/pages";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { resolveActor } from "../auth/actor";
import { effectiveCaps, type NoteRef } from "../permissions";
import { resolveVaultEntry } from "../db";
import { roleAtLeast, roleFloor } from "../roles";
import type { Note } from "../parachute";
import { semanticSearch, indexNote, deindexNote, reindexAll, stats } from "../rag/service";
import { indexJobs } from "../rag/runtime";
import { IndexJobConflict } from "../rag/jobs";
import { config, embeddingsConfigured } from "../config";

export const rag = new Hono();

rag.use("/search/semantic", validIndexVault);
rag.use("/index/*", validIndexVault);
async function validIndexVault(c: Context, next: () => Promise<void>) {
  const actor = resolveActor(c);
  const expected = c.req.header("x-prism-write-actor");
  if (expected) {
    const capability = c.req.header("authorization")?.match(/^Capability (.+)$/i)?.[1];
    const actual = actor.kind === "user" ? `user:${actor.email}` : actor.kind === "link" && capability ? `capability:${createHash("sha256").update(capability).digest("hex")}` : null;
    if (expected !== actual) return c.json({ error: "write_actor_changed" }, 409);
  }
  if (resolveVaultEntry(actor.vaultId).id !== actor.vaultId) {
    return c.json({ error: "semantic_index_unavailable", reason: "This vault is no longer available" }, 409);
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
    hits = await semanticSearch(q, limit, (note) => !(note.tags ?? []).includes(TRASH_TAG) && (roleAtLeast(actor.role, "admin") || effectiveCaps(actor.grants, ref(note), roleFloor(actor.role), subjectOf(actor)).has("view")), actor.vaultId);
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
      results.push(await indexNote(n.id, n.content ?? "", body.force, resolveActor(c).vaultId));
    } catch {
      results.push({ noteId: n.id, status: "error" as const, chunks: 0 });
    }
  }
  return c.json({ results });
});

rag.delete("/index/notes/:id", (c) => {
  if (!ownerOnly(c)) return c.json({ error: "forbidden" }, 403);
  deindexNote(c.req.param("id"), resolveActor(c).vaultId);
  return c.json({ ok: true });
});

rag.post("/index/rebuild", async (c) => {
  if (!ownerOnly(c)) return c.json({ error: "forbidden" }, 403);
  const force = c.req.query("force") === "true";
  try {
    return c.json(await reindexAll({ force, vaultId: resolveActor(c).vaultId }));
  } catch {
    return c.json({ error: "vault_error" }, 502);
  }
});

rag.get("/index/status", (c) => {
  if (!ownerOnly(c)) return c.json({ error: "forbidden" }, 403);
  const vaultId = resolveActor(c).vaultId;
  return c.json({ ...stats(vaultId), semantic: embeddingsConfigured(),
    automatic: vaultId === resolveVaultEntry().id && config.indexIntervalMs > 0,
    job: indexJobs.current(vaultId) });
});

rag.post("/index/jobs", (c) => {
  if (!ownerOnly(c)) return c.json({ error: "forbidden" }, 403);
  try { return c.json(indexJobs.start(resolveActor(c).vaultId), 202); }
  catch (error) {
    if (error instanceof IndexJobConflict) return c.json({ error: "index_busy", detail: error.message }, 409);
    return c.json({ error: "index_unavailable" }, 503);
  }
});

for (const action of ["pause", "resume"] as const) {
  rag.post(`/index/jobs/:id/${action}`, (c) => {
    if (!ownerOnly(c)) return c.json({ error: "forbidden" }, 403);
    try {
      const job = indexJobs[action](resolveActor(c).vaultId, c.req.param("id"));
      return job ? c.json(job) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof IndexJobConflict) return c.json({ error: "index_busy", detail: error.message }, 409);
      return c.json({ error: "index_unavailable" }, 503);
    }
  });
}
