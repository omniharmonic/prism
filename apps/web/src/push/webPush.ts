// Web Push client (Arch v2 WP3.3) — the web shell's implementation of core's
// PushClient seam. PWA only: the native (WP2.2) build never registers web push
// (no service worker there). SEAM for WP5.3: the iPhone app registers an APNs
// device token through this same PushClient interface instead of PushManager.
import type { PushClient, PushState } from "@prism/core/shell";
import { isNative, serverFetch } from "../transport";

const hasPushApi = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** iOS/iPadOS Safari exposes the Push API only inside an installed PWA. */
const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** VAPID keys are url-safe base64; PushManager wants bytes. */
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const toB64Url = (buf: ArrayBuffer | null): string =>
  buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "";

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

async function serverKey(): Promise<"server-off" | string> {
  const r = await serverFetch("/api/push/vapid-public-key");
  if (r.status === 503) return "server-off";
  if (!r.ok) throw new Error("Push isn't available for this account (owner only).");
  return ((await r.json()) as { publicKey: string }).publicKey;
}

export const webPush: PushClient = {
  async state(): Promise<PushState> {
    if (isNative) return "unsupported";
    if (!hasPushApi()) return isIos() && !isStandalone() ? "needs-install" : "unsupported";
    if (isIos() && !isStandalone()) return "needs-install";
    if (Notification.permission === "denied") return "denied";
    try {
      const key = await serverKey();
      if (key === "server-off") return "server-off";
    } catch {
      return "unsupported"; // not the server owner
    }
    const sub = await (await registration()).pushManager.getSubscription();
    return sub && Notification.permission === "granted" ? "on" : "off";
  },

  async enable() {
    const key = await serverKey();
    if (key === "server-off") throw new Error("Push isn't configured on this server.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications weren't allowed.");
    const reg = await registration();
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
    const r = await serverFetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: { p256dh: toB64Url(sub.getKey("p256dh")), auth: toB64Url(sub.getKey("auth")) },
      }),
    });
    if (!r.ok) {
      await sub.unsubscribe().catch(() => {});
      throw new Error("The server refused the subscription.");
    }
  },

  async disable() {
    const sub = await (await registration()).pushManager.getSubscription();
    if (!sub) return;
    await serverFetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  },

  async test() {
    // JSON content type: the route is CSRF-guarded. Only the server owner gets
    // per-endpoint counts back; everyone else gets {ok:true}.
    const r = await serverFetch("/api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!r.ok) throw new Error(r.status === 429 ? "Too many test notifications — try again in a minute." : "Couldn't send the test notification.");
    const { sent } = (await r.json()) as { sent?: number };
    if (sent === 0) throw new Error("No active subscription got the notification — turn it off and on again.");
  },
};
