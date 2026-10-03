/**
 * Linear text helpers for import and export. Everything here runs over
 * UNTRUSTED text (an uploaded archive, any member's page), so there is no
 * regular expression with an unbounded quantifier over content: every scanner
 * is a single forward pass with `indexOf`, and a failed search for a closing
 * delimiter is remembered so the same tail is never rescanned (the
 * `[[[[[…` / `](](](` shapes that make naive link regexes quadratic).
 */

/** Notion appends a 32-hex id to every exported file and folder name. */
export function stripNotionId(name: string): string {
  if (name.length < 34 || name[name.length - 33] !== " ") return name;
  for (let i = name.length - 32; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const hex = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!hex) return name;
  }
  return name.slice(0, name.length - 33).trimEnd() || name;
}

export interface MarkdownLink {
  image: boolean;
  text: string;
  /** The destination as written (angle brackets and title removed). */
  target: string;
}

/**
 * Rewrite inline links and images: `fn` returns the replacement for the WHOLE
 * `[text](target)` / `![alt](target)` construct, or null to keep it. Fenced
 * code blocks and inline code spans are left alone; `[[wikilinks]]` are skipped.
 */
export function rewriteMarkdownLinks(md: string, fn: (link: MarkdownLink) => string | null): string {
  const out: string[] = [];
  let fence: string | null = null;
  let start = 0;
  const n = md.length;
  while (start <= n) {
    let end = md.indexOf("\n", start);
    if (end === -1) end = n;
    const line = md.slice(start, end);
    const lead = line.trimStart();
    if (fence) {
      if (lead.startsWith(fence)) fence = null;
      out.push(line);
    } else if (lead.startsWith("```") || lead.startsWith("~~~")) {
      fence = lead.slice(0, 3);
      out.push(line);
    } else {
      out.push(rewriteLine(line, fn));
    }
    if (end === n) break;
    out.push("\n");
    start = end + 1;
  }
  return out.join("");
}

function rewriteLine(line: string, fn: (link: MarkdownLink) => string | null): string {
  if (line.indexOf("](") === -1) return line;
  let out = "";
  let i = 0;
  let copied = 0;
  let noBracket = false;
  let noParen = false;
  let noTick = false;
  // Cached positions of the next `]` / `)`: a run of `[ [ [ …` reuses one search.
  let nextBracket = -2;
  let nextParen = -2;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`" && !noTick) {
      const close = line.indexOf("`", i + 1);
      if (close === -1) noTick = true;
      else {
        i = close + 1;
        continue;
      }
    }
    if (ch === "[" && !noBracket && !noParen) {
      if (line[i + 1] === "[") {
        // A wikilink: skip to its end (or the rest of the line).
        const close = line.indexOf("]]", i + 2);
        i = close === -1 ? line.length : close + 2;
        continue;
      }
      if (nextBracket <= i) nextBracket = line.indexOf("]", i + 1);
      const closeText = nextBracket;
      if (closeText === -1) {
        noBracket = true;
        i++;
        continue;
      }
      if (line[closeText + 1] !== "(") {
        i++;
        continue;
      }
      if (nextParen < closeText + 2) nextParen = line.indexOf(")", closeText + 2);
      const closeTarget = nextParen;
      if (closeTarget === -1) {
        noParen = true;
        i++;
        continue;
      }
      const image = i > 0 && line[i - 1] === "!";
      const text = line.slice(i + 1, closeText);
      const replacement = text.indexOf("[") === -1 ? fn({ image, text, target: cleanTarget(line.slice(closeText + 2, closeTarget)) }) : null;
      if (replacement !== null) {
        const from = image ? i - 1 : i;
        out += line.slice(copied, from) + replacement;
        copied = closeTarget + 1;
      }
      i = closeTarget + 1;
      continue;
    }
    i++;
  }
  return copied === 0 ? line : out + line.slice(copied);
}

/** `<a b.md> "title"` → `a b.md`; `a.md "title"` → `a.md`. */
function cleanTarget(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("<")) {
    const close = t.indexOf(">");
    return close === -1 ? t.slice(1) : t.slice(1, close);
  }
  const space = t.indexOf(" ");
  if (space !== -1) {
    const rest = t.slice(space + 1).trimStart();
    if (rest.startsWith('"') || rest.startsWith("'") || rest.startsWith("(")) t = t.slice(0, space);
  }
  return t;
}

/** Is this link target a relative file reference (not a URL, anchor or absolute path)? */
export function isRelativeTarget(target: string): boolean {
  if (!target || target.startsWith("#") || target.startsWith("/") || target.startsWith("\\")) return false;
  const colon = target.indexOf(":");
  if (colon !== -1) {
    const slash = target.indexOf("/");
    if (slash === -1 || colon < slash) return false; // a scheme (http:, mailto:, data:, javascript:)
  }
  return true;
}

/** Percent-decode without throwing on malformed input. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Resolve `target` (relative, already decoded) against the directory of `from`; null if it escapes the root. */
export function resolveRelative(fromFile: string, target: string): string | null {
  const hash = target.indexOf("#");
  const clean = (hash === -1 ? target : target.slice(0, hash)).split("\\").join("/");
  const q = clean.indexOf("?");
  const path = q === -1 ? clean : clean.slice(0, q);
  const parts = fromFile.split("/");
  parts.pop();
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

// ── front matter ─────────────────────────────────────────────────────────────

const FM_MAX = 64 * 1024;
const FM_MAX_KEYS = 200;
const KEY_OK = (k: string): boolean => {
  if (!k || k.length > 64) return false;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
    if (!ok) return false;
  }
  return true;
};

function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  const c = v[0]!;
  if (c === '"' || c === "[" || c === "{" || c === "-" || (c >= "0" && c <= "9") || v === "true" || v === "false" || v === "null") {
    try {
      return JSON.parse(v);
    } catch {
      /* not JSON: a plain YAML scalar */
    }
  }
  if (v.length >= 2 && c === "'" && v[v.length - 1] === "'") return v.slice(1, -1).split("''").join("'");
  return v;
}

/**
 * A leading `---` front-matter block: flat `key: value` lines (values are JSON
 * when they parse as JSON — what `renderFrontMatter` writes — else plain text)
 * and simple `- item` lists. Anything richer is ignored, never an error.
 */
export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const none = { data: {}, body: text };
  if (!text.startsWith("---")) return none;
  const firstBreak = text.indexOf("\n");
  if (firstBreak === -1 || text.slice(0, firstBreak).trim() !== "---") return none;
  const head = text.slice(0, FM_MAX);
  let end = -1;
  let pos = firstBreak + 1;
  while (pos < head.length) {
    let nl = head.indexOf("\n", pos);
    if (nl === -1) nl = head.length;
    const l = head.slice(pos, nl).trimEnd();
    if (l === "---" || l === "...") {
      end = pos;
      break;
    }
    pos = nl + 1;
  }
  if (end === -1) return none;
  const data: Record<string, unknown> = {};
  let listKey: string | null = null;
  let count = 0;
  for (const rawLine of text.slice(firstBreak + 1, end).split("\n")) {
    const l = rawLine.trimEnd();
    if (!l.trim() || l.trimStart().startsWith("#")) continue;
    if (listKey && l.trimStart().startsWith("- ")) {
      (data[listKey] as unknown[]).push(scalar(l.trimStart().slice(2)));
      continue;
    }
    listKey = null;
    if (l.startsWith(" ") || l.startsWith("\t")) continue; // nested YAML: not supported
    const colon = l.indexOf(":");
    if (colon <= 0) continue;
    const key = l.slice(0, colon).trim();
    if (!KEY_OK(key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (++count > FM_MAX_KEYS) break;
    const rest = l.slice(colon + 1);
    if (rest.trim() === "") {
      data[key] = [];
      listKey = key;
    } else data[key] = scalar(rest);
  }
  for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && v.length === 0 && k !== "tags") delete data[k];
  let bodyStart = text.indexOf("\n", end);
  bodyStart = bodyStart === -1 ? text.length : bodyStart + 1;
  let body = text.slice(bodyStart);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { data, body };
}

/**
 * Front matter for an exported page. Every value is JSON (a YAML flow scalar /
 * sequence / mapping), so no page value can break out of its line; keys that
 * are not plain identifiers are dropped.
 */
export function renderFrontMatter(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (!KEY_OK(k) || v === undefined) continue;
    let json: string;
    try {
      json = JSON.stringify(v);
    } catch {
      continue;
    }
    if (json === undefined) continue;
    lines.push(`${k}: ${json.split("\u2028").join("\\u2028").split("\u2029").join("\\u2029")}`);
  }
  return lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

/** The first `# Heading` when it is the first non-blank line: `{title, rest}`. */
export function leadingHeading(md: string): { title: string; rest: string } | null {
  let pos = 0;
  while (pos < md.length) {
    let nl = md.indexOf("\n", pos);
    if (nl === -1) nl = md.length;
    const line = md.slice(pos, nl).trim();
    if (line === "") {
      pos = nl + 1;
      continue;
    }
    if (!line.startsWith("# ")) return null;
    return { title: line.slice(2).trim(), rest: md.slice(Math.min(nl + 1, md.length)) };
  }
  return null;
}

// ── file names ───────────────────────────────────────────────────────────────

const RESERVED = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

/** One safe file/folder name for an archive member (never empty, never `.`/`..`). */
export function safeFileSegment(raw: string, max = 120): string {
  let out = "";
  for (const ch of raw.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) continue;
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f) continue;
    out += '\\/:*?"<>|'.includes(ch) ? "_" : ch;
  }
  out = out.trim();
  while (out.endsWith(".")) out = out.slice(0, -1).trimEnd();
  while (out.startsWith(".")) out = out.slice(1);
  if ([...out].length > max) out = [...out].slice(0, max).join("").trimEnd();
  if (!out) out = "Untitled";
  if (RESERVED.has(out.toLowerCase())) out = `_${out}`;
  return out;
}

/** One clean vault page-path segment from an imported name. */
export function safePageSegment(raw: string, max = 120): string {
  let out = "";
  for (const ch of raw.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) continue;
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f) continue;
    out += ch === "/" || ch === "\\" ? "-" : ch;
  }
  out = out.trim();
  while (out.startsWith(".")) out = out.slice(1).trimStart();
  // The vault strips a trailing `.md` from a path: do it here so the planned path IS the stored one.
  while (out.toLowerCase().endsWith(".md")) out = out.slice(0, -3).trimEnd();
  if ([...out].length > max) out = [...out].slice(0, max).join("").trimEnd();
  return out || "Untitled";
}

/** Every `/api/attachments/a_<22>` id in `content`, in order, de-duplicated (linear). */
export function attachmentIdsIn(content: string): string[] {
  const NEEDLE = "/api/attachments/a_";
  const ids: string[] = [];
  let from = 0;
  for (;;) {
    const at = content.indexOf(NEEDLE, from);
    if (at === -1) break;
    const start = at + NEEDLE.length - 2;
    const id = content.slice(start, start + 24);
    from = at + NEEDLE.length;
    if (id.length !== 24) continue;
    let ok = true;
    for (let i = 2; i < 24; i++) {
      const c = id.charCodeAt(i);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45)) {
        ok = false;
        break;
      }
    }
    // The id must END there (not a longer token).
    const after = content.charCodeAt(start + 24);
    const more = (after >= 48 && after <= 57) || (after >= 65 && after <= 90) || (after >= 97 && after <= 122) || after === 95 || after === 45;
    if (ok && !more && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Replace every occurrence of each key with its value (linear per key; keys are short literal URLs). */
export function replaceAllLiteral(content: string, map: ReadonlyMap<string, string>): string {
  let out = content;
  for (const [from, to] of map) if (from && out.indexOf(from) !== -1) out = out.split(from).join(to);
  return out;
}
