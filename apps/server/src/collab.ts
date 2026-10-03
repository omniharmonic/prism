/**
 * Server-side real-time collaboration (Hocuspocus + Yjs), replacing the retired
 * Cloudflare Worker. Runs in the Prism Server process, so it shares the vault
 * token and the ACL store:
 *
 *  - onAuthenticate: resolve the connection's level (session cookie OR ?t=
 *    capability) against the note; reject below "view"; mark every connection
 *    below EDIT read-only (Hocuspocus refuses a read-only connection's Update
 *    and SyncStep2 messages wholesale — nothing is applied, nothing pends).
 *    RAW YJS WRITES NEED EDIT (suggest-only enforcement, R07/R12): a raw update
 *    can carry anything — plain text, deletions, other Y roots — so a "suggest"
 *    socket that could write was only a client-side promise. Suggest-level
 *    people and capability guests keep live reading + presence and mutate the
 *    document only through the bounded, server-authored commands in
 *    human-collab.ts (`POST /api/collab/:id/commands`): suggested
 *    insert/delete/replace and comment threads. `COLLAB_SUGGEST_ENFORCED=false`
 *    restores the old writable suggest socket (rollback switch).
 *    COMMENTS NEED SUGGEST (WP0.2): a comment thread is a write to the shared
 *    Y.Doc — its anchor is a `comment` MARK in the body fragment and its data a
 *    `comments` Y.Map — so a "comment"-level actor can neither write it over the
 *    socket nor through the command endpoint. A server-side "comments-map-only"
 *    update filter is NOT safe: the anchor lives in the body, and dropping one
 *    of a client's updates leaves a gap in its Yjs clock, so every later update
 *    from that client pends forever. That is also why enforcement is
 *    all-or-nothing per connection rather than a per-update filter.
 *  - onLoadDocument: seed the Y.Doc server-side from Parachute (so the owner's
 *    browser need not be open), preferring persisted CRDT state unless Parachute
 *    was edited externally since (then re-seed — external edit wins).
 *  - onStoreDocument: persist the Y.Doc back to Parachute (HTML) AND to SQLite
 *    (Yjs binary, for CRDT continuity across unloads).
 *
 * documentName == note id. The TipTap schema is the SHARED collabExtensions()
 * from @prism/core, so HTML↔Yjs conversion matches the client exactly.
 */
import { accessRevision, onAccessChanged } from "./access-events";
import { systemNoteReason } from "@prism/core/pages";
import { Hocuspocus, type Connection } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import type { IncomingMessage, Server } from "node:http";
import * as Y from "yjs";
import { yDocToProsemirrorJSON, updateYFragment, initProseMirrorDoc } from "@tiptap/y-tiptap";
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { inferContentType } from "@prism/core/content-types";
import { createHash } from "node:crypto";
// Content conversion (Markdown / HTML / ProseMirror) NEVER runs unbounded on this
// thread: everything goes through the conversion service (worker thread + hard
// timeout); the `…Bounded` forms convert inline only for small, pre-checked input.
import { FIELD as DOC_FIELD, schema } from "./convert/core";
import {
  ConversionError,
  contentToDocJson,
  contentToDocJsonBounded,
  contentToSeed,
  contentToSeedBounded,
  conversionRefusal,
  docJsonToHtml,
  docJsonToHtmlBounded,
  htmlToDocJson,
  htmlToDocJsonBounded,
  isDeterministicFailure,
  type ConversionFailure,
  type ConvertOptions,
  type DocJson,
} from "./convert/service";
import { VaultConflictError, VaultError } from "./parachute";
import { config } from "./config";
import { vaultClient } from "./parachute";
import { verifyCapability } from "./auth/capability";
import { verifyPeerConnToken } from "./auth/peer-conn";
import { isLocalRequest } from "./auth/local";
import { deviceEmail } from "./auth/device";
import {
  getSession,
  grantsForUser,
  grantsForCapability,
  getDocState,
  saveDocState,
  getDocMeta,
  saveDocAhead,
  saveDocAttempt,
  confirmDocAttempt,
  rebaseDoc,
  deleteDocState,
  markCollabUnsaved,
  clearCollabUnsaved,
  isCollabUnsaved,
  getCollabUnsaved,
  dueCollabUnsaved,
  noteCollabUnsavedAttempt,
  type DocMeta,
  type DocState,
  saveDocStateConfirming,
  takeUnconfirmedCollabReceipts,
  unconfirmedCollabReceipts,
  type UnconfirmedCollabReceipt,
  getFederatedByKey,
  getPeer,
  grantsForPeer,
  getFederationEnabled,
  type Grant,
} from "./db";
import { effectiveLevel, effectiveCaps, atLeast, maxLevel, type Level } from "./permissions";
import { warmPageAnchors } from "./tree";
import { writerStamp } from "./sharing";
import { randomUUID } from "node:crypto";
import { createSuggestion, suggestionsForNote } from "./db";
import { suggestionAuthors, hasSuggestions, resolveSuggestions, summarizeSuggestions, identifiedSuggestions, plainTextOf, type IdentifiedSuggestion, type PmNode } from "./suggestions";
import { roleFloor, roleAtLeast, workspaceRole, type Role } from "./roles";

export const FIELD = DOC_FIELD; // TipTap's default XML fragment name
/** The shared TipTap/ProseMirror schema (WP6.3 collab-safe MCP ops mark the doc with it). */
export const collabSchema = () => schema;

// ── document conversions ────────────────────────────────────────────────────
// Two forms of each. The ASYNC form is what every code path that handles note
// content uses: it runs in the conversion worker under a wall-clock limit and
// throws ConversionError when the content cannot be converted in budget. The
// SYNCHRONOUS form (the original names) is BOUNDED: it converts on this thread
// only when the input passes the service's inline pre-check and throws
// ConversionError("too_large") otherwise — safe to call with anything, meant for
// small inputs (a command's one-paragraph window, tests).

/** Markdown/HTML → an empty Y.Doc's encoded state for the shared fragment (bounded, synchronous). */
export function contentToYUpdate(content: string): Uint8Array {
  return contentToSeedBounded(content ?? "");
}
/** The same, for any note body: converted off the main thread. Throws ConversionError. */
export function contentToYUpdateAsync(content: string, opts?: ConvertOptions): Promise<Uint8Array> {
  return contentToSeed(content ?? "", opts);
}

/** A live document as ProseMirror JSON (linear, cheap — no DOM). */
export function yDocToDocJson(doc: Y.Doc): DocJson {
  return yDocToProsemirrorJSON(doc, FIELD) as DocJson;
}

/** The HTML a store writes for `doc` (bounded, synchronous). */
export function yDocToHtml(doc: Y.Doc): string {
  return docJsonToHtmlBounded(yDocToDocJson(doc));
}
/** The same for a document of any size: rendered off the main thread. Throws ConversionError. */
export function yDocToHtmlAsync(doc: Y.Doc, opts?: ConvertOptions): Promise<string> {
  return docJsonToHtml(yDocToDocJson(doc), opts);
}

/** Render a ProseMirror document of the shared schema to the HTML a store would write (bounded, synchronous). */
export function proseToHtml(node: { toJSON(): unknown }): string {
  return docJsonToHtmlBounded(node.toJSON());
}
export function proseToHtmlAsync(node: { toJSON(): unknown }): Promise<string> {
  return docJsonToHtml(node.toJSON());
}

// ---- server-side suggested edits (G2b) ----
// Pure transforms live in ./suggestions (PM JSON); these wrappers own the
// HTML⇄JSON rendering with the shared schema.

/** Distinct suggestion-mark authors present in a note's HTML ("" if none). */
export function suggestionAuthorsInHtml(html: string): string[] {
  if (!html.includes("data-suggestion")) return []; // cheap pre-check
  return suggestionAuthors(htmlToDocJsonBounded(html) as PmNode);
}

/** Apply accept/reject of an author's suggestion marks to a note's HTML (bounded, synchronous). */
export function resolveSuggestionsInHtml(html: string, author: string | null, action: "accept" | "reject"): string {
  const json = htmlToDocJsonBounded(html) as PmNode;
  if (!hasSuggestions(json, author)) return html;
  return docJsonToHtmlBounded(resolveSuggestions(json, author, action));
}
/** The same for a note of any size (parse + render off the main thread). Throws ConversionError. */
export async function resolveSuggestionsInHtmlAsync(html: string, author: string | null, action: "accept" | "reject", opts?: ConvertOptions): Promise<string> {
  const json = (await htmlToDocJson(html, opts)) as PmNode;
  if (!hasSuggestions(json, author)) return html;
  return docJsonToHtml(resolveSuggestions(json, author, action), opts);
}

/** Identified suggestions (id → actor + text) in a note's HTML; empty when it has none (bounded, synchronous). */
export function identifiedSuggestionsInHtml(html: string): Map<string, IdentifiedSuggestion> {
  if (!html.includes("data-suggestion-id")) return new Map(); // cheap pre-check
  return identifiedSuggestions(htmlToDocJsonBounded(html) as PmNode);
}

/** A note's HTML as decoded reader text (entities resolved, tags gone) (bounded, synchronous). */
export function plainTextOfHtml(html: string): string {
  return plainTextOf(htmlToDocJsonBounded(html) as PmNode);
}

/**
 * Both of the above from ONE off-thread parse, for a note of any size. Throws
 * ConversionError. `suggestions` is empty (and nothing is parsed) when the HTML
 * carries no suggestion id and `always` is not set.
 */
export async function suggestionViewOfHtml(html: string, always = false): Promise<{ suggestions: Map<string, IdentifiedSuggestion>; plain: string | null }> {
  if (!always && !html.includes("data-suggestion-id")) return { suggestions: new Map(), plain: null };
  const json = (await htmlToDocJson(html)) as PmNode;
  return { suggestions: html.includes("data-suggestion-id") ? identifiedSuggestions(json) : new Map(), plain: plainTextOf(json) };
}

/** Summary line for the review inbox (bounded, synchronous). */
export function summarizeSuggestionsInHtml(html: string, author: string): string {
  return summarizeSuggestions(htmlToDocJsonBounded(html) as PmNode, author);
}

/**
 * Durable suggestion capture: when a persisted document carries suggestion
 * marks, ensure a pending_suggestions row exists per suggesting author, so the
 * owner has a review QUEUE (not just marks floating in the doc). Idempotent per
 * (note, author) while a pending row exists; errors never block the persist.
 */
function captureSuggestions(noteId: string, html: string, json: PmNode): void {
  try {
    // `json` is the document the store just rendered `html` from — no re-parse.
    if (!html.includes("data-suggestion")) return; // cheap pre-check
    const authors = suggestionAuthors(json).filter((a) => a !== "");
    if (authors.length === 0) return;
    const existing = suggestionsForNote(noteId).filter((s) => s.status === "pending");
    for (const author of authors) {
      if (existing.some((s) => s.author === author)) continue;
      createSuggestion({
        id: randomUUID(),
        space_note_key: null,
        note_id: noteId,
        author,
        author_kind: "user",
        summary: summarizeSuggestions(json, author),
        payload: "",
      });
    }
  } catch {
    /* capture is best-effort — never fail the persist */
  }
}

// ---- collab kinds (type-aware seeding/persistence) ----
// `document` → TipTap XML fragment (HTML). `code` → a Y.Text of raw source
// (CodeMirror binds to it). Spreadsheet/canvas get their own kinds as their
// collab editors land; until then they aren't routed to collab by the client.
export type CollabKind = "document" | "code" | "spreadsheet" | "canvas";
export const CODE_TEXT_FIELD = "codemirror";
export const SHEET_FIELD = "rows"; // Y.Array<Y.Array<string>>
export const CANVAS_FIELD = "elements"; // Y.Map<string, ExcalidrawElement>

interface NoteMeta {
  path: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  content?: string | null;
}

/** A note body that is an Excalidraw scene — ground truth for canvas (mirrors the
 *  client's looksLikeExcalidrawScene). */
function looksLikeExcalidrawScene(content: string | null | undefined): boolean {
  if (!content) return false;
  const c = content.trimStart();
  if (!c.startsWith("{") || !c.includes('"elements"')) return false;
  return c.includes('"appState"') || c.includes("excalidraw") || /"type"\s*:\s*"(rectangle|ellipse|diamond|arrow|line|freedraw|text|frame)"/.test(c);
}

/** Detect how a note should be seeded/persisted for collaboration. Delegates to
 *  the SHARED client `inferContentType` (collapsed to the four collab kinds) so
 *  server and client can never disagree — a divergence here means one side seeds
 *  a structure the other never reads, corrupting the note (e.g. a `.html` note
 *  the client renders as a document but the server once persisted as raw code,
 *  or a canvas the server saved as `<p></p>`). This IS the client's detectKind. */
export function noteKind(note: NoteMeta): CollabKind {
  const t = inferContentType({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
  return t === "canvas" || t === "code" || t === "spreadsheet" ? t : "document";
}

// ---- federation (Parachute-to-Parachute) ------------------------------------
// GATED behind config.federationEnabled. When OFF, federationTarget below always
// returns { noteId: documentName } with no kind, so loadDocumentState /
// storeDocumentState / resolveLevel behave byte-for-byte as they do today.

/** Origin tag for federation-applied (peer) edits — distinct from client and
 *  external-Parachute edits so loop-guards can ignore our own re-applies. */
export const PEER_ORIGIN = "peer-federation";

// ---- vault-scoped documentName ----------------------------------------------
// Hocuspocus routes by documentName, and a note id is only unique WITHIN a vault
// — so two vaults' note "42" would collide on ONE in-memory doc. We therefore
// encode the vault in the wire name: the PRIMARY vault uses a BARE note id
// (backward-compatible with existing clients + persisted collab_docs rows), and
// every other vault prefixes `${vaultId}::`. Federated docs are exempt (their
// space_note_key is already globally unique and resolved before this split).

/** The shape of a vault note id (the vault's own ids are timestamp/token
 *  strings). Paths, titles with spaces or dots, and `::` wire names are not ids.
 *  Shared by the collab socket and the human command endpoint. */
const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const isNoteId = (s: string): boolean => NOTE_ID_RE.test(s);

/** Compose the wire documentName for a (vault, note). Primary → bare id. */
export function docNameFor(vaultId: string, noteId: string): string {
  return vaultId === "primary" ? noteId : `${vaultId}::${noteId}`;
}
/** Split a NON-federated documentName back into (vaultId, noteId). */
export function parseDocName(documentName: string): { vaultId: string; noteId: string } {
  const i = documentName.indexOf("::");
  return i === -1
    ? { vaultId: "primary", noteId: documentName }
    : { vaultId: documentName.slice(0, i), noteId: documentName.slice(i + 2) };
}

/**
 * Resolve a collab documentName to the local vault note it maps to. For a
 * FEDERATED doc the wire documentName is the content-independent `space_note_key`
 * (shared by both hubs); we translate it to this hub's `local_id` (in the hub's
 * vault) for all vault I/O and PIN the kind recorded at join. For every
 * NON-federated doc — and whenever federation is disabled — the vault + note are
 * decoded from the wire name (primary → bare id), so a single-vault deploy is
 * byte-for-byte today's behavior.
 */
export function federationTarget(documentName: string): { noteId: string; vaultId: string; kind?: CollabKind } {
  if (getFederationEnabled()) {
    const fed = getFederatedByKey(documentName);
    if (fed) return { noteId: fed.local_id, vaultId: fed.vault_id ?? "primary", kind: fed.kind as CollabKind };
  }
  return federationTargetNonFed(documentName);
}
function federationTargetNonFed(documentName: string): { noteId: string; vaultId: string } {
  return parseDocName(documentName);
}

/** Raw text → a fresh Y.Doc's encoded state with the code in a Y.Text. */
export function codeToYUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText(CODE_TEXT_FIELD).insert(0, content ?? "");
  return Y.encodeStateAsUpdate(doc);
}

export function yDocToCode(doc: Y.Doc): string {
  return doc.getText(CODE_TEXT_FIELD).toString();
}

// ---- spreadsheet (CSV ⇄ Y.Array<Y.Array<string>>) ----
// Cell-level CRDT: each row is a Y.Array of cell strings, so concurrent edits to
// different cells/rows merge. Minimal CSV (no quoted-comma handling) to match the
// existing SpreadsheetRenderer; fidelity is exact for simple comma/newline data.
export function parseCsv(content: string): string[][] {
  if (!content.trim()) return [[""]];
  return content.split("\n").map((row) => row.split(","));
}

export function serializeCsv(rows: string[][]): string {
  return rows.map((r) => r.join(",")).join("\n");
}

export function csvToYUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  const rows = doc.getArray<Y.Array<string>>(SHEET_FIELD);
  for (const r of parseCsv(content)) {
    const yr = new Y.Array<string>();
    yr.insert(0, r);
    rows.push([yr]);
  }
  return Y.encodeStateAsUpdate(doc);
}

export function yDocToCsv(doc: Y.Doc): string {
  const rows = doc.getArray<Y.Array<string>>(SHEET_FIELD);
  const out: string[][] = [];
  rows.forEach((yr) => out.push(yr.toArray()));
  return serializeCsv(out);
}

// ---- canvas (Excalidraw scene JSON ⇄ Y.Map<id, element>) ----
// Each Excalidraw element is one Y.Map entry keyed by element id. Re-seeding is
// idempotent (set by id overwrites — no duplication) and concurrent edits to
// different elements merge. appState (zoom/scroll/cursor) is per-viewer and NOT
// synced; only elements are shared. Persisted as the same scene JSON the
// non-collab CanvasRenderer reads ({ elements, appState }).
export interface CanvasEl {
  id?: string;
  [k: string]: unknown;
}

export function parseScene(content: string): { elements: CanvasEl[]; appState: Record<string, unknown> } {
  if (!content || !content.trim()) return { elements: [], appState: {} };
  try {
    const d = JSON.parse(content);
    return { elements: Array.isArray(d.elements) ? d.elements : [], appState: d.appState ?? {} };
  } catch {
    return { elements: [], appState: {} };
  }
}

export function sceneToYUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  const map = doc.getMap<CanvasEl>(CANVAS_FIELD);
  for (const el of parseScene(content).elements) {
    if (el && typeof el.id === "string") map.set(el.id, el);
  }
  return Y.encodeStateAsUpdate(doc);
}

export function yDocToScene(doc: Y.Doc): string {
  const map = doc.getMap<CanvasEl>(CANVAS_FIELD);
  const elements: CanvasEl[] = [];
  map.forEach((el) => elements.push(el));
  return JSON.stringify({ elements, appState: {} });
}

/** Byte size of the HTML the last store rendered for a live document. The human
 *  command engine estimates a change's effect on the stored note as this plus
 *  the change's own delta, instead of re-rendering the whole document; every
 *  store replaces the estimate with the exact figure. */
const renderedSize = new WeakMap<Y.Doc, number>();
export const renderedSizeOf = (doc: Y.Doc): number | undefined => renderedSize.get(doc);
export const setRenderedSize = (doc: Y.Doc, bytes: number): void => void renderedSize.set(doc, bytes);

/** Make sure a live document's rendered size is known — measured OFF the main
 *  thread — before the synchronous command engine needs it. Throws ConversionError. */
export async function ensureRenderedSize(doc: Y.Doc, opts?: ConvertOptions): Promise<void> {
  if (renderedSize.get(doc) !== undefined) return;
  const size = Buffer.byteLength(await yDocToHtmlAsync(doc, opts));
  if (renderedSize.get(doc) === undefined) renderedSize.set(doc, size);
}

// Kind is stable per note; cache it at load so store doesn't need to re-fetch.
const kindCache = new Map<string, CollabKind>();

const toMs = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

// ---- external-edit reconciliation (live docs ⇄ Parachute) -------------------
// We seed a doc from Parachute only at load time. While a doc is live, an
// external writer editing the same note in Parachute (an MCP agent, the desktop
// app, a script) is invisible to connected editors — and worse, the next store
// would render the stale Yjs state over it. These helpers fold an external edit
// INTO the live Y.Doc: mutating it makes Hocuspocus broadcast to every client,
// and the store then preserves it instead of clobbering it.

/** Origin tag for server-applied external edits (distinct from client edits). */
export const EXTERNAL_ORIGIN = "external-parachute";

/** Per-doc high-water mark of the Parachute updatedAt we've already folded in,
 *  so we don't re-apply the same external edit on every tick. */
const lastReconciled = new Map<string, number>();

/**
 * Record that Parachute's copy at `updatedAtMs` is already reflected in the live
 * doc (WP6.3). Used after a metadata/tag/path-only write to a LIVE note: the
 * vault's updatedAt moves but its content does not, and without this the next
 * reconcile tick would fold that (content-stale) copy back over the live doc —
 * reverting any human typing not yet stored. Advances ONLY if `prevMs` (the vault
 * version the write replaced) was itself already absorbed — otherwise an unfolded
 * external content edit would be skipped. Monotonic; returns whether it advanced.
 */
export function markReconciled(documentName: string, prevMs: number, nextMs: number): boolean {
  const { vaultId, noteId } = federationTarget(documentName);
  if (prevMs <= 0 || reconcileBaseline(documentName, vaultId, noteId) < prevMs) return false;
  if (nextMs > (lastReconciled.get(documentName) ?? 0)) lastReconciled.set(documentName, nextMs);
  return true;
}

/** Test-only: drop the reconcile high-water marks (module state survives resetDb). */
export function resetReconcileState(): void {
  lastReconciled.clear();
}

/** Minimal in-place replace of a Y.Text: keep the common prefix/suffix so a
 *  viewer's cursor outside the changed span is preserved. */
function replaceYText(ytext: Y.Text, next: string): void {
  const cur = ytext.toString();
  if (cur === next) return;
  let start = 0;
  const min = Math.min(cur.length, next.length);
  while (start < min && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
  let ec = cur.length;
  let en = next.length;
  while (ec > start && en > start && cur.charCodeAt(ec - 1) === next.charCodeAt(en - 1)) {
    ec--;
    en--;
  }
  if (ec > start) ytext.delete(start, ec - start);
  if (en > start) ytext.insert(start, next.slice(start, en));
}

/** Rebuild a spreadsheet's rows in place (delete-then-insert within the caller's
 *  transaction — never push onto live rows, which would double them). */
function rebuildRows(rows: Y.Array<Y.Array<string>>, parsed: string[][]): void {
  if (rows.length) rows.delete(0, rows.length);
  rows.insert(
    0,
    parsed.map((r) => {
      const yr = new Y.Array<string>();
      yr.insert(0, r);
      return yr;
    }),
  );
}

/** Canvas: set elements by id (idempotent) and drop ids no longer present. */
function applyCanvasMap(map: Y.Map<CanvasEl>, content: string): void {
  const ids = new Set<string>();
  for (const el of parseScene(content).elements) {
    if (el && typeof el.id === "string") {
      map.set(el.id, el);
      ids.add(el.id);
    }
  }
  for (const k of Array.from(map.keys())) if (!ids.has(k)) map.delete(k);
}

/**
 * Fold Parachute's current content into a LIVE Y.Doc, in place. For a document
 * this is a minimal CRDT diff via updateYFragment — the same path TipTap's sync
 * plugin uses — so only changed nodes update and cursors are largely preserved.
 * On conflict with a concurrent in-flight client edit, Parachute's content wins
 * for the overlapping region (mirrors loadDocumentState's "external edit wins").
 */
export function applyExternalContent(doc: Y.Doc, kind: CollabKind, content: string, prepared?: DocJson | null): void {
  // A document's body is parsed BEFORE the transaction. Callers that handle note
  // content pass `prepared` (prepareExternalContent: off the main thread); without
  // it only a small, pre-checked body is converted here (else ConversionError).
  const json = kind === "document" ? (prepared ?? contentToDocJsonBounded(content ?? "")) : null;
  doc.transact(() => {
    if (kind === "code") {
      replaceYText(doc.getText(CODE_TEXT_FIELD), content ?? "");
    } else if (kind === "spreadsheet") {
      rebuildRows(doc.getArray<Y.Array<string>>(SHEET_FIELD), parseCsv(content ?? ""));
    } else if (kind === "canvas") {
      // Guard the transition: a legacy note mis-persisted as a document (`<p></p>`)
      // must NOT be folded into a live canvas — parseScene would yield zero
      // elements and applyCanvasMap would delete the real ones. Only apply when
      // the external content is actually a scene.
      if (looksLikeExcalidrawScene(content)) applyCanvasMap(doc.getMap<CanvasEl>(CANVAS_FIELD), content ?? "");
    } else {
      const pmNode = schema.nodeFromJSON(json);
      updateYFragment(doc, doc.getXmlFragment(FIELD), pmNode, { mapping: new Map(), isOMark: new Map() });
    }
  }, EXTERNAL_ORIGIN);
}

/**
 * The off-thread half of a fold: a DOCUMENT body → ProseMirror JSON in the
 * conversion worker (null for the other kinds, whose folds are linear). Throws
 * ConversionError when the body cannot be converted in budget — the caller must
 * then NOT store the live document over the note (see "degraded documents").
 */
export async function prepareExternalContent(kind: CollabKind, content: string, opts?: ConvertOptions): Promise<DocJson | null> {
  return kind === "document" ? contentToDocJson(content ?? "", opts) : null;
}

// ── content that cannot be converted in budget ─────────────────────────────
// A note body the conversion service refuses or cannot finish (a Markdown parser
// blow-up, absurd nesting, a body beyond the caps) is NEVER given a live
// document: nothing derived from it enters a Y.Doc, the SQLite snapshot or any
// client's local store. The load fails with `DocumentTooComplexError`; the
// socket is answered `too_complex: …` (the client then shows the stored note as
// read-only plain text over REST, with a plain-text editor for people who may
// edit — the stored content is intact and the REST path works on it), and direct
// connections (commands, MCP tools, block moves) get the error.
//
// A LIVE document whose note then changes to something unconvertible can no
// longer absorb it. It is BLOCKED: never written to the vault again (that would
// overwrite the newer note), every socket is dropped and new ones refused
// `too_complex`, so it unloads; the next open goes through the load above. Its
// Yjs state stays in SQLite untouched in meaning (source version kept), for the
// day the note converts again.

export const TOO_COMPLEX_REASON = "too_complex: This page is too large or complex for the live editor.";
export const BUSY_REASON = "busy: The server is busy. Try again in a moment.";
/** Thrown by `loadDocumentState` (and so by `openDirectConnection`) for a note that cannot be opened live. */
export class DocumentTooComplexError extends Error {
  readonly reason = TOO_COMPLEX_REASON;
  constructor(readonly failure: ConversionFailure) {
    super(TOO_COMPLEX_REASON);
  }
}
/** Thrown when a load could not get a converter slot: nothing is wrong with the note. */
export class CollabBusyError extends Error {
  readonly reason = BUSY_REASON;
  constructor() {
    super(BUSY_REASON);
  }
}

/** Loaded documents that may no longer be written to the vault (name → why). Cleared when the document unloads. */
const blockedDocs = new Map<string, ConversionFailure>();
export const isDocBlocked = (documentName: string): boolean => blockedDocs.has(documentName);
function blockDocument(documentName: string, reason: ConversionFailure): void {
  if (!blockedDocs.has(documentName)) console.warn(`[collab] ${documentName}: the note changed to content that cannot be converted (${reason}) — the live document is closed and will not be stored; the note is untouched`);
  blockedDocs.set(documentName, reason);
}

// ── what a snapshot is built on ─────────────────────────────────────────────
// The persisted row (`collab_docs`, see db.ts) says which vault CONTENT the
// snapshot is built on (`base_hash`), whether it is ahead of it, the true base
// state, and which writes were sent but never confirmed (`attempts`). The ONE
// rule below is applied at load, in the reconciler and in the store.

const contentHash = (content: string): string => createHash("sha256").update(content ?? "").digest("base64");

export type VaultRelation =
  /** Nothing newer than what the snapshot already absorbed. */
  | "same"
  /** A newer version with the SAME content: a metadata-only write (property, icon, backlink). Nothing to fold. */
  | "metadata"
  /** The content of a write WE sent and never saw confirmed: it landed. Ours — nothing to fold. */
  | "ours"
  /** Somebody else changed the content. */
  | "external";

/** How the vault's current copy relates to what the snapshot is built on. `absorbedMs` = the newest vault version already absorbed. */
export function vaultRelation(meta: DocMeta | null, note: { content: string; updatedAt: string | null }, absorbedMs: number): { relation: VaultRelation; hash: string | null } {
  if (toMs(note.updatedAt) <= absorbedMs) return { relation: "same", hash: null };
  // A row from before the hash existed (or no row): the version stamp is all there is.
  if (!meta || (meta.baseHash === null && meta.attempts.length === 0)) return { relation: "external", hash: null };
  const hash = contentHash(note.content);
  if (hash === meta.baseHash) return { relation: "metadata", hash };
  if (meta.attempts.includes(hash)) return { relation: "ours", hash };
  return { relation: "external", hash };
}

/** Is every client clock of `base` covered by `doc`? (base is an ancestor state of doc) */
function isAncestorOf(base: Uint8Array, doc: Y.Doc): boolean {
  const have = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVectorFromUpdate(base))) if ((have.get(client) ?? 0) < clock) return false;
  return true;
}

/**
 * Fold the vault's (externally changed) content into `doc`.
 *
 * With the TRUE BASE — the Yjs state that equals what the vault held before —
 * this is a three-way merge: the external change is applied to a fork of the
 * base and only the fork's delta reaches the document, so what people changed
 * since the base survives when the two sides touched different blocks (same-block
 * overlaps merge as two concurrent editors would).
 *
 * Without a base (a row from before bases were kept, a document whose base is
 * unknown, sheets and canvases) the vault's content REPLACES the document's —
 * "external wins", `wholesale: true`; the caller tells connected clients when
 * that may have discarded something.
 *
 * Returns the Yjs state that equals the vault content after the fold: the new base.
 */
function foldVaultContent(doc: Y.Doc, kind: CollabKind, content: string, prepared: DocJson | null, base: Uint8Array | null | Uint8Array[]): { base: Uint8Array; wholesale: boolean } {
  const candidates = (Array.isArray(base) ? base : base ? [base] : []).filter((b) => (kind === "document" || kind === "code") && isAncestorOf(b, doc));
  const uncertain = candidates.length > 1;
  const shape = (d: Y.Doc): string => (kind === "code" ? yDocToCode(d) : JSON.stringify(yDocToDocJson(d)));
  // The external change, as a delta against each candidate base.
  const forks = candidates.map((b) => {
    const fork = new Y.Doc();
    Y.applyUpdate(fork, b);
    const before = Y.encodeStateVector(fork);
    const was = uncertain ? shape(fork) : "";
    applyExternalContent(fork, kind, content, prepared);
    const delta = Y.encodeStateAsUpdate(fork, before);
    const nextBase = Y.encodeStateAsUpdate(fork);
    // "Contained": the vault's content is this candidate plus insertions only.
    const now = uncertain ? shape(fork) : "";
    const contained = uncertain && now.length >= was.length && changedSpan(was, now) === now.length - was.length;
    fork.destroy();
    return { delta, nextBase, contained };
  });
  // Which state the vault's copy was edited FROM is not always known (a write of
  // ours may or may not have landed before the external edit — `mergeBases`, which
  // lists the candidates OLDER FIRST). The two mistakes are not alike: a base that
  // is too OLD re-creates, under new ids, what the document already holds beyond
  // it (a duplicate — visible, and the guard below catches whole blocks); one
  // that is too NEW deletes typing that never reached the vault (silent loss).
  // So: the newest candidate the vault's content merely ADDS to is taken first
  // (our write is in there verbatim: it landed); otherwise the older one, and a
  // newer one only when the older would duplicate.
  const landedAt = forks.map((f) => f.contained).lastIndexOf(true);
  if (landedAt > 0) forks.unshift(...forks.splice(landedAt, 1));
  for (const fork of forks) {
    if (!uncertain) {
      Y.applyUpdate(doc, fork.delta, EXTERNAL_ORIGIN);
      return { base: fork.nextBase, wholesale: false };
    }
    // Uncertain base: try the merge on a copy first and never let a duplicate through.
    const trial = new Y.Doc();
    Y.applyUpdate(trial, Y.encodeStateAsUpdate(doc));
    const before = blockCounts(trial, kind);
    Y.applyUpdate(trial, fork.delta);
    const duplicated = hasDuplicatedBlocks(blockCounts(trial, kind), before, prepared);
    trial.destroy();
    if (duplicated) continue;
    Y.applyUpdate(doc, fork.delta, EXTERNAL_ORIGIN);
    return { base: fork.nextBase, wholesale: false };
  }
  if (uncertain) console.warn("[collab] an external edit could not be merged against any known base without duplicating content — the note's content replaces the document's");
  applyExternalContent(doc, kind, content, prepared);
  return { base: Y.encodeStateAsUpdate(doc), wholesale: true };
}

/** Size of the region in which two strings differ (common prefix and suffix removed, both sides counted). Linear. */
function changedSpan(a: string, b: string): number {
  const min = Math.min(a.length, b.length);
  let start = 0;
  while (start < min && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < min - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  return a.length + b.length - 2 * (start + end);
}

/** Top-level blocks of a document (as JSON text) → how often each occurs. Blocks without text (empty paragraphs, rules) are not counted. */
function blockCounts(source: Y.Doc | DocJson | null, kind: CollabKind): Map<string, number> {
  const out = new Map<string, number>();
  if (kind !== "document" || !source) return out;
  const json = (source instanceof Y.Doc ? yDocToDocJson(source) : source) as { content?: unknown[] };
  for (const block of json.content ?? []) {
    const key = JSON.stringify(block);
    if (!key.includes('"text"')) continue;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}
/**
 * The post-merge guard: a three-way merge never yields MORE copies of a block
 * than both sides together asked for — more than the document held before and
 * more than the vault's copy holds is the signature of a merge against a stale
 * base (the block was re-created instead of recognised).
 */
function hasDuplicatedBlocks(after: Map<string, number>, before: Map<string, number>, vault: DocJson | null): boolean {
  const theirs = blockCounts(vault, "document");
  for (const [block, n] of after) if (n > 1 && n > Math.max(before.get(block) ?? 0, theirs.get(block) ?? 0)) return true;
  return false;
}

/** How many of a note's newest history versions are searched for a write of ours. */
const LANDED_VERSIONS_SEARCHED = 6;
/**
 * Did one of this snapshot's UNCONFIRMED writes reach the vault before the copy
 * that is there now? The vault keeps what every write replaced (note history,
 * vault ≥ 0.7.9): a version whose content hashes to an attempt IS that write.
 *
 *  - a hash        → that attempted write landed (and was then edited over);
 *  - `null`        → history is complete back to the snapshot's own version and
 *                    holds none of them: no attempt landed;
 *  - `undefined`   → cannot tell (no history, unreachable, more versions than searched).
 */
async function landedAttempt(vaultId: string, noteId: string, meta: DocMeta | null): Promise<string | null | undefined> {
  if (!meta || meta.attempts.length === 0) return null;
  try {
    const vault = vaultClient(vaultId);
    const { versions, total } = await vault.listVersions(noteId, LANDED_VERSIONS_SEARCHED, 0);
    const since = meta.sourceUpdatedAt ?? 0;
    for (const v of versions) {
      // A version superseded no later than the snapshot's own source is the base or older.
      if (toMs(v.superseded_at) <= since) return null;
      const full = await vault.getVersion(noteId, v.version_ix);
      if (typeof full.content !== "string") return undefined;
      const hash = contentHash(full.content);
      if (meta.attempts.includes(hash)) return hash;
    }
    return total <= versions.length ? null : undefined;
  } catch {
    return undefined;
  }
}
/**
 * The base(s) an EXTERNAL change is merged against (see `foldVaultContent`).
 * Normally the row's base. With unconfirmed writes it depends on whether one of
 * them landed before the external edit was made (the store's write reached the
 * vault, its acknowledgement did not — or is still in flight — and someone
 * edited the note on top of it): then the base is THAT write's state, not the
 * older one the row still names. Merging against the older one re-creates what
 * was typed in between (`start / edit one / EXTERNAL / edit one`).
 */
function mergeBases(row: DocState | null, landed: string | null | undefined): Uint8Array | null | Uint8Array[] {
  if (!row) return null;
  if (row.attempts.length === 0 || landed === null) return row.base;
  const newest = row.attempts[row.attempts.length - 1];
  if (landed !== undefined && landed === newest && row.attemptState) return row.attemptState;
  // Unknown which (or an older attempt, whose state was not kept): the fold picks, and guards.
  // Older first: `foldVaultContent` prefers it on a tie.
  return [row.base, row.attemptState].filter((b): b is Uint8Array => b !== null);
}

// ── what connected clients are told (Hocuspocus stateless messages) ─────────
/**
 * `prism:unsaved` — this page's latest changes are NOT in the stored page (and why):
 * `unsaved` = they cannot be written as the page is (permanent); `pending` = not
 * written yet, the server keeps trying (a client from before this state ignores
 * it — it only knows `unsaved`); `saved` clears both. `prism:notice` — a one-off.
 */
export type CollabClientMessage =
  | { type: "prism:unsaved"; state: "unsaved"; reason: string }
  | { type: "prism:unsaved"; state: "pending"; reason: string }
  | { type: "prism:unsaved"; state: "saved" }
  | { type: "prism:notice"; code: "external-replaced" }
  /** The workspace owner discarded this page's unsaved live changes: what is shown is the stored page again. */
  | { type: "prism:notice"; code: "unsaved-discarded" };
/**
 * A one-off notice for a document that is still loading: delivered to the sockets
 * that connect to it NOW — the ones whose open triggered the load, within
 * `noticeTtlMs` — and then dropped. (It used to live until the document
 * unloaded, so everyone who joined a long-lived page hours later was told
 * "changes made elsewhere replaced part of this page" again.)
 */
const pendingNotices = new Map<string, { message: CollabClientMessage; until: number }>();
/** Tunables tests shorten. */
export const collabTuning = { noticeTtlMs: 15_000, /** How long a load / store waits between tries for a converter slot. */ busyWaitMs: 1500 };
function tellClients(documentName: string, message: CollabClientMessage): void {
  try {
    hocuspocus.documents.get(documentName)?.broadcastStateless(JSON.stringify(message));
  } catch {
    /* best-effort */
  }
}

/** Test-only: forget blocked documents and pending store retries. */
export function resetConversionState(): void {
  blockedDocs.clear();
  convertFailures.clear();
  pendingNotices.clear();
  for (const r of storeRetries.values()) clearTimeout(r.timer);
  storeRetries.clear();
}

/** A loaded-document registry — structurally what Hocuspocus exposes as
 *  `.documents`. Kept minimal so tests can pass a plain map of Y.Docs. */
export interface LiveDocs {
  documents: Map<string, Y.Doc>;
}

/** The Parachute updatedAt we've absorbed for a doc, beyond which a newer note
 *  is an unseen external edit. Max of our persisted snapshot and last apply. */
function reconcileBaseline(documentName: string, vaultId: string, noteId: string): number {
  return Math.max(getDocMeta(noteId, vaultId)?.sourceUpdatedAt ?? 0, lastReconciled.get(documentName) ?? 0);
}

/**
 * One reconciliation tick: for every loaded, connected doc whose Parachute copy
 * is newer than what we've persisted/applied, fold the external content in. This
 * is what makes an MCP-agent edit appear in open editors within one interval.
 */
export async function reconcileLoadedDocs(server: LiveDocs): Promise<void> {
  for (const [name, doc] of server.documents) {
    const d = doc as Y.Doc & { isLoading?: boolean; getConnectionsCount?: () => number };
    if (d.isLoading) continue; // mid-load — onLoadDocument owns seeding
    if (typeof d.getConnectionsCount === "function" && d.getConnectionsCount() === 0) continue; // about to unload
    // A live document that can no longer absorb its note must go away: drop its
    // sockets so it unloads; the next open loads from the note.
    if (isDocBlocked(name)) {
      dropConnections(name);
      continue;
    }
    const target = federationTarget(name);
    let note;
    try {
      note = await vaultClient(target.vaultId).getNote(target.noteId);
    } catch {
      continue; // unreadable/deleted — the load/store lifecycle handles it
    }
    const noteMs = toMs(note.updatedAt);
    if (noteMs === 0) continue;
    const meta = getDocMeta(target.noteId, target.vaultId);
    const { relation, hash } = vaultRelation(meta, note, reconcileBaseline(name, target.vaultId, target.noteId));
    if (relation === "same") continue;
    const kind = noteKind({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
    kindCache.set(name, kind);
    if (relation === "metadata") {
      // A newer version, the same content (a property, an icon, a backlink write): nothing to fold.
      rebaseDoc(target.noteId, target.vaultId, { source: noteMs });
      lastReconciled.set(name, noteMs);
      continue;
    }
    if (relation === "ours") {
      // A write we sent and never saw confirmed DID land: it is ours, not an external edit.
      rebaseDoc(target.noteId, target.vaultId, { source: noteMs, hash: hash!, base: "attempt" });
      lastReconciled.set(name, noteMs);
      continue;
    }
    let prepared: DocJson | null;
    try {
      prepared = await prepareExternalContent(kind, note.content, { actor: `doc:${name}` });
    } catch (e) {
      if (!(e instanceof ConversionError)) throw e;
      // Load-dependent (busy / timeout / a crashed worker): try again next tick.
      // The store's own guard keeps this note from being overwritten meanwhile.
      if (!isDeterministicFailure(e.reason) && !unconvertible(e.reason, name, note.content)) continue;
      // The note's new body cannot be converted, so this live document can no
      // longer absorb it — and must not be stored over it.
      blockDocument(name, e.reason);
      dropConnections(name);
      continue;
    }
    // Writes of ours that were never confirmed: did one land before this edit was made?
    const landed = await landedAttempt(target.vaultId, target.noteId, meta);
    // The conversion was awaited: the document may have unloaded, or been flagged, meanwhile.
    if (server.documents.get(name) !== doc || d.isLoading || isDocBlocked(name)) continue;
    // …and so may the note (a store of ours, another fold): only apply what is still news.
    if (noteMs <= reconcileBaseline(name, target.vaultId, target.noteId)) continue;
    const row = getDocState(target.noteId, target.vaultId);
    const fold = foldVaultContent(doc, kind, note.content, prepared, mergeBases(row, landed));
    // Persist the merged document WITH its new base, together: a snapshot must never
    // claim a base (the new vault content) that its state does not contain.
    if (row) {
      saveDocAhead(target.noteId, Y.encodeStateAsUpdate(doc), target.vaultId);
      rebaseDoc(target.noteId, target.vaultId, { source: noteMs, hash: hash ?? contentHash(note.content), base: fold.base });
    }
    lastReconciled.set(name, noteMs);
    // The document was ahead of a base nobody kept: what it held beyond the vault's copy is gone.
    if (fold.wholesale && row?.ahead) tellClients(name, { type: "prism:notice", code: "external-replaced" });
  }
}

/**
 * The close reason the shipped client reconnects on (CollabDoc: a reason starting
 * "Access changed." → re-check access, then reconnect). Reused for every server-
 * initiated "come back and get your current mode" close.
 */
const RECONNECT_REASON = "Access changed. Reconnect to check your permissions.";

/** Close every socket of a loaded document (they reconnect; a document with no sockets unloads). */
function dropConnections(documentName: string, reason = RECONNECT_REASON): void {
  const doc = hocuspocus.documents.get(documentName);
  for (const connection of doc?.getConnections() ?? []) {
    connection.readOnly = true;
    connection.close({ code: 4403, reason });
  }
}

/** Start the periodic reconciler; returns a stop fn. The timer is unref'd so it
 *  never keeps the process alive, and overlapping ticks are skipped. */
export function startReconciler(server: LiveDocs, intervalMs = 2000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void reconcileLoadedDocs(server).finally(() => {
      running = false;
    });
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/** Read a header whether `requestHeaders` is a Fetch Headers (typed) or a node
 *  IncomingMessage's plain object (what `ws` actually provides at runtime). */
function headerGet(h: unknown, key: string): string | null {
  if (!h) return null;
  const maybe = h as { get?: (k: string) => string | null };
  if (typeof maybe.get === "function") return maybe.get(key);
  const obj = h as Record<string, string | string[] | undefined>;
  const v = obj[key] ?? obj[key.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function sessionEmailFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)prism_session=([^;]+)/);
  if (!m || !m[1]) return null;
  const s = getSession(decodeURIComponent(m[1]));
  return s ? s.email : null;
}

/** Resolve the connection's effective level for a note (session wins over link).
 *  `isLocal` = the connection came straight from loopback (the desktop app), not
 *  the public tunnel; only then is the owner-token path honored. */
/**
 * Lock state per document, refreshed by every `resolveLevel` read of the note (it
 * reads the note anyway) and set directly by the pages lock route. A locked note's
 * sockets are read-only (lib/pages/model.ts LOCK_KEY).
 */
const lockedDocs = new Map<string, boolean>();

export async function resolveLevel(documentName: string, token: string, cookieHeader: string | null, isLocal = false): Promise<Level | null> {
  // Federation path (GATED): a documentName that is a known `space_note_key` is
  // opened EITHER by a peer hub (peer-conn token) OR by THIS hub's own client
  // (owner/session/capability) — both now connect under the space_note_key (gap
  // #2). When federation is off, getFederatedByKey is never consulted, so this
  // branch is inert and the path below is byte-for-byte today's.
  if (getFederationEnabled()) {
    const fed = getFederatedByKey(documentName);
    if (fed) {
      const fedVault = fed.vault_id ?? "primary";
      const claims = verifyPeerConnToken(token);
      if (claims) {
        // A PEER hub: authenticate the signing pubkey, require a paired peer
        // scoped to this doc's space, authorize via its space grants.
        if (claims.spaceId !== fed.space_id) return null;
        const peer = getPeer(claims.pubkey);
        if (!peer || !peer.paired_at) return null;
        let tags: string[] = [];
        try {
          tags = (await vaultClient(fedVault).getNote(fed.local_id)).tags ?? [];
        } catch {
          return null; // Cannot establish current privacy for an unreadable note.
        }
        // Read gate on the `view` CAP (WP0.2), like the non-peer path below. Peer
        // grants are level-only today (acl.ts writes no caps for them), so this is
        // identical in practice — it just keeps a future caps-carrying peer grant
        // without `view` from opening a read-only socket onto the note.
        const peerGrants = grantsForPeer(claims.pubkey);
        const peerRef = { id: fed.local_id, tags, spaceIds: [fed.space_id] };
        if (!effectiveCaps(peerGrants, peerRef, null).has("view")) return null;
        return effectiveLevel(peerGrants, peerRef, null);
      }
      // Not a peer-conn token → it's our OWN client opening the federated note by
      // its space_note_key. Authorize exactly like a normal note, against the
      // LOCAL id in the federated note's vault (re-encoded as a plain docName so
      // the recursion resolves that vault, never the space_note_key → no loop).
      return resolveLevel(docNameFor(fedVault, fed.local_id), token, cookieHeader, isLocal);
    }
  }

  // Non-federated: decode the vault + note from the wire name (primary → bare id).
  const { vaultId, noteId } = parseDocName(documentName);
  // A document is named by a note ID only. The vault also resolves a path or a
  // unique title for /notes/:x; a socket opened under such an alias would load
  // a SECOND Y.Doc (and snapshot row) for the same note, whose stores the
  // reconciler then folds over the real live document. Refuse non-id shapes
  // up front, and below refuse any name the vault resolved to a different id.
  // (Federated space keys never reach this line: they are mapped to their local
  // note id above.)
  if (!isNoteId(noteId)) return null;

  // Desktop owner path: the trusted Tauri app (on localhost) presents the dedicated
  // COLLAB_TOKEN to join live docs as the owner — kept separate from the vault token
  // so that powerful credential never enters the webview. LOCAL-ONLY: a token over
  // the public tunnel is ignored, so a leaked token grants nothing from the internet.
  // The vault token is accepted too (its holder already has full vault access).
  if (isLocal && token && ((config.collabToken && token === config.collabToken) || (config.parachuteToken && token === config.parachuteToken))) {
    // Same alias rule for the owner: a readable note must answer to this id.
    // (An unreadable note keeps the old behaviour — the owner may still open it.)
    try {
      const n = await vaultClient(vaultId).getNote(noteId);
      if (n.id !== noteId) return null;
      lockedDocs.set(documentName, n.metadata?.prism_locked === true);
    } catch {
      /* unreadable: unchanged */
    }
    return "own";
  }

  // A session cookie (browser), else a native device token passed as the
  // Hocuspocus `token` param (WP2.1) — same user, same effectiveLevel semantics.
  const email = sessionEmailFromCookie(cookieHeader) ?? deviceEmail(token);
  let grants: Grant[] = [];
  let role: Role = "guest";
  if (email) {
    // The authoritative per-vault role (membership row, else OWNER_EMAIL bootstrap
    // on primary, else guest) — so a signed-in user's floor is scoped to THIS
    // vault, never leaking owner/admin reach across tenants.
    role = workspaceRole(email, vaultId);
    grants = grantsForUser(email, vaultId);
  }
  if (role !== "owner" && token && token !== "session") {
    const claims = verifyCapability(token);
    if (claims) grants = grants.concat(grantsForCapability(claims.id).filter((g) => g.vault_id === vaultId));
  }
  let tags: string[] = [];
  let path: string | null = null;
  let creator: string | null = null;
  let visibility: "private" | "workspace" = "workspace";
  await warmPageAnchors(grants); // page-subtree grants need the tree (NP-CO-09)
  try {
    const note = await vaultClient(vaultId).getNote(noteId);
    if (note.id !== noteId) return null; // resolved through a path/title alias
    lockedDocs.set(documentName, note.metadata?.prism_locked === true);
    tags = note.tags ?? [];
    path = note.path ?? null;
    // Private-to-creator also gates LIVE editing: a private note is editable only
    // by its creator (or an explicit per-note grant), never via a tag/role floor.
    creator = (note.metadata?.prism_creator as string | undefined) ?? null;
    visibility = note.metadata?.prism_visibility === "private" ? "private" : "workspace";
  } catch {
    if (role !== "owner") return null; // Never infer public visibility from a failed read.
  }
  return collabLevelFor(grants, { id: noteId, tags, path, creator, visibility }, role, email ?? null);
}

/**
 * The collab level a set of grants confers on a note — the ONE projection the
 * socket (`resolveLevel`) and the human command endpoint (routes/human-collab.ts)
 * share, so the two can never disagree about who may suggest or edit.
 *
 * Collab authorization goes through the CAPS, projected onto the ladder this
 * socket understands (P1/P2). Two asymmetries the level column alone gets wrong:
 *  - a caps grant that omits `view` (a create-only drop-box) projects to level
 *    "view" for ladder consumers, but confers NO read — refuse the socket, or
 *    it leaks a note the HTTP gateway refuses to serve;
 *  - a caps grant like ["view","suggest","edit"] (a governance role's compiled
 *    grant) projects to level "view" via levelForCaps' containment rule, but its
 *    holder may PATCH over HTTP — the socket must grant the same write access.
 * For level-only grants caps === the level's expansion, so this returns exactly
 * effectiveLevel and every pre-caps grant behaves identically.
 */
export function collabLevelFor(
  grants: Grant[],
  noteRef: { id: string; tags: string[]; path?: string | null; creator: string | null; visibility: "private" | "workspace" },
  role: Role,
  email: string | null,
): Level | null {
  const lvl = effectiveLevel(grants, noteRef, roleFloor(role), email);
  const caps = effectiveCaps(grants, noteRef, roleFloor(role), email);
  // A TRUE system note (`systemNoteReason`: agent-*/alert tags, `vault/agent`, any
  // governance record — NOT ingest notes like meetings, tasks, people or threads,
  // which collaborators edit) is READ-ONLY for everyone below workspace admin, whatever
  // their grants (an `own` grant on its tag included): the same rule as the gateway's
  // PATCH. "view" = a read-only socket, and no commands.
  if (!roleAtLeast(role, "admin") && systemNoteReason({ path: noteRef.path ?? null, tags: noteRef.tags })) return caps.has("view") ? "view" : null;
  if (lvl === "own") return "own";
  if (!caps.has("view")) return null;
  if (caps.has("edit")) return maxLevel(lvl, "edit");
  if (caps.has("suggest")) return maxLevel(lvl, "suggest");
  if (caps.has("comment")) return maxLevel(lvl, "comment");
  return lvl ?? "view";
}

/** The lowest level whose socket may send raw Yjs updates: "edit" while
 *  suggest-only enforcement is on (default), the legacy "suggest" when the
 *  COLLAB_SUGGEST_ENFORCED=false rollback switch is set. Read per call. */
export function rawWriteLevel(): Level {
  return config.collabSuggestEnforced ? "edit" : "suggest";
}

/**
 * Authorize a collab connection against a note. Throws "Forbidden" below
 * "view"; marks the connection read-only below the raw-write level (EDIT, or
 * "suggest" with the kill switch off — see `rawWriteLevel`), so view / comment /
 * suggest connections can watch but every raw update they send is refused.
 * Returns the effective level. The client learns the outcome from Hocuspocus's
 * Authenticated message (provider `authorizedScope`: "readonly" | "read-write").
 * Extracted from the Hocuspocus hook so it is directly testable.
 */
export async function authorizeConnection(
  documentName: string,
  token: string,
  cookieHeader: string | null,
  connectionConfig: { readOnly: boolean },
  isLocal = false,
): Promise<Level> {
  const revision = accessRevision();
  const level = await resolveLevel(documentName, token, cookieHeader, isLocal);
  if (revision !== accessRevision()) throw new Error("Access changed. Reconnect.");
  if (!atLeast(level, "view")) throw new Error("Forbidden");
  // A LOCKED page (metadata.prism_locked) is read-only for every socket, owner included.
  connectionConfig.readOnly = !atLeast(level, rawWriteLevel()) || lockedDocs.get(documentName) === true;
  return level as Level;
}

/** Keep the unconfirmed receipts whose change is still present in `doc`; clean
 *  up and forget the rest. Returns the rowids kept. Registered by human-collab.ts. */
let commandEffects: ((doc: Y.Doc, pending: UnconfirmedCollabReceipt[]) => number[]) | null = null;
export function setCommandEffectsCheck(fn: typeof commandEffects): void {
  commandEffects = fn;
}

/** Undo what unconfirmed human commands left in a restored snapshot. Registered
 *  by human-collab.ts (which imports this module — a setter avoids the cycle). */
let lostCommandCleanup: ((doc: Y.Doc, lost: UnconfirmedCollabReceipt[]) => void) | null = null;
export function setLostCommandCleanup(fn: typeof lostCommandCleanup): void {
  lostCommandCleanup = fn;
}

/**
 * Seed a Y.Doc for a note. Prefers persisted CRDT state for continuity, but if
 * Parachute was edited externally since we last stored (its updatedAt is newer
 * than our recorded source), the external edit wins and we re-seed from it.
 * Leaves the doc empty if nothing is loadable. Mutates and returns `doc`.
 */
/**
 * Run a conversion, waiting out a saturated converter: `busy` says nothing about
 * the content, and giving up on it costs something real (a failed open, an
 * unsaved store) — so a load and a store wait for a slot a few times first.
 */
const BUSY_RETRIES = 5;
async function patiently<T>(convert: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await convert();
    } catch (e) {
      if (!(e instanceof ConversionError) || e.reason !== "busy" || attempt >= BUSY_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, collabTuning.busyWaitMs));
    }
  }
}
/**
 * Has this content now failed (timeout / worker crash) twice for this document?
 * One such failure may be the server's load; the same content failing again is
 * treated as unconvertible. `busy` never counts.
 */
const convertFailures = new Map<string, { hash: string; count: number }>();
function unconvertible(reason: ConversionFailure, documentName: string, content: string): boolean {
  if (reason === "busy") return false;
  const hash = contentHash(content);
  const prev = convertFailures.get(documentName);
  const count = prev && prev.hash === hash ? prev.count + 1 : 1;
  convertFailures.set(documentName, { hash, count });
  return count >= 2;
}

export async function loadDocumentState(documentName: string, doc: Y.Doc, opts?: ConvertOptions): Promise<Y.Doc> {
  const target = federationTarget(documentName); // non-federated → decoded (vault, note)
  let note: { content: string; updatedAt: string | null } | null = null;
  let kind: CollabKind = target.kind ?? kindCache.get(documentName) ?? "document";
  try {
    const n = await vaultClient(target.vaultId).getNote(target.noteId);
    note = { content: n.content, updatedAt: n.updatedAt };
    if (!target.kind) kind = noteKind({ path: n.path, tags: n.tags, metadata: n.metadata, content: n.content });
    kindCache.set(documentName, kind);
  } catch {
    /* note may not be readable; leave empty */
  }

  // "Already populated this run" guard is kind-specific (document → XML fragment,
  // code → Y.Text, spreadsheet → Y.Array). Without it a reconnect re-seeds over live edits.
  const populated =
    kind === "code"
      ? doc.getText(CODE_TEXT_FIELD).length > 0
      : kind === "spreadsheet"
        ? doc.getArray(SHEET_FIELD).length > 0
        : kind === "canvas"
          ? doc.getMap(CANVAS_FIELD).size > 0
          : doc.getXmlFragment(FIELD).length > 0;
  if (populated) {
    takeUnconfirmedCollabReceipts(documentName); // as before: a (re)load forgets them, whatever it finds
    return doc;
  }

  const stored = getDocState(target.noteId, target.vaultId);
  // THE rule (see `vaultRelation`): is the vault's copy news for this snapshot?
  // Decided by CONTENT, not by the version stamp alone — a metadata-only write
  // (or our own write whose acknowledgement was lost) moves the stamp and must
  // never fold the vault's body back over a snapshot that is ahead of it.
  const rel = stored && note ? vaultRelation(stored, note, stored.sourceUpdatedAt ?? 0) : { relation: "same" as VaultRelation, hash: null };
  const externallyEdited = rel.relation === "external";

  // A DOCUMENT's body is converted in the worker BEFORE anything is applied or
  // consumed (the doc is still loading: nothing else can touch it across this
  // await). A body that cannot be converted gets NO live document — the load
  // fails and nothing derived from that body is put into Yjs or SQLite.
  let folded: DocJson | null = null; // the note's body, for the fold into stored state
  let seeded: Uint8Array | null = null; // the note's body, as a first-ever seed
  // An external edit over a snapshot with unconfirmed writes: which state was it made on?
  const landed = stored && externallyEdited ? await landedAttempt(target.vaultId, target.noteId, stored) : null;
  if (kind === "document" && note && (stored ? externallyEdited : true)) {
    try {
      const body = note.content;
      if (stored) folded = await patiently(() => prepareExternalContent(kind, body, opts));
      else seeded = await patiently(() => contentToYUpdateAsync(body, opts));
    } catch (e) {
      if (!(e instanceof ConversionError)) throw e;
      // A saturated converter says nothing about this note: the client retries.
      if (e.reason === "busy") throw new CollabBusyError();
      throw new DocumentTooComplexError(e.reason);
    }
  }
  // The load will succeed from here on (everything below is synchronous).
  // A (re)load starts a NEW in-memory document. Any human command still marked
  // 'applied' for THIS document name (never confirmed by a store) belonged to a
  // previous instance that is gone — a crash, or an unload before its store
  // succeeded. Forget those receipts now, so a retry re-applies the command
  // rather than replaying a result for a change that was lost; what they may
  // have left in a half-saved snapshot is removed below. Taken only once the load
  // cannot fail any more: a load that fails (busy converter, unconvertible note)
  // must not consume them. Confirmed ('durable') receipts survive every reload.
  const lost = takeUnconfirmedCollabReceipts(documentName);
  blockedDocs.delete(documentName);
  convertFailures.delete(documentName);
  const noteMs = note ? toMs(note.updatedAt) : 0;

  /** Does the restored snapshot hold changes the vault lacks? (then it is kept `ahead` and written later) */
  let ahead = false;
  if (stored) {
    // Always restore the persisted CRDT state first: it carries the doc's stable
    // Yjs client IDs. A reconnecting client (in-session, or via IndexedDB across
    // reloads) then merges IDENTICAL items → idempotent, no duplication.
    Y.applyUpdate(doc, stored.state);
    ahead = stored.ahead;
    if (note && rel.relation === "metadata") {
      // Same content, newer version: the snapshot stands; only its stamp moves.
      rebaseDoc(target.noteId, target.vaultId, { source: noteMs });
    } else if (note && rel.relation === "ours") {
      // The vault holds a write we sent and never saw confirmed. The snapshot
      // contains it (it was saved before the write was sent): nothing to fold.
      rebaseDoc(target.noteId, target.vaultId, { source: noteMs, hash: rel.hash!, base: "attempt" });
      ahead = true; // unknown whether it holds MORE than that write: the retry below settles it
    } else if (note && externallyEdited) {
      // Parachute's content changed underneath the snapshot: fold that edit in via
      // a CRDT diff (never an additive re-seed, which would stack a second copy of
      // the whole note on the first) — three-way against the true base when the
      // snapshot is ahead, so what was typed and what was changed elsewhere both
      // survive.
      const fold = foldVaultContent(doc, kind, note.content, folded, mergeBases(stored, landed));
      if (stored.ahead && !fold.wholesale) {
        saveDocAhead(target.noteId, Y.encodeStateAsUpdate(doc), target.vaultId);
        rebaseDoc(target.noteId, target.vaultId, { source: noteMs, hash: rel.hash ?? contentHash(note.content), base: fold.base });
      } else {
        // The document IS the vault's content now (it was not ahead, or its base
        // was unknown and the external edit replaced it).
        if (stored.ahead) {
          console.warn(`[collab] ${documentName}: the note changed elsewhere and this snapshot's base is unknown — the note's content replaced unsaved changes`);
          pendingNotices.set(documentName, { message: { type: "prism:notice", code: "external-replaced" }, until: Date.now() + collabTuning.noticeTtlMs }); // told to whoever opens it now
        }
        ahead = false;
      }
    }
  } else if (note) {
    const seed =
      kind === "code"
        ? codeToYUpdate(note.content)
        : kind === "spreadsheet"
          ? csvToYUpdate(note.content)
          : kind === "canvas"
            ? sceneToYUpdate(note.content)
            : seeded!;
    Y.applyUpdate(doc, seed); // first-ever seed into a fresh, empty doc
  }
  // A snapshot written by a FAILED store (or one taken while a command's own
  // vault write was still pending) can hold pieces of a command that was never
  // confirmed. Remove exactly what those forgotten commands left behind, so the
  // document is consistent and the retry starts from the pre-command state.
  if (lost.length > 0 && kind === "document") {
    try {
      lostCommandCleanup?.(doc, lost);
    } catch (e) {
      console.error("[collab] lost-command cleanup failed:", e instanceof Error ? e.message : "unknown");
    }
  }
  // Persist NOW, even without an edit. Otherwise a view-only note (which never
  // triggers a store) has no stored state, so every connection re-seeds a fresh
  // client-ID copy and reconnecting clients accumulate duplicates (the "content
  // repeats again and again" bug). Recording it means the next load restores this
  // exact state instead of re-seeding.
  // A note already stored as collab HTML renders back to (about) its own size;
  // the next store replaces this with the exact figure. Markdown sources are
  // left unknown — the command engine measures those once when it needs to.
  if (note && kind === "document" && note.content.trimStart().startsWith("<")) setRenderedSize(doc, Buffer.byteLength(note.content));
  if (note) {
    if (ahead) {
      // The snapshot is ahead of the vault: it stays marked so (its base and
      // source version already say what it is built on) and the note is written
      // once the document is up.
      saveDocAhead(target.noteId, Y.encodeStateAsUpdate(doc), target.vaultId);
      const unsaved = getCollabUnsaved(target.noteId, target.vaultId);
      if (!unsaved?.permanent) scheduleStoreRetry(documentName, target.noteId, target.vaultId, unsaved?.reason ?? "pending");
    } else {
      // The document IS the vault content at this version.
      saveDocState(target.noteId, Y.encodeStateAsUpdate(doc), noteMs, target.vaultId, contentHash(note.content));
      clearCollabUnsaved(target.noteId, target.vaultId);
    }
    lastReconciled.set(documentName, noteMs);
  } else if (stored?.ahead || isCollabUnsaved(target.noteId, target.vaultId)) {
    // The note could not be READ just now, and the snapshot holds changes it
    // lacks. Nothing above scheduled their write (it all hangs off the note), and
    // the sweep leaves loaded documents to their own timer — without one, a page
    // opened during a vault outage kept its changes unsaved for as long as it
    // stayed open with nobody typing.
    if (!getCollabUnsaved(target.noteId, target.vaultId)?.permanent) scheduleStoreRetry(documentName, target.noteId, target.vaultId, "unreadable");
  }
  if (kind === "document") lastSuggestions.set(documentName, suggestionTexts(doc));
  collabWriters.delete(documentName);
  if (kind === "document") {
    try {
      storeListener?.loaded?.(documentName, doc);
    } catch {
      /* best-effort */
    }
  }
  return doc;
}

// ── Writer attribution for collab stores (NP-PG-13 / NP-PG-17) ──────────────
// A collab store writes the note on behalf of whoever changed the live doc since
// the last store. We stamp the MOST RECENT writer as `metadata.prism_last_writer`
// (the gateway's writer stamp, writer-stamp.ts: an OPAQUE subject id, or "link"
// for a capability guest, with `prism_last_write_at`) plus
// `metadata.prism_last_change` = `<kind>@<write time>`, the KIND of that change: "edit" (typed in the live editor), "suggestion" (a human
// command), "agent" (a Prism MCP tool) or "accepted-suggestion" (an edit that
// resolved suggestion marks by accepting them). History and page info read these
// to say who changed what. Server-internal writes (reconciler folds, restores,
// federation) carry no writer and leave the stamp untouched.
export type CollabChangeKind = "edit" | "suggestion" | "agent";
const collabWriters = new Map<string, Map<string, CollabChangeKind>>();
/** Record that `writer` changed `documentName` (most recent last). */
export function noteCollabWriter(documentName: string, writer: string | null, kind: CollabChangeKind): void {
  if (!writer) return;
  let m = collabWriters.get(documentName);
  if (!m) collabWriters.set(documentName, (m = new Map()));
  m.delete(writer);
  m.set(writer, kind);
}
const writerByContext = new WeakMap<object, string | null>();
function socketWriter(context: Partial<LiveAccess> | undefined): string | null {
  if (!context || typeof context !== "object" || context.level === undefined) return null;
  if (writerByContext.has(context)) return writerByContext.get(context) ?? null;
  let who: string | null = null;
  if (context.isLocal && context.token && ((config.collabToken && context.token === config.collabToken) || (config.parachuteToken && context.token === config.parachuteToken))) who = config.ownerEmail;
  else who = sessionEmailFromCookie(context.cookie ?? null) ?? deviceEmail(context.token ?? "") ?? (context.token && context.token !== "session" && verifyCapability(context.token) ? "link" : null);
  writerByContext.set(context, who);
  return who;
}

/** Suggestion ids → their inserted/deleted text, from a document's prose. */
function suggestionTexts(doc: Y.Doc): Map<string, { ins: string; del: string }> {
  const out = new Map<string, { ins: string; del: string }>();
  const frag = doc.getXmlFragment(FIELD);
  if (frag.length === 0) return out;
  let prose;
  try {
    prose = initProseMirrorDoc(frag, schema).doc;
  } catch {
    return out;
  }
  prose.descendants((n) => {
    if (!n.isText || !n.text) return;
    for (const m of n.marks) {
      if (m.type.name !== "insertion" && m.type.name !== "deletion") continue;
      const id = String(m.attrs.suggestionId ?? m.attrs.id ?? "");
      if (!id) continue;
      const e = out.get(id) ?? { ins: "", del: "" };
      if (m.type.name === "insertion") e.ins += n.text;
      else e.del += n.text;
      out.set(id, e);
    }
  });
  return out;
}
const lastSuggestions = new Map<string, Map<string, { ins: string; del: string }>>();

/** The stamp for a store of `documentName`, consuming the recorded writers. */
function takeWriterStamp(documentName: string, doc: Y.Doc, kind: string): Record<string, string> | null {
  const writers = collabWriters.get(documentName);
  collabWriters.delete(documentName);
  let accepted = false;
  if (kind === "document") {
    const before = lastSuggestions.get(documentName);
    const now = suggestionTexts(doc);
    lastSuggestions.set(documentName, now);
    if (before && writers?.size) {
      const plain = doc.getXmlFragment(FIELD).toString().replace(/<[^>]*>/g, "");
      for (const [id, s] of before) {
        if (now.has(id)) continue;
        // Gone: accepted when its inserted text survived (or, for a pure deletion, its text is gone).
        if ((s.ins && plain.includes(s.ins)) || (!s.ins && s.del && !plain.includes(s.del))) accepted = true;
      }
    }
  }
  if (!writers?.size) return null;
  const [writer, change] = [...writers.entries()].pop()!;
  // The opaque subject id + time + kind (writer-stamp.ts / sharing.ts) — never an email.
  return writerStamp(writer, accepted && change === "edit" ? "accepted-suggestion" : change);
}

/**
 * Observer of persisted documents (wave 2A notifications: mention diff +
 * backlinks, comment replies). Registered by notifications.ts; collab.ts never
 * imports it. `editors` = the accounts whose sockets / commands changed this doc
 * since its previous store (every one of them is an author of the batch).
 */
export interface DocumentStoredEvent {
  docName: string;
  vaultId: string;
  noteId: string;
  prevContent: string | null;
  content: string;
  updatedAt: string | null;
  doc: Y.Doc;
  editors: string[];
}
export interface DocumentStoreListener {
  loaded?(docName: string, doc: Y.Doc): void;
  unloaded?(docName: string): void;
  stored(e: DocumentStoredEvent): void;
}
let storeListener: DocumentStoreListener | null = null;
export function setDocumentStoreListener(l: DocumentStoreListener | null): void {
  storeListener = l;
}
const docEditors = new Map<string, Set<string>>();
/** Record who changed a live doc (Hocuspocus onChange context). */
export function noteDocEditor(docName: string, context: unknown): void {
  const c = (context ?? {}) as { email?: unknown; human?: unknown; mcp?: unknown };
  const email = typeof c.email === "string" ? c.email
    : typeof c.human === "string" && c.human.startsWith("user:") ? c.human.slice(5)
    : typeof c.mcp === "string" ? c.mcp : null;
  if (!email) return;
  let set = docEditors.get(docName);
  if (!set) docEditors.set(docName, (set = new Set()));
  if (set.size < 50) set.add(email.toLowerCase());
}
function takeDocEditors(docName: string): string[] {
  const set = docEditors.get(docName);
  docEditors.delete(docName);
  return set ? [...set] : [];
}

/**
 * Persist a Y.Doc: render to HTML and write back to Parachute, then store the
 * Yjs binary in SQLite (with the resulting source updatedAt) for CRDT
 * continuity. A vault write failure still persists local state so edits aren't
 * lost. Extracted from the Hocuspocus hook so it is directly testable.
 */
// ── stores that could not reach the vault ──────────────────────────────────
// A store ALWAYS saves the Yjs state to SQLite (that needs no HTML). When the
// note itself could not be written, the snapshot is marked AHEAD of the vault
// (its base and source version are kept — nothing is ever folded back over it)
// and the note is recorded in `collab_unsaved`:
//
//  - load-dependent failures (the converter was busy / timed out / crashed, the
//    vault was unreachable or answered 5xx, the note kept changing): retried —
//    while the document is loaded by a timer with backoff, after an unload by
//    the sweep in `attachCollab`, and at the next load;
//  - failures retrying cannot fix (the document is beyond what can be rendered
//    or re-opened; the vault refuses the body: 413 over 2 MB, 400/422): the row
//    is PERMANENT — not retried, and everyone on the page is told (a stateless
//    `prism:unsaved` message, repeated to each socket that connects) so the
//    client never shows "Saved". The next store that does reach the vault clears
//    it; the Yjs state stays in SQLite and is restored whenever the page opens.
const storeRetries = new Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>();
const STORE_RETRY_MS = [3_000, 10_000, 30_000, 60_000];
/**
 * How long until store attempt number `attempts` (1-based) of a loaded document.
 * 3 s, 10 s, 30 s, 60 s, then DOUBLING — it used to stay at 60 s forever, and a
 * render that times out costs a worker thread each time (killed and respawned):
 * under a swap storm every loaded document did that once a minute. Capped at
 * 30 min when the converter is the cause (`timeout` / `failed`), 5 min otherwise
 * (the vault being down costs nothing to ask again).
 */
export function storeRetryDelayMs(attempts: number, reason: string): number {
  if (attempts <= STORE_RETRY_MS.length) return STORE_RETRY_MS[Math.max(1, attempts) - 1]!;
  const cap = reason === "timeout" || reason === "failed" ? 30 * 60_000 : 5 * 60_000;
  return Math.min(cap, 60_000 * 2 ** Math.min(attempts - STORE_RETRY_MS.length, 10));
}

/** Store a LOADED document again later (no-op once it has unloaded: the sweep and the next load take over). */
function scheduleStoreRetry(documentName: string, noteId: string, vaultId: string, reason: string): void {
  markCollabUnsaved(noteId, vaultId, documentName, reason, false);
  // The badge of everyone on the page must not say "Saved" meanwhile (L7).
  tellClients(documentName, { type: "prism:unsaved", state: "pending", reason });
  const prev = storeRetries.get(documentName);
  if (prev) clearTimeout(prev.timer);
  const attempts = (prev?.attempts ?? 0) + 1;
  const timer = setTimeout(() => {
    const live = hocuspocus.documents.get(documentName);
    if (!live || live.isLoading) return void storeRetries.delete(documentName);
    void storeLoadedDocument(live).catch(() => {});
  }, storeRetryDelayMs(attempts, reason));
  (timer as { unref?: () => void }).unref?.();
  storeRetries.set(documentName, { timer, attempts });
}
function cancelStoreRetry(documentName: string): void {
  const retry = storeRetries.get(documentName);
  if (retry) clearTimeout(retry.timer);
  storeRetries.delete(documentName);
}
/** The note cannot be written until the page itself changes: record it, stop retrying, tell everyone on the page. */
function storeRefused(documentName: string, noteId: string, vaultId: string, reason: string): void {
  cancelStoreRetry(documentName);
  const known = getCollabUnsaved(noteId, vaultId);
  markCollabUnsaved(noteId, vaultId, documentName, reason, true);
  if (!known?.permanent) console.error(`[collab] ${documentName}: the page cannot be saved to the vault (${reason}) — its changes are kept in the server's document store; people on the page are told`);
  tellClients(documentName, { type: "prism:unsaved", state: "unsaved", reason });
}
function storeSucceeded(documentName: string, noteId: string, vaultId: string): void {
  cancelStoreRetry(documentName);
  const known = getCollabUnsaved(noteId, vaultId);
  if (!known) return;
  clearCollabUnsaved(noteId, vaultId);
  tellClients(documentName, { type: "prism:unsaved", state: "saved" });
}

const UNSAVED_SWEEP_MS = 60_000;
const UNSAVED_GIVE_UP_MS = 14 * 24 * 3600_000;

/**
 * Write the notes of documents that are NOT loaded but whose last store never
 * reached the vault (the tab closed while the converter was busy, a restart).
 * Opening a direct connection loads the snapshot; disconnecting stores it.
 * Rows are taken least-recently-attempted first with a per-row exponential
 * backoff, so a note that keeps failing cannot starve the others. A deleted
 * note drops its row; a row nobody could write for two weeks stops being retried
 * (kept, logged, alerted through `/acl/workers` — never silently, and its Yjs
 * state is never deleted).
 */
export async function sweepUnsavedDocuments(limit = 5, at = Date.now()): Promise<void> {
  for (const row of dueCollabUnsaved(limit, at)) {
    const loaded = hocuspocus.documents.get(row.doc_name);
    if (loaded) {
      // Its own retry timer handles it — if it has one. A loaded document with an
      // unsaved row and NO timer (however it got there) is stored from here.
      if (!storeRetries.has(row.doc_name) && !loaded.isLoading) {
        noteCollabUnsavedAttempt(row.name, row.vault_id, at);
        await storeLoadedDocument(loaded).catch(() => {});
      }
      continue;
    }
    if (at - row.since > UNSAVED_GIVE_UP_MS) {
      markCollabUnsaved(row.name, row.vault_id, row.doc_name, "gave_up", true);
      console.error(`[collab] ${row.doc_name}: not saved to the vault for 14 days (${row.reason ?? "unknown"}) — retries stop; its changes stay in the server's document store and open with the page`);
      continue;
    }
    noteCollabUnsavedAttempt(row.name, row.vault_id, at);
    try {
      await vaultClient(row.vault_id).getNote(row.name);
    } catch (e) {
      if (e instanceof VaultError && e.status === 404) {
        clearCollabUnsaved(row.name, row.vault_id);
        console.warn(`[collab] ${row.doc_name}: the note was deleted while changes to it were unsaved — nothing left to write`);
      }
      continue; // unreachable: tried again after its backoff
    }
    try {
      const conn = await hocuspocus.openDirectConnection(row.doc_name, {});
      await conn.disconnect();
    } catch {
      /* unconvertible or busy now: stays recorded, tried again after its backoff */
    }
  }
}

export type UnsavedSettlement = "clear" | "pending" | "permanent" | "unloadable";
/**
 * For REST writers of a note's BODY: is there live state the vault does not have?
 * A note with an unsaved snapshot is given one chance to be written right now
 * (load + store). `clear` = the vault is current, write away (your version check
 * decides). `pending` = the snapshot is still ahead: a body write now would be
 * based on stale content — answer 409 `conflict {live, retry}`. `permanent` = the
 * snapshot is ahead and CANNOT be written as it is (too large to render, refused
 * by the vault, given up on): waiting changes nothing — answer a NON-retry error
 * (`unsavedPermanentBody`). `unloadable` = the
 * note itself cannot be opened live (unconvertible): REST is the only way to fix
 * it, so the write goes through; the snapshot is merged three-way at the next
 * load that succeeds.
 */
export async function settleUnsaved(vaultId: string, noteId: string): Promise<UnsavedSettlement> {
  const row = getCollabUnsaved(noteId, vaultId);
  if (!row) return "clear";
  // A row that can never be written as it is: loading and storing it again changes
  // nothing — and used to cost a load, a render and a refused vault write on EVERY
  // body write to the page (M-2). (A loaded one is its own document's business.)
  if (row.permanent && !hocuspocus.documents.has(row.doc_name)) return "permanent";
  if (!hocuspocus.documents.has(row.doc_name)) {
    try {
      const conn = await hocuspocus.openDirectConnection(row.doc_name, {});
      await conn.disconnect();
    } catch (e) {
      if (e instanceof DocumentTooComplexError) return "unloadable";
      return "pending";
    }
  }
  const after = getCollabUnsaved(noteId, vaultId);
  return !after ? "clear" : after.permanent ? "permanent" : "pending";
}
/** Why this note's live changes can NEVER be written as they are (null: they can, or there are none). */
export function unsavedPermanentReason(vaultId: string, noteId: string): string | null {
  const row = getCollabUnsaved(noteId, vaultId);
  return row?.permanent ? (row.reason ?? "unknown") : null;
}
/** In words, for an error message (see also the client's `unsavedExplanation`). */
export function unsavedReasonText(reason: string | null): string {
  if (reason === "gave_up") return "saving them was tried for two weeks without success";
  if (reason && reason.startsWith("vault ")) return reason === "vault 413" ? "the stored page would be larger than the vault accepts" : "the vault refuses the page's content";
  return "the page is too large or complex to be stored";
}
/** The 409 body for a body write to a page whose live changes can never be saved as they are: NOT a retry. */
export function unsavedPermanentBody(reason: string | null): { error: "unsaved_permanent"; live: true; retry: false; reason: string; detail: string } {
  return {
    error: "unsaved_permanent",
    live: true,
    retry: false,
    reason: reason ?? "unknown",
    detail: `This page has changes from the live editor that cannot be saved to the stored page (${unsavedReasonText(reason)}). Retrying will not help: open the page and make it smaller, or ask the workspace owner to discard the unsaved changes.`,
  };
}

/**
 * The way out of a page that can never be saved (M2): DISCARD the live changes
 * the vault lacks. The snapshot is not deleted — it is brought back to the
 * vault's content IN PLACE (the note's body replaces the document's, as an
 * external edit without a base does), so the Yjs history and client ids stay:
 * a browser that still holds the old state locally converges on the stored
 * page instead of merging a second copy into a fresh document. Works on the
 * loaded document when the page is open (everyone on it sees the stored page —
 * and is TOLD: `prism:notice unsaved-discarded`).
 *
 * Round 5 (M-5):
 *  - Only for a page that can NEVER be saved (a permanent row). One the server is
 *    still retrying needs `force` — it is not stuck, it is late (`not_permanent`).
 *  - Serialised with the document's STORE (Hocuspocus' per-document save mutex):
 *    a store that snapshotted the document before the discard used to finish
 *    afterwards and write the discarded text to the vault. The discard now waits
 *    for it and decides on what is true THEN (often: nothing left to discard).
 *  - A document that is being LOADED right now is answered `busy`: its load has
 *    already read the snapshot this would rewrite.
 * Returns what happened; throws nothing for a note without unsaved changes.
 */
export type DiscardOutcome = { discarded: boolean; live: boolean; permanent: boolean; reason: "none" | "unreadable" | "busy" | "not_permanent" | null };
export async function discardUnsavedChanges(vaultId: string, noteId: string, opts: { force?: boolean } = {}): Promise<DiscardOutcome> {
  const documentName = getCollabUnsaved(noteId, vaultId)?.doc_name ?? docNameFor(vaultId, noteId);
  const loaded = hocuspocus.documents.get(documentName);
  if (hocuspocus.loadingDocuments.has(documentName) || loaded?.isLoading) return { discarded: false, live: false, permanent: !!getCollabUnsaved(noteId, vaultId)?.permanent, reason: "busy" };
  if (!loaded) return discardNow(vaultId, noteId, documentName, null, opts.force === true);
  return loaded.saveMutex.runExclusive(() => discardNow(vaultId, noteId, documentName, loaded, opts.force === true));
}
type LoadedDocument = typeof hocuspocus.documents extends Map<string, infer D> ? D : never;
/** The discard itself. `held` = the loaded document whose save mutex the caller holds (null: none was loaded when it asked). */
async function discardNow(vaultId: string, noteId: string, documentName: string, held: LoadedDocument | null, force: boolean): Promise<DiscardOutcome> {
  // Read only now: a store that was in flight has finished, and may have saved everything.
  const row = getCollabUnsaved(noteId, vaultId);
  const snapshot = getDocState(noteId, vaultId);
  if (!row && !snapshot?.ahead) return { discarded: false, live: false, permanent: false, reason: "none" };
  const permanent = !!row?.permanent;
  if (!permanent && !force) return { discarded: false, live: false, permanent, reason: "not_permanent" };
  let note;
  try {
    note = await vaultClient(vaultId, { timeoutMs: 15_000 }).getNote(noteId);
  } catch {
    return { discarded: false, live: false, permanent, reason: "unreadable" };
  }
  const kind = federationTarget(documentName).kind ?? noteKind({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
  let prepared: DocJson | null = null;
  let convertible = true;
  try {
    prepared = await prepareExternalContent(kind, note.content);
  } catch (e) {
    if (!(e instanceof ConversionError)) throw e;
    if (e.reason === "busy") return { discarded: false, live: false, permanent, reason: "busy" };
    convertible = false; // the note has no live document at all: the snapshot is simply dropped below
  }
  // ── synchronous from here ──
  // The document this works on must still be the one whose mutex is held; one that
  // appeared (or is appearing) meanwhile has read the snapshot already.
  const liveDoc = hocuspocus.documents.get(documentName) ?? null;
  if (liveDoc !== held || hocuspocus.loadingDocuments.has(documentName) || liveDoc?.isLoading) return { discarded: false, live: false, permanent, reason: "busy" };
  const live = !!liveDoc;
  const noteMs = toMs(note.updatedAt);
  cancelStoreRetry(documentName);
  if (!convertible) {
    if (live) dropConnections(documentName);
    deleteDocState(noteId, vaultId);
  } else {
    const doc = live ? (liveDoc as unknown as Y.Doc) : new Y.Doc();
    const current = getDocState(noteId, vaultId); // (the awaits above: re-read)
    if (!live && current) Y.applyUpdate(doc, current.state);
    // Replace, then record the document as in step with the vault.
    applyExternalContent(doc, kind, note.content, prepared);
    saveDocState(noteId, Y.encodeStateAsUpdate(doc), noteMs, vaultId, contentHash(note.content));
    if (live) {
      lastReconciled.set(documentName, noteMs);
      collabWriters.delete(documentName);
      if (kind === "document") setRenderedSize(doc, Buffer.byteLength(note.content));
    } else doc.destroy();
  }
  clearCollabUnsaved(noteId, vaultId);
  if (live) {
    tellClients(documentName, { type: "prism:notice", code: "unsaved-discarded" });
    tellClients(documentName, { type: "prism:unsaved", state: "saved" });
  }
  console.warn(`[collab] ${documentName}: unsaved live changes were discarded on request — the document is the stored page again`);
  return { discarded: true, live, permanent, reason: null };
}
/** Must a body write to this note go through (or wait for) the live document? Loaded, or holding unsaved live state. */
export function hasLiveState(vaultId: string, noteId: string): boolean {
  return isDocLive(vaultId, noteId) || isCollabUnsaved(noteId, vaultId);
}

/** How often a store re-reads, merges, re-renders and retries its write when the note changed underneath it. */
const STORE_ATTEMPTS = 3;
/** Vault answers that no retry can change: the body is refused (too large for a note with history, malformed). */
const PERMANENT_VAULT_STATUS = new Set([400, 413, 422]);

/**
 * Persist a Y.Doc: render to HTML and write back to Parachute, and store the
 * Yjs binary in SQLite for CRDT continuity. Extracted from the Hocuspocus hook
 * so it is directly testable.
 *
 * Invariants:
 *  - The snapshot row always says what it is built on (`collab_docs`, db.ts).
 *    A CONFIRMED write stores exactly the state that was rendered and written
 *    (`ahead = 0`: the row IS the vault content — the only state a three-way
 *    merge may use as its base). Anything else stores the latest state marked
 *    AHEAD, keeping the true base and the source version.
 *  - The state and the hash of what is about to be written are saved BEFORE the
 *    vault write is sent: if the acknowledgement is lost, the vault's copy is
 *    recognised as ours (never folded back as an "external edit").
 *  - The vault write is compare-and-set on the version this store read. A note
 *    that changed in between is re-read: a metadata-only change needs nothing, a
 *    changed BODY is merged three-way against the true base (both sides survive
 *    when they touch different blocks), then the document is re-rendered and the
 *    write tried again, a bounded number of times.
 *  - A note whose version is known but which could not be READ now is not
 *    written at all (an unconditioned write could overwrite an edit we did not see).
 *  - Nothing written to the vault is something the live editor could not re-open.
 */
export async function storeDocumentState(documentName: string, doc: Y.Doc): Promise<void> {
  const target = federationTarget(documentName); // non-federated → decoded (vault, note)
  const { noteId, vaultId } = target;
  /** Save the latest Yjs state without claiming any vault write: marked ahead, base and source kept. */
  const keepAhead = () => saveDocAhead(noteId, Y.encodeStateAsUpdate(doc), vaultId);
  // A blocked document (its note changed to something it cannot absorb) is never
  // written to the vault: that would overwrite the newer note.
  if (isDocBlocked(documentName)) return void keepAhead();

  // Fetch the current note up front: it resolves the kind (a wrong default would
  // persist e.g. code as HTML and corrupt the note) AND lets us detect an
  // external edit we haven't folded in yet. Stores are debounced, so the read is
  // cheap; on failure we fall back to the cached kind.
  let kind = target.kind ?? kindCache.get(documentName);
  let current: { content: string; updatedAt: string | null } | null = null;
  const readNote = async (): Promise<boolean> => {
    try {
      const n = await vaultClient(vaultId).getNote(noteId);
      current = { content: n.content, updatedAt: n.updatedAt };
      if (!kind) kind = noteKind({ path: n.path, tags: n.tags, metadata: n.metadata, content: n.content });
      return true;
    } catch {
      return false; // note unreadable — keep cached kind (or default below)
    }
  };
  const readable = await readNote();
  if (!kind) kind = "document";
  kindCache.set(documentName, kind);
  // Its own actor: a document whose renders keep timing out cools down by itself (H-1) — never the store lane.
  const lane: ConvertOptions = { lane: "store", actor: `doc:${documentName}` };

  type Failure = { reason: string; permanent: boolean; retry: boolean };
  let failure: Failure | null = null;
  let vaultWritten = false; // the vault copy now reflects (or already matched) the rendered doc
  // The note's version is known but it cannot be read right now: an unconditioned
  // write could overwrite an edit made since. Keep the state; write later.
  if (!readable && (getDocMeta(noteId, vaultId)?.sourceUpdatedAt ?? null) !== null) failure = { reason: "unreadable", permanent: false, retry: true };

  try {
    for (let attempt = 1; attempt <= STORE_ATTEMPTS && !vaultWritten && !failure; attempt++) {
      const note = current as { content: string; updatedAt: string | null } | null;
      // Clobber guard: if Parachute is newer than what we've absorbed, merge that
      // external edit into the live doc BEFORE rendering, so the write below
      // carries it instead of overwriting it (and connected clients see it too).
      // A zero baseline means we have no prior knowledge of this note (e.g. a store
      // with no preceding load) — the live doc is authoritative, so don't fold. In
      // the real Hocuspocus flow onLoadDocument always runs first and sets it.
      if (note) {
        const noteMs = toMs(note.updatedAt);
        const baseline = reconcileBaseline(documentName, vaultId, noteId);
        const { relation, hash } = baseline > 0 ? vaultRelation(getDocMeta(noteId, vaultId), note, baseline) : { relation: "same" as VaultRelation, hash: null };
        if (relation === "metadata") {
          // Only metadata moved (a property, an icon, a backlink write): nothing to fold.
          rebaseDoc(noteId, vaultId, { source: noteMs });
          lastReconciled.set(documentName, noteMs);
        } else if (relation === "ours") {
          // A write of ours whose acknowledgement was lost: it landed. Not an external edit.
          rebaseDoc(noteId, vaultId, { source: noteMs, hash: hash!, base: "attempt" });
          lastReconciled.set(documentName, noteMs);
        } else if (relation === "external") {
          let prepared: DocJson | null = null;
          try {
            const body = note.content;
            prepared = await patiently(() => prepareExternalContent(kind!, body, lane));
          } catch (e) {
            if (!(e instanceof ConversionError)) throw e;
            // The vault holds a newer body this document cannot absorb. Writing
            // the live state now would OVERWRITE that edit, so nothing is written
            // (the vault's copy stands). Unconvertible content blocks the
            // document; a load-dependent failure is retried later.
            if (isDeterministicFailure(e.reason) || unconvertible(e.reason, documentName, note.content)) {
              blockDocument(documentName, e.reason);
              dropConnections(documentName);
            } else failure = { reason: e.reason, permanent: false, retry: true };
            break;
          }
          if (isDocBlocked(documentName)) break;
          const landed = await landedAttempt(vaultId, noteId, getDocMeta(noteId, vaultId));
          const row = getDocState(noteId, vaultId);
          const fold = foldVaultContent(doc, kind, note.content, prepared, mergeBases(row, landed));
          if (row) {
            saveDocAhead(noteId, Y.encodeStateAsUpdate(doc), vaultId);
            rebaseDoc(noteId, vaultId, { source: noteMs, hash: hash ?? contentHash(note.content), base: fold.base });
          }
          lastReconciled.set(documentName, noteMs);
          if (fold.wholesale && row?.ahead) tellClients(documentName, { type: "prism:notice", code: "external-replaced" });
        }
      }

      // Same tick as the snapshot below: exactly the commands this content
      // contains — and only those whose change is STILL in the document. A merge
      // of a newer vault copy (here above, or by the reconciler since the command
      // ran) can have removed a command's effect; confirming it would report a
      // lost change as applied. Those are cleaned up and forgotten instead (the
      // caller gets 503, the retry 409 stale_revision).
      const pending = kind === "document" ? unconfirmedCollabReceipts(documentName) : [];
      const rendered = pending.length && commandEffects ? commandEffects(doc, pending) : pending.map((r) => r.rowid);
      // The document is snapshotted HERE (same tick as `pending`): as ProseMirror
      // JSON — rendered to HTML off the main thread — and as the exact Yjs state
      // that JSON is. What is written to the vault and what is saved as "the
      // vault's content" are that one snapshot; typing that arrives during the
      // awaits below belongs to the next store.
      const docJson = kind === "document" ? yDocToDocJson(doc) : null;
      const snapshotState = Y.encodeStateAsUpdate(doc);
      // What the row was built on when this snapshot was taken. The render below is
      // awaited: if the reconciler merges an external edit meanwhile, the row moves
      // to a NEWER version (state, source and base together) and this snapshot is
      // older than the row — it must not be saved over it (see `saveDocAttempt`).
      const sourceAtSnapshot = getDocMeta(noteId, vaultId)?.sourceUpdatedAt ?? null;
      /** The row moved under this pass: read the note again and go round (bounded), like a 409. */
      const movedOn = async (): Promise<void> => {
        if (!(await readNote())) failure = { reason: "unreadable", permanent: false, retry: true };
        else if (attempt === STORE_ATTEMPTS) failure = { reason: "conflict", permanent: false, retry: true };
      };
      let content: string;
      if (docJson) {
        try {
          content = await patiently(() => docJsonToHtml(docJson, lane));
        } catch (e) {
          if (!(e instanceof ConversionError)) throw e;
          // Not rendered. The document STAYS LIVE and its Yjs state is saved
          // below; only the note waits (retried when the cause is the server's
          // load — a document beyond what can be rendered at all is not).
          failure = { reason: e.reason, permanent: isDeterministicFailure(e.reason), retry: !isDeterministicFailure(e.reason) };
          break;
        }
        if (isDocBlocked(documentName)) break; // flagged while rendering
        // Never write a body the live editor could not open again: the load's own
        // pre-check must accept what the store renders (by construction — a page
        // people can type into must be a page that re-opens).
        const reopen = conversionRefusal(content, false);
        if (reopen) {
          failure = { reason: reopen, permanent: true, retry: false };
          break;
        }
      } else content = kind === "code" ? yDocToCode(doc) : kind === "spreadsheet" ? yDocToCsv(doc) : yDocToScene(doc);
      if (kind === "document") setRenderedSize(doc, Buffer.byteLength(content));

      const hash = contentHash(content);
      let updatedRaw: string | null;
      if ((getDocMeta(noteId, vaultId)?.sourceUpdatedAt ?? null) !== sourceAtSnapshot) {
        await movedOn();
        continue;
      }
      if (note && content === note.content) {
        // Nothing to persist (e.g. the store right after folding an external edit
        // or a version restore). Skipping matters on vault ≥0.7.9: every write
        // captures a history version, so an identical re-write would clutter the
        // note's history with no-change entries and bump updatedAt for nothing.
        updatedRaw = note.updatedAt;
        saveDocStateConfirming(noteId, snapshotState, toMs(updatedRaw), vaultId, rendered, hash);
      } else {
        // Saved BEFORE the write is sent: the snapshot holds what is being written,
        // and its hash says "this vault copy is ours" whatever happens to the answer.
        if (!saveDocAttempt(noteId, snapshotState, hash, vaultId, sourceAtSnapshot)) {
          await movedOn();
          continue;
        }
        // Who gets the stamp is consumed by taking it; a write that does not land gives it back.
        const writersBefore = collabWriters.get(documentName);
        const suggestionsBefore = lastSuggestions.get(documentName);
        const giveBack = () => {
          if (writersBefore) collabWriters.set(documentName, new Map([...writersBefore, ...(collabWriters.get(documentName) ?? [])]));
          if (suggestionsBefore) lastSuggestions.set(documentName, suggestionsBefore);
        };
        const stamp = takeWriterStamp(documentName, doc, kind);
        try {
          // Compare-and-set on the version read above. Only a note with NO known
          // version (never read, never stored) is written unconditioned.
          const updated = await vaultClient(vaultId).updateNote(noteId, {
            content,
            ...(stamp ? { metadata: stamp } : {}),
            ...(note?.updatedAt ? { ifUpdatedAt: note.updatedAt } : {}),
          });
          updatedRaw = updated.updatedAt;
        } catch (e) {
          giveBack();
          const status = e instanceof VaultError ? e.status : 0;
          if (e instanceof VaultConflictError || status === 409) {
            // The note changed between our read and our write. Re-read it and go
            // round again: the guard above recognises our own lost write, sees
            // that only metadata moved, or merges a changed body — and the
            // document is snapshotted and rendered afresh.
            if (!(await readNote())) failure = { reason: "unreadable", permanent: false, retry: true };
            else if (attempt === STORE_ATTEMPTS) failure = { reason: "conflict", permanent: false, retry: true };
            continue;
          }
          if (status === 404) {
            // The note is gone: there is nothing to write this state to.
            failure = { reason: "vault 404", permanent: false, retry: false };
            console.warn(`[collab] ${documentName}: the note no longer exists — the live state is kept in the server's document store only`);
          } else if (PERMANENT_VAULT_STATUS.has(status)) failure = { reason: `vault ${status}`, permanent: true, retry: false };
          else failure = { reason: status ? `vault ${status}` : "vault unreachable", permanent: false, retry: true };
          break;
        }
        // Acknowledged: the snapshot saved with the attempt IS the vault content now.
        confirmDocAttempt(noteId, vaultId, toMs(updatedRaw), hash, rendered);
      }
      const sourceUpdatedAt = toMs(updatedRaw);
      vaultWritten = true;
      // Our own write (or the copy we matched) is absorbed: the reconciler must
      // never mistake it for an external edit.
      if (sourceUpdatedAt > (lastReconciled.get(documentName) ?? 0)) lastReconciled.set(documentName, sourceUpdatedAt);
      // G2b: persisted suggestion marks land in the owner's durable review queue.
      if (docJson) captureSuggestions(noteId, content, docJson as PmNode);
      // Wave 2A: mention / comment notifications + mention backlinks (fire-and-forget).
      if (kind === "document" && storeListener) {
        try {
          storeListener.stored({ docName: documentName, vaultId, noteId, prevContent: note?.content ?? null, content, updatedAt: updatedRaw, doc, editors: takeDocEditors(documentName) });
        } catch {
          /* notifications are best-effort — never fail the persist */
        }
      }
    }
  } catch {
    /* an unexpected failure: the state is kept below and the write tried again later */
    failure ??= { reason: "error", permanent: false, retry: true };
  }
  // A command applied during the awaits above is not in the snapshot that was
  // written; its own store (which its request is waiting on) confirms it, and if
  // that store fails the receipt stays unconfirmed and the caller is told to
  // retry — never a false success. A store that wrote nothing confirms nothing.
  if (vaultWritten) return void storeSucceeded(documentName, noteId, vaultId);
  // Nothing reached the vault: the latest state is saved AHEAD of it (base, source
  // version and attempted hashes kept — never a null source).
  keepAhead();
  if (isDocBlocked(documentName) || !failure) return;
  if (failure.permanent) storeRefused(documentName, noteId, vaultId, failure.reason);
  else if (failure.retry) scheduleStoreRetry(documentName, noteId, vaultId, failure.reason);
  else cancelStoreRetry(documentName);
}

/**
 * Schema handshake (C1). y-prosemirror DELETES every node/mark its schema cannot
 * represent, so a client built before the current document schema would destroy
 * newer content for everyone the moment it syncs. Live editors send their schema
 * version as `?schema=<n>` on the socket URL; a DOCUMENT-kind socket without it,
 * or with an older one, is refused outright (not read-only — a read-only socket
 * still renders the damage locally and the user would type into the void).
 * Code/sheet/canvas keep their own structures and stay ungated. Direct
 * connections (MCP tools, human commands, the federation applier) never pass
 * through onAuthenticate and are unaffected.
 */
export const UPDATE_REQUIRED_REASON = "update_required: Prism was updated. Reload or update the app to keep editing.";
export function clientSchemaVersion(params: URLSearchParams | null | undefined): number {
  const raw = params?.get("schema");
  const v = raw && /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
  return v;
}
async function documentKindOf(documentName: string): Promise<CollabKind> {
  const target = federationTarget(documentName);
  if (target.kind) return target.kind;
  const cached = kindCache.get(documentName);
  if (cached) return cached;
  try {
    const n = await vaultClient(target.vaultId).getNote(target.noteId);
    const kind = noteKind({ path: n.path, tags: n.tags, metadata: n.metadata, content: n.content });
    kindCache.set(documentName, kind);
    return kind;
  } catch {
    return "document"; // unknown → fail closed (only a stale client can hit this)
  }
}
/** Throws (reason `update_required: …`) for a stale client opening a document. */
export async function assertEditorSchema(documentName: string, params: URLSearchParams | null | undefined): Promise<void> {
  if (clientSchemaVersion(params) >= COLLAB_SCHEMA_VERSION) return;
  if ((await documentKindOf(documentName)) !== "document") return;
  throw Object.assign(new Error(UPDATE_REQUIRED_REASON), { reason: UPDATE_REQUIRED_REASON });
}

interface LiveAccess { level: Level; token: string; cookie: string | null; isLocal: boolean; email?: string | null }

/** The conversion service's fairness key for whoever a document is being loaded for. */
function actorOfContext(context: unknown): string | null {
  const c = (context ?? {}) as Partial<LiveAccess> & { human?: unknown; mcp?: unknown };
  if (typeof c.email === "string" && c.email) return `user:${c.email.toLowerCase()}`;
  if (typeof c.mcp === "string" && c.mcp) return `user:${c.mcp.toLowerCase()}`;
  if (typeof c.human === "string" && c.human) return c.human;
  if (typeof c.token === "string" && c.token && c.token !== "session") return `token:${createHash("sha256").update(c.token).digest("base64").slice(0, 16)}`;
  return null;
}

/** Recheck incoming updates against current grants, credentials and note privacy. */
async function revalidateConnection(connection: Connection<LiveAccess>): Promise<void> {
  const { context } = connection;
  try {
    if (!connection.document.hasConnection(connection) || !context) throw new Error("Access changed. Reconnect.");
    const revision = accessRevision();
    const level = await resolveLevel(connection.document.name, context.token, context.cookie, context.isLocal);
    if (revision !== accessRevision() || !connection.document.hasConnection(connection) || !level || level !== context.level) {
      throw new Error("Access changed. Reconnect.");
    }
    // A blocked document is being unloaded: its sockets reconnect and are answered `too_complex`.
    if (isDocBlocked(connection.document.name)) throw new Error("Document closed. Reconnect.");
    connection.readOnly = !atLeast(level, rawWriteLevel()) || lockedDocs.get(connection.document.name) === true;
  } catch (error) {
    connection.readOnly = true;
    connection.close({ code: 4403, reason: "Access changed. Reconnect to check your permissions." });
    throw error;
  }
}

/** Also checks idle readers, so expired credentials do not keep a live feed. */
export async function revalidateLiveAccess(): Promise<void> {
  const connections = [...hocuspocus.documents.values()].flatMap(doc => doc.getConnections());
  await Promise.allSettled(connections.map(connection => revalidateConnection(connection)));
}

export const hocuspocus = new Hocuspocus({
  async onAuthenticate(data) {
    const cookie = headerGet(data.requestHeaders, "cookie");
    // Local (loopback) connections carry no proxy headers; the tunnel always does.
    // Only local connections may use the owner-token path (see resolveLevel).
    const isLocal = isLocalRequest((k) => headerGet(data.requestHeaders, k));
    const level = await authorizeConnection(data.documentName, data.token, cookie, data.connectionConfig, isLocal);
    // After authorization, so the refusal is no oracle about a note's kind.
    await assertEditorSchema(data.documentName, data.requestParameters);
    // A loaded document that can no longer absorb its note takes no new sockets
    // (it is being unloaded): the client shows the stored note as plain text.
    if (isDocBlocked(data.documentName)) throw new DocumentTooComplexError(blockedDocs.get(data.documentName)!);
    // Credentials stay only in the connection's server-side context. `email`
    // attributes this socket's changes for notifications (never sent anywhere).
    const email = sessionEmailFromCookie(cookie) ?? deviceEmail(data.token);
    return { level, token: data.token, cookie, isLocal, email } satisfies LiveAccess;
  },
  // What a socket must know the moment it is on the page: that the page's latest
  // changes are not in the stored page (so its badge never says "Saved"), and a
  // notice raised while the document was loading.
  async connected(data) {
    try {
      const target = federationTarget(data.documentName);
      const unsaved = getCollabUnsaved(target.noteId, target.vaultId);
      // Always the CURRENT state: a tab that reconnects after the page was saved must stop saying "not saved".
      const state: CollabClientMessage = unsaved ? { type: "prism:unsaved", state: unsaved.permanent ? "unsaved" : "pending", reason: unsaved.reason ?? "unknown" } : { type: "prism:unsaved", state: "saved" };
      data.connection.sendStateless(JSON.stringify(state));
      const notice = pendingNotices.get(data.documentName);
      if (notice && Date.now() <= notice.until) data.connection.sendStateless(JSON.stringify(notice.message));
      else if (notice) pendingNotices.delete(data.documentName); // expired: a one-off, not a banner for every later visitor
    } catch {
      /* best-effort */
    }
  },
  async onChange(data) {
    noteDocEditor(data.documentName, data.context);
    // Attribute raw socket edits for history (read-only sockets never change a doc).
    if (data.connection) noteCollabWriter(data.documentName, socketWriter(data.context as Partial<LiveAccess>), "edit");
  },
  // Wave 2A (review L6): drop per-document notification state with the doc.
  async afterUnloadDocument(data) {
    docEditors.delete(data.documentName);
    collabWriters.delete(data.documentName);
    lastSuggestions.delete(data.documentName);
    blockedDocs.delete(data.documentName);
    pendingNotices.delete(data.documentName);
    convertFailures.delete(data.documentName);
    const retry = storeRetries.get(data.documentName);
    if (retry) clearTimeout(retry.timer);
    storeRetries.delete(data.documentName);
    try {
      storeListener?.unloaded?.(data.documentName);
    } catch {
      /* best-effort */
    }
  },
  async beforeHandleMessage({ connection }) {
    await revalidateConnection(connection);
  },
  async beforeSync({ connection }) {
    // A permission write can close the connection during an awaited message hook.
    if (!connection.document.hasConnection(connection)) throw new Error("Access changed. Reconnect.");
  },
  // Throws DocumentTooComplexError / CollabBusyError (each carries the `reason`
  // the client is answered with) when the note cannot be opened live. Nothing is
  // returned: the document is filled in place (returning it would make Hocuspocus
  // re-encode and re-apply its whole state to itself).
  async onLoadDocument(data) {
    try {
      await loadDocumentState(data.documentName, data.document, { actor: actorOfContext(data.context) });
    } catch (e) {
      // Hocuspocus never registered this Document, so it never destroys it either:
      // its Awareness keeps a live interval. Release it here, or every refused
      // open leaks one (and a test process never exits).
      try {
        data.document.awareness.destroy();
        data.document.destroy();
      } catch {
        /* already gone */
      }
      throw e;
    }
  },
  onStoreDocument: (data) => storeDocumentState(data.documentName, data.document),
});

// Hocuspocus 4.1 unloads BY NAME: `unloadDocument(doc)` checks only that SOME document
// is registered under `doc.name`, then deletes that entry and destroys `doc`. A late
// unload of a document that is already gone (the `setTimeout(0)` after a store, a
// released direct connection) therefore removed the NEWER document that had since been
// loaded under the same name: it stayed alive but unregistered — the people connected to
// it kept editing an orphan, the next open loaded a second copy from the vault, and its
// Awareness interval was never cleared. Likewise an unload requested while another
// document's unload under that name was still finishing was answered with THAT promise
// and silently skipped. Both are closed here: only the registered document is unloaded,
// and a request waits for an unload in progress before deciding.
{
  const unload = hocuspocus.unloadDocument.bind(hocuspocus);
  hocuspocus.unloadDocument = async (document) => {
    const pending = hocuspocus.unloadingDocuments.get(document.name);
    if (pending) await pending.catch(() => {});
    if (hocuspocus.documents.get(document.name) !== document) return;
    return unload(document);
  };
}

// Permission mutations invalidate sessions synchronously, before the response
// confirms revocation. The provider reconnects and receives its current mode.
// Scope to one vault when known; credential/peer revocations span vaults.
onAccessChanged((vaultId) => {
  for (const doc of hocuspocus.documents.values()) {
    if (vaultId && federationTarget(doc.name).vaultId !== vaultId) continue;
    for (const connection of doc.getConnections()) {
      connection.readOnly = true;
      connection.close({ code: 4403, reason: "Access changed. Reconnect to check your permissions." });
    }
  }
});

/**
 * Is this note's Yjs doc currently LOADED in the Hocuspocus server (someone has
 * it open, or it has not yet unloaded after the last disconnect)? Read-only
 * accessor for the MCP tools (WP6.2): a content write through the REST gateway
 * would race the live CRDT, so they refuse it while this is true.
 */
export function isDocLive(vaultId: string, noteId: string): boolean {
  const name = docNameFor(vaultId, noteId);
  // A blocked document is on its way out and is never stored again: for everyone
  // deciding "must I go through Yjs?", it is not live.
  return hocuspocus.documents.has(name) && !isDocBlocked(name);
}

/** The loaded Y.Doc to READ a note's live state from — undefined when not loaded or blocked. */
export function liveDocument(documentName: string): Y.Doc | undefined {
  if (isDocBlocked(documentName)) return undefined;
  return hocuspocus.documents.get(documentName) as Y.Doc | undefined;
}

/** Store a loaded document NOW through the normal hook path (bypassing the debounce). */
async function storeLoadedDocument(doc: (typeof hocuspocus.documents extends Map<string, infer D> ? D : never)): Promise<void> {
  await hocuspocus.storeDocumentHooks(
    doc,
    {
      clientsCount: doc.getConnectionsCount(),
      context: {},
      document: doc,
      documentName: doc.name,
      instance: hocuspocus,
      requestHeaders: new Headers(),
      requestParameters: new URLSearchParams(),
      socketId: "server",
      lastContext: {},
      lastTransactionOrigin: { source: "local" },
    } as never,
    true,
  );
}

/** Attach the collab WebSocket handler to the Node HTTP server at /collab. */
export function attachCollab(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (!request.url || !request.url.startsWith("/collab")) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Hocuspocus v3 only CREATES the connection here; we must pump WS messages
      // into it ourselves (its built-in path uses crossws, which we bypass).
      const connection = hocuspocus.handleConnection(ws as never, request as never) as {
        handleMessage(data: Uint8Array): void;
        handleClose(event: { code: number; reason: string }): void;
      };
      ws.on("message", (data: Buffer) => {
        connection.handleMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });
      ws.on("close", (code: number, reason: Buffer) => {
        connection.handleClose({ code, reason: reason?.toString() ?? "" });
      });
    });
  });

  // Watch loaded docs for external Parachute edits (MCP agent, desktop, scripts)
  // and fold them into the live Y.Doc so every open editor updates within a tick.
  const stopReconciler = startReconciler(hocuspocus as unknown as LiveDocs);
  server.on("close", stopReconciler);
  // Notes whose last live store never reached the vault and whose document has
  // since unloaded (tab closed while the converter was busy; a restart).
  let sweeping = false;
  const sweepTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweepUnsavedDocuments().finally(() => { sweeping = false; });
  }, UNSAVED_SWEEP_MS);
  sweepTimer.unref();
  server.on("close", () => clearInterval(sweepTimer));
  let checkingAccess = false;
  const accessTimer = setInterval(() => {
    if (checkingAccess) return;
    checkingAccess = true;
    void revalidateLiveAccess().finally(() => { checkingAccess = false; });
  }, 5_000);
  accessTimer.unref();
  server.on("close", () => clearInterval(accessTimer));

  // Federation (GATED): bring up the peer-bridge once collab is live. A no-op
  // unless getFederationEnabled() (the runtime flag, persisted; defaults to the
  // FEDERATION_ENABLED env) — and the module is imported LAZILY so the
  // @hocuspocus/provider client (and the whole federation path) never loads on
  // the default, non-federation deployment. Dynamic import also sidesteps the
  // collab ⇄ federation-manager import cycle (collab is fully loaded by now).
  // Runtime toggles after boot are handled by POST /acl/federation/enabled.
  if (getFederationEnabled()) {
    void import("./federation-manager")
      .then(({ federationManager }) => {
        federationManager.start();
        // Bind every already-known space×peer whose collab URL we have on record
        // (peers.collab_url, gap #1). No endpoints arg → self-discovers from the
        // peer registry. Re-run on demand from the ACL mutation hooks.
        void federationManager.syncSpaces();
        server.on("close", () => federationManager.stop());
      })
      .catch((e) => console.error("[federation] failed to start manager:", e));
  }
}

/**
 * The pages lock route toggled `prism_locked`: record it, and on LOCK drop every
 * writable connection to the doc (like an access change) so editors reconnect read-only.
 */
export function setNoteLocked(vaultId: string, noteId: string, locked: boolean): void {
  const name = docNameFor(vaultId, noteId);
  lockedDocs.set(name, locked);
  if (!locked) return;
  const doc = hocuspocus.documents.get(name);
  for (const connection of doc?.getConnections() ?? []) {
    if (connection.readOnly) continue;
    connection.readOnly = true;
    connection.close({ code: 4403, reason: "This page was locked. Reconnect to keep reading." });
  }
}

/** Store a live doc NOW (bypassing the debounce) — before a vault-side rewrite of its note. */
export async function flushLiveDoc(vaultId: string, noteId: string): Promise<void> {
  const doc = hocuspocus.documents.get(docNameFor(vaultId, noteId));
  if (!doc) return;
  await storeLoadedDocument(doc);
}
