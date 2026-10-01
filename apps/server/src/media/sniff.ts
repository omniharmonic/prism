/**
 * Magic-byte sniffing for proxied images. The proxy serves the type it SNIFFED,
 * never the upstream's Content-Type, and only these raster formats. SVG (script,
 * external references), HTML and everything else are refused outright —
 * rasterising SVG is out of scope.
 */
export type RasterType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "image/bmp" | "image/x-icon";

export const RASTER_EXT: Record<RasterType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
};

const startsWith = (b: Buffer, sig: number[], at = 0): boolean => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

export function sniffRaster(b: Buffer): RasterType | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  // ISO-BMFF: "ftyp" at 4, brand avif/avis.
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = b.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  // BMP: "BM", reserved words 0, a known DIB header size, sane pixel-data offset.
  if (startsWith(b, [0x42, 0x4d]) && b.length >= 26) {
    const reserved = b.readUInt32LE(6);
    const offset = b.readUInt32LE(10);
    const dib = b.readUInt32LE(14);
    if (reserved === 0 && [12, 40, 52, 56, 64, 108, 124].includes(dib) && offset >= 14 + dib && offset < b.length) return "image/bmp";
    return null;
  }
  // ICO: reserved 0, type 1, 1..255 entries, the directory present, each entry's reserved byte 0
  // and its image data inside the buffer.
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00]) && b.length >= 6) {
    const count = b.readUInt16LE(4);
    if (count < 1 || count > 255 || b.length < 6 + 16 * count) return null;
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i;
      const size = b.readUInt32LE(e + 8);
      const off = b.readUInt32LE(e + 12);
      if (b[e + 3] !== 0 || size === 0 || off < 6 + 16 * count || off + size > b.length) return null;
    }
    return "image/x-icon";
  }
  return null;
}

/**
 * Does the upstream Content-Type permit an image? `image/*` except SVG, or a
 * generic binary type some CDNs use (the sniff is the real gate either way).
 */
export function upstreamTypeAllowed(contentType: string): boolean {
  const t = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (t.includes("svg")) return false;
  if (t.startsWith("image/")) return true;
  return t === "" || t === "application/octet-stream" || t === "binary/octet-stream";
}
