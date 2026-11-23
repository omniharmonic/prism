// The display name of a person note — ONE derivation for every place that shows a person
// (Comms titles, people pages, recipients, the tidy list and its person picker, previews).
//
// Order: metadata.name → the body's first heading → the path's last segment (prettified).
// metadata.title is NEVER a name: this vault keeps job titles there ("CEO"; identity.ts personKeys). Each candidate is cleaned (HTML tags and markdown removed, entities decoded,
// whitespace collapsed, length-capped) and skipped when nothing usable is left, so a raw
// "<h1>Josie Siegel</h1><h2>Context</h2><p>…" never reaches a screen: it reads "Josie Siegel".
//
// The body is often not loaded (lean listings): the vault's `displayTitle` — derived from the
// body, HTML included — stands in for it and goes through the same heading extraction.
// Pure, dependency-free, never throws.

export const PERSON_NAME_MAX = 100;
/** Only the start of a body is looked at (a heading is at the top). */
const HEAD_SCAN = 8192;

export type PersonNameSource = "name" | "heading" | "path" | "none";

export interface PersonNameInput {
  metadata?: Record<string, unknown> | null;
  content?: string | null;
  displayTitle?: string | null;
  path?: string | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", aacute: "á", agrave: "à", acirc: "â", auml: "ä", aring: "å", atilde: "ã",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", oacute: "ó", ograve: "ò", ocirc: "ô", ouml: "ö", otilde: "õ", oslash: "ø",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", ntilde: "ñ", ccedil: "ç", szlig: "ß", yacute: "ý", yuml: "ÿ",
  Eacute: "É", Aacute: "Á", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Ouml: "Ö", Uuml: "Ü", Auml: "Ä", Ccedil: "Ç",
};

/** `&amp;` `&#233;` `&#xE9;` `&eacute;` → their characters (unknown named entities are kept). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const HAS_TAG = /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/i;
const BLOCK_END = /<\/(p|h[1-6]|div|li|ul|ol|blockquote|pre|table|tr|section|article|header)\s*>|<br\s*\/?>/i;

/** Tags removed (a block boundary becomes a space), markdown inline syntax removed, entities decoded. */
export function stripMarkup(raw: string): string {
  let s = String(raw).slice(0, HEAD_SCAN);
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/gi, " ");
  s = s.replace(/<[a-z/!][^<>]*$/i, " "); // a cut-off tag at the end ("<p class=…")
  s = decodeEntities(s);
  s = s.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, ""); // a markdown heading marker
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // image → alt
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, (_, t: string) => t.split("/").pop() ?? t);
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // [text](url) → text
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s).,!?;:])/g, "$1$2");
  s = s.replace(/~~(.+?)~~/g, "$1").replace(/`([^`]*)`/g, "$1");
  s = s.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, ""); // a list / quote marker
  return s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
}

/** Trimmed and capped at PERSON_NAME_MAX characters (at a word boundary when one is near). */
export function capName(s: string): string {
  const chars = Array.from(s.trim());
  if (chars.length <= PERSON_NAME_MAX) return s.trim();
  const cut = chars.slice(0, PERSON_NAME_MAX - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > PERSON_NAME_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A field value as a usable name, or null (not a string, or nothing left after cleaning). */
export function cleanPersonName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = stripMarkup(raw);
  return s && /[\p{L}\p{N}]/u.test(s) ? capName(s) : null;
}

/**
 * The text of a body's first heading. HTML: the first `<h1>`…`<h6>`, else the first block's
 * text. Markdown: the first `#` heading among the first 40 lines, else (only when `firstLine`)
 * the first non-empty line — the vault's displayTitle is already that line.
 */
export function headingText(raw: string | null | undefined, firstLine = false): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const body = raw.slice(0, HEAD_SCAN); // bounded: never a scan of a whole note body
  if (HAS_TAG.test(body)) {
    const h = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1\s*>/i.exec(body);
    if (h) return cleanPersonName(h[2]!);
    if (!firstLine) return null;
    const end = BLOCK_END.exec(body);
    return cleanPersonName(end ? body.slice(0, end.index) : body);
  }
  const lines = body.split(/\r?\n/).slice(0, 40);
  for (const line of lines) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return cleanPersonName(m[1]!);
  }
  if (!firstLine) return null;
  const first = lines.find((l) => l.trim());
  return first ? cleanPersonName(first) : null;
}

/** `vault/people/josie-siegel-2.md` → "Josie Siegel". */
export function prettyPathName(path: string | null | undefined): string | null {
  const leaf = (path ?? "").split("/").pop() ?? "";
  let s = decodeURIComponent(leaf.replace(/%(?![0-9a-f]{2})/gi, "%25")).replace(/\.(md|markdown)$/i, "");
  s = s.replace(/[-_ ]\d{1,2}$/, ""); // a path disambiguator ("-2")
  s = s.replace(/[_]+/g, " ");
  if (!/\s/.test(s)) s = s.replace(/-+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s && s === s.toLowerCase() && /[a-z]/.test(s)) s = s.replace(/(^|\s)(\p{Ll})/gu, (_, sp: string, c: string) => sp + c.toUpperCase());
  return cleanPersonName(s);
}

/** The display name and where it came from. */
export function derivePersonName(n: PersonNameInput): { name: string; source: PersonNameSource } {
  const m = (n.metadata ?? {}) as Record<string, unknown>;
  const name = cleanPersonName(m.name);
  if (name) return { name, source: "name" };
  const heading = headingText(n.content) ?? headingText(n.displayTitle, true);
  if (heading) return { name: heading, source: "heading" };
  const fromPath = prettyPathName(n.path);
  if (fromPath) return { name: fromPath, source: "path" };
  return { name: "", source: "none" };
}

/** The display name of a person note ("" only when the note offers nothing at all). */
export function personName(n: PersonNameInput): string {
  return derivePersonName(n).name;
}

/** A note's heading as a name (the body, else the vault's displayTitle): what name matching keys on. */
export function headingName(n: Pick<PersonNameInput, "content" | "displayTitle">): string | null {
  return headingText(n.content) ?? headingText(n.displayTitle, true);
}

const HAS_MARKUP = /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>|&(#x?[0-9a-f]+|[a-z]+);|^\s{0,3}#{1,6}\s|\*\*|__|\[\[/i;

export type PersonNameProblem = "no-name-field" | "markup-in-field" | "markup-in-display" | "no-name-at-all";

/** Emoji, pictographs, symbols and joiners removed; separators left at the ends trimmed
 *  ("Robin Cook 🛡️" → "Robin Cook", "Razvan- ZER8🧠" → "Razvan- ZER8"). */
export function stripDecorations(raw: string): string {
  return raw
    .replace(/[\p{Extended_Pictographic}\p{So}\p{Sk}\u200d\ufe0e\ufe0f\u20e3]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, (m) => (/[.'’]$/.test(m) && m.trim().length === 1 ? m : ""))
    .trim();
}

/** Two spellings of one name compare equal: case, diacritics, punctuation, emoji and spacing dropped. */
export function exactNameKey(raw: string): string {
  return stripDecorations(raw).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Curly quotes / apostrophes → ASCII (so "Joe’s" is "Joe's" for every rule). */
export const straightQuotes = (s: string): string => s.replace(/[\u2018\u2019\u02bc\u2032]/g, "'").replace(/[\u201c\u201d]/g, '"');

/** Business / trade words: such a name is an organisation, never a person (shared with tidy-batch). */
export const BUSINESS_WORDS = /(\b\w+'s\b|&|\+|\b(inc|llc|ltd|gmbh|plc|corp|co|company|shop|store|pizza|pizzeria|restaurant|diner|cafe|café|coffee|bar|pub|grill|bakery|deli|bank|clinic|dental|dentist|doctors|medical|pharmacy|salon|spa|barber|hotel|motel|airline|service|services|group|team|office|delivery|taxi|cab|uber|lyft|studio|agency|school|academy|church|club|center|centre|repair|repairs|plumber|plumbing|electric|electrician|construction|roofing|landscaping|cleaning|cleaners|movers|auto|garage|motors|florist|realty|realtor|insurance|law|legal|attorneys|consulting|solutions|labs|systems|support|dispatch|reception|front desk|dao|foundation|protocol|network|collective|capital|ventures|fund|finance|coop|cooperative|association|society|institute|university|community|alliance|guild|project|official|hq)\b)/i;

/** Section words and job titles: a heading like this is not a person's name. */
const LABEL_WORDS = new Set(["context", "notes", "note", "about", "background", "summary", "overview", "bio", "biography", "profile", "contact", "contacts",
  "details", "info", "information", "history", "timeline", "meeting", "meetings", "call", "calls", "todo", "tasks", "links", "people", "person", "untitled",
  "ceo", "cto", "cfo", "coo", "cmo", "founder", "cofounder", "co-founder", "director", "manager", "president", "partner", "advisor", "investor", "engineer",
  "the", "and", "with", "from", "for", "our", "my", "re", "fwd", "intro", "introduction", "follow-up", "followup"]);

/**
 * Does a heading / path name look like a PERSON's name? 2–5 words, each a word of letters (an
 * initial like "J." counts as a word but at least two words have ≥ 2 letters), no digits, no
 * sentence punctuation, no section label / job title / business word.
 */
export function looksLikePersonName(raw: string): boolean {
  const s = straightQuotes(raw).replace(/\s+/g, " ").trim();
  if (!s || /[\d,;:!?()[\]{}"/\\|@#*_<>=~`]/.test(s) || BUSINESS_WORDS.test(s)) return false;
  const words = s.split(" ");
  if (words.length < 2 || words.length > 5) return false;
  if (!words.every((w) => /^[\p{L}][\p{L}'.-]*$/u.test(w))) return false;
  if (words.some((w) => LABEL_WORDS.has(w.toLowerCase().replace(/\.$/, "")))) return false;
  if (words.some((w) => /\.$/.test(w) && w.replace(/\.$/, "").length > 3)) return false; // a sentence's full stop
  return words.filter((w) => w.replace(/[.'-]/g, "").length >= 2).length >= 2;
}

/**
 * What is wrong with a person note's name (scripts/people-names.ts), and the `metadata.name` a repair
 * would write: only when the note has NO name at all, from a REAL heading of its body (markdown `#`
 * or HTML `<h1>`–`<h6>`; never the vault's displayTitle / a first line) or else its path, and only
 * when that looks like a person's name (`looksLikePersonName`). Never into `metadata.title` (job
 * titles). null = nothing to repair. Pass the note WITH its body for a heading to count.
 */
export function assessPersonName(n: PersonNameInput): { problems: PersonNameProblem[]; repairName: string | null } {
  const m = (n.metadata ?? {}) as Record<string, unknown>;
  const problems: PersonNameProblem[] = [];
  const rawName = typeof m.name === "string" ? m.name : "";
  if (rawName.trim() && HAS_MARKUP.test(rawName)) problems.push("markup-in-field");
  const absent = !rawName.trim();
  if (!cleanPersonName(m.name)) problems.push("no-name-field");
  if (typeof n.displayTitle === "string" && HAS_TAG.test(n.displayTitle)) problems.push("markup-in-display");
  if (derivePersonName(n).source === "none") problems.push("no-name-at-all");
  if (!absent) return { problems, repairName: null };
  const heading = headingText(n.content); // a real heading only (no first-line fallback)
  const candidate = [heading, prettyPathName(n.path)].find((c): c is string => !!c && looksLikePersonName(c));
  return { problems, repairName: candidate ? straightQuotes(candidate) : null };
}
