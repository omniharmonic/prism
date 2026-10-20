// "Open in the app" for a page link opened in a phone's browser (decision D-H).
//
// Universal links (https://<server>/page/<id> opening the app straight away) need the
// server's domain in the app's Associated Domains entitlement, which is fixed when the app
// is BUILT. The App Store build is one build for everyone, so only the publisher's domain
// can be in it; a self-hosted server's links open in Safari. This banner is the way from
// there into the app: one tap on "Open in app" launches
//
//   prism://source/<id>?server=<this server's origin>&vault=<vault>
//
// — the shell's contextual source route (apps/client/src-tauri/src/links.rs), which the
// app opens ONLY when it is paired with this same server and vault, and otherwise says so
// and offers the page in the browser (native/appLinks.ts `openAppLink`). A context-free
// `prism://page/<id>` would open whatever note has that id on the app's OWN server.
//
// Rules (iOS Safari, researched for this):
//  - A custom scheme is launched only from the person's own tap (an <a href>, never a
//    redirect, a timer or script on load): Safari asks "Open in “Prism”?" each time, and
//    without the app installed says the address is invalid — there is no reliable way to
//    know whether the app is installed, so the page never tries on its own (no redirect
//    loops, no error dialog on page load). The banner says "if you have the app".
//  - Never for a capability link (`?t=`, or a capability kept for this tab): its access is
//    the link's own, which the app — acting as its signed-in account — would not have.
//  - Never for a URL with ANY query (the app refuses every query, and the app's own
//    "open in the browser" answer comes back here as `/page/<id>?vault=` — the banner must
//    not offer the app again, which would loop). Only `/page/<id>` and `/collab/<id>`.
//  - Never inside the Prism Client (it IS the app), and not in an installed PWA (standalone).
//  - iPhone / iPad / iPod only (iPadOS reports a Mac with a touch screen).
//  - "Not now" hides it on this device for 14 days.
//
// No server route, no CSP change (a link to another scheme is a navigation, not a fetch),
// nothing stored but the dismissal time.

const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VAULT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const OPEN_IN_APP_DISMISSED_KEY = "prism:open-in-app-dismissed";
export const OPEN_IN_APP_QUIET_MS = 14 * 24 * 60 * 60_000;

/** The page a browser URL names, when the banner may offer it; else null. */
export function openInAppPageId(loc: { pathname: string; search: string }): string | null {
  if (loc.search !== "" && loc.search !== "?") return null;
  const m = /^\/(page|collab)\/([^/]+)\/?$/.exec(loc.pathname);
  return m && PAGE_ID.test(m[2]) ? m[2] : null;
}

/** The app link for a page on this server. `origin` must be an http(s) origin; `vault` a plain id. */
export function openInAppHref(id: string, origin: string, vault: string | null | undefined): string | null {
  if (!PAGE_ID.test(id)) return null;
  let server: URL;
  try {
    server = new URL(origin);
  } catch {
    return null;
  }
  if ((server.protocol !== "https:" && server.protocol !== "http:") || server.username || server.password) return null;
  const v = vault && VAULT_ID.test(vault) ? vault : "primary";
  const query = new URLSearchParams({ server: server.origin, vault: v });
  return `prism://source/${id}?${query.toString()}`;
}

export interface BrowserTraits {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
}

/** An iPhone / iPad / iPod browser (not an installed web app). */
export function isAppleMobileBrowser(t: BrowserTraits): boolean {
  if (t.standalone) return false;
  if (/\b(iPhone|iPad|iPod)\b/.test(t.userAgent)) return true;
  // iPadOS asks for desktop sites by default: a "Mac" with a touch screen.
  return /\bMacintosh\b/.test(t.userAgent) && (t.platform === "MacIntel" || t.platform === undefined) && (t.maxTouchPoints ?? 0) > 1;
}

export function dismissedRecently(raw: string | null, now: number): boolean {
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 && at <= now && now - at < OPEN_IN_APP_QUIET_MS;
}

export interface OpenInAppDeps {
  /** Is a host shell (the Prism Client) around? Then never. */
  native: boolean;
  /** A capability link is in use for this tab. Then never. */
  capability: boolean;
  /** This server's origin (the PWA is same-origin with it). */
  origin: string;
  /** The vault the signed-in viewer is in, once known (null while signed out → "primary"). */
  vault: () => string | null | undefined;
  now?: () => number;
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(OPEN_IN_APP_DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(at: number): void {
  try {
    localStorage.setItem(OPEN_IN_APP_DISMISSED_KEY, String(at));
  } catch {
    /* no storage: it shows again next time */
  }
}

function traits(): BrowserTraits {
  const nav = navigator as Navigator & { standalone?: boolean };
  let standalone = nav.standalone === true;
  try {
    standalone ||= window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    /* no matchMedia */
  }
  return { userAgent: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints, standalone };
}

const STYLE = `
.prism-open-in-app{position:fixed;z-index:2147483000;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));margin:0 auto;max-width:420px;box-sizing:border-box;
  display:flex;align-items:center;gap:12px;padding:12px 12px 12px 16px;border-radius:14px;border:1px solid var(--glass-border,rgba(127,127,127,.35));
  background:var(--bg-elevated,#fff);color:var(--text-primary,#111);box-shadow:var(--glass-shadow-elevated,0 8px 30px rgba(0,0,0,.25));font:inherit;font-size:15px;line-height:1.35}
.prism-open-in-app p{margin:0;flex:1 1 auto;min-width:0}
.prism-open-in-app small{display:block;color:var(--text-secondary,#555);font-size:13px}
.prism-open-in-app a,.prism-open-in-app button{flex:none;min-height:44px;padding:0 14px;border-radius:10px;font:inherit;font-size:15px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;text-decoration:none}
.prism-open-in-app a{background:var(--action-bg,#111);color:var(--action-fg,#fff)}
.prism-open-in-app button{background:var(--bg-elevated,#fff);border:0;color:var(--text-secondary,#555);font-weight:500}
.prism-open-in-app a:focus-visible,.prism-open-in-app button:focus-visible{outline:2px solid var(--focus-ring,#2563eb);outline-offset:2px}
`;

/**
 * Show the banner when this browser URL is a page link the app can open. Returns the
 * banner element (or null when it is not shown). Never navigates, never focuses.
 */
export function mountOpenInAppBanner(deps: OpenInAppDeps): HTMLElement | null {
  if (deps.native || deps.capability) return null;
  if ((window as unknown as { __PRISM_HOST__?: unknown }).__PRISM_HOST__) return null;
  const id = openInAppPageId(location);
  if (!id || !isAppleMobileBrowser(traits())) return null;
  const now = deps.now ?? Date.now;
  if (dismissedRecently(readDismissed(), now())) return null;
  const href = openInAppHref(id, deps.origin, deps.vault());
  if (!href) return null;

  if (!document.getElementById("prism-open-in-app-style")) {
    const style = document.createElement("style");
    style.id = "prism-open-in-app-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const box = document.createElement("section");
  box.className = "prism-open-in-app";
  box.setAttribute("aria-label", "Open in the Prism app");
  box.dataset.openInApp = "";
  const text = document.createElement("p");
  text.append("Have the Prism app?");
  const sub = document.createElement("small");
  sub.textContent = "Open this page there, or keep reading here.";
  text.append(sub);
  const open = document.createElement("a");
  open.href = href;
  open.textContent = "Open in app";
  // The vault may be known by the time of the tap (sign-in finished): the href is rebuilt
  // then, still inside the tap — Safari reads it after this handler.
  open.addEventListener("click", () => {
    const fresh = openInAppHref(id, deps.origin, deps.vault());
    if (fresh) open.href = fresh;
    box.remove();
  });
  const later = document.createElement("button");
  later.type = "button";
  later.textContent = "Not now";
  later.addEventListener("click", () => {
    writeDismissed(now());
    box.remove();
  });
  box.append(text, open, later);
  document.body.appendChild(box);
  return box;
}
