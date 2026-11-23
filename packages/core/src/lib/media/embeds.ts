/**
 * Embed allowlist (NP-ED-15). Pure and isomorphic.
 *
 * The document never stores an iframe `src`. An embed block stores only the
 * URL the user pasted (`data-url`); the iframe address is DERIVED here, at view
 * time, from a fixed allowlist of providers. A URL that maps to no provider is
 * shown as a bookmark card instead — never a blank or arbitrary frame. So a
 * hand-edited or agent-written `data-url` can never point a frame at anything
 * outside this list, and the list can be tightened without touching content.
 *
 * Every frame is rendered with a strict `sandbox` (see `EMBED_SANDBOX`) and
 * `referrerpolicy="strict-origin-when-cross-origin"`.
 *
 * `EMBED_FRAME_SOURCES` is the exact set the CSP `frame-src` must allow for
 * these to render (web: apps/server/src/app.ts; native: apps/client origin.rs —
 * see the security proposal in CLAUDE.md "Media, embeds and attachments").
 */

export type EmbedProvider =
  | "youtube"
  | "vimeo"
  | "loom"
  | "figma"
  | "google-docs"
  | "google-sheets"
  | "google-slides"
  | "google-maps"
  | "spotify"
  | "twitter";

export interface EmbedTarget {
  provider: EmbedProvider;
  /** Human label ("YouTube"). */
  label: string;
  /** The iframe address (always https, always on EMBED_FRAME_ORIGINS). */
  src: string;
  /** Sensible default height in CSS px for this provider. */
  height: number;
  /** Extra `allow` features the provider needs. */
  allow: string;
}

/**
 * The ONLY places an embed frame can ever load, as CSP source expressions —
 * every one PATH-SCOPED to the provider's embed player (a trailing "/" is a
 * prefix match, no trailing "/" is an exact path). So `docs.google.com` frames
 * only documents/spreadsheets/presentations (never Google Forms), and
 * `www.google.com` only `/maps/embed`. The web CSP `frame-src` is built from
 * this list (apps/server/src/app.ts) and `isAllowedFrameSrc` enforces the same
 * rule before a frame is created. CodePen was removed (arbitrary user script).
 */
export const EMBED_FRAME_SOURCES = [
  "https://www.youtube-nocookie.com/embed/",
  "https://player.vimeo.com/video/",
  "https://www.loom.com/embed/",
  "https://www.figma.com/embed",
  "https://docs.google.com/document/",
  "https://docs.google.com/spreadsheets/",
  "https://docs.google.com/presentation/",
  "https://www.google.com/maps/embed",
  "https://open.spotify.com/embed/",
  "https://platform.twitter.com/embed/",
] as const;
/** @deprecated origins only; use EMBED_FRAME_SOURCES (path-scoped). */
export const EMBED_FRAME_ORIGINS = [...new Set(EMBED_FRAME_SOURCES.map((s) => new URL(s).origin))];

/**
 * Frame sandbox. Providers need their own scripts + storage (same-origin is THEIR
 * origin, never ours — the frame is always cross-origin) and presentation for
 * fullscreen players. `allow-popups` lets "Watch on YouTube" open a tab, which
 * stays sandboxed: `allow-popups-to-escape-sandbox` is deliberately NOT granted
 * (no listed provider needs it — the block's own "Open in …" link is the
 * unsandboxed way out). No top-navigation of any kind, no forms, no downloads,
 * no modals.
 */
export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-presentation";
/**
 * The same, WITHOUT popups, for the native apps (Prism Client on macOS / iOS — owner
 * decision c.7, the security reviewer's "minimal safe set … with no popups"): a player
 * there can open nothing. The block's own "Open in …" link (routed through the shell's
 * native confirmation) is the only way out.
 */
export const EMBED_SANDBOX_NATIVE = "allow-scripts allow-same-origin allow-presentation";

const MEDIA_ALLOW = "fullscreen; picture-in-picture; encrypted-media; clipboard-write";

function parse(raw: string): URL | null {
  const s = (raw ?? "").trim();
  if (!s || s.length > 2048) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeStart(u: URL): string {
  const t = u.searchParams.get("t") ?? u.searchParams.get("start");
  if (!t) return "";
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  if (!m) return "";
  const secs = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return secs > 0 && secs < 360000 ? `?start=${secs}` : "";
}

/** Map a pasted URL to an allowlisted embed, or null (→ bookmark fallback). */
export function embedFor(raw: string): EmbedTarget | null {
  const u = parse(raw);
  if (!u) return null;
  const h = host(u);
  const parts = u.pathname.split("/").filter(Boolean);

  // YouTube (watch, youtu.be, shorts, embed, live) → privacy-enhanced player.
  if (h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be" || h === "youtube-nocookie.com" || h === "music.youtube.com") {
    let id: string | null = null;
    if (h === "youtu.be") id = parts[0] ?? null;
    else if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
    if (!id || !YT_ID.test(id)) return null;
    return { provider: "youtube", label: "YouTube", src: `https://www.youtube-nocookie.com/embed/${id}${youtubeStart(u)}`, height: 0, allow: MEDIA_ALLOW };
  }
  if (h === "vimeo.com" || h === "player.vimeo.com") {
    const id = parts.find((p) => /^\d{4,12}$/.test(p));
    if (!id) return null;
    return { provider: "vimeo", label: "Vimeo", src: `https://player.vimeo.com/video/${id}`, height: 0, allow: MEDIA_ALLOW };
  }
  if (h === "loom.com") {
    const id = (parts[0] === "share" || parts[0] === "embed") ? parts[1] : null;
    if (!id || !/^[A-Za-z0-9]{16,64}$/.test(id)) return null;
    return { provider: "loom", label: "Loom", src: `https://www.loom.com/embed/${id}`, height: 0, allow: MEDIA_ALLOW };
  }
  if (h === "figma.com") {
    if (!["file", "design", "proto", "board", "slides", "deck"].includes(parts[0] ?? "") || !/^[A-Za-z0-9]{8,64}$/.test(parts[1] ?? "")) return null;
    const clean = `https://www.figma.com/${parts[0]}/${parts[1]}${parts[2] ? `/${encodeURIComponent(decodeSafe(parts[2]))}` : ""}${u.search}`;
    return { provider: "figma", label: "Figma", src: `https://www.figma.com/embed?embed_host=prism&url=${encodeURIComponent(clean)}`, height: 450, allow: "fullscreen; clipboard-write" };
  }
  if (h === "docs.google.com") {
    const kind = parts[0];
    const id = parts[1] === "d" ? parts[2] : null;
    if (!id || !/^[A-Za-z0-9_-]{20,128}$/.test(id)) return null;
    if (kind === "document") return { provider: "google-docs", label: "Google Docs", src: `https://docs.google.com/document/d/${id}/preview`, height: 520, allow: "fullscreen" };
    if (kind === "spreadsheets") return { provider: "google-sheets", label: "Google Sheets", src: `https://docs.google.com/spreadsheets/d/${id}/preview`, height: 420, allow: "fullscreen" };
    if (kind === "presentation") return { provider: "google-slides", label: "Google Slides", src: `https://docs.google.com/presentation/d/${id}/embed`, height: 0, allow: "fullscreen" };
    return null;
  }
  // Google Maps: only the official embed URLs (a share link needs an API key to embed).
  if ((h === "google.com" || h === "maps.google.com") && u.pathname.startsWith("/maps/embed")) {
    const pb = u.searchParams.get("pb");
    if (!pb || pb.length > 1800 || /[\s"'<>]/.test(pb)) return null;
    return { provider: "google-maps", label: "Google Maps", src: `https://www.google.com/maps/embed?pb=${encodeURIComponent(pb)}`, height: 400, allow: "fullscreen" };
  }
  if (h === "open.spotify.com") {
    const offset = parts[0] === "embed" ? 1 : parts[0]?.startsWith("intl-") ? 1 : 0;
    const type = parts[offset];
    const id = parts[offset + 1];
    if (!["track", "album", "playlist", "episode", "show", "artist"].includes(type ?? "") || !/^[A-Za-z0-9]{22}$/.test(id ?? "")) return null;
    return { provider: "spotify", label: "Spotify", src: `https://open.spotify.com/embed/${type}/${id}`, height: type === "track" || type === "episode" ? 152 : 352, allow: "encrypted-media; clipboard-write; fullscreen" };
  }
  if (h === "twitter.com" || h === "x.com" || h === "mobile.twitter.com") {
    const at = parts.indexOf("status");
    const id = at > 0 ? parts[at + 1] : null;
    if (!id || !/^\d{5,25}$/.test(id)) return null;
    return { provider: "twitter", label: "Post on X", src: `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true`, height: 420, allow: "" };
  }
  return null;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A frame src is only ever trusted if it is on the path-scoped allowlist (defence in depth). */
export function isAllowedFrameSrc(src: string): boolean {
  const u = parse(src);
  if (!u || u.protocol !== "https:" || u.port) return false;
  return EMBED_FRAME_SOURCES.some((source) => {
    const s = new URL(source);
    if (s.origin !== u.origin) return false;
    return s.pathname.endsWith("/") ? u.pathname.startsWith(s.pathname) : u.pathname === s.pathname;
  });
}

/** A plain http(s) URL a bookmark/link may carry (no javascript:, data:, credentials). */
export function safeWebUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const u = parse(raw);
  return u ? u.href : null;
}
