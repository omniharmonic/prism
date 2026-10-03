// APNs for the iOS app (WP5.3) — the iOS shell's implementation of core's
// PushClient seam (the PWA uses webPush.ts). Server contract: docs/push.md § APNs.
//
//  - The token comes from the shell (`push_register`: permission prompt the
//    first time, then registerForRemoteNotifications) and is POSTed here with
//    the device bearer (`serverFetch`), as `{token, environment}`.
//  - It is re-registered on EVERY launch while notifications are on (APNs may
//    rotate tokens; the server keeps one row per device and replaces it).
//  - The permission prompt only ever follows a user action (the Settings toggle
//    "Notify me when an agent finishes"), never a launch or a sign-in by itself.
//  - A tapped notification (ids only) opens its agent session through the
//    same `prism:open-agent-session` event the web push deep link uses.
import type { PushClient, PushState } from "@prism/core";
import { serverFetch } from "../transport";
import { iosShell, shellError } from "./ios";

/** The user's choice on this device: "on" | "off". Absent = never asked. */
const PREF = "prism:apns";
const readPref = (): string | null => {
  try {
    return localStorage.getItem(PREF);
  } catch {
    return null;
  }
};
const writePref = (v: "on" | "off") => {
  try {
    localStorage.setItem(PREF, v);
  } catch {
    /* private mode etc.: the choice just isn't remembered */
  }
};

async function register(): Promise<{ apnsEnabled: boolean }> {
  const shell = iosShell();
  if (!shell) throw new Error("Notifications need the Prism iOS app.");
  let reg;
  try {
    reg = await shell.pushRegister();
  } catch (e) {
    throw new Error(shellError(e));
  }
  const r = await serverFetch("/api/push/apns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: reg.token, environment: reg.environment }),
  });
  if (r.status === 403) throw new Error("Only the server owner gets agent notifications.");
  if (!r.ok) throw new Error("The server refused this device's registration.");
  const body = (await r.json().catch(() => ({}))) as { apnsEnabled?: boolean };
  return { apnsEnabled: body.apnsEnabled !== false };
}

export const apnsPush: PushClient = {
  async state(): Promise<PushState> {
    const shell = iosShell();
    if (!shell) return "unsupported";
    const permission = await shell.pushStatus().catch(() => "denied");
    if (permission === "denied") return "denied";
    return readPref() === "on" && permission !== "notDetermined" ? "on" : "off";
  },

  async enable() {
    writePref("on");
    try {
      const { apnsEnabled } = await register();
      if (!apnsEnabled) {
        throw new Error(
          "This device is registered, but Apple push isn't turned on on the server yet (docs/push.md § APNs). Notifications start once it is.",
        );
      }
    } catch (e) {
      if (/weren't allowed|turned off/i.test((e as Error).message)) writePref("off");
      throw e;
    }
  },

  async disable() {
    writePref("off");
    await serverFetch("/api/push/apns", { method: "DELETE" }).catch(() => {});
  },

  async test() {
    const r = await serverFetch("/api/push/apns/test", { method: "POST" });
    if (r.status === 503) throw new Error("Apple push isn't turned on on the server yet.");
    if (r.status === 404) throw new Error("This device isn't registered. Turn notifications off and on again.");
    if (!r.ok) throw new Error("Couldn't send the test notification.");
    const { result } = (await r.json()) as { result?: string };
    if (result === "pruned") throw new Error("Apple rejected this device's token. Turn notifications off and on again.");
    if (result !== "sent") throw new Error("Apple didn't accept the test notification. Try again in a moment.");
  },
};

const UUID_LIKE = /^[A-Za-z0-9_-]{8,64}$/;

async function openTappedSession(): Promise<void> {
  const id = await iosShell()?.takeOpenedSession();
  if (id && UUID_LIKE.test(id)) {
    window.dispatchEvent(new CustomEvent("prism:open-agent-session", { detail: { sessionId: id } }));
  }
}

let started = false;

/**
 * Boot-time wiring, once per page load, for a signed-in user of the iOS app.
 * `owner`: the APNs routes are server-owner only, so nobody else registers.
 */
export function initIosPush({ owner }: { owner: boolean }): void {
  const shell = iosShell();
  if (!shell || started) return;
  started = true;

  // Taps: warm start (the shell pings us) and cold start (ask once now).
  window.addEventListener("prism:native-push-opened", () => void openTappedSession());
  void openTappedSession();

  if (!owner) return;
  void (async () => {
    // Re-register every launch so the server always has this app's current token —
    // only when the user turned notifications on and iOS already allows them, so
    // this never shows the permission prompt.
    if (readPref() !== "on") return;
    const permission = await shell.pushStatus().catch(() => "denied");
    if (permission !== "authorized" && permission !== "provisional" && permission !== "ephemeral") return;
    await register().catch(() => {});
  })();
}
