/* Web Push handlers (Arch v2 WP3.3). Loaded INTO the generated Workbox service
 * worker via `workbox.importScripts: ["push-sw.js"]` (vite.config.ts), so the
 * precache + navigateFallbackDenylist behaviour is untouched. Classic script —
 * no imports, no build step.
 *
 * PRIVACY: the push payload is ids only ({type, sessionId, turnId, status}).
 * The notification text is generic and content-free; nothing is fetched here.
 *
 * Click → focus an open Prism window and tell it which session to open, else
 * open `/agent/<sessionId>` (a CLIENT route; the server serves the SPA shell and
 * apps/web/src/push/deeplink.ts hands the id to the Agent view).
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = {};
  }
  const isTurn = data && data.type === "agent-turn" && typeof data.sessionId === "string";
  const failed = isTurn && data.status !== "done";
  const title = "Prism";
  const body = isTurn ? (failed ? "Agent needs attention" : "Your agent finished") : "Notifications are working";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // One notification per session: a newer turn replaces the older one.
      tag: isTurn ? "agent-" + data.sessionId : "prism-test",
      renotify: true,
      data: { sessionId: isTurn ? data.sessionId : null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  // sessionId is a server uuid; encode defensively anyway.
  const target = sessionId ? "/agent/" + encodeURIComponent(sessionId) : "/";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (win) {
        if (sessionId) win.postMessage({ type: "prism:open-agent-session", sessionId });
        return win.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
