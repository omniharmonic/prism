/**
 * Magic-byte typing for uploaded attachments (routes/attachments.ts). The type
 * an attachment is stored and served as is decided HERE from its bytes — never
 * from the client's Content-Type or file name. Anything not recognised is kept
 * as an inert `application/octet-stream` download, except active content
 * (SVG/HTML/XML/script), which is refused outright.
 */
import { sniffRaster } from "./sniff";

export type AttachmentType =
  | "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
  | "application/pdf"
  | "audio/mpeg" | "audio/mp4" | "audio/ogg" | "audio/wav" | "audio/flac"
  | "video/webm" | "video/mp4" | "video/quicktime"
  | "application/octet-stream";

export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Canonical extension for the server-chosen vault filename (`upload.<ext>`). */
export const ATTACHMENT_EXT: Record<AttachmentType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/octet-stream": "bin",
};

/** Extensions the vault refuses to store (active content); refused here too. */
export const BLOCKED_EXTENSIONS = [".html", ".htm", ".xhtml", ".shtml", ".xht", ".svg", ".xml", ".js", ".mjs", ".cjs", ".css"];

const at = (b: Buffer, sig: number[], off = 0): boolean => b.length >= off + sig.length && sig.every((v, i) => b[off + i] === v);
const ascii = (b: Buffer, s: string, off = 0): boolean => b.length >= off + s.length && b.subarray(off, off + s.length).toString("latin1") === s;

const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VH", "M4VP", "dash", "3gp4", "3gp5", "3g2a", "mmp4", "MSNV"]);

/** Recognised media/document type by magic bytes, or null. */
export function sniffAttachment(b: Buffer): Exclude<AttachmentType, "application/octet-stream"> | null {
  const raster = sniffRaster(b);
  if (raster && IMAGE_TYPES.has(raster)) return raster as "image/png";
  if (ascii(b, "%PDF-")) return "application/pdf";
  if (ascii(b, "ID3")) return "audio/mpeg";
  // MPEG audio frame sync: 11 set bits, layer bits != 00, bitrate index != 1111.
  if (b.length >= 3 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0 && (b[2]! & 0xf0) !== 0xf0) return "audio/mpeg";
  if (ascii(b, "OggS")) return "audio/ogg";
  if (ascii(b, "RIFF") && ascii(b, "WAVE", 8)) return "audio/wav";
  if (ascii(b, "fLaC")) return "audio/flac";
  if (at(b, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (ascii(b, "ftyp", 4)) {
    const brand = b.subarray(8, 12).toString("latin1");
    if (brand === "M4A " || brand === "M4B " || brand === "M4P ") return "audio/mp4";
    if (brand === "qt  ") return "video/quicktime";
    if (MP4_BRANDS.has(brand)) return "video/mp4";
  }
  return null;
}

/**
 * Does the start of the file look like markup a browser could execute (SVG,
 * HTML, XML, script)? Checked on the first 2 KB after a BOM and whitespace —
 * a bounded, regex-free scan.
 */
export function looksActive(b: Buffer): boolean {
  let s = b.subarray(0, 2048).toString("latin1");
  if (s.startsWith("\xef\xbb\xbf")) s = s.slice(3);
  else if (s.startsWith("\xfe\xff") || s.startsWith("\xff\xfe")) {
    // UTF-16: drop NULs so "<\0s\0v\0g" reads as "<svg".
    s = s.slice(2).split("\0").join("");
  }
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r" || s[i] === "\f")) i++;
  const head = s.slice(i, i + 32).toLowerCase();
  return ["<svg", "<?xml", "<!doctype html", "<html", "<script", "<head", "<body", "<iframe"].some((p) => head.startsWith(p));
}

export function hasBlockedExtension(name: string): boolean {
  const n = name.toLowerCase().replace(/[.\s]+$/, "");
  return BLOCKED_EXTENSIONS.some((e) => n.endsWith(e));
}

/** Types served `inline` (rendered by the browser); everything else is a download. */
export function isInlineType(mime: string): boolean {
  return mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf";
}
