// Comms full search + contact tidy-up routes (mounted in routes/comms.ts, so COMMS_ENABLED, the
// owner guard and the comms-native client scope apply). Contracts: comms/search-index.ts,
// comms/tidy.ts and the Task 4 report.
//
//   GET  /api/comms/search?q=&thread=&person=&network=&from=me|others&cursor=&limit=
//   GET  /api/comms/search/media?kind=photos|links&q=&thread=&cursor=&limit=
//   GET  /api/comms/tidy?cursor=&limit=            GET /api/comms/tidy/threads/:id
//   GET  /api/comms/tidy/actions                   POST /api/comms/tidy/{link,create,ignore,undo}
import { resolveThreadRedirect } from "../comms/forums";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { requireCommsOwner } from "../comms/guard";
import { listThreads, getThread } from "../comms/store";
import { historyStatus, listMedia, MAX_SEARCH_OFFSET, searchIndexingEnabled, searchMessages } from "../comms/search-index";
import { attachmentOut, avatarOut, linkPreviewOut, threadOut } from "../comms/timeline";
import { wellFormedDeep } from "../comms/wire";
import { TidyError, createPerson, ignoreThread, linkThread, listTidy, recentActions, tidyEnabled, tidyForThread, undoAction, type TidyItem } from "../comms/tidy";
import { actionOrigin, csrfRefusal, readCapped } from "./actions";
import { recordAction } from "../actions/store";
import { consumeRateLimit } from "../middleware/ratelimit";
import type { Network } from "../comms/types";

const NETWORKS = new Set<string>(["whatsapp", "telegram", "discord", "messenger", "x", "imessage", "sms", "email", "matrix", "signal", "slack", "instagram", "linkedin"]);
const MAX_ID = 200;
const BAD = /[\u0000-\u001f\u007f]/;

function intParam(raw: string | undefined, def: number, max: number): number | null {
  if (raw === undefined) return def;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}

const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
function dec<T>(raw: string, check: (v: unknown) => v is T): T | null {
  if (!raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return check(v) ? v : null;
  } catch {
    return null;
  }
}

// ── search ───────────────────────────────────────────────────────────────────

type SearchCursor = { o: number; n: number; h: string };
const isSearchCursor = (v: unknown): v is SearchCursor => {
  const c = v as SearchCursor;
  return !!c && Number.isInteger(c.o) && c.o > 0 && c.o <= MAX_SEARCH_OFFSET && Number.isFinite(c.n) && typeof c.h === "string";
};

export async function getSearch(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  if (!searchIndexingEnabled()) return c.json({ error: "search_disabled" }, 404);
  const q = c.req.query("q")?.trim() ?? "";
  if (!q || q.length > 200 || BAD.test(q)) return c.json({ error: "invalid_query" }, 400);
  const limit = intParam(c.req.query("limit"), 30, 50);
  if (limit === null) return c.json({ error: "invalid_limit" }, 400);
  const thread = c.req.query("thread");
  const person = c.req.query("person");
  if (thread !== undefined && (!thread || thread.length > MAX_ID)) return c.json({ error: "invalid_thread" }, 400);
  if (person !== undefined && (!person || person.length > MAX_ID)) return c.json({ error: "invalid_person" }, 400);
  const networks = (c.req.queries("network") ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  if (networks.length > 20 || networks.some((n) => !NETWORKS.has(n))) return c.json({ error: "invalid_network" }, 400);
  const from = c.req.query("from");
  if (from !== undefined && from !== "me" && from !== "others") return c.json({ error: "invalid_from" }, 400);
  // A per-topic thread id that became its forum's (comms/forums.ts) searches the forum.
  const filter = { threadId: thread === undefined ? undefined : resolveThreadRedirect(thread), personId: person, networks, ...(from ? { fromSelf: from === "me" } : {}) };
  const hash = createHash("sha256").update(JSON.stringify([q, filter])).digest("base64url").slice(0, 16);
  const rawCursor = c.req.query("cursor");
  let offset = 0;
  let now = Date.now();
  if (rawCursor !== undefined) {
    const cur = dec(rawCursor, isSearchCursor);
    if (!cur || cur.h !== hash) return c.json({ error: "invalid_cursor" }, 400);
    offset = cur.o;
    now = cur.n; // the same clock for every page: the order cannot shift under the reader
  }
  const r = await searchMessages(q, filter, offset, limit, now);
  if (!r) return c.json({ error: "invalid_query" }, 400);
  const nextOffset = offset + r.hits.length;
  const next = r.more && nextOffset <= MAX_SEARCH_OFFSET ? enc({ o: nextOffset, n: now, h: hash }) : null;
  const threads = new Map<string, ReturnType<typeof threadOut>>();
  // A hit whose conversation is not served (its network's flag is off, final review I3) is dropped.
  const hidden = new Set<string>();
  for (const h of r.hits) {
    if (threads.has(h.threadId) || hidden.has(h.threadId)) continue;
    const t = getThread(h.threadId);
    if (t) threads.set(t.id, threadOut(t, g.actor));
    else hidden.add(h.threadId);
  }
  r.hits = r.hits.filter((h) => !hidden.has(h.threadId));
  // Suggestions (first page only, no filters): conversations whose title / last message match —
  // the client offers "Messages with <person>" (a DM's person) and "in <group>" tokens from them.
  const suggestions = offset === 0 && !thread && !person && !networks.length
    ? { threads: listThreads({ q, limit: 8 }).threads.map((t) => threadOut(t, g.actor)) }
    : undefined;
  return c.json(wellFormedDeep({
    query: q, messages: r.hits, threads: [...threads.values()], next,
    // The ranking saw only the newest matches (per-request bound): older ones may be missing.
    ...(r.partial ? { partial: true } : {}),
    ...(suggestions ? { suggestions } : {}),
    history: historyStatus(),
  }));
}

type MediaCursor = { at: number; key: string; h: string };
const isMediaCursor = (v: unknown): v is MediaCursor => {
  const c = v as MediaCursor;
  return !!c && Number.isFinite(c.at) && typeof c.key === "string" && c.key.length <= 400 && typeof c.h === "string";
};

export function getSearchMedia(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  if (!searchIndexingEnabled()) return c.json({ error: "search_disabled" }, 404);
  const kindRaw = c.req.query("kind");
  if (kindRaw !== "photos" && kindRaw !== "links") return c.json({ error: "invalid_kind" }, 400);
  const kind = kindRaw === "photos" ? "photo" : "link";
  const q = c.req.query("q")?.trim() ?? "";
  if (q.length > 200 || BAD.test(q)) return c.json({ error: "invalid_query" }, 400);
  const threadRaw = c.req.query("thread");
  if (threadRaw !== undefined && (!threadRaw || threadRaw.length > MAX_ID)) return c.json({ error: "invalid_thread" }, 400);
  const limit = intParam(c.req.query("limit"), 60, 100);
  if (limit === null) return c.json({ error: "invalid_limit" }, 400);
  const thread = threadRaw === undefined ? undefined : resolveThreadRedirect(threadRaw);
  const hash = createHash("sha256").update(JSON.stringify([kind, q, thread ?? null])).digest("base64url").slice(0, 16);
  const rawCursor = c.req.query("cursor");
  let after: { at: number; key: string } | null = null;
  if (rawCursor !== undefined) {
    const cur = dec(rawCursor, isMediaCursor);
    if (!cur || cur.h !== hash) return c.json({ error: "invalid_cursor" }, 400);
    after = { at: cur.at, key: cur.key };
  }
  const r = listMedia(kind, { q: q || undefined, threadId: thread, after, limit, now: Date.now() });
  const items = r.items.filter((it) => !("threadId" in it) || !it.threadId || !!getThread(it.threadId as string)).map((it) => ({
    ...it,
    ...(it.attachment ? { attachment: attachmentOut(it.attachment, g.actor) } : {}),
    ...(it.link ? { link: linkPreviewOut(it.link, g.actor) } : {}),
  }));
  return c.json(wellFormedDeep({ kind: kindRaw, items, next: r.next ? enc({ ...r.next, h: hash }) : null }));
}

// ── tidy ─────────────────────────────────────────────────────────────────────

const itemOut = (it: TidyItem, actor: { email: string; deviceId?: string }) => ({ ...it, avatar: avatarOut(it.avatar, actor) });

function tidyGuard(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g;
  if (!tidyEnabled()) return { ok: false as const, res: c.json({ error: "tidy_disabled" }, 404) };
  return g;
}

export async function getTidy(c: Context) {
  const g = tidyGuard(c);
  if (!g.ok) return g.res;
  const limit = intParam(c.req.query("limit"), 30, 50);
  if (limit === null) return c.json({ error: "invalid_limit" }, 400);
  const raw = c.req.query("cursor");
  let offset = 0;
  if (raw !== undefined) {
    const cur = dec(raw, (v): v is { o: number } => Number.isInteger((v as { o: number })?.o) && (v as { o: number }).o > 0 && (v as { o: number }).o <= 5_000);
    if (!cur) return c.json({ error: "invalid_cursor" }, 400);
    offset = cur.o;
  }
  const r = await listTidy(g.vaultId, { offset, limit });
  const next = offset + r.items.length < r.total ? enc({ o: offset + r.items.length }) : null;
  return c.json(wellFormedDeep({ people: r.items.map((i) => itemOut(i, g.actor)), total: r.total, next, partial: r.partial }));
}

export async function getTidyThread(c: Context) {
  const g = tidyGuard(c);
  if (!g.ok) return g.res;
  const id = resolveThreadRedirect(c.req.param("id") ?? "");
  if (!id || id.length > MAX_ID) return c.json({ error: "thread_unavailable" }, 404);
  const r = await tidyForThread(g.vaultId, id);
  if (!r) return c.json({ needed: false });
  return c.json(wellFormedDeep({ needed: true, item: itemOut(r.item, g.actor), partial: r.partial }));
}

export function getTidyActions(c: Context) {
  const g = tidyGuard(c);
  if (!g.ok) return g.res;
  return c.json({ actions: recentActions(20) });
}

type TidyOp = "link" | "create" | "ignore" | "undo";

/** Writes: owner, human origin (an agent never tidies), CSRF, a strict small JSON body, a budget. */
export function tidyWrite(op: TidyOp) {
  return async (c: Context) => {
    const g = tidyGuard(c);
    if (!g.ok) return g.res;
    const { via, origin } = actionOrigin(c);
    const audit = (status: "ok" | "failed" | "refused", target: Record<string, unknown>, error?: string) =>
      recordAction({ actorEmail: g.actor.email, via, origin, action: `comms.tidy.${op}`, vaultId: g.vaultId, target, idempotencyKey: null, status, error: error ?? null });
    if (origin !== "human") {
      audit("refused", {}, "owner_required");
      return c.json({ error: "owner_required", message: "Only the owner, in the app, can change people." }, 403);
    }
    const csrf = csrfRefusal(c, via);
    if (csrf) return csrf;
    const retry = consumeRateLimit(`comms-tidy:${g.actor.email}`, 60, 10 * 60_000);
    if (retry !== null) {
      c.header("Retry-After", String(retry));
      return c.json({ error: "rate_limited" }, 429);
    }
    const text = await readCapped(c.req.raw, 8 * 1024);
    let body: Record<string, unknown> | null = null;
    try { body = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { body = null; }
    const allowed: Record<TidyOp, string[]> = { link: ["threadId", "personId"], create: ["threadId", "name", "allowSimilar"], ignore: ["threadId"], undo: ["actionId"] };
    const str = (k: string) => (typeof body?.[k] === "string" && (body[k] as string).length >= 1 && (body[k] as string).length <= MAX_ID ? (body[k] as string) : null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !allowed[op].includes(k))) return c.json({ error: "invalid" }, 422);
    if (op === "create" && body.allowSimilar !== undefined && typeof body.allowSimilar !== "boolean") return c.json({ error: "invalid" }, 422);
    const actor = { email: g.actor.email, via };
    try {
      let action;
      if (op === "undo") {
        const id = str("actionId");
        if (!id) return c.json({ error: "invalid" }, 422);
        action = await undoAction(g.vaultId, id);
      } else {
        const threadId = str("threadId");
        if (!threadId) return c.json({ error: "invalid" }, 422);
        if (op === "link") {
          const personId = str("personId");
          if (!personId) return c.json({ error: "invalid" }, 422);
          action = await linkThread(g.vaultId, threadId, personId, actor);
        } else if (op === "create") {
          if (typeof body.name !== "string") return c.json({ error: "invalid" }, 422);
          action = await createPerson(g.vaultId, threadId, body.name, actor, body.allowSimilar === true);
        } else action = ignoreThread(threadId, actor);
      }
      // Ids only — never a name, a handle or a number.
      audit("ok", { actionId: action.id, threadId: action.threadId, personId: action.personId });
      const t = getThread(action.threadId);
      const { threadLinks: _counts, ...wire } = action; // server-side counts stay off the wire
      return c.json(wellFormedDeep({ action: wire, ...(t ? { thread: threadOut(t, g.actor) } : {}) }));
    } catch (e) {
      if (e instanceof TidyError) {
        audit(e.status === 503 ? "failed" : "refused", {}, e.code);
        return c.json(wellFormedDeep(e.body()), e.status);
      }
      audit("failed", {}, "internal");
      throw e;
    }
  };
}

export type { Network };
