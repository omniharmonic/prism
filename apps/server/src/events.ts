/**
 * Invalidation channel (Arch v2 WP7.2) — `GET /api/events` (SSE).
 *
 * WHY: clients polled the vault every 5-30 s (inbox, messages, agent activity,
 * status bar). N idle tabs/devices = N x that load on the single-threaded vault.
 * Instead the server, which already holds ONE subscribe WebSocket per vault for the
 * tree projection (tree.ts), fans a tiny "something changed" signal out to clients,
 * which refetch only what they are looking at.
 *
 * WIRE (ids only — never content, path, tags or metadata):
 *   data: {"type":"note","id":"<id>","op":"upsert"|"remove"}
 *   data: {"type":"resync"}        // refetch everything (reconnect, snapshot replace,
 *                                  //  per-client buffer overflow, projection reset)
 *   : ping                         // every 25 s
 *
 * LEAK-PROOFING. An id of a note the viewer can't see is itself a leak (it tells
 * them a note exists and when it changes), so every event is filtered per connection
 * through the SAME `view` cap math as every read (`canView`, injected from the
 * gateway's `capsFor`), evaluated on the row's state BEFORE and AFTER the change:
 *   - upsert: emit iff viewable after OR before (a note that just became hidden is
 *     one the client may hold; telling it to refetch — and get a 404/403 — reveals
 *     nothing it didn't already know, and lets it drop the stale copy);
 *   - remove: emit iff it was viewable just before the delete;
 *   - a note the viewer never could see produces no frame at all.
 * Owners/admins see everything in their vault. `resync` carries no data. Anon
 * callers are refused (401). Capability links are allowed and view-scoped exactly
 * like signed-in users. The actor's grants are resolved when the stream opens, so
 * a connection is recycled after EVENTS_MAX_AGE_MS (default 15 min) and the client's
 * reconnect re-resolves them (revoked grants/sessions stop leaking within that bound;
 * the client also resyncs on every reconnect).
 *
 * Back-pressure: each connection has a bounded queue (EVENTS_BUFFER, 200). Overflow
 * drops the queue and sends a single `resync`. Connections are capped per principal
 * (EVENTS_MAX_PER_USER, 8) and globally (EVENTS_MAX_TOTAL, 200) → 429.
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { VaultEntry } from "./config";
import type { NoteRef } from "./permissions";
import { rowRef, subscribeTreeChanges, treeRowChanged, type TreeChange } from "./tree";

/** `tree: true` = this viewer's sidebar row for the note changed (created, removed,
 *  appeared / disappeared for them, or path / tags / type / icon / title / aliases / order / trash
 *  state changed). Absent on a plain content edit. Still ids only. */
export type InvalidationEvent = { type: "note"; id: string; op: "upsert" | "remove"; tree?: true } | { type: "resync" };

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const cfg = {
  perUser: () => num("EVENTS_MAX_PER_USER", 8),
  total: () => num("EVENTS_MAX_TOTAL", 200),
  buffer: () => num("EVENTS_BUFFER", 200),
  pingMs: () => num("EVENTS_PING_MS", 25_000),
  maxAgeMs: () => num("EVENTS_MAX_AGE_MS", 15 * 60_000),
};

const perPrincipal = new Map<string, number>();
let total = 0;

/** Introspection for tests/ops. */
export const eventConnections = () => ({ total, principals: perPrincipal.size });

/** Pure: map a projection change to the event THIS viewer may receive, or null. */
export function eventFor(change: TreeChange, canView: (r: NoteRef) => boolean): InvalidationEvent | null {
  switch (change.kind) {
    case "resync":
      return { type: "resync" };
    case "upsert": {
      // Judged on the SAME view filter, before and after — so the flag says nothing
      // about a note (or a state of it) this viewer cannot see.
      const now = canView(rowRef(change.row));
      const before = !!change.prev && canView(rowRef(change.prev));
      if (!now && !before) return null;
      const tree = now !== before || treeRowChanged(change.prev, change.row);
      return tree ? { type: "note", id: change.row.id, op: "upsert", tree: true } : { type: "note", id: change.row.id, op: "upsert" };
    }
    case "remove":
      return canView(rowRef(change.prev)) ? { type: "note", id: change.id, op: "remove", tree: true } : null;
  }
}

export interface EventStreamParams {
  entry: VaultEntry;
  /** Stable principal key for the per-user cap (email / capability id). */
  principal: string;
  canView: (r: NoteRef) => boolean;
}

export async function openEventStream(c: Context, p: EventStreamParams): Promise<Response> {
  if (total >= cfg.total() || (perPrincipal.get(p.principal) ?? 0) >= cfg.perUser()) {
    return c.json({ error: "too_many_streams" }, 429, { "Retry-After": "30" });
  }
  total++;
  perPrincipal.set(p.principal, (perPrincipal.get(p.principal) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    total--;
    const n = (perPrincipal.get(p.principal) ?? 1) - 1;
    if (n <= 0) perPrincipal.delete(p.principal);
    else perPrincipal.set(p.principal, n);
  };

  let queue: string[] = [];
  let wake: () => void = () => {};
  let closed = false;
  const RESYNC = JSON.stringify({ type: "resync" });
  const push = (ev: InvalidationEvent) => {
    if (closed) return;
    const data = JSON.stringify(ev);
    if (ev.type === "resync") queue = [RESYNC]; // subsumes everything queued
    else if (queue[0] === RESYNC) return; // a pending resync covers this too
    else if (queue.length >= cfg.buffer()) queue = [RESYNC]; // slow client: degrade to resync
    else queue.push(data);
    wake();
  };

  let unsub: () => void;
  try {
    unsub = await subscribeTreeChanges(p.entry, (ch) => {
      const ev = eventFor(ch, p.canView);
      if (ev) push(ev);
    });
  } catch (e) {
    release();
    console.warn(`[events] vault unreachable: ${(e as Error).message}`);
    return c.json({ error: "vault_unreachable" }, 502);
  }

  return streamSSE(c, async (stream) => {
    const finish = () => {
      closed = true;
      wake();
    };
    stream.onAbort(finish);
    const ping = setInterval(() => {
      if (!closed) void stream.write(": ping\n\n").catch(finish);
    }, cfg.pingMs());
    const life = setTimeout(finish, cfg.maxAgeMs());
    ping.unref();
    life.unref();
    try {
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!closed) {
        if (queue.length === 0) await new Promise<void>((r) => (wake = r));
        while (queue.length && !closed) {
          const data = queue.shift()!;
          await stream.writeSSE({ data });
        }
      }
    } catch {
      /* client went away */
    } finally {
      closed = true;
      clearInterval(ping);
      clearTimeout(life);
      unsub();
      release();
    }
  });
}
