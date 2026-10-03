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
import { Window } from "happy-dom";
import { accessRevision, onAccessChanged } from "./access-events";
import { Hocuspocus, type Connection } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import type { IncomingMessage, Server } from "node:http";
import * as Y from "yjs";
import { generateJSON, generateHTML, getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON, updateYFragment, initProseMirrorDoc } from "@tiptap/y-tiptap";
import { collabExtensions, COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { inferContentType } from "@prism/core/content-types";
import { marked } from "marked";
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
import { suggestionAuthors, hasSuggestions, resolveSuggestions, summarizeSuggestions, type PmNode } from "./suggestions";
import { roleFloor, workspaceRole, type Role } from "./roles";

// TipTap's generate{JSON,HTML} need a DOM at call time; provide a lightweight
// one. (These globals are read when the hooks run, never at import.)
const _win = new Window();
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= _win;
g.document ??= _win.document;
g.DOMParser ??= _win.DOMParser;

export const FIELD = "default"; // TipTap's default XML fragment name
const exts = collabExtensions();
const schema = getSchema(exts);
/** The shared TipTap/ProseMirror schema (WP6.3 collab-safe MCP ops mark the doc with it). */
export const collabSchema = () => schema;

/** Markdown/HTML → an empty Y.Doc's encoded state for the shared fragment. */
export function contentToYUpdate(content: string): Uint8Array {
  const src = content ?? "";
  const html = src.trim().startsWith("<") ? src : (marked.parse(src) as string);
  const json = generateJSON(html || "<p></p>", exts);
  return Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, json, FIELD));
}

export function yDocToHtml(doc: Y.Doc): string {
  return generateHTML(yDocToProsemirrorJSON(doc, FIELD), exts);
}

/** Render a ProseMirror document of the shared schema to the HTML a store would write. */
export function proseToHtml(node: { toJSON(): unknown }): string {
  return generateHTML(node.toJSON() as never, exts);
}

// ---- server-side suggested edits (G2b) ----
// Pure transforms live in ./suggestions (PM JSON); these wrappers own the
// HTML⇄JSON rendering with the shared schema.

/** Distinct suggestion-mark authors present in a note's HTML ("" if none). */
export function suggestionAuthorsInHtml(html: string): string[] {
  if (!html.includes("data-suggestion")) return []; // cheap pre-check
  return suggestionAuthors(generateJSON(html, exts) as PmNode);
}

/** Apply accept/reject of an author's suggestion marks to a note's HTML. */
export function resolveSuggestionsInHtml(html: string, author: string | null, action: "accept" | "reject"): string {
  const json = generateJSON(html, exts) as PmNode;
  if (!hasSuggestions(json, author)) return html;
  return generateHTML(resolveSuggestions(json, author, action) as never, exts);
}

/** Summary line for the review inbox. */
export function summarizeSuggestionsInHtml(html: string, author: string): string {
  return summarizeSuggestions(generateJSON(html, exts) as PmNode, author);
}

/**
 * Durable suggestion capture: when a persisted document carries suggestion
 * marks, ensure a pending_suggestions row exists per suggesting author, so the
 * owner has a review QUEUE (not just marks floating in the doc). Idempotent per
 * (note, author) while a pending row exists; errors never block the persist.
 */
function captureSuggestions(noteId: string, html: string): void {
  try {
    const authors = suggestionAuthorsInHtml(html).filter((a) => a !== "");
    if (authors.length === 0) return;
    const existing = suggestionsForNote(noteId).filter((s) => s.status === "pending");
    const json = generateJSON(html, exts) as PmNode;
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
export function applyExternalContent(doc: Y.Doc, kind: CollabKind, content: string): void {
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
      const src = content ?? "";
      const html = src.trim().startsWith("<") ? src : (marked.parse(src) as string);
      const json = generateJSON(html || "<p></p>", exts);
      const pmNode = schema.nodeFromJSON(json);
      updateYFragment(doc, doc.getXmlFragment(FIELD), pmNode, { mapping: new Map(), isOMark: new Map() });
    }
  }, EXTERNAL_ORIGIN);
}

/** A loaded-document registry — structurally what Hocuspocus exposes as
 *  `.documents`. Kept minimal so tests can pass a plain map of Y.Docs. */
export interface LiveDocs {
  documents: Map<string, Y.Doc>;
}

/** The Parachute updatedAt we've absorbed for a doc, beyond which a newer note
 *  is an unseen external edit. Max of our persisted snapshot and last apply. */
function reconcileBaseline(documentName: string, vaultId: string, noteId: string): number {
  return Math.max(getDocState(noteId, vaultId)?.sourceUpdatedAt ?? 0, lastReconciled.get(documentName) ?? 0);
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
    const target = federationTarget(name);
    let note;
    try {
      note = await vaultClient(target.vaultId).getNote(target.noteId);
    } catch {
      continue; // unreadable/deleted — the load/store lifecycle handles it
    }
    const noteMs = toMs(note.updatedAt);
    if (noteMs === 0 || noteMs <= reconcileBaseline(name, target.vaultId, target.noteId)) continue;
    const kind = noteKind({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
    kindCache.set(name, kind);
    applyExternalContent(doc, kind, note.content);
    lastReconciled.set(name, noteMs);
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
  let creator: string | null = null;
  let visibility: "private" | "workspace" = "workspace";
  let notePath: string | null = null;
  await warmPageAnchors(grants); // page-subtree grants need the tree (NP-CO-09)
  try {
    const note = await vaultClient(vaultId).getNote(noteId);
    if (note.id !== noteId) return null; // resolved through a path/title alias
    lockedDocs.set(documentName, note.metadata?.prism_locked === true);
    tags = note.tags ?? [];
    // Private-to-creator also gates LIVE editing: a private note is editable only
    // by its creator (or an explicit per-note grant), never via a tag/role floor.
    creator = (note.metadata?.prism_creator as string | undefined) ?? null;
    visibility = note.metadata?.prism_visibility === "private" ? "private" : "workspace";
    notePath = note.path ?? null;
  } catch {
    if (role !== "owner") return null; // Never infer public visibility from a failed read.
  }
  return collabLevelFor(grants, { id: noteId, tags, creator, visibility, path: notePath }, role, email ?? null);
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
  noteRef: { id: string; tags: string[]; creator: string | null; visibility: "private" | "workspace"; path?: string | null },
  role: Role,
  email: string | null,
): Level | null {
  const lvl = effectiveLevel(grants, noteRef, roleFloor(role), email);
  if (lvl === "own") return "own";
  const caps = effectiveCaps(grants, noteRef, roleFloor(role), email);
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
export async function loadDocumentState(documentName: string, doc: Y.Doc): Promise<Y.Doc> {
  const target = federationTarget(documentName); // non-federated → decoded (vault, note)
  // A (re)load starts a NEW in-memory document. Any human command still marked
  // 'applied' for THIS document name (never confirmed by a store) belonged to a
  // previous instance that is gone — a crash, or an unload before its store
  // succeeded. Forget those receipts NOW (before any await) so a retry
  // re-applies the command rather than replaying a result for a change that was
  // lost; what they may have left in a half-saved snapshot is removed below.
  // Confirmed ('durable') receipts are kept: they survive every reload/reseed.
  const lost = takeUnconfirmedCollabReceipts(documentName);
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
  if (populated) return doc;

  const stored = getDocState(target.noteId, target.vaultId);
  const externallyEdited = stored && note && toMs(note.updatedAt) > (stored.sourceUpdatedAt ?? 0);

  if (stored) {
    // Always restore the persisted CRDT state first: it carries the doc's stable
    // Yjs client IDs. A reconnecting client (in-session, or via IndexedDB across
    // reloads) then merges IDENTICAL items → idempotent, no duplication.
    Y.applyUpdate(doc, stored.state);
    // If Parachute changed underneath us, fold that edit in via a minimal CRDT
    // DIFF (updateYFragment et al.) — NOT an additive re-seed, which would stack
    // a second fresh-client-ID copy of the whole note on top of the first.
    if (externallyEdited && note) applyExternalContent(doc, kind, note.content);
  } else if (note) {
    const seed =
      kind === "code"
        ? codeToYUpdate(note.content)
        : kind === "spreadsheet"
          ? csvToYUpdate(note.content)
          : kind === "canvas"
            ? sceneToYUpdate(note.content)
            : contentToYUpdate(note.content);
    Y.applyUpdate(doc, seed); // first-ever seed into a fresh, empty doc
  }
  // A snapshot written by a FAILED store (or one taken while a command's own
  // vault write was still pending) can hold pieces of a command that was never
  // confirmed: the fold above restores the body from the vault, but not the
  // `comments` map. Remove exactly what those forgotten commands left behind, so
  // the document is consistent and the retry starts from the pre-command state.
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
    saveDocState(target.noteId, Y.encodeStateAsUpdate(doc), toMs(note.updatedAt), target.vaultId);
    lastReconciled.set(documentName, toMs(note.updatedAt));
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
export async function storeDocumentState(documentName: string, doc: Y.Doc): Promise<void> {
  const target = federationTarget(documentName); // non-federated → decoded (vault, note)
  let sourceUpdatedAt: number | null = null;
  let vaultWritten = false; // the vault copy now reflects (or already matched) the rendered doc
  // Fetch the current note up front: it resolves the kind (a wrong default would
  // persist e.g. code as HTML and corrupt the note) AND lets us detect an
  // external edit we haven't folded in yet. Stores are debounced, so the read is
  // cheap; on failure we fall back to the cached kind.
  let kind = target.kind ?? kindCache.get(documentName);
  let current: { content: string; updatedAt: string | null } | null = null;
  try {
    const n = await vaultClient(target.vaultId).getNote(target.noteId);
    current = { content: n.content, updatedAt: n.updatedAt };
    if (!kind) kind = noteKind({ path: n.path, tags: n.tags, metadata: n.metadata, content: n.content });
  } catch {
    /* note unreadable — keep cached kind (or default below) */
  }
  if (!kind) kind = "document";
  kindCache.set(documentName, kind);

  // Clobber guard: if Parachute is newer than what we've absorbed, fold that
  // external edit into the live doc BEFORE rendering, so the write below merges
  // it in instead of overwriting it (and connected clients see it too).
  // A zero baseline means we have no prior knowledge of this note (e.g. a store
  // with no preceding load) — the live doc is authoritative, so don't fold. In
  // the real Hocuspocus flow onLoadDocument always runs first and sets it.
  if (current) {
    const noteMs = toMs(current.updatedAt);
    const baseline = reconcileBaseline(documentName, target.vaultId, target.noteId);
    if (baseline > 0 && noteMs > baseline) {
      applyExternalContent(doc, kind, current.content);
      lastReconciled.set(documentName, noteMs);
    }
  }

  let rendered: number[] = [];
  let sourceUpdatedRaw: string | null = null;
  try {
    // Same tick as the render below: exactly the commands this content contains
    // — and only those whose change is STILL in the document. A fold of a newer
    // vault copy (here above, or by the reconciler since the command ran) can
    // have removed a command's effect; confirming it would report a lost change
    // as applied. Those are cleaned up and forgotten instead (the caller gets
    // 503, the retry 409 stale_revision).
    const pending = kind === "document" ? unconfirmedCollabReceipts(documentName) : [];
    rendered = pending.length && commandEffects ? commandEffects(doc, pending) : pending.map((r) => r.rowid);
    const content =
      kind === "code"
        ? yDocToCode(doc)
        : kind === "spreadsheet"
          ? yDocToCsv(doc)
          : kind === "canvas"
            ? yDocToScene(doc)
            : yDocToHtml(doc);
    if (kind === "document") setRenderedSize(doc, Buffer.byteLength(content));
    if (current && content === current.content) {
      // Nothing to persist (e.g. the store right after folding an external edit
      // or a version restore). Skipping matters on vault ≥0.7.9: every write
      // captures a history version, so an identical re-write would clutter the
      // note's history with no-change entries and bump updatedAt for nothing.
      sourceUpdatedAt = toMs(current.updatedAt);
      sourceUpdatedRaw = current.updatedAt;
    } else {
      const stamp = takeWriterStamp(documentName, doc, kind);
      const updated = await vaultClient(target.vaultId).updateNote(target.noteId, stamp ? { content, metadata: stamp } : { content });
      sourceUpdatedAt = toMs(updated.updatedAt);
      sourceUpdatedRaw = updated.updatedAt;
    }
    vaultWritten = true;
    // G2b: persisted suggestion marks land in the owner's durable review queue.
    if (kind === "document") captureSuggestions(target.noteId, content);
    // Wave 2A: mention / comment notifications + mention backlinks (fire-and-forget).
    if (kind === "document" && storeListener) {
      try {
        storeListener.stored({ docName: documentName, vaultId: target.vaultId, noteId: target.noteId, prevContent: current?.content ?? null, content, updatedAt: sourceUpdatedRaw, doc, editors: takeDocEditors(documentName) });
      } catch {
        /* notifications are best-effort — never fail the persist */
      }
    }
  } catch {
    /* vault write failed — still persist CRDT state below */
  }
  // Snapshot + receipt confirmation are ONE transaction, and it confirms ONLY
  // the commands that were already applied when `content` was rendered — the
  // ones the vault write above really carried. A command applied during that
  // await is in this snapshot but not in the vault; its own store (which its
  // request is waiting on) confirms it, and if that store fails the receipt
  // stays unconfirmed and the caller is told to retry — never a false success.
  // After a failed vault write nothing is confirmed: that snapshot has no source
  // version, the next load folds the (older) vault copy back over it.
  saveDocStateConfirming(target.noteId, Y.encodeStateAsUpdate(doc), sourceUpdatedAt, target.vaultId, vaultWritten ? rendered : []);
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
    // Credentials stay only in the connection's server-side context. `email`
    // attributes this socket's changes for notifications (never sent anywhere).
    const email = sessionEmailFromCookie(cookie) ?? deviceEmail(data.token);
    return { level, token: data.token, cookie, isLocal, email } satisfies LiveAccess;
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
  onLoadDocument: (data) => loadDocumentState(data.documentName, data.document),
  onStoreDocument: (data) => storeDocumentState(data.documentName, data.document),
});

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
  return hocuspocus.documents.has(docNameFor(vaultId, noteId));
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
