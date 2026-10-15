/**
 * Readable names for Omni surfaces (Today, nudges, notification headlines). Many notes carry
 * no `metadata.title`, and their path leaf is a slug (`app-2-app-2-defined`), so Omni names a
 * note by, in order: `metadata.title` → the first markdown H1 of its body → its path leaf made
 * readable (hyphens / underscores to spaces, sentence case). Omni-only: `leafTitle` in
 * @prism/core keeps its meaning for the rest of Prism.
 */
import { containerTitle } from "@prism/core/pages";

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** Inline markdown reduced to its words (a heading like `# **Q3** [plan](x)` → "Q3 plan"). */
export function plainInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first level-1 ATX heading of a markdown body (front matter and fenced code skipped), or null. */
export function firstHeading(content: string | null | undefined): string | null {
  if (!content) return null;
  let body = content.slice(0, 64_000);
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end !== -1) body = body.slice(end + 4);
  }
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const f = /^\s{0,3}(```|~~~)/.exec(line);
    if (f) {
      fence = fence === null ? f[1]! : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    const m = /^\s{0,3}#\s+(.+)$/.exec(line);
    if (m) {
      const h = plainInline(m[1]!);
      if (h) return h;
    }
  }
  return null;
}

/** A path's last segment as words: `vault/tasks/app-2_defined.md` → "App 2 defined". */
export function humanizeLeaf(pathOrId: string): string {
  const leaf = (pathOrId.split("/").filter(Boolean).pop() ?? pathOrId).replace(/\.(md|markdown|txt)$/i, "");
  const words = leaf.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return pathOrId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Does this read like a path or a slug rather than a name? One "word" joined by hyphens /
 * underscores (`call-dana`, `app_2`), anything with a slash, or a markdown file name.
 */
export function looksLikeSlug(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (t.includes("/") || /\.(md|markdown)$/i.test(t)) return true;
  return !/\s/.test(t) && /[-_]/.test(t);
}

export interface TitleSource {
  id: string;
  path?: string | null;
  metadata?: Record<string, unknown> | null;
  content?: string | null;
}

/** The note's readable name: metadata title → first H1 → readable path leaf (→ id). */
export function omniTitle(n: TitleSource): string {
  const meta = text(n.metadata?.title);
  if (meta) return meta;
  const h1 = firstHeading(n.content);
  if (h1) return h1;
  const container = containerTitle(n.path ?? null, n.metadata);
  if (container) return container;
  return n.path ? humanizeLeaf(n.path) : n.id;
}

/** A display string bounded for a card or a headline (whole characters, ellipsis when cut). */
export function clip(s: string, max: number): string {
  const chars = Array.from(s.replace(/\s+/g, " ").trim());
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : chars.join("");
}

/**
 * Markdown (a raw note preview) reduced to plain text: front matter, fenced code, heading /
 * quote / list markers, emphasis, links and tags go; the words stay. Bounded to `max`.
 */
export function plainText(s: string, max = 1000): string {
  let body = s.slice(0, 32_768);
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end !== -1) body = body.slice(end + 4);
  }
  body = body
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "").replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, ""))
    .map(plainInline)
    .filter(Boolean)
    .join(" ");
  return clip(body.replace(/[\p{Cc}\p{Cf}]/gu, " "), max);
}

/**
 * What a nudge is called and says, made readable on upsert. A proposed title that reads like
 * a slug or a path (or is just the source's file name) is replaced by the source's metadata
 * title → its first H1 → its path leaf in words; a summary is kept as plain text, without a
 * leading repeat of the title (a raw preview starts with its own `# Heading`).
 */
export async function readableNudgeText(
  proposed: { title: string; summary: string },
  source: { id: string; path: string | null; title?: string | null },
  readContent: (id: string) => Promise<string | null>,
): Promise<{ title: string; summary: string }> {
  const leaf = source.path ? (source.path.split("/").pop() ?? "").replace(/\.md$/i, "") : "";
  const raw = proposed.title.trim();
  let title = plainInline(raw.replace(/^#+\s+/, ""));
  if (!title || looksLikeSlug(raw) || (leaf && raw.replace(/\.md$/i, "").toLowerCase() === leaf.toLowerCase())) {
    const meta = text(source.title);
    if (meta && !looksLikeSlug(meta)) title = meta;
    else title = firstHeading(await readContent(source.id).catch(() => null)) ?? humanizeLeaf(meta || source.path || source.id);
  }
  title = clip(title, 200);
  // A raw preview opens with the note's own `# Heading`: that line is the title, not the summary.
  let body = proposed.summary.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "");
  const first = /^\s*#{1,6}\s+([^\n]*)(?:\n|$)/.exec(body);
  if (first && [title, raw].some((t) => plainInline(first[1]!).toLowerCase() === t.toLowerCase())) body = body.slice(first[0].length);
  let summary = plainText(body, 1000);
  if (!summary || looksLikeSlug(summary)) summary = title;
  return { title, summary };
}
