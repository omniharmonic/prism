// What a Comms attachment may be, decided from its BYTES (never the client's Content-Type or file
// name), and the facts the Matrix event carries about it (mimetype, image size).
//
// Per kind (what the mautrix bridges accept, see the send-server report):
//   image  JPEG / PNG / GIF / WebP only. HEIC/AVIF are refused (mautrix-whatsapp sends only
//          JPEG and converts PNG/WebP; HEIC would fail there) — the client converts to JPEG.
//   video  MP4 (incl. 3GP brands) / QuickTime / WebM.
//   voice  Ogg/Opus (preferred: WhatsApp + Telegram play it as a voice note), AAC in MP4 (.m4a),
//          raw AAC (ADTS) or MP3. Opus in CAF (`audio/x-caf`, what Messages sends an audio
//          message as) is accepted here but only SENT to iMessage/SMS (send.ts refuses it for
//          the Matrix bridges, whose recipients can't play CAF).
//   file   anything that is not active content (SVG/HTML/XML/script — media/sniff-file.ts) and
//          not an executable (magic bytes or extension). Recognised types keep their sniffed
//          mimetype; a few document types are named by extension; everything else is
//          application/octet-stream.
import { hasBlockedExtension, looksActive, sniffAttachment } from "../media/sniff-file";
import { sanitizeName } from "../attachments";

export type AttachmentKind = "image" | "video" | "file" | "voice";
export const ATTACHMENT_KINDS: ReadonlySet<string> = new Set(["image", "video", "file", "voice"]);

export class MediaRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaRefusal";
  }
}

const IMAGE_OK = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VIDEO_OK = new Set(["video/mp4", "video/quicktime", "video/webm"]);

const ascii = (b: Buffer, s: string, off = 0): boolean => b.length >= off + s.length && b.subarray(off, off + s.length).toString("latin1") === s;

/** Native executables and scripts a recipient's machine could run. */
export function looksExecutable(b: Buffer): boolean {
  if (ascii(b, "MZ")) return true; // PE (Windows .exe/.dll/.scr)
  if (ascii(b, "\x7fELF")) return true;
  const m = b.length >= 4 ? b.readUInt32BE(0) : 0;
  // Mach-O (32/64, both byte orders) and fat binaries (CAFEBABE, which is also a Java class).
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(m)) return true;
  if (ascii(b, "#!")) return true; // shell / interpreter script
  return false;
}

const EXECUTABLE_EXT = [
  ".exe", ".dll", ".com", ".bat", ".cmd", ".scr", ".msi", ".msp", ".pif", ".cpl", ".ps1", ".psm1", ".vbs", ".vbe",
  ".js", ".jse", ".wsf", ".wsh", ".hta", ".jar", ".apk", ".app", ".command", ".sh", ".bash", ".zsh", ".csh",
  ".lnk", ".reg", ".scf", ".url", ".workflow", ".action", ".pkg", ".mpkg", ".dmg", ".iso", ".deb", ".rpm",
];
export function hasExecutableExtension(name: string): boolean {
  const n = name.toLowerCase().replace(/[.\s]+$/, "");
  return EXECUTABLE_EXT.some((e) => n.endsWith(e));
}

/** Plain document types named by extension (their bytes have no reliable magic). Safe, inert. */
const DOC_BY_EXT: Record<string, string> = {
  txt: "text/plain", csv: "text/csv", md: "text/markdown", rtf: "application/rtf", ics: "text/calendar", vcf: "text/vcard",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  key: "application/vnd.apple.keynote", pages: "application/vnd.apple.pages", numbers: "application/vnd.apple.numbers",
  zip: "application/zip", heic: "image/heic", heif: "image/heif",
};

/** Ogg whose first page is an Opus stream ("OpusHead" in the first packet). */
function isOggOpus(b: Buffer): boolean {
  return ascii(b, "OggS") && b.subarray(0, 512).includes(Buffer.from("OpusHead", "latin1"));
}
/**
 * Opus in CAF: the "caff" file header (version 1) followed directly by the mandatory `desc`
 * chunk (32 bytes: Float64 sample rate, then the format id), whose format id is 'opus'.
 */
export function isCafOpus(b: Buffer): boolean {
  return b.length >= 44 && ascii(b, "caff") && b.readUInt16BE(4) === 1 && ascii(b, "desc", 8) &&
    b.readBigInt64BE(12) === 32n && ascii(b, "opus", 28);
}
export const CAF_MIME = "audio/x-caf";
/** Raw AAC: an ADTS sync word (12 bits set, layer 00). */
const isAdts = (b: Buffer): boolean => b.length >= 7 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0;

export interface MediaFacts {
  mimetype: string;
  /** Pixel size for images when the header gives it. */
  w?: number;
  h?: number;
  /** The file name the event carries (sanitised; the server's own for voice). */
  filename: string;
}

/** Decide whether `bytes` may be sent as `kind`; throws MediaRefusal (→ 415) otherwise. */
export function classifyAttachment(kind: AttachmentKind, bytes: Buffer, rawName: unknown): MediaFacts {
  if (!bytes.length) throw new MediaRefusal("the file is empty");
  const name = sanitizeName(rawName);
  if (looksActive(bytes) || hasBlockedExtension(name)) throw new MediaRefusal("web pages, SVG and scripts can't be sent");
  if (looksExecutable(bytes) || hasExecutableExtension(name)) throw new MediaRefusal("programs and scripts can't be sent");
  const sniffed = sniffAttachment(bytes);
  switch (kind) {
    case "image": {
      if (!sniffed || !IMAGE_OK.has(sniffed)) throw new MediaRefusal("photos must be JPEG, PNG, GIF or WebP");
      return { mimetype: sniffed, filename: withExt(name, sniffed), ...imageSize(bytes, sniffed) };
    }
    case "video": {
      if (!sniffed || !VIDEO_OK.has(sniffed)) throw new MediaRefusal("videos must be MP4, QuickTime or WebM");
      return { mimetype: sniffed, filename: withExt(name, sniffed) };
    }
    case "voice": {
      if (sniffed === "audio/ogg") {
        if (!isOggOpus(bytes)) throw new MediaRefusal("voice messages in Ogg must be Opus");
        return { mimetype: "audio/ogg", filename: "Voice message.ogg" };
      }
      if (sniffed === "audio/mp4") return { mimetype: "audio/mp4", filename: "Voice message.m4a" };
      if (sniffed === "audio/mpeg") return { mimetype: "audio/mpeg", filename: "Voice message.mp3" };
      if (!sniffed && isAdts(bytes)) return { mimetype: "audio/aac", filename: "Voice message.aac" };
      // Messages' own name for an audio message (iMessage/SMS only — send.ts).
      if (!sniffed && isCafOpus(bytes)) return { mimetype: CAF_MIME, filename: "Audio Message.caf" };
      throw new MediaRefusal("voice messages must be Ogg/Opus, M4A (AAC), AAC, MP3 or Opus in CAF");
    }
    case "file": {
      if (sniffed) return { mimetype: sniffed, filename: name };
      const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
      return { mimetype: (ext && DOC_BY_EXT[ext]) || "application/octet-stream", filename: name };
    }
  }
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
};
/** A photo/video named "file" (no name sent) gets a type-matching extension. */
function withExt(name: string, mime: string): string {
  if (name !== "file") return name;
  const base = mime.startsWith("image/") ? "image" : "video";
  return `${base}.${EXT[mime] ?? "bin"}`;
}

// ── image size from the header (no decoding) ────────────────────────────────

const sane = (w: number, h: number): { w: number; h: number } | Record<string, never> =>
  Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 65_535 && h <= 65_535 ? { w, h } : {};

export function imageSize(b: Buffer, mime: string): { w?: number; h?: number } {
  try {
    if (mime === "image/png" && b.length >= 24) return sane(b.readUInt32BE(16), b.readUInt32BE(20));
    if (mime === "image/gif" && b.length >= 10) return sane(b.readUInt16LE(6), b.readUInt16LE(8));
    if (mime === "image/webp" && b.length >= 30) {
      const chunk = b.subarray(12, 16).toString("latin1");
      if (chunk === "VP8X") return sane(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
      if (chunk === "VP8L" && b[20] === 0x2f) {
        const bits = b.readUInt32LE(21);
        return sane((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8 ") return sane(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
      return {};
    }
    if (mime === "image/jpeg") return jpegSize(b);
  } catch {
    // a truncated header: no size
  }
  return {};
}

/** Walk JPEG markers to the first SOFn frame header. EXIF orientation is NOT applied (the
 *  stored pixel size is what Matrix clients expect; most send it the same way). */
function jpegSize(b: Buffer): { w?: number; h?: number } {
  let i = 2;
  let guard = 0;
  while (i + 9 < b.length && guard++ < 10_000) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return {};
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return sane(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
    i += 2 + len;
  }
  return {};
}

/** A thumbnail part (optional, image/video): JPEG or PNG only. */
export function classifyThumbnail(bytes: Buffer): { mimetype: string; w?: number; h?: number } {
  const sniffed = sniffAttachment(bytes);
  if (sniffed !== "image/jpeg" && sniffed !== "image/png") throw new MediaRefusal("a thumbnail must be JPEG or PNG");
  return { mimetype: sniffed, ...imageSize(bytes, sniffed) };
}
