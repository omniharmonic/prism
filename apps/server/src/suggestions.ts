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
 *
 * A suggested PARAGRAPH BREAK or LINE BREAK holds no text, so it is not a mark: the node
 * itself carries `suggestion` ("insert" | "delete") and `suggestionBy` (packages/core
 * editor/suggestionNodes). The functions here COUNT those (authors, has, summary); resolving
 * them joins / removes blocks, which needs the schema — collab.ts does that step with the
 * editor's own `resolveNodeSuggestionsInDoc`, right after `resolveSuggestions`.
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

/** The suggested break a node carries: who suggested it, or null. */
const breakBy = (n: PmNode): string | null =>
  n.attrs?.suggestion === "insert" || n.attrs?.suggestion === "delete" ? String(n.attrs.suggestionBy ?? "") : null;
const breakFor = (n: PmNode, author: string | null): boolean => {
  const by = breakBy(n);
  return by !== null && (author === null || by === author);
};

const markUser = (m: PmMark): string => String(m.attrs?.user ?? "");
const isFor = (m: PmMark, author: string | null): boolean =>
  SUGGESTION_MARKS.has(m.type) && (author === null || markUser(m) === author);

/** Distinct authors of suggestion marks anywhere in the doc. */
export function suggestionAuthors(node: PmNode): string[] {
  const out = new Set<string>();
  const walk = (n: PmNode): void => {
    for (const m of n.marks ?? []) if (SUGGESTION_MARKS.has(m.type)) out.add(markUser(m));
    const by = breakBy(n);
    if (by !== null) out.add(by);
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  return [...out];
}

/** Does the doc carry any suggestion marks (optionally for one author)? */
export function hasSuggestions(node: PmNode, author: string | null = null): boolean {
  for (const m of node.marks ?? []) if (isFor(m, author)) return true;
  if (breakFor(node, author)) return true;
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
  let breaks = 0;
  const walk = (n: PmNode): void => {
    if (breakFor(n, author)) breaks++;
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
  if (breaks) parts.push(`${breaks} ${breaks === 1 ? "break" : "breaks"}`);
  return `Suggested edits by ${author}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** One identified suggestion in a document: who made it (the opaque/legacy actor
 *  id on its marks, if any) and its inserted / deleted text. */
export interface IdentifiedSuggestion {
  actorId: string | null;
  ins: string;
  del: string;
}

/** Suggestions that carry a `suggestionId`, keyed by it (wave 3: accepted /
 *  rejected notifications). Legacy marks without an id are not listed. */
export function identifiedSuggestions(node: PmNode, out = new Map<string, IdentifiedSuggestion>()): Map<string, IdentifiedSuggestion> {
  if (typeof node.text === "string") {
    for (const m of node.marks ?? []) {
      if (m.type !== "insertion" && m.type !== "deletion") continue;
      const id = typeof m.attrs?.suggestionId === "string" ? m.attrs.suggestionId : "";
      if (!id) continue;
      const e = out.get(id) ?? { actorId: null, ins: "", del: "" };
      if (typeof m.attrs?.actorId === "string" && m.attrs.actorId) e.actorId = m.attrs.actorId;
      if (m.type === "insertion") e.ins += node.text;
      else e.del += node.text;
      out.set(id, e);
    }
  }
  for (const child of node.content ?? []) identifiedSuggestions(child, out);
  return out;
}

/** A document's text as readers see it (decoded; one line per block). */
export function plainTextOf(node: PmNode, out: string[] = [], top = true): string {
  if (typeof node.text === "string") out.push(node.text);
  for (const child of node.content ?? []) plainTextOf(child, out, false);
  if (!top && node.content && node.type !== "text") out.push("\n");
  return top ? out.join("") : "";
}
