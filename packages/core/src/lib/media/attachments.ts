/**
 * Attachment + cover helpers shared by the editor blocks, the page cover and
 * database gallery cards. Pure and isomorphic (the server imports the schema
 * that uses `safeMediaSrc`).
 */

export type AttachmentKind = "file" | "pdf" | "audio" | "video";

/** Where an attachment's bytes may come from: our own access-checked route, or an https URL. */
const OWN_ATTACHMENT = /^\/api\/attachments\/[A-Za-z0-9_-]{1,64}$/;

/** A src an <img>/<audio>/<video>/download link may carry, or null. Never javascript:/data:/protocol-relative. */
export function safeMediaSrc(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  if (OWN_ATTACHMENT.test(s)) return s;
  // Same-origin fixture/static paths (no scheme, no //, no backslash, no dot-segments).
  if (/^\/(?![/\\])/.test(s) && !/(^|\/)\.\.?(\/|$)|\\/.test(s) && !/[\s"'<>]/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
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
