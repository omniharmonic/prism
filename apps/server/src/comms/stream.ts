// GET /api/comms/stream (Task 11): the comms_events log as Server-Sent Events, owner-only.
//
// ── Wire format ────────────────────────────────────────────────────────────────
//   id: <comms_events.id>\nevent: <kind>\ndata: <json>\n\n
//   kind ∈ thread.updated | message.created | message.updated | message.deleted | reaction.changed
//   `: ping\n\n` every 25 s (heartbeat comment); `: connected\n\n` first.
//
// ── Payload schema (data) ─────────────────────────────────────────────────────
//   every event:        { threadId: string | null, ...kind-specific }
//   thread.updated:     { threadId }                       → refetch GET /threads/:id (or the list)
//   message.created:    { threadId, message: Message }     → append (dedupe by message.id)
//   message.updated:    { threadId, message: Message }     → replace by message.id (edit, healed reply)
//   message.deleted:    { threadId, message: Message }     → replace by id; message.redacted = true
//   reaction.changed:   { threadId, message: Message }     → replace by id; only `reactions` differ
//   reset:              { threadId: null }                 → drop local state, refetch everything
//   `message` is the full wire Message of GET /threads/:id/messages: every mxc is rewritten to
//   media tokens (messageOut) FOR THIS SUBSCRIBER at send time — the log itself stores the
//   normalized message, and no mxc:// ever leaves the server.
//
// ── Resume ─────────────────────────────────────────────────────────────────────
//   No Last-Event-ID: live from now. Last-Event-ID: N → every event with id > N, then live.
//   N older than retention (pruned, EVENT_RETENTION_MS), from another database (N > the last id
//   issued) or not a number → one `event: reset` (id = the newest id) and live from there.
//
// Long-poll note: with COMMS_SYNC_LONGPOLL=true a Matrix pass is running nearly all the time (a
// 30 s /sync each), so the manual POST /api/integrations/matrix/sync mostly answers 409 `busy`
// — expected: the long-poll chain IS the continuous sync; nothing is lost by the refusal.
//
// The connection closes after 15 min (the client resumes with Last-Event-ID; access is checked
// again) or as soon as the actor no longer resolves the same (checked with each heartbeat), and
// cleans up its timer and its listener on every way out (client disconnect included).
import { wellFormedDeep } from "./wire";
import type { Context } from "hono";
import { eventBounds, eventsAfter, onCommsEvent, pruneEventsThrottled } from "./store";
import { messageOut, type MediaActor } from "./timeline";
import { withReadState } from "./receipts";
import { roomOfMessage } from "./forums";
import type { Message } from "./types";

const DEFAULTS = { pingMs: 25_000, maxAgeMs: 15 * 60_000, maxStreams: 8, batch: 200, maxBufferedBytes: 1024 * 1024 };
const tuning = { ...DEFAULTS };
export function setCommsStreamTuningForTests(v: Partial<typeof DEFAULTS> | null): void {
  Object.assign(tuning, v ?? DEFAULTS);
}

let openStreams = 0;
export const commsStreamCount = (): number => openStreams;

const enc = new TextEncoder();

function dataOf(payload: unknown, actor: MediaActor): Record<string, unknown> {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...p, threadId: typeof p.threadId === "string" ? p.threadId : null };
  if (p.message && typeof p.message === "object") {
    let m = p.message as Message;
    // Read receipts (Task 8): the state NOW, so a replayed frame never shows an older one.
    if (m.sender?.isSelf && typeof m.threadId === "string") m = withReadState([m], roomOfMessage(m))[0]!;
    out.message = messageOut(m, actor);
  }
  return wellFormedDeep(out);
}

/** Where to start: the id to stream after, and whether the client must reset first. */
export function resumePoint(raw: string | undefined): { after: number; reset: boolean } {
  const { seq, min } = eventBounds();
  if (raw === undefined || raw.trim() === "") return { after: seq, reset: false };
  if (!/^\d{1,15}$/.test(raw.trim())) return { after: seq, reset: true };
  const n = Number(raw.trim());
  const pruned = min === null ? n < seq : n < min - 1;
  if (n > seq || pruned) return { after: seq, reset: true };
  return { after: n, reset: false };
}

export function commsStream(c: Context, actor: MediaActor, stillAllowed: () => boolean): Response {
  if (openStreams >= tuning.maxStreams) return c.json({ error: "too_many_streams" }, 429);
  try { pruneEventsThrottled(); } catch { /* never refuse a stream over housekeeping */ }
  const start = resumePoint(c.req.header("Last-Event-ID"));
  let lastId = start.after;
  let closed = false;
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let ping: ReturnType<typeof setInterval> | undefined;
  let life: ReturnType<typeof setTimeout> | undefined;
  let unsub: (() => void) | undefined;
  openStreams++;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    openStreams--;
    if (ping) clearInterval(ping);
    if (life) clearTimeout(life);
    unsub?.();
    try { ctrl.close(); } catch { /* already closed / cancelled */ }
  };
  const send = (s: string) => {
    if (closed) return;
    try {
      ctrl.enqueue(enc.encode(s));
      // A client that stops reading must not grow the queue without bound: drop it, it resumes.
      if ((ctrl.desiredSize ?? 0) < -tuning.maxBufferedBytes) cleanup();
    } catch {
      cleanup();
    }
  };
  const drain = () => {
    while (!closed) {
      const rows = eventsAfter(lastId, tuning.batch);
      for (const r of rows) {
        if (closed) return;
        send(`id: ${r.id}\nevent: ${r.kind}\ndata: ${JSON.stringify(dataOf(r.payload, actor))}\n\n`);
        lastId = r.id;
      }
      if (rows.length < tuning.batch) return;
    }
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        ctrl = controller;
        send(": connected\n\n");
        if (start.reset) send(`id: ${start.after}\nevent: reset\ndata: {"threadId":null}\n\n`);
        unsub = onCommsEvent(drain);
        drain();
        ping = setInterval(() => {
          if (!stillAllowed()) return cleanup();
          send(": ping\n\n");
        }, tuning.pingMs);
        life = setTimeout(cleanup, tuning.maxAgeMs);
        ping.unref?.();
        life.unref?.();
      },
      cancel() {
        cleanup();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
  );
  return c.body(body, 200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Accel-Buffering": "no",
  });
}
