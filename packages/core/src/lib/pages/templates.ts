/**
 * Template variables (NP-TX-02).
 *
 * A template may contain `@today`, `@now` and `@me` (alias `@creator`). They are
 * resolved ONCE, when a page is created from the template — the new page holds
 * the concrete date / name, exactly like Notion's "@Today when duplicated".
 *
 *  - In the BODY: an HTML body gets a date chip for `@today` / `@now` (the
 *    editor's `mention` node, kind `date`) and the creator's name as text; a
 *    Markdown body gets plain text. Tokens inside tags/attributes, code
 *    (`<code>`, `<pre>`, Markdown fences and inline code) and wikilinks are left
 *    alone, and a token must stand on its own (`a@today` in an e-mail address is
 *    not one).
 *  - In PROPERTIES: a string value that is exactly a token becomes the value a
 *    property of that kind stores — `@today` → `YYYY-MM-DD`, `@now` → an ISO
 *    timestamp, `@me` → the creator's name.
 *
 * Pure and linear (a single pass; no regular expression over template text).
 */
export interface TemplateContext {
  /** The moment of creation. */
  now: Date;
  /** Who is creating the page (display name, else e-mail); omitted → `@me` stays as written. */
  creator?: string | null;
  /** Random id for a new chip (injected for deterministic tests). */
  uid?: () => string;
}

export const TEMPLATE_VARIABLES = ["@today", "@now", "@me"] as const;

const pad = (n: number) => String(n).padStart(2, "0");
/** The creator's LOCAL calendar day, `YYYY-MM-DD`. */
export const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const longDay = (d: Date): string => d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
const longMoment = (d: Date): string => `${longDay(d)} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
const escapeHtml = (s: string): string => s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");
const defaultUid = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID().replace(/-/g, "").slice(0, 16) : Math.random().toString(36).slice(2, 18);
};

type Token = "today" | "now" | "me";
const NAMES: Array<[string, Token]> = [["today", "today"], ["now", "now"], ["me", "me"], ["creator", "me"]];
const isWord = (code: number): boolean => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code > 127;

/** The token starting at `text[at] === "@"`, or null. */
function tokenAt(text: string, at: number): { token: Token; length: number } | null {
  if (at > 0) {
    const before = text.charCodeAt(at - 1);
    if (isWord(before) || before === 64 /* @ */ || before === 46 /* . */) return null;
  }
  for (const [name, token] of NAMES) {
    if (text.length < at + 1 + name.length) continue;
    if (text.slice(at + 1, at + 1 + name.length).toLowerCase() !== name) continue;
    const after = text.charCodeAt(at + 1 + name.length);
    // Must end the word; and `@me.com` / `@now@x` are not tokens.
    if (!Number.isNaN(after) && (isWord(after) || after === 64 || after === 45)) continue;
    if (after === 46 && isWord(text.charCodeAt(at + 2 + name.length))) continue;
    return { token, length: name.length + 1 };
  }
  return null;
}

function replacement(token: Token, ctx: TemplateContext, html: boolean): string | null {
  if (token === "me") {
    const who = ctx.creator?.trim();
    return who ? (html ? escapeHtml(who) : who) : null;
  }
  if (!html) return token === "today" ? longDay(ctx.now) : longMoment(ctx.now);
  // The editor's date chip (lib/tiptap/MentionNode.ts): a day for @today, the instant for @now.
  const date = token === "today" ? localDay(ctx.now) : ctx.now.toISOString();
  const uid = (ctx.uid ?? defaultUid)();
  return `<span data-type="mention" data-kind="date" data-date="${date}" data-mention-uid="${escapeHtml(uid)}">@${date.slice(0, 10)}</span>`;
}

/** Replace tokens in one run of plain text (no markup). */
function resolveText(text: string, ctx: TemplateContext, html: boolean): string {
  let at = text.indexOf("@");
  if (at === -1) return text;
  let out = "";
  let copied = 0;
  while (at !== -1) {
    const hit = tokenAt(text, at);
    const value = hit ? replacement(hit.token, ctx, html) : null;
    if (hit && value !== null) {
      out += text.slice(copied, at) + value;
      copied = at + hit.length;
      at = text.indexOf("@", copied);
    } else at = text.indexOf("@", at + 1);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

const looksLikeHtml = (s: string): boolean => {
  const t = s.trimStart();
  if (t.length < 3 || t[0] !== "<") return false;
  const c = t.charCodeAt(1) | 0x20;
  return c >= 97 && c <= 122;
};

function resolveHtml(html: string, ctx: TemplateContext): string {
  let out = "";
  let i = 0;
  let skipUntil: string | null = null; // inside <code>/<pre>: the closing tag to wait for
  let inMention = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const text = html.slice(i, lt === -1 ? html.length : lt);
    out += skipUntil || inMention ? text : resolveText(text, ctx, true);
    if (lt === -1) break;
    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      out += html.slice(lt);
      break;
    }
    const tag = html.slice(lt, gt + 1);
    out += tag;
    i = gt + 1;
    const lower = tag.slice(0, 12).toLowerCase();
    if (skipUntil) {
      if (lower.startsWith(skipUntil)) skipUntil = null;
    } else if (lower.startsWith("<code") || lower.startsWith("<pre")) {
      skipUntil = lower.startsWith("<code") ? "</code" : "</pre";
    } else if (lower.startsWith("<span") && tag.includes('data-type="mention"')) {
      inMention = 1; // an existing chip's own text (`@2026-10-03`) is not a token
    } else if (inMention && lower.startsWith("</span")) {
      inMention = 0;
    }
  }
  return out;
}

function resolveMarkdown(md: string, ctx: TemplateContext): string {
  const lines = md.split("\n");
  let fence: string | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const lead = line.trimStart();
    if (fence) {
      if (lead.startsWith(fence)) fence = null;
      continue;
    }
    if (lead.startsWith("```") || lead.startsWith("~~~")) {
      fence = lead.slice(0, 3);
      continue;
    }
    if (line.indexOf("@") === -1) continue;
    // Split on inline code spans and wikilinks; resolve only the text between them.
    let out = "";
    let i = 0;
    while (i < line.length) {
      const tick = line.indexOf("`", i);
      const wiki = line.indexOf("[[", i);
      const next = tick === -1 ? wiki : wiki === -1 ? tick : Math.min(tick, wiki);
      if (next === -1) {
        out += resolveText(line.slice(i), ctx, false);
        break;
      }
      out += resolveText(line.slice(i, next), ctx, false);
      const close = next === tick ? line.indexOf("`", next + 1) : line.indexOf("]]", next + 2);
      const end = close === -1 ? line.length : close + (next === tick ? 1 : 2);
      out += line.slice(next, end);
      i = end;
    }
    lines[n] = out;
  }
  return lines.join("\n");
}

/** A template body with its variables resolved for this creation. */
export function resolveTemplateContent(content: string, ctx: TemplateContext): string {
  if (!content || content.indexOf("@") === -1) return content;
  return looksLikeHtml(content) ? resolveHtml(content, ctx) : resolveMarkdown(content, ctx);
}

/** Property values that are exactly a variable (top level and inside string arrays). */
export function resolveTemplateMetadata(metadata: Record<string, unknown>, ctx: TemplateContext): Record<string, unknown> {
  const one = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    const t = v.trim().toLowerCase();
    if (t === "@today") return localDay(ctx.now);
    if (t === "@now") return ctx.now.toISOString();
    if ((t === "@me" || t === "@creator") && ctx.creator?.trim()) return ctx.creator.trim();
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) out[k] = Array.isArray(v) ? v.map(one) : one(v);
  return out;
}

/** Apply both to a template copy (`templateCopy` in ./model.ts). The title is the user's own and is not touched. */
export function applyTemplateVariables<T extends { content: string; metadata: Record<string, unknown> }>(copy: T, ctx: TemplateContext): T {
  const title = copy.metadata.title;
  const metadata = resolveTemplateMetadata(copy.metadata, ctx);
  if (title !== undefined) metadata.title = title;
  return { ...copy, content: resolveTemplateContent(copy.content, ctx), metadata };
}

/**
 * Who is creating the page, for `@me`: the signed-in account's DISPLAY NAME from
 * the Prism Server, else the neutral "Me" — never the account's e-mail address
 * (a page made from a template is usually shared). null in shells without a
 * server (the variable then stays as written).
 */
export async function templateCreator(fetchMe: () => Promise<Response>): Promise<string | null> {
  try {
    const res = await fetchMe();
    if (!res.ok) return null;
    const me = (await res.json()) as { name?: unknown; email?: unknown; authenticated?: unknown };
    const name = typeof me.name === "string" ? me.name.trim() : "";
    // An account whose "name" is its address has no display name.
    if (name && !name.includes("@")) return name.slice(0, 120);
    return me.authenticated === false ? null : "Me";
  } catch {
    return null;
  }
}
