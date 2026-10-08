/**
 * In-process fan-out for the Omni module: per-thread stream subscribers (the
 * `/threads/:id/stream` SSE) and the owner-wide change channel (`/api/omni/events`,
 * ids only). Plus the push seam: an ids-only, content-free notification through the
 * existing APNs sender (injectable for tests).
 */
import { apnsEnabled, sendApnsToOwner } from "../apns";
import { omniConfig } from "./config";
import type { OmniEvent } from "./stream";

export interface ThreadMessage {
  /** Persisted events carry their seq; live-only deltas do not. */
  seq?: number;
  turnId: string | null;
  event: OmniEvent;
}
export interface OmniNotice {
  type: "thread" | "approval" | "card";
  id: string;
  op: string;
  threadId?: string;
}

const threadSubs = new Map<string, Set<(m: ThreadMessage) => void>>();
const globalSubs = new Set<(n: OmniNotice) => void>();

export function subscribeThread(threadId: string, l: (m: ThreadMessage) => void): () => void {
  let s = threadSubs.get(threadId);
  if (!s) threadSubs.set(threadId, (s = new Set()));
  s.add(l);
  return () => {
    s!.delete(l);
    if (s!.size === 0) threadSubs.delete(threadId);
  };
}
export const threadWatched = (threadId: string): boolean => (threadSubs.get(threadId)?.size ?? 0) > 0;
export function publishThread(threadId: string, m: ThreadMessage): void {
  for (const l of [...(threadSubs.get(threadId) ?? [])]) {
    try {
      l(m);
    } catch {
      /* a broken subscriber never stops the turn */
    }
  }
}
export function subscribeNotices(l: (n: OmniNotice) => void): () => void {
  globalSubs.add(l);
  return () => void globalSubs.delete(l);
}
export function publishNotice(n: OmniNotice): void {
  for (const l of [...globalSubs]) {
    try {
      l(n);
    } catch {
      /* ignore */
    }
  }
}

// ── push ────────────────────────────────────────────────────────────────────

/** Push categories (integration-contract.md § 4 Push). */
export type OmniPushKind = "OMNI_THREAD" | "OMNI_APPROVAL";
export type OmniPusher = (owner: string, kind: OmniPushKind, id: string) => Promise<void>;

/**
 * Default: the existing APNs sender, content-free (`{type:"omni", category, id}` +
 * generic alert text; the app fetches everything else). NOTE: it is sent with Prism's
 * configured APNs topic; an Omni-own topic (`/api/omni/push`, contract § 4) is deferred.
 */
const defaultPusher: OmniPusher = async (owner, kind, id) => {
  if (!apnsEnabled()) return;
  const approval = kind === "OMNI_APPROVAL";
  const path = approval ? `approval/${encodeURIComponent(id)}` : `thread/${encodeURIComponent(id)}`;
  await sendApnsToOwner(owner, {
    payload: {
      aps: { alert: { title: "Omni", body: approval ? "A draft is waiting for your review" : "Omni has an update" }, sound: "default", category: kind, "thread-id": approval ? "omni-approvals" : `omni-${id}` },
      type: "omni",
      category: kind,
      id,
      url: `omni://${path}`,
    },
    collapseId: `omni-${kind}-${id}`.slice(0, 64),
  });
};
let pusher: OmniPusher = defaultPusher;
export function setOmniPusherForTests(p: OmniPusher | null): void {
  pusher = p ?? defaultPusher;
}
/** Fire-and-forget; never throws. */
export function pushOmni(kind: OmniPushKind, id: string): void {
  try {
    void pusher(omniConfig.ownerEmail(), kind, id).catch((e) => console.error(`[omni] push failed: ${(e as Error).message}`));
  } catch (e) {
    console.error(`[omni] push failed: ${(e as Error).message}`);
  }
}
