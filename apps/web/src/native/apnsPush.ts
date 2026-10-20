// APNs for the iOS app (WP5.3) — the iOS shell's implementation of core's
// PushClient seam (the PWA uses webPush.ts). Server contract: docs/push.md § APNs.
//
//  - The token comes from the shell (`push_register`: permission prompt the
//    first time, then registerForRemoteNotifications) and is POSTed here with
//    the device bearer (`serverFetch`), as `{token, environment}`. The routes
//    refuse anything but the app's `pd_` device credential (a cookie → 403
//    `device_token_required`) and bind the row to that device.
//  - Every signed-in account may register (wave 2A: mentions, replies, reminders
//    and access requests notify members too; agent-turn pushes still only reach
//    the session owner). The choice is remembered PER ACCOUNT on this device, so
//    a second person signing in on the same phone is asked for themselves.
//  - While it is on, the token is re-registered on EVERY launch (APNs may rotate
//    tokens; the server keeps one row per device and replaces it).
//  - The permission prompt only ever follows a user action (the Settings
//    toggle), never a launch or a sign-in by itself.
//  - Turning it off, signing out and "Sign out & change server" remove the row
//    (DELETE here; the shell's sign-out and the server's device revoke do too).
//  - A tapped notification (ids only) arrives as a validated client PATH from the
//    shell (`/agent/<id>` or `/inbox/<id>`, null while the app is locked) and is
//    opened as a tab through the same code as an incoming link.
import type { PushClient, PushState } from "@prism/core/shell";
import { getMe } from "../config";
import { gatewayOrigin, serverFetch } from "../transport";
import { openAppLink } from "./appLinks";
import { iosShell, shellError } from "./ios";

/** The pre-account-scoped key (one choice per device); removed on first use. */
const LEGACY_PREF = "prism:apns";
const PREF_PREFIX = "prism:apns:";

/** A short, non-reversible tag (two 32-bit FNV-1a passes → 16 hex): no address is stored. */
function tag(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ ((c << 5) | (c >>> 3)) ^ i, 0x85ebca6b);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** This account's key on this server, or null when nobody is signed in. */
function prefKey(): string | null {
  const email = getMe()?.email;
  return email ? PREF_PREFIX + tag(`${gatewayOrigin()}\n${email.toLowerCase()}`) : null;
}

/** The user's choice on this device: "on" | "off". Absent = never asked. */
const readPref = (): string | null => {
  const key = prefKey();
  if (!key) return null;
  try {
    localStorage.removeItem(LEGACY_PREF);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writePref = (v: "on" | "off") => {
  const key = prefKey();
  if (!key) return;
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode etc.: the choice just isn't remembered */
  }
};

const ALLOWED = new Set(["authorized", "provisional", "ephemeral"]);

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
  if (r.status === 401) throw new Error("You’re signed out. Sign in again, then turn notifications on.");
  if (r.status === 403) throw new Error("This sign-in can’t register for notifications. Sign out and in again in the app.");
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
      // Not allowed by iOS, or the server did not take the registration: the toggle
      // must not read "on" for a device the server will never push to.
      if (/weren't allowed|turned off|signed out|can’t register|refused/i.test((e as Error).message)) writePref("off");
      throw e;
    }
  },

  async disable() {
    writePref("off");
    const r = await serverFetch("/api/push/apns", { method: "DELETE" }).catch(() => null);
    // The choice is saved either way (nothing is re-registered at launch); say so when the
    // server could not be told, because it may keep pushing until it hears from this device.
    if (!r || (!r.ok && r.status !== 401 && r.status !== 403)) {
      throw new Error("Turned off on this device. The server couldn’t be reached, so a notification may still arrive until it is.");
    }
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

/** Open what the tapped notification names — the shell hands over a validated path, or null. */
async function openTappedNotification(): Promise<void> {
  const path = await iosShell()?.takeOpenedNotification();
  if (path) openAppLink(path); // strict again (appLinkTarget): anything else opens nothing
}

let started = false;

/**
 * Boot-time wiring, once per page load, for a signed-in user of the iOS app:
 * notification taps, and the launch-time token refresh for an account that
 * turned notifications on.
 */
export function initIosPush(): void {
  const shell = iosShell();
  if (!shell || started) return;
  started = true;

  // Taps: warm start and the unlock after a tap (the shell pings us), and cold start (ask once now).
  window.addEventListener("prism:native-push-opened", () => void openTappedNotification());
  void openTappedNotification();

  void (async () => {
    // Re-register every launch so the server always has this app's current token —
    // only when THIS account turned notifications on and iOS already allows them, so
    // this never shows the permission prompt.
    if (readPref() !== "on") return;
    const permission = await shell.pushStatus().catch(() => "denied");
    if (!ALLOWED.has(permission)) return;
    await register().catch(() => {});
  })();
}
