/**
 * Text diffs for note version history. Every note kind is reduced to readable
 * lines first — rich-text HTML to paragraphs, an Excalidraw scene to one line
 * per element — so "what changed" reads as prose, not markup.
 */
import { diffLines, diffWordsWithSpace } from "diff";

/** Reduce stored note content to diffable, human-readable text lines. */
export function contentAsText(content: string | null | undefined): string {
  if (!content) return "";
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"elements"')) return sceneAsText(trimmed) ?? content;
  if (trimmed.startsWith("<")) return htmlAsText(trimmed);
  return content;
}

const BLOCK_END = /<\/(p|h[1-6]|li|blockquote|pre|tr|div|ul|ol|table)>|<br\s*\/?>|<hr\s*\/?>/gi;

function htmlAsText(html: string): string {
  // Break after every block, bullet list items, then let the parser decode
  // entities and drop the remaining inline markup.
  const marked = html
    .replace(/<li[^>]*>/gi, "$&• ")
    .replace(/<h([1-6])[^>]*>/gi, (m, n: string) => `${m}${"#".repeat(Number(n))} `)
    .replace(BLOCK_END, "$&\n");
  let text: string;
  if (typeof DOMParser !== "undefined") {
    text = new DOMParser().parseFromString(marked, "text/html").body.textContent ?? "";
  } else {
    text = marked.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}

function sceneAsText(json: string): string | null {
  try {
    const scene = JSON.parse(json) as { elements?: Array<Record<string, unknown>> };
    if (!Array.isArray(scene.elements)) return null;
    return scene.elements
      .filter((el) => !el.isDeleted)
      .map((el) => {
        const text = typeof el.text === "string" && el.text ? ` “${el.text}”` : "";
        return `${el.type ?? "element"}${text}`;
      })
      .sort()
      .join("\n");
  } catch {
    return null;
  }
}

/** One inline run inside a changed line. */
export interface DiffSpan {
  text: string;
  kind: "same" | "add" | "del";
}

/** A rendered diff row: an unchanged, added, removed or edited line, or a fold. */
export type DiffRow =
  | { kind: "same"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string }
  | { kind: "edit"; spans: DiffSpan[] }
  | { kind: "fold"; lines: string[] };

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
}

/** Lines of unchanged context kept around each change before folding the rest. */
const CONTEXT = 2;

/**
 * Line diff `before` → `after`. A one-line removal immediately replaced by a
 * one-line addition becomes a single `edit` row with word-level spans, which is
 * how a typo fix should look. Long unchanged runs fold, keeping context.
 */
export function diffText(before: string, after: string): DiffResult {
  const parts = diffLines(before, after);
  const raw: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  const lines = (v: string) => v.replace(/\n$/, "").split("\n");

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const next = parts[i + 1];
    if (p.removed && next?.added) {
      const del = lines(p.value);
      const add = lines(next.value);
      removed += del.length;
      added += add.length;
      if (del.length === add.length) {
        del.forEach((d, j) => raw.push(editRow(d, add[j]!)));
      } else {
        for (const d of del) raw.push({ kind: "del", text: d });
        for (const a of add) raw.push({ kind: "add", text: a });
      }
      i++;
      continue;
    }
    const kind = p.added ? "add" : p.removed ? "del" : "same";
    for (const text of lines(p.value)) {
      raw.push({ kind, text });
      if (kind === "add") added++;
      if (kind === "del") removed++;
    }
  }
  return { rows: fold(raw), added, removed };
}

function editRow(before: string, after: string): DiffRow {
  if (before === after) return { kind: "same", text: after };
  const spans: DiffSpan[] = diffWordsWithSpace(before, after).map((c) => ({
    text: c.value,
    kind: c.added ? "add" : c.removed ? "del" : "same",
  }));
  return { kind: "edit", spans };
}

function fold(rows: DiffRow[]): DiffRow[] {
  const changed = rows.map((r) => r.kind !== "same");
  const keep = rows.map((_, i) => {
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (changed[i + d]) return true;
    return false;
  });
  const out: DiffRow[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push({ kind: "fold", lines: run });
    run = [];
  };
  rows.forEach((r, i) => {
    if (keep[i]) {
      flush();
      out.push(r);
    } else {
      run.push((r as { text: string }).text);
    }
  });
  flush();
  return out;
}

/** A metadata key whose value differs between two versions. */
export interface MetaChange {
  key: string;
  before: unknown;
  after: unknown;
}

/** Keys Prism maintains mechanically; changes to them aren't worth showing. */
const QUIET_KEYS = new Set(["contentFont", "mirror_source_updated_at", "lastMessageAt", "messageCount"]);

export function diffMetadata(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): MetaChange[] {
  const a = before ?? {};
  const b = after ?? {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !QUIET_KEYS.has(k)).sort();
  return keys
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((key) => ({ key, before: a[key], after: b[key] }));
}
