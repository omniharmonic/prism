/**
 * Links inside the editor (NP-ED-18): which hrefs name a Prism PAGE, which may be
 * followed at all, and how. Pure except `appOrigins()` / `openLinkTarget()`.
 *
 * A page link is `<app origin>/page/<note id>` (what "Copy link" writes — see
 * `pageLink`). It is recognised ONLY for our own origin(s), compared as parsed
 * origins (never by prefix or substring), with a strict note-id shape and
 * nothing else in the path or query: a look-alike host, a userinfo trick
 * (`https://app.example@evil.test/page/x`) or `//host` is an ordinary link.
 *
 * 🔒 A stored link must never take THIS window to another origin (links arrive
 * from collaborators, REST and MCP). So:
 *  - a value holding a backslash, a control character, a space or DEL is refused
 *    outright (`/\evil.tld` and `/<TAB>/evil.tld` both resolve to `//evil.tld`);
 *  - a relative value is RESOLVED against our origin and must stay on it;
 *  - nothing is ever opened with `location.assign`: in place we only scroll to an
 *    `#anchor` and open our own `/page/<id>` (a tab in the app); every other
 *    same-origin path opens in a NEW tab that cannot reach this window.
 */
import { MENTION_ID } from "./MentionParse";
import { parseHeadingHash } from "../pages/headingSlug";

/** The origins a shareable page link may carry: this page's, and (Prism Client) the configured server's. */
export function appOrigins(): string[] {
  const out: string[] = [];
  if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) out.push(location.origin);
  const host = typeof window !== "undefined" ? (window as unknown as { __PRISM_HOST__?: { apiOrigin?: string } }).__PRISM_HOST__ : undefined;
  if (host?.apiOrigin) {
    try {
      const o = new URL(host.apiOrigin);
      if (/^https?:$/.test(o.protocol) && !out.includes(o.origin)) out.push(o.origin);
    } catch { /* not a URL: ignored */ }
  }
  return out;
}

const PAGE_PATH = /^\/page\/([^/]+)\/?$/;

/** A backslash, any character ≤ 0x20 (controls, tab, newline, space) or DEL: never part of a link we follow. */
export function hasUnsafeLinkChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

/** The note id an ABSOLUTE page URL names, or null. `origins` = {@link appOrigins}. */
export function pageIdFromUrl(raw: string | null | undefined, origins: readonly string[] = appOrigins()): string | null {
  const text = (raw ?? "").trim();
  if (!text || text.length > 2048 || hasUnsafeLinkChar(text) || !/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.username || url.password || url.search) return null;
  if (!origins.includes(url.origin)) return null;
  const id = PAGE_PATH.exec(url.pathname)?.[1];
  return id && MENTION_ID.test(id) ? id : null;
}

/** The note id a link HREF names: an absolute page URL of ours, or the in-app path `/page/<id>`. */
export function pageIdFromHref(href: string | null | undefined, origins: readonly string[] = appOrigins()): string | null {
  const text = (href ?? "").trim();
  if (hasUnsafeLinkChar(text)) return null;
  if (text.startsWith("/") && !text.startsWith("//")) {
    const path = text.split("#")[0]!;
    const id = PAGE_PATH.exec(path)?.[1];
    return id && MENTION_ID.test(id) ? id : null;
  }
  return pageIdFromUrl(text, origins);
}

/**
 * What following a link does:
 *  - `page`     one of our pages → a tab in the app (`heading`: the `#h-<slug>` it names, if any);
 *  - `anchor`   `#id` → scroll within this page;
 *  - `tab`      another path on OUR origin → a new tab (never this window);
 *  - `external` http(s) without credentials, or mailto → a new tab;
 *  - `blocked`  everything else (`javascript:`, `data:`, `vbscript:`, `//host`, backslashes,
 *               control characters, `user:pass@` URLs, relative values that leave our origin).
 */
export type LinkTarget =
  | { kind: "page"; id: string; heading?: string }
  | { kind: "anchor"; id: string }
  | { kind: "tab"; url: string }
  | { kind: "external"; url: string }
  | { kind: "blocked" };

const BLOCKED: LinkTarget = { kind: "blocked" };

export function linkTarget(href: string | null | undefined, origins: readonly string[] = appOrigins(), base: string | undefined = typeof location !== "undefined" ? location.origin : undefined): LinkTarget {
  const value = (href ?? "").trim();
  if (!value || value.length > 4096 || hasUnsafeLinkChar(value)) return BLOCKED;
  const page = pageIdFromHref(value, origins);
  if (page) {
    const at = value.indexOf("#");
    const heading = at < 0 ? null : parseHeadingHash(value.slice(at));
    return heading ? { kind: "page", id: page, heading } : { kind: "page", id: page };
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return BLOCKED;
      if (url.username || url.password) return BLOCKED; // never hand credentials to (or disguise) a host
      return { kind: "external", url: url.href };
    } catch { return BLOCKED; }
  }
  if (/^mailto:[^\s]+$/i.test(value)) return { kind: "external", url: value };
  if (value.startsWith("#")) return value.length > 1 ? { kind: "anchor", id: value.slice(1) } : BLOCKED;
  // An in-app path: resolved like the browser would, and it must stay on our origin.
  if (value.startsWith("/") && !value.startsWith("//") && base) {
    try {
      const origin = new URL(base).origin;
      const url = new URL(value, origin);
      if (url.origin !== origin || (url.protocol !== "http:" && url.protocol !== "https:")) return BLOCKED;
      return { kind: "tab", url: url.href };
    } catch { return BLOCKED; }
  }
  return BLOCKED;
}

/** Open `url` in a new tab that gets no handle on this window. An anchor click, not window.open: `rel` is honoured everywhere. */
export function openInNewTab(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * Follow a link. Never navigates this window: a Prism page goes to `openPage`,
 * an anchor scrolls (`#h-<slug>` through `focusHeading`, when the caller has one), everything else
 * that is allowed opens in a new tab.
 * Returns false when the link is not one we open.
 */
export function openLinkTarget(target: LinkTarget, openPage: (id: string, heading?: string) => void, focusHeading?: (slug: string) => void): boolean {
  if (target.kind === "blocked") return false;
  if (target.kind === "page") { openPage(target.id, target.heading); return true; }
  if (typeof window === "undefined") return false;
  if (target.kind === "anchor") {
    let id = target.id;
    try { id = decodeURIComponent(id); } catch { /* keep as typed */ }
    const el = document.getElementById(id);
    el?.scrollIntoView({ block: "start" });
    if (el) return true;
    // `#h-<slug>`: a heading of THIS page (editor headings carry no id — the slug is derived).
    const heading = parseHeadingHash(`#${id}`);
    if (!heading || !focusHeading) return false;
    focusHeading(heading);
    return true;
  }
  openInNewTab(target.url);
  return true;
}
