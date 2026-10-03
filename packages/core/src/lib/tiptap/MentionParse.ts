/**
 * Pure mention extraction (no DOM, no TipTap) — shared by the Prism Server
 * (diff on store → notifications, backlinks) and the client.
 *
 * Reads `<span data-type="mention" …>` opening tags out of stored HTML. Bounded:
 * at most MAX_MENTIONS chips per document and attribute values are length-capped
 * (the same caps the schema's parseHTML applies). Linear scan, no backtracking
 * regex over document text.
 */
import type { MentionKind } from "./MentionNode";

export interface ParsedMention {
  kind: MentionKind;
  id: string | null;
  label: string | null;
  date: string | null;
  reminder: string | null;
  uid: string | null;
}

export const MAX_MENTIONS = 500;
/** Prism note ids / person ids: the gateway's strict id shape. */
export const MENTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const OPEN = "<span";
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function decode(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function extractMentions(html: string | null | undefined): ParsedMention[] {
  const out: ParsedMention[] = [];
  if (!html || html.indexOf("data-type=\"mention\"") < 0) return out;
  let i = 0;
  while (out.length < MAX_MENTIONS) {
    const at = html.indexOf(OPEN, i);
    if (at < 0) break;
    const end = html.indexOf(">", at);
    if (end < 0) break;
    i = end + 1;
    const tag = html.slice(at + OPEN.length, end);
    if (tag.length > 2000 || tag.indexOf("mention") < 0) continue;
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR.exec(tag))) attrs[m[1]!.toLowerCase()] = decode(m[3] ?? m[4] ?? "");
    if (attrs["data-type"] !== "mention") continue;
    const kind = attrs["data-kind"];
    const k: MentionKind = kind === "person" || kind === "date" ? kind : "page";
    const cap = (v: string | undefined, max: number) => (v && v.length <= max ? v : null);
    const id = cap(attrs["data-id"], 128);
    out.push({
      kind: k,
      id: id && MENTION_ID.test(id) ? id : null,
      label: cap(attrs["data-label"], 120),
      date: cap(attrs["data-date"], 40),
      reminder: cap(attrs["data-reminder"], 80),
      uid: cap(attrs["data-mention-uid"], 64),
    });
  }
  return out;
}

/** Diff key: the chip's uid when it has one, else kind+id (+date). */
export const mentionKey = (m: ParsedMention): string => `${m.uid ?? ""}|${m.kind}|${m.id ?? ""}|${m.kind === "date" ? (m.date ?? "") : ""}`;

/** Mentions in `next` that were not in `prev` (by key). */
export function newMentions(prev: string | null | undefined, next: string | null | undefined): ParsedMention[] {
  const before = new Set(extractMentions(prev).map(mentionKey));
  return extractMentions(next).filter((m) => !before.has(mentionKey(m)));
}

// ── Mentions inside comments (plain text, stored as data) ────────────────────
/** Comment-text token for a person mention: `@[Ada Lovelace](person:<id>)`. */
export const COMMENT_MENTION = /@\[([^\]\n]{1,80})\]\(person:([A-Za-z0-9_-]{1,128})\)/g;

export function commentMentionToken(label: string, personId: string): string {
  return `@[${label.replace(/[\]\n]/g, " ").trim().slice(0, 80) || "person"}](person:${personId})`;
}

export function extractCommentMentions(text: string | null | undefined): Array<{ label: string; id: string }> {
  const out: Array<{ label: string; id: string }> = [];
  if (!text) return out;
  COMMENT_MENTION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMENT_MENTION.exec(text)) && out.length < 50) out.push({ label: m[1]!, id: m[2]! });
  return out;
}

/** Split comment text into plain runs and mention tokens (for rendering chips). */
export function splitCommentMentions(text: string): Array<{ text: string } | { label: string; id: string }> {
  const parts: Array<{ text: string } | { label: string; id: string }> = [];
  let last = 0;
  COMMENT_MENTION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMENT_MENTION.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ label: m[1]!, id: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
