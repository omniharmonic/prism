/**
 * Notification deep links (wave 2A): open the page a notification is about and
 * land on the exact chip / comment / reminder it points at.
 *
 * Anchors are DOM attributes the editors already render:
 *   mention  → [data-mention-uid="<uid>"]       (MentionNode)
 *   reminder → [data-reminder="<reminder id>"]  (date chip with a reminder)
 *   thread   → [data-comment-id="<thread id>"]  (comment anchor mark)
 *   property → [data-property-key="<key>"]      (the page's property bar row; `assigned`)
 * For a thread we also dispatch `prism:open-comment-thread` {threadId} so a
 * comments sidebar can open that thread. Values are matched with CSS.escape —
 * they come from the server but are never trusted as selectors.
 */
import { useUIStore } from "../../app/stores/ui";
import type { ContentType } from "../types";
import type { NotificationItem } from "./client";

export const ANCHOR_FLASH_CLASS = "prism-anchor-flash";
/** `{noteId, key}`: show this property in the page's property bar (it may be hidden while empty). */
export const REVEAL_PROPERTY_EVENT = "prism:reveal-property";
const WAIT_MS = 8_000;

function esc(v: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
}

export function anchorSelector(anchor: NotificationItem["anchor"]): string | null {
  if (!anchor) return null;
  if (anchor.mention) return `[data-mention-uid="${esc(anchor.mention)}"]`;
  if (anchor.reminder) return `[data-reminder="${esc(anchor.reminder)}"]`;
  if (anchor.thread) return `[data-comment-id="${esc(anchor.thread)}"]`;
  if (anchor.property) return `[data-property-key="${esc(anchor.property)}"]`;
  return null;
}

/** Wait for `selector` inside the workspace document, scroll to it and flash it. */
export function focusAnchor(selector: string, root: ParentNode = document): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const scope = (root as Document).getElementById?.("workspace-document") ?? root;
      const el = scope.querySelector<HTMLElement>(selector);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add(ANCHOR_FLASH_CLASS);
        el.setAttribute("data-anchor-target", "true");
        window.setTimeout(() => {
          el.classList.remove(ANCHOR_FLASH_CLASS);
          el.removeAttribute("data-anchor-target");
        }, 2_400);
        resolve(true);
        return;
      }
      if (Date.now() - started > WAIT_MS) return resolve(false);
      window.setTimeout(tick, 120);
    };
    tick();
  });
}

/**
 * Open the page of a notification and jump to its anchor. Returns false when
 * there is nothing to open (an access outcome without a viewable page).
 */
export function openNotification(item: NotificationItem): boolean {
  if (!item.noteId) return false;
  useUIStore.getState().openTab(item.noteId, item.title ?? "Page", "document" as ContentType);
  if (item.anchor?.thread) {
    window.dispatchEvent(new CustomEvent("prism:open-comment-thread", { detail: { noteId: item.noteId, threadId: item.anchor.thread } }));
  }
  // A property the bar keeps folded away is brought out first (PropertyBar listens).
  if (item.anchor?.property) {
    const detail = { noteId: item.noteId, key: item.anchor.property };
    window.dispatchEvent(new CustomEvent(REVEAL_PROPERTY_EVENT, { detail }));
    window.setTimeout(() => window.dispatchEvent(new CustomEvent(REVEAL_PROPERTY_EVENT, { detail })), 600);
  }
  const selector = anchorSelector(item.anchor);
  if (selector) void focusAnchor(selector);
  return true;
}

/**
 * A notification click while Prism is already open: the service worker
 * (push-sw.js) posts `{type: "prism:open-notification", notificationId}` (or the
 * bare `{type: "prism:open-inbox"}`) to the window; this opens the Inbox tab. Returns an unsubscribe. No-op without a service worker (native shell).
 */
export function listenForInboxOpenRequests(): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const h = (e: MessageEvent) => {
    const d = e.data as { type?: unknown } | null;
    if (d?.type !== "prism:open-inbox" && d?.type !== "prism:open-notification") return;
    const id = (d as { notificationId?: unknown }).notificationId;
    if (typeof id === "string") setPendingNotification(id);
    useUIStore.getState().openTab("notifications", "Inbox", "notifications" as ContentType);
    window.dispatchEvent(new Event("prism:notifications-changed"));
  };
  navigator.serviceWorker.addEventListener("message", h);
  return () => navigator.serviceWorker.removeEventListener("message", h);
}

/**
 * A notification id to open as soon as the Inbox has it loaded (push deep link:
 * `/inbox/<id>` on cold start, or the service worker's postMessage). Ids are
 * server-minted; anything not matching the strict shape is ignored.
 */
let pendingNotification: string | null = null;
export function setPendingNotification(id: string | null): void {
  pendingNotification = id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}
export function takePendingNotification(): string | null {
  return pendingNotification;
}
export function clearPendingNotification(): void {
  pendingNotification = null;
}
