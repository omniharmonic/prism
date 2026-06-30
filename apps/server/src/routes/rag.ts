/**
 * Semantic-search + indexing routes. Mounted under /api BEFORE the main gateway
 * so they are NOT swallowed by the owner→vault passthrough (the vault has no
 * semantic endpoint). Authorization is enforced here exactly as in the gateway:
 *
 *  - GET  /api/search/semantic   any actor; non-owners get results filtered to
 *                                effectiveLevel >= view (same guard as /search).
 *  - POST /api/index/notes       OWNER only — the Rust indexer feeds chunks here.
 *  - POST /api/index/rebuild     OWNER only — pull the vault and (re)embed.
 *  - DEL  /api/index/notes/:id   OWNER only.
 *  - GET  /api/index/status      OWNER only.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { resolveActor } from "../auth/actor";
import { effectiveLevel, atLeast, type NoteRef } from "../permissions";
import { roleAtLeast, roleFloor } from "../roles";
import type { Note } from "../parachute";
import { semanticSearch, indexNote, deindexNote, reindexAll, stats } from "../rag/service";

export const rag = new Hono();

const ref = (n: Note): NoteRef => ({ id: n.id, tags: n.tags ?? [] });
const ownerOnly = (c: Context) => roleAtLeast(resolveActor(c).role, "admin");

rag.get("/search/semantic", async (c) => {
  const actor = resolveActor(c);
  const q = c.req.query("q") ?? c.req.query("search") ?? "";
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
  let hits;
  try {
    hits = await semanticSearch(q, limit);
  } catch {
    return c.json({ error: "search_error" }, 502);
  }
  const visible = roleAtLeast(actor.role, "admin")
    ? hits
    : hits.filter((h) => atLeast(effectiveLevel(actor.grants, ref(h.note), roleFloor(actor.role)), "view"));
  // Shape mirrors /notes entries, plus score + snippet for ranked display.
  return c.json(
    visible.map((h) => ({ ...h.note, _score: h.score, _snippet: h.snippet })),
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
