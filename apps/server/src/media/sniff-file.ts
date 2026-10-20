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
  // MP3: an ID3v2 tag followed by a valid frame header, or two CONSECUTIVE valid
  // frame headers. One loose sync word is not enough — UTF-16 text with a BOM
  // (FF FE 3C 00 …, e.g. UTF-16 HTML) starts with the same 11 set bits.
  if (ascii(b, "ID3") && b.length >= 10) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    const after = 10 + size + ((b[5]! & 0x10) ? 10 : 0);
    // The tag may be longer than what we were handed (or the whole buffer); then the tag header must at least be well-formed.
    if (after + 4 <= b.length ? mpegFrameLength(b, after) > 0 : (b[3]! < 0xff && b[4]! < 0xff && ((b[6]! | b[7]! | b[8]! | b[9]!) & 0x80) === 0)) return "audio/mpeg";
  }
  {
    const first = mpegFrameLength(b, 0);
    if (first > 0 && mpegFrameLength(b, first) > 0) return "audio/mpeg";
  }
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

const MPEG_BITRATES: Record<string, number[]> = {
  // kbit/s by bitrate index 1..14, keyed "<version group><layer>"
  "1-1": [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Length in bytes of the MPEG audio frame whose header starts at `off`, or 0 if it is not a valid header. */
export function mpegFrameLength(b: Buffer, off: number): number {
  if (off < 0 || b.length < off + 4) return 0;
  if (b[off] !== 0xff || (b[off + 1]! & 0xe0) !== 0xe0) return 0;
  const version = (b[off + 1]! >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5, 1 = reserved
  const layerBits = (b[off + 1]! >> 1) & 0x03; // 3 = Layer I, 2 = II, 1 = III, 0 = reserved
  const bitrateIdx = b[off + 2]! >> 4;
  const rateIdx = (b[off + 2]! >> 2) & 0x03;
  const padding = (b[off + 2]! >> 1) & 0x01;
  if (version === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return 0;
  const layer = 4 - layerBits;
  const bitrate = MPEG_BITRATES[`${version === 3 ? 1 : 2}-${layer}`]![bitrateIdx - 1]! * 1000;
  const rate = MPEG_RATES[version]![rateIdx]!;
  if (layer === 1) return (Math.floor((12 * bitrate) / rate) + padding) * 4;
  const samples = layer === 3 && version !== 3 ? 72 : 144;
  return Math.floor((samples * bitrate) / rate) + padding;
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
    // UTF-16: drop NULs so "<\0s\0v\0g" reads as "<svg". Any UTF-16 text whose
    // first character is "<" is treated as markup (a browser would sniff it so).
    s = s.slice(2).split("\0").join("");
    let k = 0;
    while (k < s.length && (s[k] === " " || s[k] === "\t" || s[k] === "\n" || s[k] === "\r" || s[k] === "\f")) k++;
    if (s[k] === "<") return true;
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
