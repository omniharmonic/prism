/**
 * Note content → embeddable text chunks. Notes are HTML (TipTap) or markdown;
 * we strip to plain text, then split into overlapping windows on paragraph/
 * sentence boundaries so each chunk is self-contained but context bleeds across
 * the seam. Chunk-level (not note-level) embedding is what makes retrieval
 * precise on long notes — a query matches the relevant passage, not an averaged
 * whole-note vector.
 */

const TAG_RE = /<[^>]+>/g;
const WS_RE = /[ \t\f\v]+/g;

/** Strip HTML tags + collapse whitespace, preserving paragraph breaks. */
export function toPlainText(content: string): string {
  return content
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(TAG_RE, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(WS_RE, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

export interface Chunk {
  index: number;
  text: string;
}

const MAX_CHARS = 1200; // ~300 tokens; a sentence-rich passage
const OVERLAP = 200;

/**
 * Split text into overlapping chunks of ~MAX_CHARS, breaking on paragraph then
 * sentence boundaries where possible. Always returns at least one chunk for
 * non-empty input; empty/whitespace input yields no chunks.
 */
export function chunkText(text: string): Chunk[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= MAX_CHARS) return [{ index: 0, text: clean }];

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < clean.length) {
    let end = Math.min(start + MAX_CHARS, clean.length);
    if (end < clean.length) {
      // Prefer a paragraph break, then a sentence end, within the tail window.
      const window = clean.slice(start, end);
      const para = window.lastIndexOf("\n\n");
      const sent = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
      const cut = para > MAX_CHARS * 0.5 ? para : sent > MAX_CHARS * 0.5 ? sent + 1 : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push({ index: index++, text: piece });
    if (end >= clean.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return chunks;
}

/** Full pipeline: note content → plain-text chunks. */
export function chunkNote(content: string): Chunk[] {
  return chunkText(toPlainText(content));
}
