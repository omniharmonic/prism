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
// The shell delivers only while someone is signed in and only to a loaded page;
// this module is started only for a signed-in workspace (main.tsx), so a link
// that arrives at the sign-in screen stays with the shell until after sign-in.
//
// The same allowlist lives in three places — keep them in step:
//   apps/server/src/routes/app-links.ts   (what the OS may hand to the app)
//   apps/client/src-tauri/src/links.rs    (what the shell accepts)
//   here                                   (what the page opens)
import { openAgentChat, setPendingNotification, useUIStore } from "@prism/core/shell";

export type AppLinkTarget =
  | { kind: "page"; id: string }
  | { kind: "inbox"; id: string | null }
  | { kind: "agent"; id: string | null };

const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The destination a shell-delivered path names, or null. Strict on purpose
 * (defence in depth — the shell already validated): a plain path of one or two
 * segments, no query, fragment, escape, dot or backslash.
 */
export function appLinkTarget(path: unknown): AppLinkTarget | null {
  if (typeof path !== "string" || path.length > 256) return null;
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
  if (target.kind === "page") {
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

let started = false;
/**
 * Take links from the shell: the one already waiting (cold start, or delivered
 * while the app was still booting) and every later one. Idempotent.
 */
export function initAppLinks(): void {
  if (started || !hasAppLinkBridge()) return;
  started = true;
  const take = () => {
    const path = shell()?.takePendingLink?.();
    if (path == null) return;
    if (!openAppLink(path)) shell()?.toast?.("This link can’t be opened in Prism.");
  };
  window.addEventListener("prism:open-link", take);
  take();
}
