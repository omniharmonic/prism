// Agent-session deep link (Arch v2 WP3.3). A push notification opens
// `/agent/<sessionId>` (cold start) or postMessages the open window from the
// service worker (push-sw.js). Either way the id lands here.
//
// INTEGRATION POINT for WP3.2's Agent view (not merged when this was written):
//   import { takePendingAgentSession, onAgentSessionRequest } from "…/push/deeplink";
//   - on mount:  const id = takePendingAgentSession(); if (id) open that session
//   - while open: const off = onAgentSessionRequest((id) => open that session)
// The same handoff is also dispatched as a `prism:open-agent-session` DOM event
// (detail: { sessionId }), so @prism/core can listen without importing apps/web.
// Also accepted on cold start: `/?agentSession=<id>`.

const EVENT = "prism:open-agent-session";
let pending: string | null = null;

const UUID_LIKE = /^[A-Za-z0-9_-]{8,64}$/;

function deliver(id: string): void {
  if (!UUID_LIKE.test(id)) return;
  pending = id;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { sessionId: id } }));
}

/** Read the session id the page was opened with, then normalise the URL to "/". */
export function initAgentDeepLink(): void {
  const m = window.location.pathname.match(/^\/agent\/([^/]+)\/?$/);
  const q = new URLSearchParams(window.location.search).get("agentSession");
  const id = m ? decodeURIComponent(m[1]!) : q;
  if (id && UUID_LIKE.test(id)) {
    pending = id;
    try {
      window.history.replaceState(null, "", "/");
    } catch {
      /* best-effort */
    }
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { type?: string; sessionId?: unknown } | null;
      if (d?.type === "prism:open-agent-session" && typeof d.sessionId === "string") deliver(d.sessionId);
    });
  }
}

/** Consume the pending session id (once). */
export function takePendingAgentSession(): string | null {
  const id = pending;
  pending = null;
  return id;
}

/** Subscribe to "open this session" requests while the app is running. */
export function onAgentSessionRequest(cb: (sessionId: string) => void): () => void {
  const h = (e: Event) => {
    const id = (e as CustomEvent<{ sessionId: string }>).detail.sessionId;
    pending = null;
    cb(id);
  };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
