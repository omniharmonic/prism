import { Hono } from "hono";
import { config } from "../config";
import { resolveActor } from "../auth/actor";
import { resolveVaultEntry } from "../db";
import { getSecret } from "../secrets";
import { vaultClient } from "../parachute";
import { consumeRateLimit } from "../middleware/ratelimit";
import { MatrixClient, type MatrixCreds, type MatrixEvent } from "../worker/matrix";
import { validateRoomId } from "../actions/matrix";
import type { MatrixMessage } from "@prism/core/messages";

type Reader = Pick<MatrixClient, "whoami" | "joinedRooms" | "joinedMembers" | "messagePage">;
let factory: ((creds: MatrixCreds) => Reader) | null = null;
export function setThreadReaderForTests(value: typeof factory) { factory = value; }
export const threadsApi = new Hono();

/** Source identity is authoritative. Display names never determine who is You. */
export function projectMessage(event: MatrixEvent, self: string, names: Record<string, string>): MatrixMessage | null {
  if (event.type !== "m.room.message" || typeof event.event_id !== "string" || !event.event_id ||
    typeof event.sender !== "string" || !event.sender) return null;
  const content = event.content ?? {};
  const redacted = !!event.unsigned?.redacted_because;
  const body = typeof content.body === "string" ? content.body : "";
  if (!redacted && !body && typeof content.url !== "string") return null;
  // Edited events are retained as distinct source events until a durable edit
  // projection can reconcile the original across page boundaries. No guessing.
  return {
    event_id: event.event_id, sender: event.sender, sender_name: names[event.sender] || event.sender,
    body: redacted ? "Message removed" : body.slice(0, 64_000),
    msg_type: typeof content.msgtype === "string" ? content.msgtype : "m.text",
    timestamp: typeof event.origin_server_ts === "number" && Number.isFinite(event.origin_server_ts) ? event.origin_server_ts : 0,
    is_outgoing: event.sender === self, media_url: !redacted && typeof content.url === "string" && content.url.startsWith("mxc://") ? content.url : null,
    media_info: null, source: "matrix", redacted, truncated: !redacted && body.length > 64_000,
  };
}

threadsApi.get("/:id/live", async c => {
  c.header("Cache-Control", "private, no-store");
  const actor = resolveActor(c);
  // The connector belongs to the server owner, not everyone who can read a
  // saved transcript. Secondary-vault secrets cannot redirect this reader.
  if (actor.kind !== "user" || actor.email !== config.ownerEmail) return c.json({ error: "forbidden" }, 403);
  const primary = resolveVaultEntry(undefined);
  if (actor.vaultId !== primary.id || (c.req.header("X-Prism-Vault") && c.req.header("X-Prism-Vault") !== primary.id))
    return c.json({ error: "source_vault_unavailable" }, 409);
  const before = c.req.query("before");
  if (before !== undefined && (!before || before.length > 2048 || /[\u0000-\u001f]/.test(before))) return c.json({ error: "invalid_cursor" }, 400);
  const limited = consumeRateLimit(`thread-live:${actor.email}`, 120, 60_000);
  if (limited) { c.header("Retry-After", String(limited)); return c.json({ error: "rate_limited" }, 429); }
  try {
    const vc = vaultClient(primary.id);
    const note = await vc.getNote(c.req.param("id"));
    if (!note.tags?.includes("message-thread")) return c.json({ error: "thread_unavailable" }, 404);
    const room = validateRoomId(note.metadata?.matrixRoomId ?? note.metadata?.matrix_room_id);
    const creds = JSON.parse(getSecret(primary.id, config.ownerEmail, "matrix") ?? "null") as MatrixCreds | null;
    if (!creds?.homeserver || !creds.accessToken) return c.json({ error: "source_unconfigured" }, 503);
    const reader = factory ? factory(creds) : new MatrixClient(creds, fetch, 15_000);
    if (!(await reader.joinedRooms()).includes(room)) return c.json({ error: "room_unavailable" }, 404);
    const [self, names, page] = await Promise.all([
      reader.whoami(), reader.joinedMembers(room).catch(() => ({})), reader.messagePage(room, before, 50),
    ]);
    const current = resolveActor(c);
    if (current.kind !== "user" || current.email !== actor.email || current.vaultId !== actor.vaultId)
      return c.json({ error: "access_changed" }, 403);
    const latest = await vc.getNote(note.id);
    if (!latest.tags?.includes("message-thread") || (latest.metadata?.matrixRoomId ?? latest.metadata?.matrix_room_id) !== room)
      return c.json({ error: "thread_changed" }, 409);
    const seen = new Set<string>();
    const messages = page.chunk.map(e => projectMessage(e, self, names)).filter((m): m is MatrixMessage => {
      if (!m || seen.has(m.event_id)) return false;
      seen.add(m.event_id); return true;
    });
    const end = page.end && page.end !== before && page.end !== page.start ? page.end : null;
    return c.json({ messages, start: page.start, end, has_more: !!end && page.chunk.length > 0 });
  } catch { return c.json({ error: "live_thread_unavailable" }, 503); }
});
