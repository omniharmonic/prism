// Incoming links in the native shell (NP-NA-04): the page half.
//
// The shell (apps/client/src-tauri/src/links.rs) receives a universal link or a
// prism:// deep link from the OS, validates it (origin = the configured server,
// path on the allowlist) and hands over ONE client path through the host hook:
//   window.__PRISM_SHELL__.openLink("/page/<id>")  → held by host.js
//   → a payload-free `prism:open-link` event       → we take it here.
// The path never comes from the event and nothing here navigates: a link becomes
// a TAB, opened through the app's own data layer, so access is whatever the
// signed-in account has (a page it cannot view shows "Document unavailable").
//
// The shell delivers to a loaded page once a device token EXISTS — it cannot know
// the server still accepts it. So the page takes links from before the sign-in
// gate (`captureAppLinks`) and keeps one across the sign-in reload; it OPENS them
// only once the signed-in workspace is up (`initAppLinks`).
//
// The same allowlist lives in three places — keep them in step:
//   apps/server/src/routes/app-links.ts   (what the OS may hand to the app)
//   apps/client/src-tauri/src/links.rs    (what the shell accepts)
//   here                                   (what the page opens)
import { askConfirm, openAgentChat, setPendingNotification, useUIStore } from "@prism/core/shell";

import { apiBase, getMe } from "../config";
import { sourceLinkTarget, sourceContextMatches, type SourceLinkTarget } from "./sourceLinks";

export type AppLinkTarget =
  | { kind: "page"; id: string }
  | SourceLinkTarget
  | { kind: "inbox"; id: string | null }
  | { kind: "agent"; id: string | null };

const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The destination a shell-delivered path names, or null. Strict on purpose
 * (defence in depth — the shell already validated): a plain path of one or two
 * segments, no query, fragment, escape, dot or backslash. The contextual source
 * descriptor alone permits its two validated query keys.
 */
export function appLinkTarget(path: unknown): AppLinkTarget | null {
  if (typeof path !== "string" || path.length > 2048) return null;
  if (path.startsWith("/source/")) return sourceLinkTarget(path);
  const m = /^\/(page|inbox|agent)(?:\/([A-Za-z0-9_-]+))?\/?$/.exec(path);
  if (!m) return null;
  const [, route, id] = m;
  if (route === "page") return id && PAGE_ID.test(id) ? { kind: "page", id } : null;
  if (route === "inbox") return id === undefined ? { kind: "inbox", id: null } : NOTIFICATION_ID.test(id) ? { kind: "inbox", id } : null;
  return id === undefined ? { kind: "agent", id: null } : SESSION_ID.test(id) ? { kind: "agent", id: id.toLowerCase() } : null;
}

/** Open the destination as a tab. Returns false for a path that is not one of ours. */
export function openAppLink(path: unknown): boolean {
  const target = appLinkTarget(path);
  if (!target) return false;
  if (target.kind === "source") {
    const me = getMe();
    if (!sourceContextMatches(target, new URL(apiBase(), location.origin).origin, me)) {
      void askConfirm({ title: "This source belongs to a different workspace", body: "Prism will keep its current server and vault. Open the source in your browser instead?", confirm: "Open in Browser" })
        .then(yes => { if (yes) window.open(`${target.server}/page/${target.id}`, "_blank", "noopener,noreferrer"); });
      return true;
    }
    useUIStore.getState().openTab(target.id, "Page", "document");
  } else if (target.kind === "page") {
    useUIStore.getState().openTab(target.id, "Page", "document");
  } else if (target.kind === "inbox") {
    if (target.id) setPendingNotification(target.id);
    // "notifications" is a virtual tab (not in the ContentType union) — the same cast as lib/notifications/anchor.ts.
    useUIStore.getState().openTab("notifications", "Inbox", "notifications" as never);
    window.dispatchEvent(new Event("prism:notifications-changed"));
  } else {
    openAgentChat(target.id ? { sessionId: target.id } : {});
  }
  return true;
}

interface LinkShell {
  takePendingLink?(): string | null;
  toast?(message: string): void;
}
const shell = (): LinkShell | undefined => (window as unknown as { __PRISM_SHELL__?: LinkShell }).__PRISM_SHELL__;

/** Does a host shell provide the link bridge? (Only the Prism Client does.) */
export const hasAppLinkBridge = (): boolean => typeof shell()?.takePendingLink === "function";

// A link taken while nobody is signed in (no token, or a token the server no longer
// accepts — the shell cannot tell a stale token from a good one) waits HERE, in
// sessionStorage, across the sign-in reload: host.js keeps its copy in memory only.
// What is stored is the validated client path (never a URL, never a token), for at
// most STASH_TTL_MS; it is removed the moment it is opened.
const STASH_KEY = "prism:pending-link";
const STASH_TTL_MS = 10 * 60_000;

function stash(path: string): void {
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    /* no storage: the link is lost, safely */
  }
}
function unstash(): string | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(STASH_KEY);
    const v = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof v.path !== "string" || typeof v.at !== "number") return null;
    const age = Date.now() - v.at;
    return age >= 0 && age <= STASH_TTL_MS && appLinkTarget(v.path) ? v.path : null;
  } catch {
    return null;
  }
}

/** Forget a link kept for after sign-in (the server it belonged to was signed out of and replaced). */
export function forgetPendingAppLink(): void {
  try {
    sessionStorage.removeItem(STASH_KEY);
  } catch {
    /* no storage: nothing was kept */
  }
}

let capturing = false;
let ready = false;

function take(): void {
  const path = shell()?.takePendingLink?.();
  if (path == null) return;
  if (!appLinkTarget(path)) {
    shell()?.toast?.("This link can’t be opened in Prism.");
    return;
  }
  if (ready) openAppLink(path);
  else stash(path); // newest wins
}

/**
 * Start taking links from the shell. Call BEFORE the sign-in gate: a link that
 * arrives (or is already waiting) while the sign-in screen is up is kept for
 * after sign-in instead of dying with the reload. Opens nothing by itself.
 * Idempotent; a no-op without a host shell.
 */
export function captureAppLinks(): void {
  if (capturing || !hasAppLinkBridge()) return;
  capturing = true;
  window.addEventListener("prism:open-link", take);
  take();
}

/**
 * The signed-in workspace is up: open the link that was waiting (from before
 * sign-in, or delivered while the app was booting) and every later one at once.
 */
export function initAppLinks(): void {
  if (!hasAppLinkBridge()) return;
  ready = true;
  captureAppLinks();
  // The one kept from before sign-in first, then anything newer the shell holds (it ends up in front).
  const waiting = unstash();
  if (waiting) openAppLink(waiting);
  take();
}
