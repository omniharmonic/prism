/**
 * A small QR Code encoder (ISO/IEC 18004), written for Prism — no dependency.
 *
 * Scope: what the pairing QR needs and nothing more — byte mode, error-correction level M,
 * versions 1–20 (up to 666 bytes), automatic mask choice. Pure and synchronous: text in, a
 * square grid of modules out (`true` = dark). Rendering is the caller's (see `qrSvgPath`).
 *
 * Pinned by apps/server/test/qrcode.test.ts (format/version words, Reed–Solomon against
 * known vectors, structure) — the server suite is where pure core code is tested.
 */

const MAX_VERSION = 20;
/** Error-correction codewords per block, level M, by version (index 0 unused). */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
/** Number of error-correction blocks, level M, by version. */
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
/** Format-information bits for level M. */
const ECL_M_BITS = 0;

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** `modules[y][x]`, true = dark. */
  modules: boolean[][];
}

/** Modules available for data + ECC in a version (everything that is not a function pattern). */
export function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    r -= (25 * align - 10) * align - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const rawCodewords = (ver: number): number => Math.floor(rawDataModules(ver) / 8);
/** Data codewords (bytes) a version holds at level M. */
export const dataCodewords = (ver: number): number => rawCodewords(ver) - ECC_PER_BLOCK[ver]! * NUM_BLOCKS[ver]!;

// ---------------------------------------------------------------- GF(256), Reed–Solomon

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial of `degree`, highest coefficient first, the leading 1 left out. */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** The ECC codewords of `data` for a divisor from `rsDivisor`. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i]! ^= gfMul(divisor[i]!, factor);
  }
  return result;
}

// ---------------------------------------------------------------- format + version words

/** The 15-bit format word for level M and `mask` (BCH(15,5), XOR 0x5412). */
export function formatBits(mask: number): number {
  const data = (ECL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18-bit version word (BCH(18,6)), versions ≥ 7. */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ---------------------------------------------------------------- encoding

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

function dataCodewordsFor(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const put = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!;
    out.push(v);
  }
  for (let pad = 0xec; out.length < dataCodewords(ver); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add each block's ECC, interleave. */
function withEcc(data: number[], ver: number): number[] {
  const blocks = NUM_BLOCKS[ver]!;
  const ecLen = ECC_PER_BLOCK[ver]!;
  const raw = rawCodewords(ver);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(ecLen);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - ecLen + (i < shortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0); // placeholder, skipped below
    all.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < all[0]!.length; i++) {
    all.forEach((b, j) => {
      if (i !== shortLen - ecLen || j >= shortBlocks) out.push(b[i]!);
    });
  }
  return out;
}

class Grid {
  readonly size: number;
  readonly mods: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly ver: number) {
    this.size = ver * 4 + 17;
    this.mods = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.mods[y]![x] = dark;
    this.fn[y]![x] = true;
  }
  drawFunctionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    const finder = (cx: number, cy: number) => {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < s && y >= 0 && y < s) this.set(x, y, d !== 2 && d !== 4);
        }
    };
    finder(3, 3);
    finder(s - 4, 3);
    finder(3, s - 4);
    const pos = alignmentPositions(this.ver);
    const n = pos.length;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    this.drawFormat(0); // reserve; redrawn per mask
    if (this.ver >= 7) {
      const v = versionBits(this.ver);
      for (let i = 0; i < 18; i++) {
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(v, i));
        this.set(b, a, bit(v, i));
      }
    }
  }
  drawFormat(mask: number) {
    const f = formatBits(mask);
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(f, i));
    this.set(8, 7, bit(f, 6));
    this.set(8, 8, bit(f, 7));
    this.set(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(f, i));
    this.set(8, s - 8, true); // the dark module
  }
  drawCodewords(data: number[]) {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - vert : vert;
          if (!this.fn[y]![x] && i < data.length * 8) {
            this.mods[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
    }
  }
  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) {
        if (this.fn[y]![x]) continue;
        let inv: boolean;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (inv) this.mods[y]![x] = !this.mods[y]![x];
      }
  }
  /** ISO 18004 §7.8.3 penalty (rules 1–4). Any mask decodes; this only picks the cleanest. */
  penalty(): number {
    const s = this.size;
    const m = this.mods;
    let p = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i <= s; i++) {
        if (i < s && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) p += run - 2;
          run = 1;
        }
      }
      // Finder-like 1:1:3:1:1 with four light modules on a side.
      for (let i = 0; i + 10 < s; i++) {
        const pat = [true, false, true, true, true, false, true];
        const fits = (off: number) => pat.every((v, k) => get(off + k) === v);
        const light = (from: number) => [0, 1, 2, 3].every((k) => !get(from + k));
        if (fits(i) && light(i + 7)) p += 40;
        if (fits(i + 4) && light(i)) p += 40;
      }
    };
    for (let y = 0; y < s; y++) line((i) => m[y]![i]!);
    for (let x = 0; x < s; x++) line((i) => m[i]![x]!);
    for (let y = 0; y + 1 < s; y++)
      for (let x = 0; x + 1 < s; x++) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) p += 3;
      }
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    const total = s * s;
    p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return p;
  }
}

/** Encode `text` (UTF-8). Throws when it does not fit in version 20 at level M. */
export function encodeQr(text: string, opts: { mask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  const bitsNeeded = (v: number) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
  while (ver <= MAX_VERSION && bitsNeeded(ver) > dataCodewords(ver) * 8) ver++;
  if (ver > MAX_VERSION) throw new Error("text too long for a QR code");
  const codewords = withEcc(dataCodewordsFor(bytes, ver), ver);
  let best: { mask: number; mods: boolean[][]; p: number } | null = null;
  // `opts.mask` forces one mask (tests: every mask must decode); otherwise the lowest penalty wins.
  const masks = opts.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask];
  for (const mask of masks) {
    const g = new Grid(ver);
    g.drawFunctionPatterns();
    g.drawCodewords(codewords);
    g.applyMask(mask);
    g.drawFormat(mask);
    const p = g.penalty();
    if (!best || p < best.p) best = { mask, mods: g.mods, p };
  }
  return { version: ver, size: ver * 4 + 17, mask: best!.mask, modules: best!.mods };
}

/** One SVG path of the dark modules, offset by a `quiet` zone (4 modules is the standard). */
export function qrSvgPath(qr: QrCode, quiet = 4): string {
  let d = "";
  qr.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }),
  );
  return d;
}
