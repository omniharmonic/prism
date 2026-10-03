/**
 * Collab-safe Yjs operations for the Prism MCP tools (Architecture v2 WP6.3).
 *
 * Pure-ish functions over a Y.Doc — no auth, no vault, no Hocuspocus. The MCP
 * layer (mcp/tool-collab.ts) decides WHO may call them and on WHICH doc; these
 * decide HOW a change lands so that concurrent human edits survive:
 *
 *  - CONTENT REPLACE (prism_update_note on a live doc) is a THREE-WAY merge done
 *    by Yjs itself: fork the base state the agent read, apply the agent's content
 *    to the fork with the same minimal-diff path the reconciler uses
 *    (`applyExternalContent` → updateYFragment for documents, prefix/suffix
 *    Y.Text diff for code), then ship ONLY the fork's delta to the live doc. Edits
 *    humans made after the base (stored or not) are items the fork never touched,
 *    so they survive; overlapping edits merge the way any two Yjs peers do.
 *    Spreadsheets diff CELL BY CELL (never the reconciler's whole-table rebuild)
 *    and canvases upsert only CHANGED elements by id (version bumped, so the
 *    Excalidraw client's version reconciliation accepts them).
 *  - COMMENTS / SUGGESTIONS mutate the shared document schema's own marks
 *    (`comment`, `insertion`, `deletion` — packages/core editor/*Mark.ts) via a
 *    ProseMirror transform + updateYFragment: exactly what the editor's
 *    ySyncPlugin does for a human, so the result is indistinguishable to clients.
 *    Thread data uses the same `comments` Y.Map shape as editor/comments.ts.
 *  - SHEET RANGES are A1 ranges over the Y.Array<Y.Array<string>> rows, written
 *    per cell with the client's own delete+insert idiom (CollabSpreadsheet).
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { Node as PMNode, Mark as PMMark } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { initProseMirrorDoc, updateYFragment } from "@tiptap/y-tiptap";
import {
  FIELD,
  SHEET_FIELD,
  CANVAS_FIELD,
  applyExternalContent,
  collabSchema,
  parseScene,
  yDocToHtml,
  yDocToCode,
  yDocToCsv,
  yDocToScene,
  type CanvasEl,
  type CollabKind,
} from "./collab";

/** Render a doc to the note body its kind persists as (what the store writes). */
export function renderDoc(doc: Y.Doc, kind: CollabKind): string {
  return kind === "code" ? yDocToCode(doc) : kind === "spreadsheet" ? yDocToCsv(doc) : kind === "canvas" ? yDocToScene(doc) : yDocToHtml(doc);
}

/** Is every client clock in `base` covered by `live`? (base is an ancestor state of live) */
export function isAncestorState(base: Uint8Array, live: Y.Doc): boolean {
  const baseSv = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(base));
  const liveSv = Y.decodeStateVector(Y.encodeStateVector(live));
  for (const [client, clock] of baseSv) if ((liveSv.get(client) ?? 0) < clock) return false;
  return true;
}

// ── content replace ─────────────────────────────────────────────────────────

/** Thrown when content cannot be applied safely (maps to invalid_request). */
export class CollabOpError extends Error {}
export class CollabConflictError extends CollabOpError {}

/**
 * Apply `content` (the note's full new body) to `doc` minimally for its kind.
 * Runs inside the caller's transaction (or opens one).
 */
export function applyContentMinimal(doc: Y.Doc, kind: CollabKind, content: string): void {
  if (kind === "spreadsheet") {
    doc.transact(() => applySheetContent(doc.getArray<Y.Array<string>>(SHEET_FIELD), parseCsvStrict(content)));
  } else if (kind === "canvas") {
    // Never let a non-scene body (e.g. a stray `<p></p>`) through: parseScene would
    // read zero elements and the upsert would delete every real one.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      /* not JSON */
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { elements?: unknown }).elements)) {
      throw new CollabOpError('canvas content must be Excalidraw scene JSON: {"elements": [...]}');
    }
    doc.transact(() => applyCanvasUpsert(doc.getMap<CanvasEl>(CANVAS_FIELD), content));
  } else {
    // document + code: the reconciler's own minimal-diff path.
    applyExternalContent(doc, kind, content);
  }
}

/**
 * Three-way content merge: fork `baseState`, apply `content` there, and apply
 * only the fork's delta to `live` under `origin`. Returns true if anything changed.
 */
export function mergeContentIntoLive(live: Y.Doc, baseState: Uint8Array, kind: CollabKind, content: string, origin: string): boolean {
  const fork = new Y.Doc();
  Y.applyUpdate(fork, baseState);
  const baseSv = Y.encodeStateVector(fork);
  const before = renderDoc(fork, kind);
  applyContentMinimal(fork, kind, content);
  if (renderDoc(fork, kind) === before) {
    fork.destroy();
    return false;
  }
  const delta = Y.encodeStateAsUpdate(fork, baseSv);
  fork.destroy();
  Y.applyUpdate(live, delta, origin);
  return true;
}

// ── spreadsheet ─────────────────────────────────────────────────────────────

/** Same shape as collab.ts parseCsv (minimal CSV: no quoting). */
function parseCsvStrict(content: string): string[][] {
  if (!content.trim()) return [[""]];
  return content.split("\n").map((row) => row.split(","));
}

/** Set one cell with the client's idiom (delete+insert at the column), padding the row if short. */
function setYCell(row: Y.Array<string>, c: number, v: string): boolean {
  if (row.length <= c) {
    const pad = new Array(c - row.length).fill("");
    row.insert(row.length, [...pad, v]);
    return true;
  }
  if (row.get(c) === v) return false;
  row.delete(c, 1);
  row.insert(c, [v]);
  return true;
}

/** Cell-level diff of the rows against `parsed` — never a whole-table rebuild. */
export function applySheetContent(rows: Y.Array<Y.Array<string>>, parsed: string[][]): void {
  const shared = Math.min(rows.length, parsed.length);
  for (let r = 0; r < shared; r++) {
    const row = rows.get(r);
    const want = parsed[r]!;
    for (let c = 0; c < Math.min(row.length, want.length); c++) setYCell(row, c, want[c]!);
    if (row.length > want.length) row.delete(want.length, row.length - want.length);
    else if (row.length < want.length) row.insert(row.length, want.slice(row.length));
  }
  if (rows.length > parsed.length) rows.delete(parsed.length, rows.length - parsed.length);
  for (let r = rows.length; r < parsed.length; r++) {
    const yr = new Y.Array<string>();
    yr.insert(0, parsed[r]!);
    rows.insert(rows.length, [yr]);
  }
}

export interface A1Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /** A single-cell anchor ("B2"): the write's extent comes from `values`. */
  anchor: boolean;
}

const colIndex = (letters: string): number => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export function colName(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export const formatA1 = (r1: number, c1: number, r2: number, c2: number): string =>
  r1 === r2 && c1 === c2 ? `${colName(c1)}${r1 + 1}` : `${colName(c1)}${r1 + 1}:${colName(c2)}${r2 + 1}`;

/** Parse "B2" or "A1:C3" (0-based, normalized). Throws CollabOpError on bad input. */
export function parseA1(range: string): A1Range {
  const m = /^\s*([A-Za-z]{1,3})([1-9][0-9]{0,5})(?::([A-Za-z]{1,3})([1-9][0-9]{0,5}))?\s*$/.exec(range);
  if (!m) throw new CollabOpError(`bad A1 range "${range}" (want e.g. "B2" or "A1:C3")`);
  const a = { r: Number(m[2]) - 1, c: colIndex(m[1]!) };
  if (!m[3]) return { r1: a.r, c1: a.c, r2: a.r, c2: a.c, anchor: true };
  const b = { r: Number(m[4]) - 1, c: colIndex(m[3]!) };
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c), anchor: false };
}

/** Read a rectangular range from a grid ("" beyond the data). */
export function readGridRange(grid: string[][], r: A1Range): string[][] {
  const out: string[][] = [];
  for (let i = r.r1; i <= r.r2; i++) {
    const row = grid[i] ?? [];
    const line: string[] = [];
    for (let j = r.c1; j <= r.c2; j++) line.push(row[j] ?? "");
    out.push(line);
  }
  return out;
}

export function gridOfRows(rows: Y.Array<Y.Array<string>>): string[][] {
  const out: string[][] = [];
  rows.forEach((yr) => out.push(yr.toArray()));
  return out;
}

/** Validate `values` against the range; returns the effective (r1,c1,r2,c2). */
export function writeExtent(r: A1Range, values: string[][]): { r1: number; c1: number; r2: number; c2: number } {
  if (values.length === 0 || values.some((row) => row.length === 0)) throw new CollabOpError("values must be a non-empty 2-D array");
  const width = Math.max(...values.map((row) => row.length));
  for (const row of values) {
    for (const v of row) {
      if (/[,\r\n]/.test(v)) throw new CollabOpError("cell values cannot contain commas or line breaks (sheets are stored as simple CSV)");
    }
  }
  if (r.anchor) return { r1: r.r1, c1: r.c1, r2: r.r1 + values.length - 1, c2: r.c1 + width - 1 };
  if (values.length !== r.r2 - r.r1 + 1 || values.some((row) => row.length !== r.c2 - r.c1 + 1)) {
    throw new CollabOpError(`values must be exactly ${r.r2 - r.r1 + 1} row(s) × ${r.c2 - r.c1 + 1} column(s) for ${formatA1(r.r1, r.c1, r.r2, r.c2)}`);
  }
  return { r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2 };
}

/** Write values into a plain grid (the not-live CSV path). Mutates + returns it. */
export function setGridCells(grid: string[][], r1: number, c1: number, values: string[][]): string[][] {
  const width = Math.max(grid[0]?.length ?? 0, c1 + Math.max(...values.map((v) => v.length)));
  while (grid.length < r1 + values.length) grid.push(new Array(width).fill(""));
  values.forEach((row, i) => {
    const target = grid[r1 + i]!;
    row.forEach((v, j) => {
      while (target.length <= c1 + j) target.push("");
      target[c1 + j] = v;
    });
  });
  return grid;
}

/** Write values into the live Y rows, one cell at a time. Returns #cells changed. */
export function setYCells(rows: Y.Array<Y.Array<string>>, r1: number, c1: number, values: string[][]): number {
  const width = Math.max(rows.length ? rows.get(0).length : 0, c1 + Math.max(...values.map((v) => v.length)));
  while (rows.length < r1 + values.length) {
    const yr = new Y.Array<string>();
    yr.insert(0, new Array(width).fill(""));
    rows.insert(rows.length, [yr]);
  }
  let changed = 0;
  values.forEach((row, i) => {
    const yr = rows.get(r1 + i);
    row.forEach((v, j) => {
      if (setYCell(yr, c1 + j, v)) changed++;
    });
  });
  return changed;
}

// ── canvas ──────────────────────────────────────────────────────────────────

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Canvas content replace: upsert CHANGED elements by id (version bumped past
 * both copies, fresh versionNonce — Excalidraw keeps the higher version) and drop
 * ids absent from the scene. Unchanged elements are not rewritten, so a human's
 * concurrent edit to one of them is never overwritten.
 */
export function applyCanvasUpsert(map: Y.Map<CanvasEl>, content: string): { upserted: number; deleted: number } {
  const ids = new Set<string>();
  let upserted = 0;
  let deleted = 0;
  for (const el of parseScene(content).elements) {
    if (!el || typeof el.id !== "string") continue;
    ids.add(el.id);
    const cur = map.get(el.id);
    if (cur && JSON.stringify(cur) === JSON.stringify(el)) continue;
    const next: CanvasEl = { ...el };
    if (cur || typeof el.version === "number") {
      next.version = Math.max(num(cur?.version), num(el.version)) + 1;
      next.versionNonce = Math.floor(Math.random() * 2 ** 31);
    }
    map.set(el.id, next);
    upserted++;
  }
  for (const k of Array.from(map.keys())) {
    if (!ids.has(k)) {
      map.delete(k);
      deleted++;
    }
  }
  return { upserted, deleted };
}

// ── documents: text search + marks ──────────────────────────────────────────

/**
 * First occurrence of `needle` in the document's text, within ONE textblock
 * (a quote cannot span paragraphs). Returns ProseMirror positions.
 */
export function findTextRange(doc: PMNode, needle: string): { from: number; to: number } | null {
  return findTextRanges(doc, needle, 1)[0] ?? null;
}

/** Search exact quotes without joining text across paragraph boundaries. */
function findTextRanges(doc: PMNode, needle: string, limit = 2): Array<{ from: number; to: number }> {
  if (!needle) return [];
  const found: Array<{ from: number; to: number }> = [];
  doc.descendants((node, pos) => {
    if (found.length >= limit) return false;
    if (!node.isTextblock) return true;
    let text = "";
    const map: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        const t = child.text ?? "";
        for (let i = 0; i < t.length; i++) map.push(start + i);
        text += t;
      } else {
        map.push(start);
        text += "￼";
      }
    });
    let offset = 0;
    while (found.length < limit) {
      const index = text.indexOf(needle, offset);
      if (index < 0) break;
      found.push({ from: map[index]!, to: map[index + needle.length - 1]! + 1 });
      offset = index + 1; // Include overlapping matches (e.g. "aa" in "aaa").
    }
    return false;
  });
  return found;
}

/** Run a ProseMirror transform over the doc's shared fragment and write the result back minimally. */
export function editFragment(ydoc: Y.Doc, fn: (doc: PMNode) => PMNode | null): void {
  const frag = ydoc.getXmlFragment(FIELD);
  const { doc, meta } = initProseMirrorDoc(frag, collabSchema());
  const next = fn(doc);
  if (next && !next.eq(doc)) updateYFragment(ydoc, frag, next, meta as never);
}

const COLORS = ["#f783ac", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];
/** Same stable per-identity color as the web client (CollabDoc colorFor). */
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

/** Who an MCP write is attributed to, in the editor's own vocabulary. */
export interface CollabAuthor {
  actorId?: string;
  turnId?: string;
  /** Display label — the account's name (or email) + " (agent)". */
  name: string;
  color: string;
}

// Thread data: identical shape to packages/core editor/comments.ts (`comments` Y.Map
// of Y.Map { id, quote, resolved, comments: Y.Array<CommentItem> }).
export interface CommentItem {
  author: string;
  color: string;
  text: string;
  createdAt: number;
  /** Set on comments written through Prism MCP (clients ignore unknown keys). */
  agent?: boolean;
}
export interface ThreadOut {
  id: string;
  quote: string;
  resolved: boolean;
  /** Whether a `comment` mark with this id still anchors text in the body. */
  anchored: boolean;
  /** A page-level discussion (NP-CO-02): about the page as a whole; never anchored. */
  page?: true;
  comments: Array<Omit<CommentItem, "color">>;
}

const threadsRoot = (ydoc: Y.Doc) => ydoc.getMap<Y.Map<unknown>>("comments");

function anchoredIds(ydoc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  const frag = ydoc.getXmlFragment(FIELD);
  if (frag.length === 0) return ids;
  const { doc } = initProseMirrorDoc(frag, collabSchema());
  doc.descendants((n) => {
    for (const m of n.marks) if (m.type.name === "comment" && m.attrs.id) ids.add(String(m.attrs.id));
  });
  return ids;
}

export function listThreads(ydoc: Y.Doc, includeResolved: boolean): ThreadOut[] {
  const anchored = anchoredIds(ydoc);
  const out: ThreadOut[] = [];
  threadsRoot(ydoc).forEach((t) => {
    const resolved = !!t.get("resolved");
    if (resolved && !includeResolved) return;
    const items = (t.get("comments") as Y.Array<CommentItem> | undefined)?.toArray() ?? [];
    const id = String(t.get("id") ?? "");
    out.push({
      id,
      quote: String(t.get("quote") ?? ""),
      resolved,
      anchored: anchored.has(id),
      ...(t.get("page") === true ? { page: true as const } : {}),
      comments: items.map(({ color: _c, ...rest }) => rest),
    });
  });
  // Same order as the editor sidebar: unresolved first, then by first-comment time.
  return out.sort((a, b) => (a.resolved !== b.resolved ? (a.resolved ? 1 : -1) : (a.comments[0]?.createdAt ?? 0) - (b.comments[0]?.createdAt ?? 0)));
}

export function getThread(ydoc: Y.Doc, id: string): Y.Map<unknown> | undefined {
  return threadsRoot(ydoc).get(id);
}

let stampCounter = 0;
const stamp = () => Date.now() + (stampCounter++ % 1000);

/**
 * Open a thread anchored on the first match of `quote` (the editor's
 * commentOnRange: a `comment` mark {id, resolved:false} over the range + the
 * thread in the `comments` map, one transaction). Null if `quote` is not found.
 */
export function addCommentThread(ydoc: Y.Doc, quote: string, text: string, who: CollabAuthor, origin: string): { threadId: string } | null {
  const schema = collabSchema();
  const frag = ydoc.getXmlFragment(FIELD);
  const { doc } = initProseMirrorDoc(frag, schema);
  const range = findTextRange(doc, quote);
  if (!range) return null;
  const id = `c-${Date.now().toString(36)}-${range.from}-${Math.random().toString(36).slice(2, 6)}`;
  ydoc.transact(() => {
    editFragment(ydoc, (d) => new Transform(d).addMark(range.from, range.to, schema.marks.comment!.create({ id, resolved: false })).doc);
    const t = new Y.Map<unknown>();
    t.set("id", id);
    t.set("quote", d0Text(doc, range).slice(0, 200));
    t.set("resolved", false);
    const arr = new Y.Array<CommentItem>();
    arr.push([{ author: who.name, color: who.color, text, createdAt: stamp(), agent: true }]);
    t.set("comments", arr);
    threadsRoot(ydoc).set(id, t);
  }, origin);
  return { threadId: id };
}

const d0Text = (doc: PMNode, r: { from: number; to: number }) => doc.textBetween(r.from, r.to, " ");

export function replyToThread(ydoc: Y.Doc, threadId: string, text: string, who: CollabAuthor, origin: string): void {
  const t = getThread(ydoc, threadId);
  if (!t) throw new CollabOpError("no such thread");
  ydoc.transact(() => {
    (t.get("comments") as Y.Array<CommentItem>).push([{ author: who.name, color: who.color, text, createdAt: stamp(), agent: true }]);
  }, origin);
}

/** Resolve/reopen: the thread flag AND a re-stamp of its anchor mark (the editor's setResolved). */
export function setThreadResolved(ydoc: Y.Doc, threadId: string, resolved: boolean, origin: string): void {
  const t = getThread(ydoc, threadId);
  if (!t) throw new CollabOpError("no such thread");
  const markType = collabSchema().marks.comment!;
  ydoc.transact(() => {
    t.set("resolved", resolved);
    editFragment(ydoc, (d) => {
      const tr = new Transform(d);
      d.descendants((node, pos) => {
        if (!node.isText) return;
        for (const mk of node.marks) {
          if (mk.type === markType && mk.attrs.id === threadId && !!mk.attrs.resolved !== resolved) {
            tr.removeMark(pos, pos + node.nodeSize, mk);
            tr.addMark(pos, pos + node.nodeSize, markType.create({ ...mk.attrs, resolved }));
          }
        }
      });
      return tr.docChanged ? tr.doc : null;
    });
  }, origin);
}

/**
 * A tracked change, as a human suggester's editor makes it: a unique match of
 * `find` gets a `deletion` mark and `replace` is inserted right after it with an
 * `insertion` mark — both attributed to `who`. Null if `find` is not found.
 */
export function suggestReplace(ydoc: Y.Doc, find: string, replace: string, who: CollabAuthor, origin: string): { from: number; to: number; suggestionId: string } | null {
  const schema = collabSchema();
  const { doc } = initProseMirrorDoc(ydoc.getXmlFragment(FIELD), schema);
  const matches = findTextRanges(doc, find);
  if (matches.length > 1) throw new CollabConflictError("This quote occurs more than once. Read the current document and use a longer, unique quote.");
  const range = matches[0];
  if (!range) return null;
  let overlaps = false;
  doc.nodesBetween(range.from, range.to, (node) => {
    if (node.marks.some((mark) => mark.type.name === "insertion" || mark.type.name === "deletion")) overlaps = true;
  });
  if (overlaps) throw new CollabConflictError("This passage already has a pending suggestion. Review it before proposing another change here.");
  const suggestionId = randomUUID();
  const attrs = { user: who.name, color: who.color, suggestionId, actorId: who.actorId ?? null, turnId: who.turnId ?? null };
  ydoc.transact(() => {
    editFragment(ydoc, (d) => {
      const tr = new Transform(d);
      tr.addMark(range.from, range.to, schema.marks.deletion!.create(attrs));
      if (replace) {
        // Keep the replaced text's formatting (bold, link…) minus review marks.
        const $end = tr.doc.resolve(range.to);
        const keep = ($end.nodeBefore?.marks ?? []).filter((m: PMMark) => !["deletion", "insertion", "comment"].includes(m.type.name));
        tr.insert(range.to, schema.text(replace, [...keep, schema.marks.insertion!.create(attrs)]));
      }
      return tr.doc;
    });
  }, origin);
  return { ...range, suggestionId };
}
