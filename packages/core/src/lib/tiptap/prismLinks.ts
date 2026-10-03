/**
 * Links inside the editor (NP-ED-18): which hrefs name a Prism PAGE, which may be
 * opened at all, and how. Pure except `appOrigins()` / `openLinkTarget()`.
 *
 * A page link is `<app origin>/page/<note id>` (what "Copy link" writes — see
 * `pageLink`). It is recognised ONLY for our own origin(s), compared as parsed
 * origins (never by prefix or substring), with a strict note-id shape and
 * nothing else in the path or query: a look-alike host, a userinfo trick
 * (`https://app.example@evil.test/page/x`) or `//host` is an ordinary link.
 */
import { MENTION_ID } from "./MentionParse";

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

/** The note id an ABSOLUTE page URL names, or null. `origins` = {@link appOrigins}. */
export function pageIdFromUrl(raw: string | null | undefined, origins: readonly string[] = appOrigins()): string | null {
  const text = (raw ?? "").trim();
  if (!text || text.length > 2048 || !/^https?:\/\//i.test(text)) return null;
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
  if (text.startsWith("/") && !text.startsWith("//")) {
    const path = text.split("#")[0]!;
    const id = PAGE_PATH.exec(path)?.[1];
    return id && MENTION_ID.test(id) ? id : null;
  }
  return pageIdFromUrl(text, origins);
}

/**
 * What following a link does. Only web, mail and in-app targets are ever opened —
 * the same rule the inline link field applies when a link is typed (`normalizeLink`);
 * `javascript:`, `data:`, `vbscript:`, `//host` and anything else are `blocked`.
 */
export type LinkTarget =
  | { kind: "page"; id: string }
  | { kind: "external"; url: string }
  | { kind: "internal"; url: string }
  | { kind: "blocked" };

export function linkTarget(href: string | null | undefined, origins: readonly string[] = appOrigins()): LinkTarget {
  const value = (href ?? "").trim();
  if (!value || value.length > 4096) return { kind: "blocked" };
  const page = pageIdFromHref(value, origins);
  if (page) return { kind: "page", id: page };
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "blocked" };
      return { kind: "external", url: url.href };
    } catch { return { kind: "blocked" }; }
  }
  if (/^mailto:[^\s]+$/i.test(value)) return { kind: "external", url: value };
  // In-app paths and anchors ("/x", "#x") — never "//host".
  if ((value.startsWith("/") && !value.startsWith("//")) || value.startsWith("#")) return { kind: "internal", url: value };
  return { kind: "blocked" };
}

/**
 * Follow a link: a Prism page opens in the app (`openPage`), an outside link in a
 * new tab that cannot reach this window, an in-app path in place. Returns false
 * when the link is not one we open.
 */
export function openLinkTarget(target: LinkTarget, openPage: (id: string) => void): boolean {
  if (target.kind === "blocked") return false;
  if (target.kind === "page") { openPage(target.id); return true; }
  if (typeof window === "undefined") return false;
  if (target.kind === "external") {
    // An anchor click, not window.open: `rel` is honoured everywhere and no handle comes back.
    const a = document.createElement("a");
    a.href = target.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    document.body.append(a);
    a.click();
    a.remove();
    return true;
  }
  if (target.url.startsWith("#")) { location.hash = target.url; return true; }
  location.assign(target.url);
  return true;
}
