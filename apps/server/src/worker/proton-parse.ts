/**
 * Pure port of the message → note half of the Proton Bridge ingest script
 * (`proton_mail.py`: parse_message, derive_labels, extract_body, html_to_text,
 * thread_root, note_content, note_path, and the metadata dict of
 * upsert_email_note), for the server worker in ./proton.ts (WP1.2b).
 *
 * The script parses with Python's `email.message_from_bytes(raw,
 * policy=email.policy.default)`, so what it stores is shaped by that parser's
 * header semantics. This module reproduces the parts of those semantics the
 * script's output depends on — pinned byte-for-byte against a fixture produced
 * by running the script's own functions (Python 3.9, the version the launchd job
 * uses) on synthetic messages (test/fixtures/proton-script-fixture.json):
 *   - headers are unfolded by deleting CR/LF (the following WSP stays), 8-bit
 *     header bytes read as UTF-8 with replacement, first occurrence wins;
 *   - unstructured headers (Subject, List-*, Precedence, X-*, Return-Path,
 *     References, …): RFC 2047 encoded words decoded anywhere, the whitespace
 *     BETWEEN two encoded words dropped, all other whitespace kept;
 *   - address headers (From/To/Cc) are re-rendered the way `str(header)` does:
 *     `Display <addr>`, the display name quoted when it contains one of
 *     `()<>@,:;."[]`, comments dropped, unquoted whitespace runs collapsed,
 *     groups as `Name: a, b;`;
 *   - Date: `email.utils.parsedate_to_datetime` (the lenient `_parsedate_tz`),
 *     no zone / `-0000` read as UTC, anything invalid → "now" (as the script);
 *   - bodies: Python's `walk()` order, CTE base64 / quoted-printable, charset via
 *     the part's `charset` param (unknown → UTF-8), `errors="replace"`;
 *   - `html.unescape` (numeric refs exactly as Python, named refs via the HTML5
 *     table in `entities`, which implements the same longest-prefix rule),
 *     `str.strip()` / `str.splitlines()` with Python's whitespace/line-break sets,
 *     body length counted in code points (Python `len`), not UTF-16 units;
 *   - the label regexes use Python's Unicode `\b` / `\w` / `\d`.
 * Known, accepted gaps (they can only affect a NEW note's text, never cause a
 * rewrite of an existing one — the worker keys existing notes by Message-ID):
 * exotic header edge cases (encoded words with whitespace inside, unknown
 * charsets inside encoded words, obsolete address syntax), charsets whose Python
 * codec differs from the WHATWG decoder (cp1252's five undefined bytes), and
 * Unicode combining marks with canonical class 0 in slugs.
 */
import crypto from "node:crypto";
import { decodeHTML } from "entities";

export const NOTE_DIR = "vault/messages/email";
export const SOURCE = "proton-bridge";
export const MAX_BODY_CHARS = 20_000;

// ── Python string helpers ────────────────────────────────────────────────────

/** Python `str.isspace()` set (Unicode White_Space + the \x1c-\x1f separators). */
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
/** Python `str.strip()` with no argument. */
export const pyStrip = (s: string): string => s.replace(PY_STRIP_RE, "");
/** Python `str.split()` with no argument. */
const pySplit = (s: string): string[] => pyStrip(s).split(new RegExp(`[${PY_WS}]+`)).filter(Boolean);
/** Python `str.strip(chars)`. */
function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}
/** Python's line boundaries: \r\n, \n, \r, \v, \f, \x1c-\x1e, \x85, U+2028, U+2029. */
const PY_LINEBREAK = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]");
/** Python `str.splitlines()` (no keepends). */
const pySplitLines = (s: string): string[] => {
  if (!s) return [];
  const parts = s.split(PY_LINEBREAK);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
};
const codePoints = (s: string): string[] => Array.from(s);

/**
 * Compile a regex written in Python syntax with Python 3's Unicode semantics:
 * `\w` = letters/digits/underscore in any script, `\b` = a boundary of that,
 * `\d` = any decimal digit. (JS `\w`/`\b` are ASCII-only even with the u flag.)
 */
export function pyRe(src: string, flags = ""): RegExp {
  const W = "\\p{L}\\p{N}_";
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[i + 1]!;
      i++;
      if (n === "w") out += inClass ? W : `[${W}]`;
      else if (n === "d") out += inClass ? "\\p{Nd}" : "\\p{Nd}";
      else if (n === "b" && !inClass) out += `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
      else out += "\\" + n;
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, flags.includes("u") ? flags : flags + "u");
}

// ── charsets + transfer encodings ────────────────────────────────────────────

/** `bytes.decode(charset, errors="replace")`, unknown charset → UTF-8 (the
 *  script's LookupError fallback). */
export function decodeCharset(buf: Buffer, charset: string | null | undefined): string {
  const cs = (charset ?? "utf-8").trim().toLowerCase();
  if (["us-ascii", "ascii", "646", "us"].includes(cs)) {
    let s = "";
    for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : "�";
    return s;
  }
  if (["iso-8859-1", "iso8859-1", "8859", "cp819", "latin", "latin1", "latin-1", "l1", "iso_8859_1", "iso-ir-100"].includes(cs)) {
    return buf.toString("latin1");
  }
  try {
    return new TextDecoder(cs, { fatal: false, ignoreBOM: true }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buf);
  }
}

/** binascii.a2b_qp (header=False): `=XX` hex (either case), `=` + line break =
 *  soft break, a trailing `=` dropped, anything else literal. */
export function decodeQuotedPrintable(input: Buffer): Buffer {
  const out: number[] = [];
  const hex = (b: number | undefined) =>
    b !== undefined && ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66));
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c !== 0x3d) {
      out.push(c);
      continue;
    }
    const a = input[i + 1];
    const b = input[i + 2];
    if (a === undefined) break; // "=" at end of data
    if (a === 0x0a) {
      i += 1;
      continue;
    }
    if (a === 0x0d && b === 0x0a) {
      i += 2;
      continue;
    }
    if (a === 0x0d) {
      i += 1;
      continue;
    }
    if (hex(a) && hex(b)) {
      out.push(parseInt(String.fromCharCode(a, b!), 16));
      i += 2;
      continue;
    }
    out.push(c);
  }
  return Buffer.from(out);
}

// ── RFC 2047 encoded words ───────────────────────────────────────────────────

const EW_RE = /=\?([^?\s]+)\?([bBqQ])\?([^?]*?)\?=/g;

function decodeEncodedWord(charset: string, enc: string, text: string): string {
  const cs = charset.split("*")[0]!;
  let bytes: Buffer;
  if (enc.toLowerCase() === "b") bytes = Buffer.from(text, "base64");
  else {
    const t = text.replace(/_/g, " ");
    const out: number[] = [];
    for (let i = 0; i < t.length; i++) {
      const m = /^[0-9a-fA-F]{2}$/.test(t.slice(i + 1, i + 3));
      if (t[i] === "=" && m) {
        out.push(parseInt(t.slice(i + 1, i + 3), 16));
        i += 2;
      } else out.push(t.charCodeAt(i) & 0xff);
    }
    bytes = Buffer.from(out);
  }
  return decodeCharset(bytes, cs);
}

/**
 * Python policy.default unstructured header value: encoded words decoded
 * anywhere (even glued to an atom), the whitespace between two adjacent encoded
 * words removed, everything else verbatim.
 */
export function decodeUnstructured(value: string): string {
  let out = "";
  let last = 0;
  let prevEwEnd = -1;
  for (const m of value.matchAll(EW_RE)) {
    const start = m.index!;
    const between = value.slice(last, start);
    if (prevEwEnd === last && between.length && /^[ \t]+$/.test(between)) {
      // whitespace between two encoded words is dropped
    } else out += between;
    out += decodeEncodedWord(m[1]!, m[2]!, m[3]!);
    last = start + m[0].length;
    prevEwEnd = last;
  }
  return out + value.slice(last);
}

/** Encoded words decoded, whitespace kept (address phrases / quoted strings). */
const decodeEwKeepWs = (s: string): string => s.replace(EW_RE, (_m, cs: string, e: string, t: string) => decodeEncodedWord(cs, e, t));

/** `str(make_header(decode_header(v))).strip()` — the script's `_decode`. */
export function pyDecodeHeader(v: string | null | undefined): string {
  if (!v) return "";
  return pyStrip(decodeUnstructured(v));
}

// ── MIME entities ────────────────────────────────────────────────────────────

export interface MimeEntity {
  /** [lowercased name, unfolded value] in order; `get` returns the first. */
  headers: Array<[string, string]>;
  body: Buffer;
  children: MimeEntity[] | null;
}

function splitLinesKeep(buf: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (c === 0x0a) {
      lines.push(buf.subarray(start, i + 1));
      start = i + 1;
    } else if (c === 0x0d) {
      if (buf[i + 1] === 0x0a) {
        lines.push(buf.subarray(start, i + 2));
        i++;
      } else lines.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}

const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const HEADER_LINE = /^[\x21-\x39\x3b-\x7e]+:/;

/** Parse one entity (headers + body, recursing into multiparts / message/rfc822). */
export function parseMime(raw: Buffer, depth = 0): MimeEntity {
  const lines = splitLinesKeep(raw);
  const headers: Array<[string, string]> = [];
  let i = 0;
  if (lines[0] && utf8.decode(lines[0]).startsWith("From ")) i = 1; // unix-from
  let cur: [string, string] | null = null;
  for (; i < lines.length; i++) {
    const line = utf8.decode(lines[i]!);
    if (/^(\r\n|\r|\n)$/.test(line)) {
      i++;
      break;
    }
    if ((line[0] === " " || line[0] === "\t") && cur) {
      cur[1] += line;
      continue;
    }
    if (!HEADER_LINE.test(line)) break; // missing header/body separator → body starts here
    const colon = line.indexOf(":");
    cur = [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).replace(/^[ \t]+/, "")];
    headers.push(cur);
  }
  for (const h of headers) h[1] = h[1].replace(/[\r\n]/g, "");
  const bodyStart = lines.slice(0, i).reduce((n, l) => n + l.length, 0);
  const body = raw.subarray(Math.min(bodyStart, raw.length));
  const ent: MimeEntity = { headers, body, children: null };
  if (depth > 20) return ent;

  const ctype = contentType(ent);
  if (ctype.startsWith("multipart/")) {
    const boundary = getParam(ent, "content-type", "boundary");
    if (boundary !== null) ent.children = splitMultipart(body, boundary.replace(/[ \t\r\n]+$/, "")).map((p) => parseMime(p, depth + 1));
  } else if (ctype === "message/rfc822") {
    ent.children = [parseMime(body, depth + 1)];
  }
  return ent;
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const sep = "--" + boundary;
  const lines = splitLinesKeep(body);
  const parts: Buffer[] = [];
  let current: Buffer[] | null = null;
  const esc = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}(--)?[ \\t]*(\\r\\n|\\r|\\n)?$`);
  const flush = () => {
    if (!current) return;
    if (current.length) {
      // the line break before a delimiter belongs to the delimiter
      const last = current[current.length - 1]!;
      let cut = last.length;
      if (cut >= 2 && last[cut - 2] === 0x0d && last[cut - 1] === 0x0a) cut -= 2;
      else if (cut >= 1 && (last[cut - 1] === 0x0a || last[cut - 1] === 0x0d)) cut -= 1;
      current[current.length - 1] = last.subarray(0, cut);
    }
    parts.push(Buffer.concat(current));
  };
  for (const l of lines) {
    const m = re.exec(l.toString("latin1"));
    if (m) {
      flush();
      if (m[1]) {
        current = null;
        return parts;
      }
      current = [];
      continue;
    }
    if (current) current.push(l);
  }
  if (current) parts.push(Buffer.concat(current)); // no close delimiter: runs to EOF
  return parts;
}

export function getHeader(e: MimeEntity, name: string): string | null {
  const n = name.toLowerCase();
  const h = e.headers.find(([k]) => k === n);
  return h ? h[1] : null;
}

/** `(msg.get(name) or "").strip()` for an unstructured header. */
const hdr = (e: MimeEntity, name: string): string => pyStrip(decodeUnstructured(getHeader(e, name) ?? ""));

/** Parameters of a structured header (RFC 2045 + RFC 2231 continuations/charset). */
function parseParams(value: string): { main: string; params: Map<string, string> } {
  const params = new Map<string, string>();
  const parts: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (q && c === "\\" && i + 1 < value.length) {
      cur += c + value[++i];
      continue;
    }
    if (c === '"') q = !q;
    if (c === ";" && !q) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const main = (parts.shift() ?? "").trim();
  const ext = new Map<string, Array<{ ix: number; enc: boolean; v: string }>>();
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (!m) continue;
    if (m[2] === undefined && !m[3]) {
      if (!params.has(m[1]!)) params.set(m[1]!, v);
      continue;
    }
    const list = ext.get(m[1]!) ?? [];
    list.push({ ix: m[2] === undefined ? 0 : Number(m[2]), enc: !!m[3], v });
    ext.set(m[1]!, list);
  }
  for (const [name, list] of ext) {
    list.sort((a, b) => a.ix - b.ix);
    let charset = "us-ascii";
    const bytes: number[] = [];
    list.forEach((seg, n) => {
      let v = seg.v;
      if (seg.enc) {
        if (n === 0) {
          const q1 = v.indexOf("'");
          const q2 = q1 >= 0 ? v.indexOf("'", q1 + 1) : -1;
          if (q2 >= 0) {
            charset = v.slice(0, q1) || "us-ascii";
            v = v.slice(q2 + 1);
          }
        }
        for (let i = 0; i < v.length; i++) {
          if (v[i] === "%" && /^[0-9a-fA-F]{2}$/.test(v.slice(i + 1, i + 3))) {
            bytes.push(parseInt(v.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(...Buffer.from(v[i]!, "utf8"));
        }
      } else bytes.push(...Buffer.from(v, "utf8"));
    });
    params.set(name, decodeCharset(Buffer.from(bytes), charset));
  }
  return { main, params };
}

function getParam(e: MimeEntity, header: string, name: string): string | null {
  const v = getHeader(e, header);
  if (v === null) return null;
  return parseParams(v).params.get(name) ?? null;
}

/** `get_content_type()`: lowercased, default text/plain, invalid → text/plain. */
export function contentType(e: MimeEntity): string {
  const v = getHeader(e, "content-type");
  if (v === null) return "text/plain";
  const main = parseParams(v).main.toLowerCase();
  return main.split("/").length === 2 ? main : "text/plain"; // Python: ctype.count('/') != 1 → text/plain
}

/** `get_payload(decode=True)`. */
function payloadBytes(e: MimeEntity): Buffer {
  const cte = (getHeader(e, "content-transfer-encoding") ?? "").trim().toLowerCase();
  if (cte === "base64") return Buffer.from(e.body.toString("latin1").replace(/[\r\n]/g, ""), "base64");
  if (cte === "quoted-printable") return decodeQuotedPrintable(e.body);
  return e.body;
}

/** Python `Message.walk()`: pre-order, the entity itself first. */
export function* walk(e: MimeEntity): Generator<MimeEntity> {
  yield e;
  for (const c of e.children ?? []) yield* walk(c);
}

// ── html_to_text ─────────────────────────────────────────────────────────────

const INVALID_CHARREFS: Record<number, string> = {
  0x00: "�", 0x0d: "\r", 0x80: "€", 0x81: "\x81", 0x82: "‚", 0x83: "ƒ", 0x84: "„",
  0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹",
  0x8c: "Œ", 0x8d: "\x8d", 0x8e: "Ž", 0x8f: "\x8f", 0x90: "\x90", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™",
  0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9d: "\x9d", 0x9e: "ž", 0x9f: "Ÿ",
};
function invalidCodepoint(n: number): boolean {
  return (
    (n >= 0x1 && n <= 0x8) || n === 0xb || (n >= 0xe && n <= 0x1f) || (n >= 0x7f && n <= 0x9f) ||
    (n >= 0xfdd0 && n <= 0xfdef) || (n & 0xfffe) === 0xfffe
  );
}

/** Python `html.unescape`. */
export function pyUnescape(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (whole, g: string) => {
    if (g[0] === "#") {
      const num = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2).replace(/;$/, ""), 16) : parseInt(g.slice(1).replace(/;$/, ""), 10);
      if (num in INVALID_CHARREFS) return INVALID_CHARREFS[num]!;
      if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff || !Number.isFinite(num)) return "�";
      if (invalidCodepoint(num)) return "";
      return String.fromCodePoint(num);
    }
    return decodeHTML(whole);
  });
}

export function htmlToText(markup: string): string {
  let text = markup.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = pyUnescape(text).replace(/\xa0/g, " ");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = pySplitLines(text).map(pyStrip).join("\n");
  return pyStrip(text.replace(/\n{3,}/g, "\n\n"));
}

// ── body + attachments ───────────────────────────────────────────────────────

export function extractBody(msg: MimeEntity): string {
  const plain: string[] = [];
  const html: string[] = [];
  for (const part of walk(msg)) {
    const ctype = contentType(part);
    if (ctype.startsWith("multipart/")) continue;
    if ((getHeader(part, "content-disposition") ?? "").toLowerCase().includes("attachment")) continue;
    if (ctype !== "text/plain" && ctype !== "text/html") continue;
    const payload = payloadBytes(part);
    if (!payload.length) continue;
    const text = decodeCharset(payload, contentCharset(part));
    (ctype === "text/plain" ? plain : html).push(text);
  }
  let body = pyStrip(plain.join("\n\n")) || htmlToText(html.join("\n\n"));
  const cps = codePoints(body);
  if (cps.length > MAX_BODY_CHARS) body = cps.slice(0, MAX_BODY_CHARS).join("") + "\n\n[… truncated …]";
  return body;
}

/** `get_content_charset()`: the charset param, lowercased; non-ASCII → none. */
function contentCharset(e: MimeEntity): string | null {
  const cs = getParam(e, "content-type", "charset");
  if (cs === null || !cs || /[^\x00-\x7f]/.test(cs)) return null;
  return cs.toLowerCase();
}

/** `get_filename()` (+ the script's `_decode`). */
function filename(e: MimeEntity): string | null {
  const f = getParam(e, "content-disposition", "filename") ?? getParam(e, "content-type", "name");
  return f === null ? null : pyStrip(f);
}

export function attachmentNames(msg: MimeEntity): string[] {
  const names: string[] = [];
  for (const part of walk(msg)) {
    const disp = (getHeader(part, "content-disposition") ?? "").toLowerCase();
    const fn = filename(part);
    if (disp.includes("attachment") || fn) {
      const name = pyDecodeHeader(fn);
      if (name) names.push(name);
    }
  }
  return names;
}

// ── threading ────────────────────────────────────────────────────────────────

const INTERNAL_ID = "@protonmail.internalid";

export function threadRoot(msg: MimeEntity): string {
  const refs = pySplit(decodeUnstructured(getHeader(msg, "references") ?? "")).filter((r) => !r.toLowerCase().includes(INTERNAL_ID));
  if (refs.length) return stripChars(refs[0]!, "<>");
  const irt = pyStrip(decodeUnstructured(getHeader(msg, "in-reply-to") ?? ""));
  if (irt && !irt.toLowerCase().includes(INTERNAL_ID)) return stripChars(irt, "<>");
  return stripChars(pyStrip(decodeUnstructured(getHeader(msg, "message-id") ?? "")), "<>");
}

/** The Message-ID the script records: `.strip().strip("<>")`. Also used on a
 *  header-only fetch, so it must not depend on anything but the header. */
export const messageIdOf = (msg: MimeEntity): string => stripChars(pyStrip(decodeUnstructured(getHeader(msg, "message-id") ?? "")), "<>");

// ── addresses (policy.default AddressHeader + getaddresses) ──────────────────

interface Addr {
  name: string;
  addr: string;
}
interface AddrItem {
  group: string | null;
  members: Addr[];
}

const SPECIALS = '()<>@,:;."[]';
const needsQuote = (s: string): boolean => [...s].some((c) => SPECIALS.includes(c));
const quoteString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

type Tok = { t: "word" | "quoted" | "angle" | "comma" | "colon" | "semi" | "ws"; v: string };

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t") {
      let j = i;
      while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
      toks.push({ t: "ws", v: s.slice(i, j) });
      i = j;
    } else if (c === "(") {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === "\\") {
          j++;
          continue;
        }
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      i = j + 1; // comments are dropped (CFWS)
      toks.push({ t: "ws", v: " " });
    } else if (c === '"') {
      let j = i + 1;
      let v = "";
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length) j++;
        v += s[j];
      }
      toks.push({ t: "quoted", v });
      i = j + 1;
    } else if (c === "<") {
      const j = s.indexOf(">", i);
      const end = j < 0 ? s.length : j;
      toks.push({ t: "angle", v: s.slice(i + 1, end).replace(/[ \t]+/g, "") });
      i = end + 1;
    } else if (c === ",") {
      toks.push({ t: "comma", v: c });
      i++;
    } else if (c === ":") {
      toks.push({ t: "colon", v: c });
      i++;
    } else if (c === ";") {
      toks.push({ t: "semi", v: c });
      i++;
    } else {
      let j = i;
      while (j < s.length && !' \t()"<,:;'.includes(s[j]!)) j++;
      toks.push({ t: "word", v: s.slice(i, j) });
      i = j;
    }
  }
  return toks;
}

/** A phrase's display name: unquoted whitespace collapses to one space, quoted
 *  text is kept verbatim, encoded words decoded in both. */
function phrase(toks: Tok[]): string {
  let out = "";
  for (const t of toks) {
    if (t.t === "ws") out += " ";
    else if (t.t === "quoted") out += decodeEwKeepWs(t.v);
    else if (t.t === "word") out += decodeEwKeepWs(t.v);
  }
  return out.replace(/^ +| +$/g, "");
}

function parseMailbox(toks: Tok[]): Addr | null {
  const angle = toks.findIndex((t) => t.t === "angle");
  if (angle >= 0) {
    const name = phrase(collapseWs(toks.slice(0, angle)));
    return { name, addr: toks[angle]!.v };
  }
  const addr = toks
    .filter((t) => t.t !== "ws")
    .map((t) => (t.t === "quoted" ? quoteString(t.v) : t.v))
    .join("");
  return addr ? { name: "", addr } : null;
}

function collapseWs(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const t of toks) {
    if (t.t === "ws" && out[out.length - 1]?.t === "ws") continue;
    out.push(t);
  }
  return out;
}

export function parseAddressList(raw: string): AddrItem[] {
  const toks = tokenize(raw);
  const items: AddrItem[] = [];
  let buf: Tok[] = [];
  let group: { name: string; members: Addr[] } | null = null;
  const flushAddr = () => {
    const a = parseMailbox(buf);
    buf = [];
    if (!a) return;
    if (group) group.members.push(a);
    else items.push({ group: null, members: [a] });
  };
  for (const t of toks) {
    if (t.t === "colon" && !group) {
      group = { name: phrase(collapseWs(buf)), members: [] };
      buf = [];
    } else if (t.t === "semi" && group) {
      flushAddr();
      items.push({ group: group.name, members: group.members });
      group = null;
    } else if (t.t === "comma") flushAddr();
    else buf.push(t);
  }
  flushAddr();
  if (group) items.push({ group: group.name, members: group.members });
  return items;
}

function renderAddr(a: Addr): string {
  const disp = needsQuote(a.name) ? quoteString(a.name) : a.name;
  if (disp) return `${disp} <${a.addr === "<>" ? "" : a.addr}>`;
  return a.addr;
}

/** `str(msg.get("From"))` under policy.default (then the script's `_decode`). */
export function renderAddressHeader(raw: string | null): string {
  if (raw === null) return "";
  const out = parseAddressList(raw).map((it) => {
    if (it.group === null) return renderAddr(it.members[0]!);
    const g = needsQuote(it.group) ? quoteString(it.group) : it.group;
    const members = it.members.map(renderAddr).join(", ");
    return `${g}:${members ? " " + members : ""};`;
  });
  return pyStrip(out.join(", "));
}

/** `[a for _, a in getaddresses([header]) if a]`. */
export function addresses(raw: string | null): string[] {
  if (raw === null) return [];
  return parseAddressList(raw)
    .flatMap((it) => it.members.map((m) => m.addr))
    .filter((a) => a && a !== "<>");
}

// ── dates ────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYNAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIMEZONES: Record<string, number> = {
  UT: 0, UTC: 0, GMT: 0, Z: 0, AST: -400, ADT: -300, EST: -500, EDT: -400, CST: -600, CDT: -500, MST: -700, MDT: -600, PST: -800, PDT: -700,
};
const pyInt = (s: string | number): number | null => {
  if (typeof s === "number") return s;
  const t = s.trim();
  return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null;
};

/** Python `email.utils.parsedate_to_datetime` (+ the script's naive→UTC rule) →
 *  epoch ms, or null where Python raises. */
export function parseDateMs(value: string | null): number | null {
  if (!value) return null;
  let data = pySplit(value);
  if (!data.length) return null;
  if (data[0]!.endsWith(",") || DAYNAMES.includes(data[0]!.toLowerCase())) data.shift();
  else {
    const i = data[0]!.lastIndexOf(",");
    if (i >= 0) data[0] = data[0]!.slice(i + 1);
  }
  if (data.length === 3) {
    const stuff = data[0]!.split("-");
    if (stuff.length === 3) data = [...stuff, ...data.slice(1)];
  }
  if (data.length === 4) {
    const s = data[3]!;
    let i = s.indexOf("+");
    if (i === -1) i = s.indexOf("-");
    if (i > 0) data = [...data.slice(0, 3), s.slice(0, i), s.slice(i)];
    else data.push("");
  }
  if (data.length < 5) return null;
  let [dd, mm, yy, tm, tz] = data.slice(0, 5) as [string, string, string, string, string];
  mm = mm.toLowerCase();
  if (!MONTHS.includes(mm)) {
    [dd, mm] = [mm, dd.toLowerCase()];
    if (!MONTHS.includes(mm)) return null;
  }
  let mon = MONTHS.indexOf(mm) + 1;
  if (mon > 12) mon -= 12;
  if (dd.endsWith(",")) dd = dd.slice(0, -1);
  if (yy.indexOf(":") > 0) [yy, tm] = [tm, yy];
  if (yy.endsWith(",")) yy = yy.slice(0, -1);
  if (!yy) return null; // Python: yy[0] → IndexError → the script falls back to "now"
  if (!/^\p{Nd}/u.test(yy)) [yy, tz] = [tz, yy];
  if (tm.endsWith(",")) tm = tm.slice(0, -1);
  let parts = tm.split(":");
  let thh: string, tmm: string, tss: string | number;
  if (parts.length === 2) [thh, tmm, tss] = [parts[0]!, parts[1]!, "0"];
  else if (parts.length === 3) [thh, tmm, tss] = parts as [string, string, string];
  else if (parts.length === 1 && parts[0]!.includes(".")) {
    parts = parts[0]!.split(".");
    if (parts.length === 2) [thh, tmm, tss] = [parts[0]!, parts[1]!, 0];
    else if (parts.length === 3) [thh, tmm, tss] = parts as [string, string, string];
    else return null;
  } else return null;
  const Y0 = pyInt(yy), D = pyInt(dd), H = pyInt(thh), Mi = pyInt(tmm), S = pyInt(tss);
  if (Y0 === null || D === null || H === null || Mi === null || S === null) return null;
  let Y = Y0;
  if (Y < 100) Y += Y > 68 ? 1900 : 2000;
  let off: number | null = null;
  const TZ = tz.toUpperCase();
  if (TZ in TIMEZONES) off = TIMEZONES[TZ]!;
  else {
    const n = pyInt(TZ);
    if (n !== null) off = n;
    if (off === 0 && TZ.startsWith("-")) off = null;
  }
  let offSec = 0;
  if (off) {
    const sign = off < 0 ? -1 : 1;
    const a = Math.abs(off);
    offSec = sign * (Math.floor(a / 100) * 3600 + (a % 100) * 60);
    if (Math.abs(offSec) >= 86_400) return null; // datetime.timezone refuses it
  }
  // datetime(...) validation
  if (Y < 1 || Y > 9999 || mon < 1 || mon > 12 || H < 0 || H > 23 || Mi < 0 || Mi > 59 || S < 0 || S > 59) return null;
  const dim = new Date(Date.UTC(Y, mon, 0)).getUTCDate();
  if (D < 1 || D > dim) return null;
  return Date.UTC(Y, mon - 1, D, H, Mi, S) - offSec * 1000;
}

/** `dt.astimezone().strftime('%Y-%m-%d %H:%M')` in `tz` (default: the process zone). */
export function formatLocal(ms: number, tz?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

// ── labels (derive_labels) ───────────────────────────────────────────────────

const BULK_HEADERS = ["List-Unsubscribe", "List-Id", "List-Post", "List-Help"];
const BULK_PRECEDENCE = pyRe("^\\s*(bulk|list|junk)\\s*$", "i");
const AUTO_HEADERS = ["X-Auto-Response-Suppress", "X-Autoreply", "X-Autorespond"];
const AUTO_SUBMITTED = pyRe("^\\s*auto-(generated|replied|notified)", "i");
const AUTO_PRECEDENCE = pyRe("^\\s*auto[_-]?reply\\s*$", "i");
const ESP_HEADERS = ["Feedback-ID", "Feedback-Id", "X-Mailgun-Tag", "X-SES-Outgoing", "X-Ses-Outgoing", "X-Campaign", "X-CSA-Complaints", "X-Complaints-To", "X-Entity-Ref-ID"];
const NOREPLY_LOCALPART = pyRe(
  "^(no[-_.]?reply|donotreply|do[-_.]?not[-_.]?reply|notifications?|alerts?|" +
    "mailer|mail|bounce\\w*|postmaster|automated|auto|system|admin|webmaster|" +
    "billing|invoice|invoices|receipts?|statements?|payments?|failed-payments|" +
    "support|service|help|updates?|news|newsletters?|marketing|deals|offers|" +
    "promo\\w*|sales|info|hello|team|welcome|drive-shares[-\\w]*|reaction|forum|" +
    "reply-[0-9a-f]{6,})\\b",
  "i",
);
const VIA_SENDER = pyRe("\\(via [^)]+\\)\\s*$", "i");
const BOUNCE_LOCALPART = pyRe("^(bounce\\w*|msprvs\\d*|prvs|return|reject)\\b", "i");
const SOCIAL_CATEGORY = pyRe(
  "(reaction|comment|follow|mention|subscription-notification|free-welcome|chat-thread|messages?-request|live-stream|recommendation)",
  "i",
);
const PROMO_CATEGORY = pyRe("(expiry|unfinished-subscription|upsell|promo|offer|winback)", "i");
const SOCIAL_DOMAIN = pyRe(
  "(^|\\.)(substack\\.com|linkedin\\.com|facebookmail\\.com|x\\.com|twitter\\.com|" +
    "instagram\\.com|redditmail\\.com|medium\\.com|mastodon\\.\\w+|meetup\\.com|" +
    "pinterest\\.com|quora\\.com|nextdoor\\.com|tiktok\\.com|youtube\\.com|" +
    "discourse\\.\\w+|hylo\\.com)$",
  "i",
);
const SOCIAL_SUBJECT = pyRe(
  "(\\bliked\\b|\\breacted to\\b|\\bfollowed you\\b|new follower|" +
    "mentioned you|new comment on|replied to your|new (free|paid) subscriber|" +
    "started following|viewed your profile|endorsed you|invited you to connect|" +
    "new message request|new thread from|is now following)",
  "i",
);
const CHAT_DOMAIN = pyRe(
  "(^|\\.)(slack\\.com|slack-mail\\.com|discord\\.com|discordapp\\.com|" +
    "teams\\.microsoft\\.com|chat\\.google\\.com|zulipchat\\.com|mattermost\\.com|" +
    "twist\\.com|flock\\.com|rocket\\.chat)$",
  "i",
);
const PROMO_LOCALPART = pyRe("^(deals?|promo\\w*|offers?|marketing|sales|store|shop|campaigns?)\\b", "i");
const PROMO_SUBDOMAIN = pyRe("^(mkt|marketing|promo\\w*|deals?|campaigns?|offers?)$", "i");
const TRANSACTIONAL_SUBJECT = pyRe(
  "(\\breceipt\\b|\\binvoice\\b|\\bpayment\\b|\\bpayout\\b|\\brefund\\b|\\bbilling\\b|" +
    "\\bcharged\\b|\\bunsuccessful\\b|\\bpast due\\b|\\boverdue\\b|" +
    "\\border\\s*(#|confirm|shipp|status)|\\bshipped\\b|\\bdelivery\\b|\\btracking number\\b|" +
    "\\bitinerary\\b|\\bbooking\\b|\\breservation\\b|\\bconfirmation (code|number)\\b|" +
    "\\bboarding pass\\b|\\bcheck[- ]?in\\b|\\bflight\\b)",
  "i",
);
const OPERATIONAL_SUBJECT = pyRe(
  "(\\bpassword\\b|\\bsign[- ]?in\\b|\\bsigned in\\b|\\blogin\\b|\\blog in\\b|" +
    "\\bsecurity\\b|\\bverif\\w+\\b|\\bauthentication\\b|\\bone[- ]time code\\b|" +
    "\\b2fa\\b|\\bpasskey\\b|\\baccount (is|was|has|access|suspend|clos|paus)|" +
    "\\bsuspend\\w*\\b|\\bpaused\\b|\\bexpir\\w+\\b|\\bdeadline\\b|\\bmaintenance\\b|" +
    "\\boutage\\b|\\bdelayed\\b|\\bcancel\\w*\\b|\\bdelet\\w+\\b|\\bmigrat\\w+\\b)",
  "i",
);
const CAT_RE = pyRe("cat-([\\w.-]+)");

/** `_sender_address`: (localpart, domain) of the first From address with an "@". */
export function senderAddress(msg: MimeEntity): [string, string] {
  const addr = addresses(getHeader(msg, "from") ?? "").find((a) => a.includes("@")) ?? "";
  const lower = addr.toLowerCase();
  const at = lower.indexOf("@");
  return at < 0 ? [lower, ""] : [lower.slice(0, at), lower.slice(at + 1)];
}

function espCategory(msg: MimeEntity): string {
  const tag = hdr(msg, "X-Mailgun-Tag");
  if (tag) return tag;
  const fb = hdr(msg, "Feedback-ID") || hdr(msg, "Feedback-Id");
  const m = CAT_RE.exec(fb);
  return m ? m[1]! : "";
}

export function deriveLabels(msg: MimeEntity, mailbox: string, isUnread: boolean): string[] {
  const labels = [mailbox.toUpperCase()];
  if (isUnread) labels.push("UNREAD");
  const subject = pyDecodeHeader(getHeader(msg, "subject"));
  const [local, domain] = senderAddress(msg);
  const category = espCategory(msg);
  const returnPath = stripChars(hdr(msg, "Return-Path"), "<>").toLowerCase();
  const at = returnPath.indexOf("@");
  const rpLocal = at < 0 ? returnPath : returnPath.slice(0, at);
  const rpDomain = at < 0 ? "" : returnPath.slice(at + 1);

  const bulk = BULK_HEADERS.some((h) => !!hdr(msg, h)) || BULK_PRECEDENCE.test(hdr(msg, "Precedence"));
  const automated = AUTO_SUBMITTED.test(hdr(msg, "Auto-Submitted")) || AUTO_PRECEDENCE.test(hdr(msg, "Precedence")) || AUTO_HEADERS.some((h) => !!hdr(msg, h));
  const esp = ESP_HEADERS.some((h) => !!hdr(msg, h));
  const verp = !!rpLocal && (rpLocal.includes("=") || BOUNCE_LOCALPART.test(rpLocal) || rpDomain.split(".").includes("bounce"));
  const machineSender = NOREPLY_LOCALPART.test(local) || VIA_SENDER.test(renderAddressHeader(getHeader(msg, "from"))) || verp;

  if (bulk) labels.push("BULK");
  if (automated) labels.push("AUTOMATED");
  const transactional = TRANSACTIONAL_SUBJECT.test(subject);
  if (transactional) labels.push("TRANSACTIONAL");
  const operational = transactional || OPERATIONAL_SUBJECT.test(subject);
  if (!operational && (CHAT_DOMAIN.test(domain) || CHAT_DOMAIN.test(rpDomain))) labels.push("CHAT");
  if (bulk && !operational) {
    const social = SOCIAL_CATEGORY.test(category) || (SOCIAL_DOMAIN.test(domain) && SOCIAL_SUBJECT.test(subject));
    if (social) labels.push("SOCIAL");
    else if (PROMO_CATEGORY.test(category) || PROMO_LOCALPART.test(local) || PROMO_SUBDOMAIN.test(domain.split(".")[0] ?? "")) labels.push("PROMOTIONS");
  }
  if (!(bulk || automated || esp || machineSender)) labels.push("DIRECT");
  return labels;
}

// ── the parsed message + the note the script writes ──────────────────────────

export interface ParsedMessage {
  uid: number;
  mailbox: string;
  labels: string[];
  subject: string;
  from: string;
  to: string;
  cc: string;
  messageId: string;
  threadId: string;
  /** epoch ms (the script's `date`, a tz-aware datetime). */
  dateMs: number;
  isUnread: boolean;
  isFlagged: boolean;
  body: string;
  attachments: string[];
}

/** Flags as imapflow reports them (a Set/array of `\Seen`-style strings). */
const hasFlag = (flags: Iterable<string>, f: string): boolean => [...flags].some((x) => x.toLowerCase() === f.toLowerCase());
export const isUnreadFlags = (flags: Iterable<string>): boolean => !hasFlag(flags, "\\Seen");

export function parseMessage(raw: Buffer, flags: Iterable<string>, mailbox: string, uid: number, now: number = Date.now()): ParsedMessage {
  const msg = parseMime(raw);
  const subject = pyDecodeHeader(getHeader(msg, "subject")) || "(no subject)";
  const from = pyDecodeHeader(renderAddressHeader(getHeader(msg, "from")));
  const to = addresses(getHeader(msg, "to")).join(", ");
  const cc = addresses(getHeader(msg, "cc")).join(", ");
  const messageId = messageIdOf(msg);
  const dateMs = parseDateMs(getHeader(msg, "date")) ?? now;
  const isUnread = isUnreadFlags(flags);
  return {
    uid,
    mailbox,
    labels: deriveLabels(msg, mailbox, isUnread),
    subject,
    from,
    to,
    cc,
    messageId: messageId || `${mailbox}-uid-${uid}`,
    threadId: threadRoot(msg) || `${mailbox}-uid-${uid}`,
    dateMs,
    isUnread,
    isFlagged: hasFlag(flags, "\\Flagged"),
    body: extractBody(msg),
    attachments: attachmentNames(msg),
  };
}

export function noteContent(m: ParsedMessage, tz?: string): string {
  const header = [`# ${m.subject}`, ""];
  header.push(`**From:** ${m.from}  `);
  if (m.to) header.push(`**To:** ${m.to}  `);
  if (m.cc) header.push(`**Cc:** ${m.cc}  `);
  header.push(`**Date:** ${formatLocal(m.dateMs, tz)}  `);
  if (m.attachments.length) header.push(`**Attachments:** ${m.attachments.join(", ")}  `);
  header.push("", "---", "", m.body);
  return header.join("\n");
}

/** parachute_writer.slugify: NFKD, drop combining marks, non-[A-Za-z0-9] runs → "-". */
export function slugify(value: string): string {
  if (!value) return "";
  const norm = value.normalize("NFKD").replace(/\p{Mn}/gu, "");
  return stripChars(norm.replace(/[^a-zA-Z0-9]+/g, "-"), "-").toLowerCase();
}

export function notePath(m: Pick<ParsedMessage, "subject" | "messageId">): string {
  const slug = slugify(m.subject).slice(0, 80) || "no-subject";
  const digest = crypto.createHash("sha256").update(m.messageId, "utf8").digest("hex").slice(0, 8);
  return `${NOTE_DIR}/${slug}-${digest}`;
}

/** The script's metadata dict, same key order. */
export function noteMetadata(m: ParsedMessage, account: string, tz?: string): Record<string, unknown> {
  return {
    type: "email",
    subject: m.subject,
    from: m.from,
    to: m.to,
    date: formatLocal(m.dateMs, tz),
    isUnread: m.isUnread,
    labels: m.labels.length ? m.labels : [m.mailbox.toUpperCase(), ...(m.isUnread ? ["UNREAD"] : [])],
    messageCount: 1,
    threadId: m.threadId,
    messageId: m.messageId,
    lastMessageAt: m.dateMs,
    source: SOURCE,
    account,
    mailbox: m.mailbox,
    uid: m.uid,
  };
}

/**
 * The flag refresh's label rule (cmd_sync): UNREAD is also carried in labels, so
 * both move together — drop every "UNREAD", then re-insert it at index 1 (after
 * the folder label) when unread.
 */
export function relabelUnread(labels: unknown, unread: boolean): unknown[] {
  const out: unknown[] = (Array.isArray(labels) ? labels : []).filter((l) => l !== "UNREAD");
  if (unread) out.splice(Math.min(1, out.length), 0, "UNREAD");
  return out;
}
