/**
 * In-process fan-out for the Omni module: per-thread stream subscribers (the
 * `/threads/:id/stream` SSE) and the owner-wide change channel (`/api/omni/events`,
 * ids only). Plus the push seam: an per-device opt-in notification through the
 * existing APNs sender (injectable for tests).
 */
import { apnsEnabled, sendApnsToOwner, type NotificationPreview, type ApnsNotification } from "../apns";
import { getThread } from "./store";
import { getApproval } from "./approvals";
import { approvalBody, approvalHeadline } from "./push-text";
import { getCard } from "./cards";
import { cardNotification, cardPushAllowed } from "./card-push";
import { attentionNotificationBody } from "./attention-preferences";
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
export type OmniPushKind = "OMNI_THREAD" | "OMNI_APPROVAL" | "OMNI_CARD";
export type OmniPusher = (owner: string, kind: OmniPushKind, id: string, completedReply?: string) => Promise<void>;

/** Plain, bounded Unicode text. Code, links and local/media paths are not previews. */
export function notificationText(value: string, max: number): string {
  const plain = value.slice(0, 32_768)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/`[^`]*(?:`|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\.(?:wav|mp3|m4a|aac|ogg|flac|aiff|caf)[^)]*\)/gi, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/(?:https?:\/\/|file:\/\/|\/|~\/)[^\s]+|\b[^\s]+\.(?:wav|mp3|m4a|aac|ogg|flac|aiff|caf)\b/gi, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/(?:^|\n)\s*(?:#{1,6}|>|[-*+] |\d+\. )/g, " ")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ").trim();
  const chars = Array.from(plain);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : plain;
}

/**
 * Private payload construction: content never enters the owner-wide notice bus.
 * A thread: `title` = the thread's title, `completedReply` = its finished answer.
 * An approval: `title` = its headline ("Tweet ready to approve"), `completedReply` = the plain
 * preview of what would be sent. `generic` devices always get the fixed wording.
 */
export function omniNotification(kind: OmniPushKind, id: string, preference: NotificationPreview = "generic", title?: string, completedReply?: string): ApnsNotification {
  const approval = kind === "OMNI_APPROVAL";
  const path = approval ? `approval/${encodeURIComponent(id)}` : `thread/${encodeURIComponent(id)}`;
  let alertTitle = "Omni";
  let body = approval ? "A draft is waiting for your review" : "Omni has an update";
  // Without a completed visible answer (errors, external hooks, code/audio-only), a thread stays generic.
  const preview = completedReply ? notificationText(completedReply, 180) : "";
  const headline = title ? notificationText(title, 80) : "";
  if (approval && preference !== "generic" && headline) {
    alertTitle = headline;
    if (preference === "title_preview" && preview) body = preview;
  } else if (!approval && preference !== "generic" && preview && headline) {
    alertTitle = headline;
    if (preference === "title_preview") body = preview;
  }
  return {
    payload: {
      aps: { alert: { title: alertTitle, body }, sound: "default", category: kind, "thread-id": approval ? "omni-approvals" : `omni-${id}` },
      type: "omni", category: kind, id, url: `omni://${path}`,
    },
    collapseId: `omni-${kind}-${id}`.slice(0, 64),
  };
}
const defaultPusher: OmniPusher = async (owner, kind, id, completedReply) => {
  if (!apnsEnabled()) return;
  if (kind === "OMNI_CARD") {
    const card = getCard(owner, id);
    if (!card || !cardPushAllowed(owner)) return;
    const generic = attentionNotificationBody(owner);
    await sendApnsToOwner(owner, (row) => cardNotification(card, row.preview, generic), "omni");
    return;
  }
  if (kind === "OMNI_APPROVAL") {
    const a = getApproval(owner, id);
    const headline = a ? approvalHeadline(a) : undefined;
    const body = a ? approvalBody(a) || undefined : undefined;
    await sendApnsToOwner(owner, row => omniNotification(kind, id, row.preview, headline, body), "omni");
    return;
  }
  const title = getThread(id)?.title ?? undefined;
  await sendApnsToOwner(owner, row => omniNotification(kind, id, row.preview, title, completedReply), "omni");
};
let pusher: OmniPusher = defaultPusher;
export function setOmniPusherForTests(p: OmniPusher | null): void {
  pusher = p ?? defaultPusher;
}
/** Fire-and-forget; never throws. */
export function pushOmni(kind: OmniPushKind, id: string, completedReply?: string): void {
  try {
    void pusher(omniConfig.ownerEmail(), kind, id, completedReply).catch(() => console.error("[omni] push failed"));
  } catch (e) {
    console.error("[omni] push failed");
  }
}
