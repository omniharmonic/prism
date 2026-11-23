// Pins (sprint Task 8): the owner's pinned conversations, shared by every device.
//
//   GET    /api/comms/pins              → {threads: Thread[]} in grid order (at most 9)
//   POST   /api/comms/threads/:id/pin   → {thread}        409 pin_limit {max: 9} past nine
//   DELETE /api/comms/threads/:id/pin   → {thread}
//   PUT    /api/comms/pins {threadIds}  → {threads}       409 pins_changed {threadIds: current}
//
// Owner only (requireCommsOwner), behind COMMS_PINS_ENABLED (off → 404 pins_disabled). The
// global CSRF floor (middleware/csrf.ts) covers the writes; PUT takes application/json ≤ 4 KB.
// A pin only writes the owner override on comms_threads — nothing is sent to any network.
import { resolveThreadRedirect } from "../comms/forums";
import type { Context } from "hono";
import { config } from "../config";
import { requireCommsOwner } from "../comms/guard";
import { MAX_PINS, PinError, pinThread, reorderPins, unpinThread, pinnedIds } from "../comms/pins";
import { pinnedThreads } from "../comms/store";
import { threadOut } from "../comms/timeline";
import { readCapped } from "./actions";
import { humanOnly } from "./comms-thread-actions";

const MAX_THREAD_ID = 200;

function gate(c: Context, write = true) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g;
  if (!config.commsPinsEnabled) return { ok: false as const, res: c.json({ error: "pins_disabled" }, 404) };
  // Pins are the owner's own arrangement: writes are a person's (final review I2).
  const refused = write ? humanOnly(c) : null;
  if (refused) return { ok: false as const, res: refused };
  return g;
}

function pinErr(c: Context, e: unknown): Response {
  if (!(e instanceof PinError)) throw e;
  if (e.code === "pin_limit") return c.json({ error: e.code, max: MAX_PINS }, 409);
  if (e.code === "pins_changed") return c.json({ error: e.code, threadIds: pinnedIds() }, 409);
  return c.json({ error: e.code }, e.status);
}

export function getPins(c: Context): Response {
  const g = gate(c, false);
  if (!g.ok) return g.res;
  return c.json({ threads: pinnedThreads().map((t) => threadOut(t, g.actor)) });
}

export function postPin(c: Context): Response {
  const g = gate(c);
  if (!g.ok) return g.res;
  const id = resolveThreadRedirect(c.req.param("id") ?? "");
  if (!id || id.length > MAX_THREAD_ID) return c.json({ error: "thread_unavailable" }, 404);
  try {
    return c.json({ thread: threadOut(pinThread(id), g.actor) });
  } catch (e) {
    return pinErr(c, e);
  }
}

export function deletePin(c: Context): Response {
  const g = gate(c);
  if (!g.ok) return g.res;
  const id = resolveThreadRedirect(c.req.param("id") ?? "");
  if (!id || id.length > MAX_THREAD_ID) return c.json({ error: "thread_unavailable" }, 404);
  try {
    return c.json({ thread: threadOut(unpinThread(id), g.actor) });
  } catch (e) {
    return pinErr(c, e);
  }
}

export async function putPins(c: Context): Promise<Response> {
  const g = gate(c);
  if (!g.ok) return g.res;
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return c.json({ error: "unsupported_type" }, 415);
  const raw = await readCapped(c.req.raw, 4 * 1024);
  if (raw === null) return c.json({ error: "too_large" }, 413);
  let ids: unknown;
  try {
    const body = JSON.parse(raw) as unknown;
    ids = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).threadIds : undefined;
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (!Array.isArray(ids) || ids.length > MAX_PINS || ids.some((v) => typeof v !== "string" || !v || v.length > MAX_THREAD_ID))
    return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json({ threads: reorderPins((ids as string[]).map(resolveThreadRedirect)).map((t) => threadOut(t, g.actor)) });
  } catch (e) {
    return pinErr(c, e);
  }
}
