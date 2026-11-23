// Comms send ledger (table comms_sends, db.ts): one row per client-chosen message id.
//
// Why not the live-actions ledger (actions/store.ts action_idempotency)? Its rule is "an attempt
// that may have reached the homeserver is burned and replays its failure forever". Comms needs a
// "Try Again" that reuses the SAME clientId after a `maybeSent` failure — and that is safe here,
// because the Matrix transaction id is derived from the clientId: a homeserver that already took
// the first PUT answers the retry with the ORIGINAL event id and posts nothing (Synapse keeps txn
// ids per access token/device: in memory ~30 min, persisted 24 h in current versions). So:
//
//   sent        → replay the stored 200 (Idempotent-Replayed), never send again;
//   pending     → a request with this clientId is running (409 in_progress); a pending row older
//                 than PENDING_STALE_MS is an attempt that died mid-flight → retryable like maybe_sent;
//   maybe_sent  → retry allowed with the same txn id, only within the retry window (6 h with a
//                 device token, 25 min without one — RETRY_WINDOW*_MS) of the FIRST
//                 attempt and only with the same Matrix credential (txn ids are scoped to it);
//                 otherwise refused as `expired` (the client must not resend blind);
//   no row      → claim it. A failure that provably sent nothing deletes the row (release).
// Same clientId + a different request (thread, text, bytes …) → `mismatch` (422).
//
// The row also maps the sent event id back to its clientId, so the echoed message can carry
// `clientId` and is never mistaken for an Omni-authored one (timeline.ts messageOut).
import { createHmac, createHash } from "node:crypto";
import { config } from "../config";
import { db } from "../db";
import { MATRIX_SEND_EVENT_TIMEOUT_MS, MATRIX_UPLOAD_TIMEOUT_MS } from "../worker/matrix";

export type SendKind = "text" | "image" | "video" | "file" | "voice" | "reaction";

/** The read deadline of the send pipeline's Matrix client (joined rooms, whoami, members,
 *  encryption state, replied-to event). */
export const SEND_READ_TIMEOUT_MS = 15_000;
/** Worst case one attempt can stay in flight after its claim: up to five reads, the file and the
 *  thumbnail uploads, the event PUT. A pending row older than this (+ 1 min slack) is an attempt
 *  that died (crash / restart), never one still running — derived, so a timeout change moves it. */
export const PENDING_STALE_MS = 5 * SEND_READ_TIMEOUT_MS + 2 * MATRIX_UPLOAD_TIMEOUT_MS + MATRIX_SEND_EVENT_TIMEOUT_MS + 60_000;
/** A maybe-sent message may be retried with the same txn id for this long after its first
 *  attempt — when the token has a DEVICE (Synapse persists txn ids per device, 24 h). */
export const RETRY_WINDOW_MS = 6 * 3_600_000;
/** …and only this long for a device-less token (admin-minted / appservice): Synapse then keeps
 *  txn ids in memory only (~30 min, and a restart forgets them). */
export const RETRY_WINDOW_NO_DEVICE_MS = 25 * 60_000;
/** Rows (and with them the eventId → clientId echo) are kept this long. */
const KEEP_MS = 90 * 24 * 3_600_000;

/** HMAC (server secret) for anything derived from message content that is kept: the ledger's
 *  request hash and the audit's text hash. A plain hash of "ok" is a dictionary lookup. */
const hashKey = (): Buffer => createHash("sha256").update(`prism-comms-send-hash\n${config.sessionSecret}`).digest();
export const contentHmac = (s: string): string => createHmac("sha256", hashKey()).update(s, "utf8").digest("hex");

export type SendClaim =
  | { kind: "claimed"; retry: boolean; attempt: number }
  | { kind: "replay"; response: Record<string, unknown> }
  | { kind: "mismatch" }
  | { kind: "in_progress" }
  | { kind: "expired" };

interface Row {
  actor_email: string;
  request_hash: string;
  cred_hash: string | null;
  state: "pending" | "sent" | "maybe_sent";
  attempts: number;
  event_id: string | null;
  thread_id: string;
  created_at: number;
  updated_at: number;
}

let clock: () => number = () => Date.now();
export function setSendLedgerClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/** Atomically claim `clientId` for this request, or say why not. */
export function claimSend(p: {
  clientId: string; actorEmail: string; threadId: string; kind: SendKind; requestHash: string; credHash: string;
  /** RETRY_WINDOW_MS, or RETRY_WINDOW_NO_DEVICE_MS for a device-less token. */
  retryWindowMs: number;
}): SendClaim {
  const now = clock();
  return db.transaction((): SendClaim => {
    db.prepare(`DELETE FROM comms_sends WHERE created_at < ?`).run(now - KEEP_MS);
    const row = db.prepare(`SELECT actor_email, request_hash, cred_hash, state, attempts, event_id, thread_id, created_at, updated_at
      FROM comms_sends WHERE client_id = ?`).get(p.clientId) as Row | undefined;
    if (!row) {
      db.prepare(`INSERT INTO comms_sends (client_id, actor_email, thread_id, kind, request_hash, cred_hash, state, attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`).run(p.clientId, p.actorEmail, p.threadId, p.kind, p.requestHash, p.credHash, now, now);
      return { kind: "claimed", retry: false, attempt: 1 };
    }
    if (row.actor_email !== p.actorEmail || row.request_hash !== p.requestHash) return { kind: "mismatch" };
    if (row.state === "sent") {
      return { kind: "replay", response: { clientId: p.clientId, eventId: row.event_id ?? "", status: "sent" } };
    }
    if (row.state === "pending" && now - row.updated_at <= PENDING_STALE_MS) return { kind: "in_progress" };
    // maybe_sent, or a pending attempt that died: the same txn id may be PUT again — only while
    // the homeserver still remembers it, and only with the credential it is scoped to.
    if (now - row.created_at > p.retryWindowMs || row.cred_hash !== p.credHash) return { kind: "expired" };
    db.prepare(`UPDATE comms_sends SET state = 'pending', attempts = attempts + 1, updated_at = ? WHERE client_id = ?`).run(now, p.clientId);
    return { kind: "claimed", retry: true, attempt: row.attempts + 1 };
  })();
}

// Every write below is bound to the ATTEMPT that claimed the row: a slow first attempt that
// finishes after a Try Again reclaimed the row (stale) must not delete or overwrite the row the
// retry now owns.

export function markSent(clientId: string, attempt: number, eventId: string): void {
  db.prepare(`UPDATE comms_sends SET state = 'sent', event_id = ?, updated_at = ? WHERE client_id = ? AND attempts = ?`).run(eventId, clock(), clientId, attempt);
}

/** The homeserver may have accepted it: keep the row (retryable with the same txn id). */
export function markMaybeSent(clientId: string, attempt: number): void {
  db.prepare(`UPDATE comms_sends SET state = 'maybe_sent', updated_at = ? WHERE client_id = ? AND attempts = ? AND state = 'pending'`).run(clock(), clientId, attempt);
}

/** Nothing left the server for this attempt. A FIRST attempt's row is deleted (the clientId is
 *  free again); a retry of a maybe-sent message goes back to maybe_sent — the earlier attempt
 *  may still have landed, so the row must keep guarding the txn id. */
export function releaseSend(clientId: string, attempt: number, retry: boolean): void {
  if (retry) markMaybeSent(clientId, attempt);
  else db.prepare(`DELETE FROM comms_sends WHERE client_id = ? AND attempts = ? AND state = 'pending'`).run(clientId, attempt);
}

/** The clientId a sent event was sent under (the echo), or null: the ledger once the send answered,
 *  else an echo recorded before the answer (recordEchoClientId). */
export function clientIdForEvent(eventId: string): string | null {
  if (!eventId) return null;
  const r = db.prepare(`SELECT client_id FROM comms_sends WHERE event_id = ? AND state = 'sent' LIMIT 1`).get(eventId) as { client_id: string } | undefined;
  if (r) return r.client_id;
  const e = db.prepare(`SELECT client_id FROM comms_echo_ids WHERE event_id = ?`).get(eventId) as { client_id: string } | undefined;
  return e?.client_id ?? null;
}

/** The Matrix transaction id of a Comms send (txn id = f(clientId); the homeserver dedupes on it). */
export const txnIdFor = (clientId: string): string => `comms-${createHash("sha256").update(`comms-send\n${clientId}`).digest("hex").slice(0, 32)}`;
const TXN_RE = /^comms-[0-9a-f]{32}$/;

/** The clientId behind a Matrix echo's `unsigned.transaction_id` (the homeserver includes it for
 *  events this access token sent — the send and the projection share the stored credential), or
 *  null. Only ledger rows of the last 26 h are candidates (txn ids are kept 24 h upstream). */
export function clientIdForTxn(txn: string | null | undefined): string | null {
  if (!txn || !TXN_RE.test(txn)) return null;
  const rows = db.prepare(`SELECT client_id FROM comms_sends WHERE created_at >= ? AND kind != 'reaction'`).all(clock() - 26 * 3_600_000) as { client_id: string }[];
  return rows.find((r) => txnIdFor(r.client_id) === txn)?.client_id ?? null;
}

/** Remember that source message `eventId` is the echo of Comms send `clientId` (an echo that came
 *  before the send's answer). Only a clientId the ledger knows is recorded. */
export function recordEchoClientId(eventId: string, clientId: string): boolean {
  if (!eventId || !db.prepare(`SELECT 1 FROM comms_sends WHERE client_id = ?`).get(clientId)) return false;
  const now = clock();
  db.prepare(`DELETE FROM comms_echo_ids WHERE created_at < ?`).run(now - KEEP_MS);
  db.prepare(`INSERT INTO comms_echo_ids (event_id, client_id, created_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING`).run(eventId, clientId, now);
  return true;
}
