/**
 * Matrix rooms for a thin client (Arch v2 WP4.3). The desktop asked its own
 * Matrix client for the joined-room list (`matrix_get_rooms`); a PWA / Prism
 * Client has no Matrix session, but the server's Matrix ingest keeps one
 * `message-thread` note per room (metadata `{platform, matrixRoomId,
 * participants, lastMessageAt}`), so the room list is derived from those notes
 * and sending goes through the server's live actions (`/api/actions/matrix/send`).
 */
import type { Note } from "../types";
import type { MatrixRoom } from "./types";

/** Pure: `message-thread` notes → MatrixRoom rows (newest activity first). */
export function roomsFromThreadNotes(notes: Array<Pick<Note, "path" | "tags" | "metadata">>): MatrixRoom[] {
  const rooms: Array<MatrixRoom & { _at: number }> = [];
  const seen = new Set<string>();
  for (const n of notes) {
    const m = (n.metadata ?? {}) as Record<string, unknown>;
    const roomId = typeof m.matrixRoomId === "string" ? m.matrixRoomId : "";
    if (!roomId.startsWith("!") || seen.has(roomId)) continue;
    if (!(n.tags ?? []).includes("message-thread")) continue;
    seen.add(roomId);
    const participants = Array.isArray(m.participants) ? m.participants.length : 0;
    const name = (n.path ?? "").split("/").pop()?.replace(/-/g, " ").trim() || roomId;
    const at = typeof m.lastMessageAt === "string" ? Date.parse(m.lastMessageAt) : typeof m.lastMessageAt === "number" ? m.lastMessageAt : 0;
    rooms.push({
      room_id: roomId,
      name,
      platform: typeof m.platform === "string" ? m.platform : "matrix",
      // The ingest records every sender seen; a DM has the user + one other
      // (bridge bots aside). Unknown (no participants yet) counts as a DM so the
      // composer's DM-first match still finds a fresh 1:1 thread.
      is_dm: participants <= 2,
      unread_count: 0,
      last_message: null,
      avatar_url: null,
      member_count: participants,
      _at: Number.isFinite(at) ? at : 0,
    });
  }
  return rooms.sort((a, b) => b._at - a._at).map(({ _at: _ignored, ...r }) => r);
}
