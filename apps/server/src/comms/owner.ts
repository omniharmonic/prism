// Who "self" is for Comms: the Matrix account itself (whoami), the agent's own senders, and the
// OWNER's own senders — his bridge ghosts and the ids his person note claims. The projection
// rebuild works the owner's ids out (it reads every room's members) and stores them here, so the
// timeline route and the live listener — which see one room at a time — use the same set.
import { createHash } from "node:crypto";
import { config } from "../config";
import { db } from "../db";
import { agentSenderIds } from "../worker/matrix";
import type { GhostStats } from "./owner-detect";

/** detected = owner-detect.ts · override = COMMS_OWNER_GHOSTS · configured = ownerProfile ids ·
 *  person = members the people index resolves to the owner's person note. */
export type OwnerSenderSource = "detected" | "override" | "configured" | "person";
export interface OwnerSender { mxid: string; source: OwnerSenderSource; stats?: GhostStats | null }

/** The owner's ids the last rebuild stored (lowercased). */
export function storedOwnerSenders(): string[] {
  return storedOwnerSenderRows().map((r) => r.mxid);
}
export function storedOwnerSenderRows(): OwnerSender[] {
  return (db.prepare(`SELECT mxid, source, stats_json FROM comms_owner_senders ORDER BY mxid`).all() as Array<{ mxid: string; source: OwnerSenderSource; stats_json: string | null }>)
    .map((r) => ({ mxid: r.mxid, source: r.source, stats: r.stats_json ? (JSON.parse(r.stats_json) as GhostStats) : null }));
}

/** Replace the stored set (one transaction). */
export function storeOwnerSenders(entries: Array<{ id: string; source: OwnerSenderSource; stats?: GhostStats | null }>): void {
  const ins = db.prepare(`INSERT OR REPLACE INTO comms_owner_senders (mxid, source, stats_json) VALUES (?, ?, ?)`);
  db.transaction(() => {
    db.prepare(`DELETE FROM comms_owner_senders`).run();
    for (const e of entries) if (e.id) ins.run(e.id.trim().toLowerCase(), e.source, e.stats ? JSON.stringify(e.stats) : null);
  })();
}

/** Networks blocked from auto-detection (an earlier owner ghost there was dropped). */
export function ownerBlockedNetworks(): string[] {
  return (db.prepare(`SELECT network FROM comms_owner_blocks ORDER BY network`).all() as { network: string }[]).map((r) => r.network);
}
export function setOwnerBlockedNetworks(networks: readonly string[], now: number = Date.now()): void {
  const ins = db.prepare(`INSERT OR IGNORE INTO comms_owner_blocks (network, at) VALUES (?, ?)`);
  db.transaction(() => {
    db.prepare(`DELETE FROM comms_owner_blocks WHERE network NOT IN (${networks.map(() => "?").join(",") || "''"})`).run(...networks);
    for (const n of networks) ins.run(n, now);
  })();
}

/** The explicit reset: forget detected ids and blocks; the next rebuild detects afresh. */
export function resetOwnerDetection(): { removed: number; unblocked: number } {
  return db.transaction(() => ({
    removed: db.prepare(`DELETE FROM comms_owner_senders WHERE source = 'detected'`).run().changes,
    unblocked: db.prepare(`DELETE FROM comms_owner_blocks`).run().changes,
  }))();
}

/** Every id Comms treats as self: whoami + the agent's senders + the stored owner ids + `extra`. */
export function commsSelfIds(me: string, extra: readonly string[] = []): string[] {
  return [...new Set([me, ...agentSenderIds(), ...storedOwnerSenders(), ...extra].map((i) => i.trim().toLowerCase()).filter(Boolean))];
}

/** How the owner's ghosts are found now. */
export function ownerDetectionMode(): "override" | "off" | "auto" {
  return config.commsOwnerGhosts.length ? "override" : config.commsOwnerDetect ? "auto" : "off";
}

/** The network of a ghost id (`@telegram_…` → telegram), or "matrix". */
export const ghostNetwork = (mxid: string): string => /^@([a-z]+)_/.exec(mxid.toLowerCase())?.[1] ?? "matrix";
/** A log-safe reference: network + the first 8 hex of sha256(mxid). */
export const redactMxid = (mxid: string): string =>
  `${ghostNetwork(mxid)}:${createHash("sha256").update(mxid.toLowerCase()).digest("hex").slice(0, 8)}`;
