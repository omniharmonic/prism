/**
 * Server-side suggested-edit transforms (G2b). Pure functions over ProseMirror
 * JSON — no TipTap/DOM here (collab.ts owns the HTML⇄JSON rendering and wraps
 * these; see resolveSuggestionsInHtml there). The mark model is the shared
 * schema's `insertion` / `deletion` marks (packages/core editor/suggestionMarks),
 * each carrying a `user` attribute:
 *
 *   accept: insertion → keep the text, drop the mark; deletion → remove the text.
 *   reject: insertion → remove the text;            deletion → keep the text, drop the mark.
 *
 * `author=null` applies to every author (accept/reject all).
 */

export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PmNode {
  type: string;
  text?: string;
  marks?: PmMark[];
  content?: PmNode[];
  attrs?: Record<string, unknown>;
}

const SUGGESTION_MARKS = new Set(["insertion", "deletion"]);

const markUser = (m: PmMark): string => String(m.attrs?.user ?? "");
const isFor = (m: PmMark, author: string | null): boolean =>
  SUGGESTION_MARKS.has(m.type) && (author === null || markUser(m) === author);

/** Distinct authors of suggestion marks anywhere in the doc. */
export function suggestionAuthors(node: PmNode): string[] {
  const out = new Set<string>();
  const walk = (n: PmNode): void => {
    for (const m of n.marks ?? []) if (SUGGESTION_MARKS.has(m.type)) out.add(markUser(m));
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  return [...out];
}

/** Does the doc carry any suggestion marks (optionally for one author)? */
export function hasSuggestions(node: PmNode, author: string | null = null): boolean {
  for (const m of node.marks ?? []) if (isFor(m, author)) return true;
  for (const c of node.content ?? []) if (hasSuggestions(c, author)) return true;
  return false;
}

/**
 * Resolve suggestion marks for `author` (null = all): returns a NEW doc.
 * A node is dropped entirely when the action removes its text (accept+deletion,
 * reject+insertion); otherwise the matched marks are stripped and the node kept.
 */
export function resolveSuggestions(node: PmNode, author: string | null, action: "accept" | "reject"): PmNode {
  const dropMark = action === "accept" ? "deletion" : "insertion";

  const visit = (n: PmNode): PmNode | null => {
    const marks = n.marks ?? [];
    const mine = marks.filter((m) => isFor(m, author));
    if (mine.some((m) => m.type === dropMark)) return null; // text removed by the action
    // Strip the resolved suggestion marks — and their STYLE ECHOES: the marks
    // render with text-decoration underline/line-through, which the schema's
    // Underline/Strike extensions re-parse as genuine marks on the same run.
    // Resolving a suggestion must not leave its styling behind.
    const echo = new Set<string>();
    for (const m of mine) {
      if (m.type === "insertion") echo.add("underline");
      if (m.type === "deletion") echo.add("strike");
    }
    const keptMarks = marks.filter((m) => !isFor(m, author) && !(mine.length > 0 && echo.has(m.type)));
    const content = (n.content ?? []).map(visit).filter((c): c is PmNode => c !== null);
    const out: PmNode = { ...n };
    if (n.marks) {
      if (keptMarks.length) out.marks = keptMarks;
      else delete out.marks;
    }
    if (n.content) out.content = content;
    return out;
  };

  return visit(node) ?? { type: node.type, content: [] };
}

/** One-line human summary for the review inbox. */
export function summarizeSuggestions(node: PmNode, author: string): string {
  let ins = 0;
  let del = 0;
  const walk = (n: PmNode): void => {
    for (const m of n.marks ?? []) {
      if (!isFor(m, author)) continue;
      const len = (n.text ?? "").length || 1;
      if (m.type === "insertion") ins += len;
      else del += len;
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  const parts: string[] = [];
  if (ins) parts.push(`+${ins} chars`);
  if (del) parts.push(`−${del} chars`);
  return `Suggested edits by ${author}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
