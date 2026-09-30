/**
 * On-demand calendar sync (Architecture v2 WP1.3) — replaces the desktop's
 * `calendar_sync_range` Tauri command: `POST /api/calendar/sync?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * pulls that window from Google via the co-located `gog`, upserts the meeting
 * notes and reconciles the window — under the SAME gates as the worker
 * (CALENDAR_SHADOW writes nothing; CALENDAR_DELETE_MODE decides deletes). With
 * both CALENDAR_SYNC_ENABLED and CALENDAR_SHADOW off it refuses (409): the
 * desktop still owns calendar ingest, and two writers reconciling the same
 * window is the double-ingest hazard this package exists to avoid.
 *
 * Admin-session only (same gate as /api/sync); mounted BEFORE the gateway so it
 * is never proxied to the vault. Response = the desktop command's shape
 * ({synced, errors, deleted, cancelled, total, from, to}) plus server counters.
 */
import { Hono } from "hono";
import { resolveActor } from "../auth/actor";
import { roleAtLeast } from "../roles";
import { isIsoDay, runCalendarRange } from "../worker/calendar";

export const calendar = new Hono();

/** A range longer than this is refused (the UI asks for a view: a month or so). */
const MAX_RANGE_DAYS = 400;

calendar.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (actor.kind !== "user" || !roleAtLeast(actor.role, "admin")) return c.json({ error: "forbidden" }, 403);
  await next();
});

calendar.post("/sync", async (c) => {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!isIsoDay(from) || !isIsoDay(to)) return c.json({ error: "bad_request", detail: "from and to must be YYYY-MM-DD" }, 400);
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (span < 0) return c.json({ error: "bad_request", detail: "from must not be after to" }, 400);
  if (span > MAX_RANGE_DAYS) return c.json({ error: "bad_request", detail: `range longer than ${MAX_RANGE_DAYS} days` }, 400);
  const actor = resolveActor(c);
  try {
    return c.json(await runCalendarRange(actor.vaultId, from, to));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "disabled") return c.json({ error: "calendar_sync_disabled", detail: (e as Error).message }, 409);
    if (code === "no_account") return c.json({ error: "google_not_configured", detail: (e as Error).message }, 400);
    return c.json({ error: "sync_failed", detail: (e as Error).message }, 502);
  }
});
