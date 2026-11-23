/**
 * Live Matrix actions (Arch v2 WP1.5): send a text message, react to an event.
 *
 * Uses the stored `matrix` credential ({homeserver, accessToken}) and the ingest's
 * `MatrixClient` (worker/matrix.ts). Target rules (enforced in routes/actions.ts):
 *   - a HUMAN-origin request (session cookie / device token) may target any room
 *     the account has JOINED (checked live via /joined_rooms, cached briefly);
 *   - an AGENT-origin request (Prism MCP in-process dispatch, loopback owner
 *     token) may target only rooms in ACTIONS_MATRIX_AGENT_ROOMS (and joined).
 * The Matrix transaction id is derived from the idempotency key, so even a retry
 * that slipped past the ledger is deduped by the homeserver.
 */
import crypto from "node:crypto";
import { config } from "../config";
import { getSecret } from "../secrets";
import { MatrixClient, type MatrixCreds } from "../worker/matrix";
import { ActionInputError, ActionTransportError } from "./email";

export const MATRIX_LIMITS = { maxBody: 32_000, maxKey: 64 } as const;

// !opaque:server.name  /  $eventid (v3+ rooms: url-safe base64; older: $x:server)
const ROOM_ID_RE = /^![A-Za-z0-9._~=+/-]{1,255}:[A-Za-z0-9.-]{1,255}(:\d{1,5})?$/;
const EVENT_ID_RE = /^\$[A-Za-z0-9._~=+/:-]{1,255}$/;

export function validateRoomId(v: unknown): string {
  if (typeof v !== "string" || !ROOM_ID_RE.test(v)) throw new ActionInputError("roomId: not a valid Matrix room id");
  return v;
}
export function validateEventId(v: unknown): string {
  if (typeof v !== "string" || !EVENT_ID_RE.test(v)) throw new ActionInputError("eventId: not a valid Matrix event id");
  return v;
}
export function validateBody(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new ActionInputError("body: required");
  if (v.includes("\0")) throw new ActionInputError("body: invalid characters");
  if (Buffer.byteLength(v, "utf8") > MATRIX_LIMITS.maxBody) throw new ActionInputError("body: too large");
  return v;
}
export function validateReactionKey(v: unknown): string {
  if (typeof v !== "string" || !v || /[\0\r\n]/.test(v) || [...v].length > MATRIX_LIMITS.maxKey) {
    throw new ActionInputError("key: a short reaction (e.g. an emoji) is required");
  }
  return v;
}

/** Deterministic, opaque Matrix txn id for an idempotency key (or a random one). */
export const txnIdFor = (idempotencyKey: string | null): string =>
  `prism-act-${idempotencyKey ? crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32) : crypto.randomUUID()}`;

export type MatrixActionClient = Pick<MatrixClient, "sendEvent" | "joinedRooms">;
type ClientFactory = (creds: MatrixCreds) => MatrixActionClient;

let factory: ClientFactory | null = null;
/** Inject a fake client factory (tests). `null` restores the real one. */
export function setMatrixActionClientForTests(f: ClientFactory | null): void {
  factory = f;
  joinedCache.clear();
}
export const matrixActionClient = (creds: MatrixCreds): MatrixActionClient => (factory ?? ((c) => new MatrixClient(c)))(creds);

const JOINED_TTL_MS = 60_000;
const joinedCache = new Map<string, { at: number; rooms: Set<string> }>();

/** Is the account joined to `roomId`? (/joined_rooms, cached 60 s per homeserver+token.) */
export async function isJoined(client: MatrixActionClient, creds: MatrixCreds, roomId: string, now = Date.now()): Promise<boolean> {
  const k = crypto.createHash("sha256").update(`${creds.homeserver}\n${creds.accessToken}`).digest("hex");
  let hit = joinedCache.get(k);
  if (!hit || now - hit.at > JOINED_TTL_MS || !hit.rooms.has(roomId)) {
    // A miss refreshes once, so a room joined a moment ago is not refused.
    hit = { at: now, rooms: new Set(await client.joinedRooms()) };
    joinedCache.set(k, hit);
  }
  return hit.rooms.has(roomId);
}

/** The stored `matrix` credential of `vaultId` (owner-written), or null when absent/invalid. */
export function loadMatrixCreds(vaultId: string): MatrixCreds | null {
  try {
    const c = JSON.parse(getSecret(vaultId, config.ownerEmail, "matrix") ?? "null") as MatrixCreds | null;
    return c?.homeserver && c.accessToken ? c : null;
  } catch {
    return null;
  }
}

/**
 * PUT one event with a caller-chosen txn id, classifying a failure for the caller's
 * idempotency ledger: a 4xx answer means the homeserver refused it (nothing was posted,
 * `sent: false`); no answer / timeout / 5xx means it may have been accepted (`unknown`).
 * Shared by /api/actions/matrix/* and the Comms send routes.
 */
export async function sendMatrixEvent(
  client: Pick<MatrixClient, "sendEvent">,
  roomId: string,
  type: "m.room.message" | "m.reaction",
  txnId: string,
  content: Record<string, unknown>,
): Promise<string> {
  try {
    return await client.sendEvent(roomId, type, txnId, content);
  } catch (e) {
    const status = (e as { status?: number }).status;
    throw new ActionTransportError(`matrix send failed (${status ?? "network"})`, typeof status === "number" && status >= 400 && status < 500 ? false : "unknown");
  }
}
