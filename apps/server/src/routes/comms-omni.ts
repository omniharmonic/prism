// Omni in Comms (Phase 4, PRD §5.7, D9) — mounted in routes/comms.ts, so COMMS_ENABLED's 404 and the
// comms-native client scope apply unchanged.
//
//   GET  /api/comms/threads/:id/omni       → {enabled, drafting, turn, reply, drafts[]}
//   POST /api/comms/threads/:id/assist     {instruction, messageIds?}   → 202 {omniThreadId, turnId, kind:"draft"}
//   POST /api/comms/threads/:id/catch-up   {}                           → 202 {omniThreadId, turnId, kind:"catch-up"}
//   POST /api/comms/threads/:id/omni/dismiss {turnId}                   → {ok}  the owner closed that turn's
//        note: GET leaves it out (reply: null) on every device; a thread.updated {reason:"omni"} tells
//        the other devices to refresh (owner-testing round 4: closed notes kept coming back).
//
// Drafts are Omni approvals (kind `message`, payload {commsThreadId, roomId, body}). Approve & Send,
// Refine (revise + feedback) and Discard (cancel) go through the EXISTING approval routes
// (/api/omni/approvals/:id/decision): digest of the exact text, human DEVICE origin, Idempotency-Key —
// and the executor sends through POST /threads/:id/messages (routes/omni.ts commsDraftExecutor).
// Nothing here sends anything, and nothing Omni writes enters the chat: its answer is a private note.
import { resolveThreadRedirect } from "../comms/forums";
import type { Context } from "hono";
import { Hono } from "hono";
import { requireCommsOwner } from "../comms/guard";
import { actionOrigin, readCapped } from "./actions";
import { consumeRateLimit } from "../middleware/ratelimit";
import { IDEMPOTENCY_KEY_RE } from "../actions/store";
import { getThread as getCommsThread } from "../comms/store";
import { assistPrompt, catchUpPrompt, commsDraftIds, commsOmniEnabled, omniThreadFor } from "../comms/omni";
import { omniConfig } from "../omni/config";
import { ensureSourceSession } from "../omni/source-session";
import { activeTurn, ensureThread, eventsAfter, getThread as getOmniThread, lastTurn, omniAudit, type TurnRow } from "../omni/store";
import { startTurn } from "../omni/turns";
import { approvalView, expireApprovals, getApproval } from "../omni/approvals";
import { db } from "../db";
import { appendEvent } from "../comms/store";

export const commsOmniApi = new Hono();

const MAX_BODY = 32 * 1024;
const MAX_INSTRUCTION = 4_000;
const DRAFT_WINDOW_MS = 24 * 3_600_000;
const KIND_PREFIX = { draft: "comms-assist-", "catch-up": "comms-catchup-" } as const;
type TurnKind = keyof typeof KIND_PREFIX;

const kindOf = (t: TurnRow): TurnKind => (t.idemKey?.startsWith(KIND_PREFIX["catch-up"]) ? "catch-up" : "draft");

/** The gates every route here shares; POSTs (which start an agent turn) also need the owner's device. */
function gate(c: Context, write: boolean): { ok: true; threadId: string } | { ok: false; res: Response } {
  const g = requireCommsOwner(c);
  if (!g.ok) return g;
  if (!commsOmniEnabled()) return { ok: false, res: c.json({ error: "omni_disabled" }, 404) };
  const threadId = resolveThreadRedirect(c.req.param("id") ?? "");
  if (!getCommsThread(threadId)) return { ok: false, res: c.json({ error: "not_found" }, 404) };
  if (write) {
    const { via, origin } = actionOrigin(c);
    if (origin !== "human" || via !== "device") return { ok: false, res: c.json({ error: "device_required", message: "Ask Omni from the Comms app on your signed-in device." }, 403) };
    const retry = consumeRateLimit(`comms-omni:${g.actor.email}`, 30, 10 * 60_000);
    if (retry !== null) {
      c.header("Retry-After", String(retry));
      return { ok: false, res: c.json({ error: "rate_limited", message: "Omni has a lot to do right now. Try again in a moment." }, 429) };
    }
  }
  return { ok: true, threadId };
}

async function body(c: Context): Promise<Record<string, unknown> | null> {
  if ((c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return null;
  const raw = await readCapped(c.req.raw, MAX_BODY);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The last turn's answer text (Omni's own words, private), once it ended. */
function replyOf(omniThreadId: string, turn: TurnRow | null): { text: string; at: string } | null {
  if (!turn || turn.status === "running") return null;
  const t = getOmniThread(omniThreadId);
  if (!t) return null;
  const ev = eventsAfter(omniThreadId, Math.max(0, t.eventSeq - 500));
  let text: string | null = null;
  for (const e of ev) if (e.turnId === turn.id && e.payload.t === "text" && typeof e.payload.text === "string") text = e.payload.text;
  return text ? { text, at: new Date(turn.endedAt ?? turn.startedAt).toISOString() } : null;
}

const dismissedStmt = db.prepare(`SELECT 1 FROM comms_omni_dismissed WHERE thread_id = ? AND turn_id = ?`);
/** Did the owner close this turn's note (on any device)? */
export const omniNoteDismissed = (threadId: string, turnId: string): boolean => !!dismissedStmt.get(threadId, turnId);

commsOmniApi.get("/threads/:id/omni", (c) => {
  const g = gate(c, false);
  if (!g.ok) return g.res;
  const omniThreadId = omniThreadFor(g.threadId);
  const known = !!getOmniThread(omniThreadId);
  const turn = known ? lastTurn(omniThreadId) : null;
  expireApprovals();
  const owner = omniConfig.ownerEmail();
  const drafts = commsDraftIds(g.threadId, Date.now() - DRAFT_WINDOW_MS)
    .map((id) => getApproval(owner, id))
    .filter((a): a is NonNullable<typeof a> => !!a && a.status !== "revised")
    .map(approvalView);
  return c.json({
    enabled: true,
    drafting: known && !!activeTurn(omniThreadId),
    turn: turn ? { id: turn.id, kind: kindOf(turn), status: turn.status, startedAt: new Date(turn.startedAt).toISOString(), endedAt: turn.endedAt ? new Date(turn.endedAt).toISOString() : null, errorCode: turn.errorCode } : null,
    reply: turn && omniNoteDismissed(g.threadId, turn.id) ? null : replyOf(omniThreadId, turn),
    drafts,
  });
});

async function start(c: Context, kind: TurnKind): Promise<Response> {
  const g = gate(c, true);
  if (!g.ok) return g.res;
  const b = await body(c);
  if (!b) return c.json({ error: "invalid", message: "A JSON object body is required." }, 422);
  const key = c.req.header("idempotency-key");
  if (key !== undefined && !IDEMPOTENCY_KEY_RE.test(key)) return c.json({ error: "invalid", message: "Idempotency-Key: 8–200 characters of [A-Za-z0-9._:-]." }, 422);
  let message: string;
  if (kind === "draft") {
    if (Object.keys(b).some((k) => k !== "instruction" && k !== "messageIds" && k !== "topic")) return c.json({ error: "invalid", message: "Unknown field." }, 422);
    // A forum: the topic on the owner's screen (fix round 1, I-1); the selected messages' own topic wins.
    if (b.topic !== undefined && (typeof b.topic !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.topic))) return c.json({ error: "invalid", message: "topic: a topic id." }, 422);
    const instruction = typeof b.instruction === "string" ? b.instruction.trim() : "";
    if (!instruction || instruction.length > MAX_INSTRUCTION) return c.json({ error: "invalid", message: `instruction: 1–${MAX_INSTRUCTION} characters.` }, 422);
    const ids = b.messageIds ?? [];
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((x) => typeof x !== "string" || !x || x.length > 255)) return c.json({ error: "invalid", message: "messageIds: at most 20 message ids." }, 422);
    message = assistPrompt(g.threadId, instruction, ids as string[], typeof b.topic === "string" ? b.topic : null);
  } else {
    if (Object.keys(b).length) return c.json({ error: "invalid", message: "Unknown field." }, 422);
    message = catchUpPrompt(g.threadId, getCommsThread(g.threadId)?.unread.count ?? 0);
  }
  const owner = omniConfig.ownerEmail();
  const omniThreadId = omniThreadFor(g.threadId);
  try {
    // Hermes needs the session before a turn; the title holds no conversation content.
    await ensureSourceSession(owner, `comms:${g.threadId}`, "Comms conversation", omniThreadId);
  } catch {
    return c.json({ error: "omni_unavailable", message: "Omni isn't answering right now. Try again in a moment." }, 502);
  }
  ensureThread({ id: omniThreadId, title: "Comms conversation", source: "comms" });
  const r = startTurn(omniThreadId, message, key ? `${KIND_PREFIX[kind]}${key}`.slice(0, 200) : `${KIND_PREFIX[kind]}${crypto.randomUUID()}`);
  if ("active" in r) return c.json({ error: "busy", message: "Omni is still working on this conversation.", omniThreadId, turnId: r.active.id }, 409);
  const turn = "turn" in r ? r.turn : r.replay;
  omniAudit({ actor: owner, via: "device", action: `comms.omni-${kind}`, threadId: omniThreadId, status: "ok" });
  if ("replay" in r) c.header("Idempotent-Replayed", "true");
  return c.json({ omniThreadId, turnId: turn.id, kind }, 202);
}

commsOmniApi.post("/threads/:id/assist", (c) => start(c, "draft"));
commsOmniApi.post("/threads/:id/catch-up", (c) => start(c, "catch-up"));

const TURN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
/** The owner closed Omni's note for one turn. Idempotent; ids only. Not an Omni turn, so it does
 *  not spend the Omni rate budget; it needs the owner's own device like every write here. */
commsOmniApi.post("/threads/:id/omni/dismiss", async (c) => {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  if (!commsOmniEnabled()) return c.json({ error: "omni_disabled" }, 404);
  const threadId = resolveThreadRedirect(c.req.param("id") ?? "");
  if (!getCommsThread(threadId)) return c.json({ error: "not_found" }, 404);
  const { via, origin } = actionOrigin(c);
  if (origin !== "human" || via !== "device") return c.json({ error: "device_required", message: "Close Omni's note from the Comms app on your signed-in device." }, 403);
  const b = await body(c);
  if (!b || Object.keys(b).some((k) => k !== "turnId") || typeof b.turnId !== "string" || !TURN_ID_RE.test(b.turnId))
    return c.json({ error: "invalid", message: "turnId required." }, 422);
  const changed = db.prepare(`INSERT OR IGNORE INTO comms_omni_dismissed (thread_id, turn_id, at) VALUES (?, ?, ?)`).run(threadId, b.turnId, Date.now()).changes;
  // Keep the table small: a thread only ever shows its LAST turn's note.
  db.prepare(`DELETE FROM comms_omni_dismissed WHERE at < ?`).run(Date.now() - 90 * 86_400_000);
  if (changed) appendEvent("thread.updated", threadId, { threadId, reason: "omni" });
  return c.json({ ok: true });
});
