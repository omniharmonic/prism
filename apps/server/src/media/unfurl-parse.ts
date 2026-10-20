/**
 * Link-preview extraction for `/api/unfurl` (bookmark blocks). A BOUNDED,
 * LINEAR, regex-free scan of the first 256 KB (or up to `</head>`) of an HTML
 * page: <title>, the og:/twitter:/description metas and the first icon link.
 * Nothing is executed, nothing else is fetched. Every cursor only moves
 * forward and every search remembers a miss, so pathological input (a megabyte
 * of `<`, unterminated quotes, endless `<title>`) stays O(n) — the CLAUDE.md
 * ReDoS rule for untrusted markup.
 */

export interface UnfurlMeta {
  title: string | null;
  description: string | null;
  siteName: string | null;
  image: string | null;
  favicon: string | null;
}

export const SCAN_LIMIT = 256 * 1024;
const TAG_LIMIT = 4096;
/** Title/meta values are cut to this many chars BEFORE entity decoding. */
const VALUE_LIMIT = 4096;

const isLetter = (c: string | undefined): boolean => !!c && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Decode the common HTML entities (named subset + decimal/hex numeric). */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf("&", i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    // Bounded lookahead: an entity is at most ~10 chars. An unbounded indexOf(";")
    // per "&" made a run of 250k "&" quadratic (2.3 s).
    let semi = -1;
    for (let k = amp + 1, end = Math.min(s.length, amp + 11); k < end; k++) {
      const ch = s[k];
      if (ch === ";") { semi = k; break; }
      if (ch === "&" || ch === "<" || ch === " ") break;
    }
    if (semi > amp) {
      const body = s.slice(amp + 1, semi);
      let rep: string | null = null;
      if (body[0] === "#") {
        const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) rep = String.fromCodePoint(n);
      } else if (Object.prototype.hasOwnProperty.call(NAMED, body.toLowerCase())) {
        rep = NAMED[body.toLowerCase()]!;
      }
      if (rep !== null) {
        out += rep;
        i = semi + 1;
        continue;
      }
    }
    out += "&";
    i = amp + 1;
  }
  return out;
}

/** Collapse whitespace, strip control characters, cap length (by code point). */
export function clean(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  // A few KB is far more than any cap below needs; never decode an unbounded value.
  if (s.length > VALUE_LIMIT) s = s.slice(0, VALUE_LIMIT);
  let out = "";
  let space = false;
  for (const ch of decodeEntities(s)) {
    const cp = ch.codePointAt(0)!;
    if (isSpace(ch) || cp === 0xa0) {
      space = out.length > 0;
      continue;
    }
    if (cp < 0x20 || cp === 0x7f) continue;
    if (space) out += " ";
    space = false;
    out += ch;
  }
  if (!out) return null;
  const cps = [...out];
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : out;
}

/** Absolute http(s) URL relative to `base`, ≤ 2048 chars, else null. */
export function absoluteUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw || raw.length > VALUE_LIMIT) return null;
  const v = decodeEntities(raw).trim();
  if (!v || v.length > 2048) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.href.length <= 2048 ? u.href : null;
  } catch {
    return null;
  }
}

interface Tag {
  name: string;
  attrs: Map<string, string>;
  /** Index just past the scanned tag (always > start). */
  end: number;
}

/** Scan one tag starting at `<` (s[i] === "<", s[i+1] is a letter). Stops at `>`, a stray `<`, or TAG_LIMIT. */
function scanTag(s: string, i: number): Tag {
  let j = i + 1;
  let name = "";
  while (j < s.length && (isLetter(s[j]) || (s[j]! >= "0" && s[j]! <= "9") || s[j] === "-" || s[j] === ":")) name += s[j++]!.toLowerCase();
  const attrs = new Map<string, string>();
  const limit = Math.min(s.length, i + TAG_LIMIT);
  while (j < limit) {
    while (j < limit && (isSpace(s[j]) || s[j] === "/")) j++;
    if (j >= limit) break;
    const c = s[j]!;
    if (c === ">") return { name, attrs, end: j + 1 };
    if (c === "<") return { name, attrs, end: j };
    let key = "";
    while (j < limit && !isSpace(s[j]) && s[j] !== "=" && s[j] !== ">" && s[j] !== "<" && s[j] !== "/") key += s[j++]!.toLowerCase();
    if (!key) {
      j++;
      continue;
    }
    while (j < limit && isSpace(s[j])) j++;
    let value = "";
    if (s[j] === "=") {
      j++;
      while (j < limit && isSpace(s[j])) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        j++;
        const start = j;
        while (j < limit && s[j] !== q) j++;
        value = s.slice(start, j);
        if (j < limit) j++;
      } else {
        const start = j;
        while (j < limit && !isSpace(s[j]) && s[j] !== ">" && s[j] !== "<") j++;
        value = s.slice(start, j);
      }
    }
    if (!attrs.has(key)) attrs.set(key, value);
  }
  return { name, attrs, end: Math.max(j, i + 1) };
}

/** Extract preview fields from `html` fetched from `finalUrl`. */
export function parseUnfurl(html: string, finalUrl: string): UnfurlMeta {
  let s = html.length > SCAN_LIMIT ? html.slice(0, SCAN_LIMIT) : html;
  const lower = s.toLowerCase();
  const headEnd = lower.indexOf("</head");
  if (headEnd >= 0) s = s.slice(0, headEnd);

  const metas = new Map<string, string>();
  let title: string | null = null;
  let icon: string | null = null;
  let titleCloseMissing = false;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    const next = s[lt + 1];
    if (next === "!" || next === "?") {
      // Comment / doctype: skip to the end marker once (a miss ends the scan).
      const close = next === "!" && s.startsWith("<!--", lt) ? s.indexOf("-->", lt + 4) : s.indexOf(">", lt + 2);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    if (!isLetter(next)) {
      i = lt + 1;
      continue;
    }
    const tag = scanTag(s, lt);
    i = tag.end;
    if (tag.name === "meta") {
      const key = (tag.attrs.get("property") ?? tag.attrs.get("name") ?? "").trim().toLowerCase();
      const content = tag.attrs.get("content");
      if (key && content !== undefined && !metas.has(key)) metas.set(key, content);
    } else if (tag.name === "link" && icon === null) {
      const rel = ` ${(tag.attrs.get("rel") ?? "").toLowerCase()} `;
      const href = tag.attrs.get("href");
      if (href && (rel.includes(" icon ") || rel.includes(" shortcut ") || rel.includes(" apple-touch-icon "))) icon = href;
    } else if (tag.name === "title" && title === null && !titleCloseMissing) {
      const close = lower.indexOf("</title", i);
      if (close < 0 || close > s.length) {
        titleCloseMissing = true;
      } else {
        title = s.slice(i, Math.min(close, i + VALUE_LIMIT));
        i = close;
      }
    }
  }

  const first = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = metas.get(k);
      if (v && v.trim()) return v;
    }
    return null;
  };
  return {
    title: clean(first("og:title", "twitter:title") ?? title, 300),
    description: clean(first("og:description", "twitter:description", "description"), 600),
    siteName: clean(first("og:site_name", "application-name"), 120),
    image: absoluteUrl(first("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"), finalUrl),
    favicon: absoluteUrl(icon, finalUrl),
  };
}
