/**
 * A small, dependency-free ZIP reader + writer (isomorphic: Node and browser).
 *
 * WRITER — `ZipWriter` produces a classic (non-ZIP64) archive chunk by chunk, so
 * a caller can stream it to disk or a response without holding it whole. Entries
 * are stored, or deflated when the caller hands over a raw-deflate function
 * (the server passes zlib's; the browser fixtures store).
 *
 * READER — `readZipDirectory` + `readZipEntry` are written for HOSTILE input
 * (an uploaded Notion export):
 *  - only the central directory is trusted for the entry list, and every number
 *    in it is bounds-checked against the buffer before use;
 *  - ZIP64, multi-disk, encrypted entries and methods other than stored/deflate
 *    are refused;
 *  - limits on entry count, per-entry size, total declared size and name length
 *    are enforced BEFORE any byte is inflated (zip bomb);
 *  - entries whose data ranges overlap are refused (the "better zip bomb" layout
 *    declares many entries over one compressed blob);
 *  - an entry inflates to EXACTLY its declared size or fails (the injected
 *    inflate must stop at `maxOut`), and its CRC is verified;
 *  - names are never used as file-system paths here; `safeZipName` still
 *    canonicalises them and refuses absolute paths, drive letters, NUL and any
 *    `.`/`..` segment (zip slip), so a consumer mapping names to vault paths
 *    starts from a clean relative path.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipErrorCode =
  | "not_zip"
  | "unsupported"
  | "too_many_entries"
  | "too_large"
  | "corrupt"
  | "encrypted";

export class ZipError extends Error {
  constructor(public readonly code: ZipErrorCode, message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipLimits {
  /** Entries in the central directory (directories included). */
  maxEntries: number;
  /** Declared uncompressed size of one entry. */
  maxEntryBytes: number;
  /** Sum of declared uncompressed sizes. */
  maxTotalBytes: number;
  /** Bytes of one entry name. */
  maxNameBytes?: number;
}

export interface ZipEntry {
  /** Canonical relative path (forward slashes), or the raw name when `unsafe`. */
  name: string;
  /** Why this entry must be ignored (never read): an unsafe path, a symlink, a duplicate name… */
  unsafe?: string;
  directory: boolean;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  crc: number;
  /** Offset of the entry's DATA inside the archive buffer. */
  dataOffset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const utf8 = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;
function decodeName(bytes: Uint8Array, isUtf8: boolean): string {
  if (isUtf8 || bytes.every((c) => c < 0x80)) return utf8 ? utf8.decode(bytes) : String.fromCharCode(...bytes);
  // Legacy code page: try UTF-8 first (most tools write it without the flag), else Latin-1.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let s = "";
    for (const c of bytes) s += String.fromCharCode(c);
    return s;
  }
}

/**
 * A clean relative path for an archive member, or null when it must be ignored:
 * NUL / control characters, an absolute path, a drive letter, or any `.` / `..`
 * segment. Backslashes are separators (Windows-made archives).
 */
export function safeZipName(raw: string): string | null {
  if (!raw || raw.length > 4096) return null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  const s = raw.split("\\").join("/");
  if (s.startsWith("/")) return null;
  if (s.length >= 2 && s[1] === ":") return null;
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "") continue; // "a//b", trailing slash
    if (seg === "." || seg === "..") return null;
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** True when the bytes start like a ZIP archive (local header or an empty archive). */
export function looksLikeZip(buf: Uint8Array): boolean {
  if (buf.length < 4) return false;
  const sig = u32(buf, 0);
  return sig === LOC_SIG || sig === EOCD_SIG;
}

export function readZipDirectory(buf: Uint8Array, limits: ZipLimits): ZipEntry[] {
  if (buf.length < 22) throw new ZipError("not_zip", "not a zip archive");
  // End-of-central-directory: scan back over at most a 64 KB comment.
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf[i] === 0x50 && u32(buf, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not_zip", "not a zip archive");
  const disk = u16(buf, eocd + 4);
  const cdDisk = u16(buf, eocd + 6);
  const onDisk = u16(buf, eocd + 8);
  const total = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new ZipError("unsupported", "multi-part archives are not supported");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("unsupported", "ZIP64 archives are not supported");
  if (total > limits.maxEntries) throw new ZipError("too_many_entries", `the archive has more than ${limits.maxEntries} entries`);
  if (cdOffset + cdSize > eocd) throw new ZipError("corrupt", "the archive directory is out of range");

  const maxName = limits.maxNameBytes ?? 1024;
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let sum = 0;
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cdOffset + cdSize || u32(buf, p) !== CEN_SIG) throw new ZipError("corrupt", "the archive directory is damaged");
    const madeBy = u16(buf, p + 4);
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    const compressedSize = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const external = u32(buf, p + 38);
    const localOffset = u32(buf, p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize) throw new ZipError("corrupt", "the archive directory is damaged");
    if (nameLen > maxName) throw new ZipError("corrupt", "an entry name is too long");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("unsupported", "ZIP64 archives are not supported");
    const rawName = decodeName(buf.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    p = next;

    const directory = rawName.endsWith("/") || rawName.endsWith("\\");
    if (flags & 0x1) throw new ZipError("encrypted", "password-protected archives are not supported");
    if (method !== 0 && method !== 8) throw new ZipError("unsupported", "the archive uses an unsupported compression method");
    if (size > limits.maxEntryBytes) throw new ZipError("too_large", "a file in the archive is too large");
    sum += size;
    if (sum > limits.maxTotalBytes) throw new ZipError("too_large", "the archive is too large when unpacked");
    // The local header decides where the data starts.
    if (localOffset + 30 > cdOffset || u32(buf, localOffset) !== LOC_SIG) throw new ZipError("corrupt", "an entry is out of range");
    const dataOffset = localOffset + 30 + u16(buf, localOffset + 26) + u16(buf, localOffset + 28);
    if (dataOffset + compressedSize > cdOffset) throw new ZipError("corrupt", "an entry is out of range");
    if (method === 0 && compressedSize !== size) throw new ZipError("corrupt", "a stored entry has mismatched sizes");

    const safe = safeZipName(rawName);
    // Unix symlink (made-by host 3, mode S_IFLNK): its content is a path, never a file.
    const symlink = madeBy >> 8 === 3 && ((external >>> 16) & 0xf000) === 0xa000;
    const entry: ZipEntry = { name: safe ?? rawName, directory, method: method as 0 | 8, compressedSize, size, crc, dataOffset };
    if (!safe) entry.unsafe = "unsafe path";
    else if (symlink) entry.unsafe = "symbolic link";
    else if (seen.has(safe.toLowerCase())) entry.unsafe = "duplicate name";
    else seen.add(safe.toLowerCase());
    entries.push(entry);
  }

  // No two entries may share bytes: an overlapping layout multiplies one blob.
  const ranges = entries.filter((e) => e.compressedSize > 0).map((e) => [e.dataOffset, e.dataOffset + e.compressedSize] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]![0] < ranges[i - 1]![1]) throw new ZipError("corrupt", "the archive has overlapping entries");
  }
  return entries;
}

/** Raw-deflate inflate that MUST fail (throw) rather than produce more than `maxOut` bytes. */
export type Inflate = (data: Uint8Array, maxOut: number) => Uint8Array;

export function readZipEntry(buf: Uint8Array, entry: ZipEntry, inflate?: Inflate): Uint8Array {
  if (entry.unsafe) throw new ZipError("corrupt", `entry refused: ${entry.unsafe}`);
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let out: Uint8Array;
  if (entry.method === 0) out = raw;
  else {
    if (!inflate) throw new ZipError("unsupported", "compressed archives are not supported here");
    try {
      out = inflate(raw, entry.size);
    } catch {
      throw new ZipError("corrupt", "an entry could not be unpacked");
    }
  }
  if (out.length !== entry.size) throw new ZipError("corrupt", "an entry does not match its declared size");
  if (crc32(out) !== entry.crc) throw new ZipError("corrupt", "an entry failed its checksum");
  return out;
}

// ── writer ───────────────────────────────────────────────────────────────────

/** Classic ZIP limits (no ZIP64): stay under them or `add`/`end` throws. */
export const ZIP_MAX_ENTRIES = 65_000;
export const ZIP_MAX_BYTES = 0xfff00000; // a little under 4 GiB

const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const encode = (s: string): Uint8Array => enc!.encode(s);

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function header(size: number) {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  return { b, w16: (o: number, n: number) => v.setUint16(o, n, true), w32: (o: number, n: number) => v.setUint32(o, n >>> 0, true) };
}

export class ZipWriter {
  private central: Uint8Array[] = [];
  private offset = 0;
  private names = new Set<string>();
  count = 0;

  /** Bytes written so far (the archive's size before the directory). */
  get bytes(): number {
    return this.offset;
  }

  /** True when `name` (case-insensitive) is already in the archive. */
  has(name: string): boolean {
    return this.names.has(name.toLowerCase());
  }

  /**
   * Append one file; returns the bytes to write next (local header + data).
   * `deflate` (raw deflate) is used when it makes the entry smaller.
   */
  add(name: string, data: Uint8Array, opts: { deflate?: (d: Uint8Array) => Uint8Array; mtime?: Date } = {}): Uint8Array {
    const clean = safeZipName(name);
    if (!clean) throw new Error(`unsafe zip entry name`);
    if (this.has(clean)) throw new Error(`duplicate zip entry: ${clean}`);
    if (this.count + 1 > ZIP_MAX_ENTRIES) throw new Error("too many zip entries");
    const nameBytes = encode(clean);
    if (nameBytes.length > 0xffff) throw new Error("zip entry name too long");
    let body = data;
    let method = 0;
    if (opts.deflate && data.length > 64) {
      const packed = opts.deflate(data);
      if (packed.length < data.length) {
        body = packed;
        method = 8;
      }
    }
    if (this.offset + 30 + nameBytes.length + body.length > ZIP_MAX_BYTES) throw new Error("zip archive too large");
    const crc = crc32(data);
    const { time, date } = dosTime(opts.mtime ?? new Date());

    const loc = header(30 + nameBytes.length);
    loc.w32(0, LOC_SIG);
    loc.w16(4, 20);
    loc.w16(6, 0x800); // UTF-8 names
    loc.w16(8, method);
    loc.w16(10, time);
    loc.w16(12, date);
    loc.w32(14, crc);
    loc.w32(18, body.length);
    loc.w32(22, data.length);
    loc.w16(26, nameBytes.length);
    loc.w16(28, 0);
    loc.b.set(nameBytes, 30);

    const cen = header(46 + nameBytes.length);
    cen.w32(0, CEN_SIG);
    cen.w16(4, 20);
    cen.w16(6, 20);
    cen.w16(8, 0x800);
    cen.w16(10, method);
    cen.w16(12, time);
    cen.w16(14, date);
    cen.w32(16, crc);
    cen.w32(20, body.length);
    cen.w32(24, data.length);
    cen.w16(28, nameBytes.length);
    cen.w32(42, this.offset);
    cen.b.set(nameBytes, 46);
    this.central.push(cen.b);

    const out = new Uint8Array(loc.b.length + body.length);
    out.set(loc.b, 0);
    out.set(body, loc.b.length);
    this.offset += out.length;
    this.count++;
    this.names.add(clean.toLowerCase());
    return out;
  }

  /** The central directory + end record: the last bytes of the archive. */
  end(): Uint8Array {
    const size = this.central.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(size + 22);
    let p = 0;
    for (const c of this.central) {
      out.set(c, p);
      p += c.length;
    }
    const v = new DataView(out.buffer);
    v.setUint32(p, EOCD_SIG, true);
    v.setUint16(p + 8, this.count, true);
    v.setUint16(p + 10, this.count, true);
    v.setUint32(p + 12, size, true);
    v.setUint32(p + 16, this.offset, true);
    return out;
  }
}

/** Convenience for small archives (tests, fixtures): the whole ZIP in memory. */
export function zipSync(files: Array<{ name: string; data: Uint8Array | string }>, opts: { deflate?: (d: Uint8Array) => Uint8Array } = {}): Uint8Array {
  const w = new ZipWriter();
  const chunks: Uint8Array[] = [];
  for (const f of files) chunks.push(w.add(f.name, typeof f.data === "string" ? encode(f.data) : f.data, opts));
  chunks.push(w.end());
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
