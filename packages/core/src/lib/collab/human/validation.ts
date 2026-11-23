import type { Node as ProseNode, Schema } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { initProseMirrorDoc } from "@tiptap/y-tiptap";
import { collabExtensions } from "../../../editor/collabSchema";
import {
  HUMAN_COLLAB_LIMITS,
  humanCollabRevision,
  type HumanCollabCommand,
  type HumanCollabRange,
} from "../commands";

const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
export const humanNoteId = (value: string) =>
  /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const humanThreadId = (value: string) =>
  /^[A-Za-z0-9_-]{1,200}$/.test(value);
/** ES2020-compatible: never silently replace invalid UTF-16 before hashing. */
export function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export function humanTextProblem(
  text: string,
  kind: "suggest" | "comment" | "quote",
): string | null {
  if (!wellFormed(text)) return "The text contains an invalid character.";
  if (kind === "quote")
    return text.includes("\0")
      ? "The selection contains an invalid character."
      : null;
  if (controls.test(text))
    return "Remove the control character before submitting.";
  if (kind === "suggest") {
    if (/[\r\n\u2028\u2029]/.test(text))
      return "Suggest one line at a time; line breaks cannot be tracked.";
    if (text.includes("\t")) return "Use spaces instead of a tab.";
    if (text && !text.trim())
      return "Enter text, or choose Delete for the selected passage.";
    if (/\s\s/.test(text)) return "Use single spaces in proposed text.";
  } else if (!text.trim()) return "Enter a comment before submitting.";
  return null;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Strict record validation, also used when recovering an immutable saved request.
 * Age is deliberately not pruned locally: an old uncertain outcome still needs review. */
export function parseHumanCommand(body: string): HumanCollabCommand | null {
  if (new TextEncoder().encode(body).length > HUMAN_COLLAB_LIMITS.body)
    return null;
  try {
    const v = JSON.parse(body);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const base = ["kind", "requestId", "createdAt", "revision"];
    const extra: Record<string, string[]> = {
      suggest: ["from", "to", "quote", "text"],
      comment: ["from", "to", "quote", "text"],
      "page-comment": ["text"],
      reply: ["threadId", "text"],
      resolve: ["threadId", "resolved"],
      "delete-comment": ["threadId"],
    };
    if (
      !extra[v.kind] ||
      Object.keys(v).sort().join() !== [...base, ...(extra[v.kind] ?? [])].sort().join()
    )
      return null;
    if (
      typeof v.requestId !== "string" ||
      !uuid.test(v.requestId) ||
      !Number.isSafeInteger(v.createdAt) ||
      v.createdAt < 0 ||
      typeof v.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(v.revision)
    )
      return null;
    if (v.kind === "suggest" || v.kind === "comment") {
      if (
        !Number.isSafeInteger(v.from) ||
        !Number.isSafeInteger(v.to) ||
        v.from < 0 ||
        v.to < v.from ||
        v.to > 50_000_000 ||
        typeof v.quote !== "string" ||
        v.quote.length > HUMAN_COLLAB_LIMITS.quote ||
        humanTextProblem(v.quote, "quote")
      )
        return null;
      if (v.kind === "comment" && v.from === v.to) return null;
    } else if (v.kind !== "page-comment" && (typeof v.threadId !== "string" || !humanThreadId(v.threadId)))
      return null;
    if (["suggest", "comment", "page-comment", "reply"].includes(v.kind)) {
      if (
        typeof v.text !== "string" ||
        v.text.length >
          (v.kind === "suggest"
            ? HUMAN_COLLAB_LIMITS.text
            : HUMAN_COLLAB_LIMITS.commentText) ||
        humanTextProblem(v.text, v.kind === "suggest" ? "suggest" : "comment")
      )
        return null;
      if (v.kind === "suggest" && v.from === v.to && !v.text) return null;
      if (v.kind === "page-comment" && !v.text.trim()) return null;
    }
    if (v.kind === "resolve" && typeof v.resolved !== "boolean") return null;
    return v as HumanCollabCommand;
  } catch {
    return null;
  }
}
export type HumanSelectionAction =
  | "replace"
  | "delete"
  | "before"
  | "after"
  | "empty"
  | "comment";
export interface CapturedHumanSelection extends HumanCollabRange {
  revision: string;
  /** "match": the editor's JSON equals the server's projection of the shared
   *  fragment, so it was hashed; "fragment": they differed (a client-only
   *  attribute/mark) and the fragment projection was hashed instead. */
  parity: "match" | "fragment";
  originalQuote: string;
  action: HumanSelectionAction;
  /** Immutable captured body for text-edge validation; never applied to Yjs. */
  doc: ProseNode;
}
const reviewMarked = (node?: ProseNode | null) =>
  !!node?.marks.some((mark) =>
    ["insertion", "deletion"].includes(mark.type.name),
  );
const nodeSuggested = (node?: ProseNode | null) =>
  node?.attrs?.suggestion === "insert" || node?.attrs?.suggestion === "delete";
export function humanRangeProblem(
  doc: ProseNode,
  from: number,
  to: number,
  kind: "suggest" | "comment",
): string | null {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 1 ||
    to < from ||
    to > doc.content.size
  )
    return "Select a passage inside the document.";
  const start = doc.resolve(from),
    end = doc.resolve(to);
  if (!start.parent.isTextblock || !end.parent.isTextblock)
    return "Select text inside a paragraph.";
  if (kind === "suggest" && !start.sameParent(end))
    return "Select one paragraph at a time for a suggestion.";
  const mark =
    doc.type.schema.marks[kind === "suggest" ? "insertion" : "comment"];
  const deletion = doc.type.schema.marks.deletion;
  if (
    !mark ||
    !start.parent.type.allowsMarkType(mark) ||
    !end.parent.type.allowsMarkType(mark) ||
    (kind === "suggest" &&
      (!deletion || !end.parent.type.allowsMarkType(deletion)))
  )
    return "This block does not support that change.";
  let runs = 0,
    unmarkable = false,
    // Schema v6: a block start, a line break or a chip can itself BE a pending suggestion
    // (`attrs.suggestion`). A command inside such a block, or over such a node, would stack a
    // second suggestion on the first — refused like text that already carries one. (The server
    // applies the same rule: `planSuggest` in apps/server/src/human-collab.ts.)
    overlap = kind === "suggest" && (nodeSuggested(start.parent) || nodeSuggested(end.parent));
  doc.nodesBetween(from, to, (node) => {
    if (!node.isInline) return true;
    runs++;
    if (nodeSuggested(node)) overlap = true;
    if (
      !node.isText ||
      node.marks.some((existing) => existing.type.excludes(mark))
    )
      unmarkable = true;
    if (reviewMarked(node)) overlap = true;
    return false;
  });
  if (runs > 100)
    return "Select a shorter passage with fewer formatting changes.";
  if (
    kind === "suggest" &&
    (overlap ||
      (from === to &&
        (reviewMarked(start.nodeBefore) ||
          reviewMarked(start.nodeAfter) ||
          start
            .marks()
            .some((mark) =>
              ["insertion", "deletion"].includes(mark.type.name),
            ))))
  )
    return "This passage touches a pending suggestion. Review it before suggesting another change.";
  if (unmarkable)
    // (Inline code CAN carry a suggestion since schema v6; a line break or a chip is a node, not text.)
    return "Select text without line breaks or embedded items.";
  return null;
}
export function suggestionTextProblem(
  anchor: CapturedHumanSelection,
  text: string,
): string | null {
  const problem = humanTextProblem(text, "suggest");
  if (problem) return problem;
  if (text.length > HUMAN_COLLAB_LIMITS.text)
    return "Keep proposed text within 10,000 characters.";
  if (!text && anchor.from === anchor.to) return "Enter text to insert.";
  const point = anchor.doc.resolve(anchor.to);
  const before =
    anchor.to > point.start()
      ? anchor.doc.textBetween(anchor.to - 1, anchor.to, "\n", "\ufffc")
      : "";
  const after =
    anchor.to < point.end()
      ? anchor.doc.textBetween(anchor.to, anchor.to + 1, "\n", "\ufffc")
      : "";
  if (
    (/^\s/.test(text) && (!before || /\s/.test(before))) ||
    (/\s$/.test(text) && (!after || /\s/.test(after)))
  )
    return "Remove the edge space; it would be lost when this paragraph is saved.";
  return null;
}
/** Capture all revision inputs before awaiting crypto; selection-only, no body edits. */
export async function captureHumanSelection(
  editor: Editor,
  ydoc: Y.Doc,
  action: HumanSelectionAction,
  ready: boolean,
): Promise<CapturedHumanSelection> {
  if (!ready)
    throw Error("Wait for this document to connect and finish syncing.");
  const doc = editor.state.doc;
  let { from, to } = editor.state.selection;
  if (action === "empty") {
    if (
      doc.childCount !== 1 ||
      !doc.firstChild?.isTextblock ||
      doc.firstChild.content.size !== 0
    )
      throw Error(
        "Select a passage and choose where to insert the proposed text.",
      );
    from = to = 1;
  } else if (from === to)
    throw Error(
      "Select text first. Choose Insert before or Insert after for an explicit insertion point.",
    );
  const originalQuote = doc.textBetween(from, to, "\n", "\ufffc");
  const rangeProblem = humanRangeProblem(
    doc,
    from,
    to,
    action === "comment" ? "comment" : "suggest",
  );
  if (rangeProblem) throw Error(rangeProblem);
  if (
    originalQuote.length > HUMAN_COLLAB_LIMITS.quote ||
    humanTextProblem(originalQuote, "quote")
  )
    throw Error("Select valid text within 10,000 characters.");
  if (action === "before") to = from;
  if (action === "after") from = to;
  const insertionProblem = humanRangeProblem(
    doc,
    from,
    to,
    action === "comment" ? "comment" : "suggest",
  );
  if (insertionProblem) throw Error(insertionProblem);
  const quote = doc.textBetween(from, to, "\n", "\ufffc");
  const { body, parity } = humanRevisionBody(doc, ydoc);
  // The range and quote were read from the EDITOR's document. If that is not
  // exactly what the server projects from the shared fragment, the same positions
  // could address different text (repeated words) — refuse rather than guess.
  if (parity !== "match")
    throw Error(
      "This page shows content this version of Prism can’t place a suggestion in. Reload, then try again.",
    );
  const comments = ydoc.getMap("comments").toJSON();
  return {
    action,
    doc,
    from,
    to,
    quote,
    originalQuote,
    parity,
    revision: await humanCollabRevision(body, comments),
  };
}

let sharedSchema: Schema | null = null;
/** The schema the SERVER projects the shared fragment with (no client-only extensions). */
function serverSchema(): Schema {
  return (sharedSchema ??= getSchema(collabExtensions()));
}

/**
 * The ProseMirror JSON a command revision hashes. The server hashes
 * `initProseMirrorDoc(fragment, sharedSchema).doc.toJSON()`; the browser's
 * `editor.state.doc.toJSON()` is the same document when no client-only extension
 * adds an attribute or mark. Synchronous (call it in the same tick as the range
 * capture). When the two differ the fragment projection is used (positions are
 * still the editor's — a structural difference would surface as a 409/400, never
 * as a misplaced change).
 */
export function humanRevisionBody(doc: ProseNode, ydoc: Y.Doc): { body: unknown; parity: "match" | "fragment" } {
  const editorJson = doc.toJSON();
  const fragment = ydoc.getXmlFragment("default");
  // A never-written fragment under an editor showing its one empty paragraph: the
  // server normalises a blank note to that same paragraph, and position 1 of an
  // empty paragraph cannot address other text — hash the editor's document.
  if (fragment.length === 0 && doc.childCount === 1 && !!doc.firstChild?.isTextblock && doc.firstChild.content.size === 0) {
    return { body: editorJson, parity: "match" };
  }
  let projected: unknown = editorJson;
  try {
    projected = initProseMirrorDoc(fragment, serverSchema()).doc.toJSON();
  } catch {
    return { body: editorJson, parity: "match" };
  }
  return JSON.stringify(projected) === JSON.stringify(editorJson) ? { body: editorJson, parity: "match" } : { body: projected, parity: "fragment" };
}
