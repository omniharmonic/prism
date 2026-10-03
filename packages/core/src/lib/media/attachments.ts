/**
 * Attachment + cover helpers shared by the editor blocks, the page cover and
 * database gallery cards. Pure and isomorphic (the server imports the schema
 * that uses `safeMediaSrc`).
 */

export type AttachmentKind = "file" | "pdf" | "audio" | "video";

/** Where an attachment's bytes may come from: our own access-checked route, or an https URL. */
const OWN_ATTACHMENT = /^\/api\/attachments\/[A-Za-z0-9_-]{1,64}$/;

/** The media proxy path the server hands out for third-party preview images (bookmark image/favicon). */
const PROXIED = /^\/api\/media\/proxy\?u=[A-Za-z0-9%._~!*'()-]{1,3000}$/;

function httpUrl(s: string, httpsOnly = false): string | null {
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && (httpsOnly || u.protocol !== "http:")) return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}
const clean = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return s && s.length <= 3100 ? s : null;
};

/**
 * Where an ATTACHMENT block's bytes may come from: our own access-checked route,
 * or an https URL (shown as a plain download/open link only — never framed, never
 * played inline). Never a same-origin path (it could name any app route).
 */
export function safeAttachmentSrc(raw: unknown): string | null {
  const s = clean(raw);
  if (!s) return null;
  return OWN_ATTACHMENT.test(s) ? s : httpUrl(s, true);
}

/** Preview images the SERVER produced (bookmark image / favicon): own attachment or the media proxy. Never a raw third-party URL. */
export function ownOrProxiedSrc(raw: unknown): string | null {
  const s = clean(raw);
  return s && (OWN_ATTACHMENT.test(s) || PROXIED.test(s)) ? s : null;
}
export const isProxiedSrc = (src: string | null | undefined): boolean => !!src && PROXIED.test(src);

/** A page cover / card image: own attachment, the media proxy, or an http(s) URL the user chose. Never javascript:/data:/any other same-origin path. */
export function safeMediaSrc(raw: unknown): string | null {
  const s = clean(raw);
  if (!s) return null;
  if (OWN_ATTACHMENT.test(s) || PROXIED.test(s)) return s;
  return httpUrl(s);
}

/**
 * Is this <img src> one the editor must refuse to KEEP? Only dangerous schemes:
 * relative paths, `//cdn…`, `cid:` and `blob:` images are content (Markdown
 * imports, mail) and must survive a round-trip even if they don't load here.
 * `data:` stays refused as before (the base editor never accepted base64 images).
 */
export function isDangerousImageSrc(raw: unknown): boolean {
  if (typeof raw !== "string") return true;
  const s = raw.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  return !s || /^(javascript|vbscript|data):/.test(s);
}

export const isOwnAttachment = (src: string | null | undefined): boolean => !!src && OWN_ATTACHMENT.test(src);

export function attachmentKind(mime: string | null | undefined): AttachmentKind {
  const m = (mime ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "file";
}

export function isAttachmentKind(v: unknown): v is AttachmentKind {
  return v === "file" || v === "pdf" || v === "audio" || v === "video";
}

/** "1.4 MB" — binary units, one decimal under 10. */
export function formatBytes(n: unknown): string {
  const b = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  if (b < 1024) return `${b} B`;
  const units = ["KB", "MB", "GB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Upload size caps the client checks before sending (the server enforces its own). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

// ── Page covers (NP-PG-02) ──────────────────────────────────────────────────

/**
 * A page cover lives in note metadata:
 *   cover   = "gradient:<name>" | an image URL (own attachment or https)
 *   coverY  = vertical focal point, 0–100 (%), default 50
 * Flat strings so it round-trips through every metadata path (vault merge, CSV, MCP).
 */
export interface PageCover {
  kind: "gradient" | "image";
  /** Gradient name, or the image src. */
  value: string;
  /** 0–100 */
  y: number;
}

/** Brand gradients (BRAND.md spectrum: violet, blue, teal, amber, coral; graphite, ivory). */
export const COVER_GRADIENTS: Array<{ name: string; label: string; css: string }> = [
  { name: "spectrum", label: "Spectrum", css: "linear-gradient(100deg,#8b5cf6 0%,#3a7bd5 25%,#4cc3bd 50%,#f7bd5d 75%,#f47c6b 100%)" },
  { name: "lagoon", label: "Lagoon", css: "linear-gradient(120deg,#2f6fe0 0%,#4cc3bd 100%)" },
  { name: "dusk", label: "Dusk", css: "linear-gradient(120deg,#8b5cf6 0%,#3a7bd5 100%)" },
  { name: "dawn", label: "Dawn", css: "linear-gradient(120deg,#f47c6b 0%,#f7bd5d 100%)" },
  { name: "meadow", label: "Meadow", css: "linear-gradient(120deg,#4cc3bd 0%,#f7bd5d 100%)" },
  { name: "ember", label: "Ember", css: "linear-gradient(120deg,#f47c6b 0%,#8b5cf6 100%)" },
  { name: "graphite", label: "Graphite", css: "linear-gradient(120deg,#1f2328 0%,#4b5563 100%)" },
  { name: "ivory", label: "Ivory", css: "linear-gradient(120deg,#fbf8f1 0%,#e9e2d3 100%)" },
];

export function gradientCss(name: string): string | null {
  return COVER_GRADIENTS.find((g) => g.name === name)?.css ?? null;
}

export function parseCover(metadata: Record<string, unknown> | null | undefined): PageCover | null {
  const raw = metadata?.cover;
  if (typeof raw !== "string" || !raw) return null;
  const yRaw = Number(metadata?.coverY);
  const y = Number.isFinite(yRaw) ? Math.max(0, Math.min(100, Math.round(yRaw))) : 50;
  if (raw.startsWith("gradient:")) {
    const name = raw.slice("gradient:".length);
    return gradientCss(name) ? { kind: "gradient", value: name, y } : null;
  }
  const src = safeMediaSrc(raw);
  return src ? { kind: "image", value: src, y } : null;
}

/** Metadata patch for a cover (null removes it). */
export function coverPatch(cover: PageCover | null): Record<string, unknown> {
  if (!cover) return { cover: null, coverY: null };
  return { cover: cover.kind === "gradient" ? `gradient:${cover.value}` : cover.value, coverY: cover.y };
}

/**
 * The image a database gallery card shows (NP-DB-05): the page cover image, else
 * the first image in the body. Gradient covers return `{gradient}` so the card
 * can paint them. Bounded scan — never parses the whole body.
 */
export function coverForNote(note: { metadata?: Record<string, unknown> | null; content?: string | null }): { src?: string; gradient?: string; y: number } | null {
  const cover = parseCover(note.metadata ?? null);
  if (cover?.kind === "image") return { src: cover.value, y: cover.y };
  if (cover?.kind === "gradient") return { gradient: gradientCss(cover.value)!, y: 50 };
  const body = (note.content ?? "").slice(0, 200_000);
  const html = /<img\b[^>]{0,2000}?\bsrc\s*=\s*"([^"]{1,2048})"/i.exec(body);
  const md = html ? null : /!\[[^\]\n]{0,300}\]\(\s*([^)\s]{1,2048})/.exec(body);
  const src = safeMediaSrc((html?.[1] ?? md?.[1] ?? "").replace(/&amp;/g, "&"));
  return src ? { src, y: 50 } : null;
}

// ── Files & media property values (NP-DB-09) ────────────────────────────────

/**
 * A "files" property stores a list of Markdown-style links, one per file:
 *   `[Q3 report.pdf](/api/attachments/a_…)`
 * Readable in the vault, CSV-safe, and the sweep for orphaned attachments finds
 * the id in the note's metadata. Only OUR attachments are valid file values.
 */
export interface FileRef { name: string; url: string }
const FILE_REF = /^\[([^\]\n]{1,200})\]\((\/api\/attachments\/[A-Za-z0-9_-]{1,64})\)$/;

export function fileRef(name: string, url: string): string {
  const clean = (name || "file").replace(/[\[\]\n\r]/g, " ").trim().slice(0, 200) || "file";
  return `[${clean}](${url})`;
}
export function parseFileRef(value: unknown): FileRef | null {
  if (typeof value !== "string") return null;
  const m = FILE_REF.exec(value.trim());
  return m ? { name: m[1]!, url: m[2]! } : null;
}
export function parseFileRefs(value: unknown): FileRef[] {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map(parseFileRef).filter((x): x is FileRef => !!x);
}
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif)$/i;
export const isImageFileName = (name: string): boolean => IMAGE_NAME.test(name);
/** For a gallery cover: the first image of a files value, or the value itself when it is a plain image URL. */
export function firstFileUrl(value: unknown): string | null {
  const files = parseFileRefs(value);
  if (files.length) return (files.find((f) => isImageFileName(f.name)) ?? null)?.url ?? null;
  return typeof value === "string" ? safeMediaSrc(value) : null;
}

/** Download one of OUR attachments through the installed transport (cookie in the PWA, bearer in the native client). */
export async function downloadOwnAttachment(fetcher: (path: string) => Promise<Response>, url: string, name: string): Promise<void> {
  if (!isOwnAttachment(url)) throw new Error("not an attachment");
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = name || "download";
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}
