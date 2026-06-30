/**
 * Server-side real-time collaboration (Hocuspocus + Yjs), replacing the retired
 * Cloudflare Worker. Runs in the Prism Server process, so it shares the vault
 * token and the ACL store:
 *
 *  - onAuthenticate: resolve the connection's level (session cookie OR ?t=
 *    capability) against the note; reject below "view"; mark view/comment
 *    connections read-only (their edits are dropped by Hocuspocus).
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
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import type { IncomingMessage, Server } from "node:http";
import * as Y from "yjs";
import { generateJSON, generateHTML, getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON, updateYFragment } from "@tiptap/y-tiptap";
import { collabExtensions } from "@prism/core/editor-schema";
import { inferContentType } from "@prism/core/content-types";
import { marked } from "marked";
import { config } from "./config";
import { vault } from "./parachute";
import { verifyCapability } from "./auth/capability";
import { verifyPeerConnToken } from "./auth/peer-conn";
import { isLocalRequest } from "./auth/local";
import {
  getSession,
  grantsForUser,
  grantsForCapability,
  getDocState,
  saveDocState,
  getFederatedByKey,
  getPeer,
  grantsForPeer,
  getFederationEnabled,
  type Grant,
} from "./db";
import { effectiveLevel, atLeast, type Level } from "./permissions";
import { roleFloor, type Role } from "./roles";

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

/**
 * Resolve a collab documentName to the local vault note it maps to. For a
 * FEDERATED doc the wire documentName is the content-independent `space_note_key`
 * (shared by both hubs); we translate it to this hub's `local_id` for all vault
 * I/O and PIN the kind recorded at join (so an inbound update can never reseed a
 * note as the wrong structure). For every NON-federated doc — and whenever
 * federation is disabled — this returns `{ noteId: documentName }` with no kind,
 * i.e. exactly the documentName the caller already used (no behavior change).
 */
export function federationTarget(documentName: string): { noteId: string; kind?: CollabKind } {
  if (getFederationEnabled()) {
    const fed = getFederatedByKey(documentName);
    if (fed) return { noteId: fed.local_id, kind: fed.kind as CollabKind };
  }
  return { noteId: documentName };
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
function parseCsv(content: string): string[][] {
  if (!content.trim()) return [[""]];
  return content.split("\n").map((row) => row.split(","));
}

function serializeCsv(rows: string[][]): string {
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
interface CanvasEl {
  id?: string;
  [k: string]: unknown;
}

function parseScene(content: string): { elements: CanvasEl[]; appState: Record<string, unknown> } {
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
function reconcileBaseline(name: string): number {
  return Math.max(getDocState(name)?.sourceUpdatedAt ?? 0, lastReconciled.get(name) ?? 0);
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
    let note;
    try {
      note = await vault.getNote(name);
    } catch {
      continue; // unreadable/deleted — the load/store lifecycle handles it
    }
    const noteMs = toMs(note.updatedAt);
    if (noteMs === 0 || noteMs <= reconcileBaseline(name)) continue;
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
export async function resolveLevel(noteId: string, token: string, cookieHeader: string | null, isLocal = false): Promise<Level | null> {
  // Federation path (GATED): a documentName that is a known `space_note_key` is
  // opened EITHER by a peer hub (peer-conn token) OR by THIS hub's own client
  // (owner/session/capability) — both now connect under the space_note_key (gap
  // #2). When federation is off, getFederatedByKey is never consulted, so this
  // branch is inert and the path below is byte-for-byte today's.
  if (getFederationEnabled()) {
    const fed = getFederatedByKey(noteId);
    if (fed) {
      const claims = verifyPeerConnToken(token);
      if (claims) {
        // A PEER hub: authenticate the signing pubkey, require a paired peer
        // scoped to this doc's space, authorize via its space grants.
        if (claims.spaceId !== fed.space_id) return null;
        const peer = getPeer(claims.pubkey);
        if (!peer || !peer.paired_at) return null;
        let tags: string[] = [];
        try {
          tags = (await vault.getNote(fed.local_id)).tags ?? [];
        } catch {
          /* unreadable note — match on id/space only */
        }
        return effectiveLevel(grantsForPeer(claims.pubkey), { id: fed.local_id, tags, spaceIds: [fed.space_id] }, null);
      }
      // Not a peer-conn token → it's our OWN client opening the federated note by
      // its space_note_key. Authorize exactly like a normal note, against the
      // LOCAL id (a real note id, never a space_note_key → no recursion).
      return resolveLevel(fed.local_id, token, cookieHeader, isLocal);
    }
  }

  // Desktop owner path: the trusted Tauri app (on localhost) presents the dedicated
  // COLLAB_TOKEN to join live docs as the owner — kept separate from the vault token
  // so that powerful credential never enters the webview. LOCAL-ONLY: a token over
  // the public tunnel is ignored, so a leaked token grants nothing from the internet.
  // The vault token is accepted too (its holder already has full vault access).
  if (isLocal && token && ((config.collabToken && token === config.collabToken) || (config.parachuteToken && token === config.parachuteToken))) {
    return "own";
  }

  const email = sessionEmailFromCookie(cookieHeader);
  let grants: Grant[] = [];
  let role: Role = "guest";
  if (email) {
    // Phase 0: role from OWNER_EMAIL (byte-identical to the old isOwner).
    role = email === config.ownerEmail ? "owner" : "member";
    grants = grantsForUser(email);
  }
  if (role !== "owner" && token && token !== "session") {
    const claims = verifyCapability(token);
    if (claims) grants = grants.concat(grantsForCapability(claims.id));
  }
  let tags: string[] = [];
  let creator: string | null = null;
  let visibility: "private" | "workspace" = "workspace";
  try {
    const note = await vault.getNote(noteId);
    tags = note.tags ?? [];
    // Private-to-creator also gates LIVE editing: a private note is editable only
    // by its creator (or an explicit per-note grant), never via a tag/role floor.
    creator = (note.metadata?.prism_creator as string | undefined) ?? null;
    visibility = note.metadata?.prism_visibility === "private" ? "private" : "workspace";
  } catch {
    /* new/unknown note — no tags/metadata */
  }
  return effectiveLevel(grants, { id: noteId, tags, creator, visibility }, roleFloor(role), email ?? null);
}

/**
 * Authorize a collab connection against a note. Throws "Forbidden" below
 * "view"; marks the connection read-only below "suggest" (so view/comment
 * peers can watch but their edits are dropped). Returns the effective level.
 * Extracted from the Hocuspocus hook so it is directly testable.
 */
export async function authorizeConnection(
  documentName: string,
  token: string,
  cookieHeader: string | null,
  connectionConfig: { readOnly: boolean },
  isLocal = false,
): Promise<Level> {
  const level = await resolveLevel(documentName, token, cookieHeader, isLocal);
  if (!atLeast(level, "view")) throw new Error("Forbidden");
  if (!atLeast(level, "suggest")) connectionConfig.readOnly = true;
  return level as Level;
}

/**
 * Seed a Y.Doc for a note. Prefers persisted CRDT state for continuity, but if
 * Parachute was edited externally since we last stored (its updatedAt is newer
 * than our recorded source), the external edit wins and we re-seed from it.
 * Leaves the doc empty if nothing is loadable. Mutates and returns `doc`.
 */
export async function loadDocumentState(documentName: string, doc: Y.Doc): Promise<Y.Doc> {
  const target = federationTarget(documentName); // non-federated → { noteId: documentName }
  let note: { content: string; updatedAt: string | null } | null = null;
  let kind: CollabKind = target.kind ?? kindCache.get(documentName) ?? "document";
  try {
    const n = await vault.getNote(target.noteId);
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

  const stored = getDocState(documentName);
  const externallyEdited = stored && note && toMs(note.updatedAt) > (stored.sourceUpdatedAt ?? 0);

  if (stored && !externallyEdited) {
    Y.applyUpdate(doc, stored.state); // live CRDT state is current
  } else if (note) {
    const seed =
      kind === "code"
        ? codeToYUpdate(note.content)
        : kind === "spreadsheet"
          ? csvToYUpdate(note.content)
          : kind === "canvas"
            ? sceneToYUpdate(note.content)
            : contentToYUpdate(note.content);
    Y.applyUpdate(doc, seed); // seed (or re-seed on external edit)
  }
  // The doc now reflects Parachute as of note.updatedAt — record it so the
  // reconciler doesn't immediately re-apply the very content we just loaded.
  if (note) lastReconciled.set(documentName, toMs(note.updatedAt));
  return doc;
}

/**
 * Persist a Y.Doc: render to HTML and write back to Parachute, then store the
 * Yjs binary in SQLite (with the resulting source updatedAt) for CRDT
 * continuity. A vault write failure still persists local state so edits aren't
 * lost. Extracted from the Hocuspocus hook so it is directly testable.
 */
export async function storeDocumentState(documentName: string, doc: Y.Doc): Promise<void> {
  const target = federationTarget(documentName); // non-federated → { noteId: documentName }
  let sourceUpdatedAt: number | null = null;
  // Fetch the current note up front: it resolves the kind (a wrong default would
  // persist e.g. code as HTML and corrupt the note) AND lets us detect an
  // external edit we haven't folded in yet. Stores are debounced, so the read is
  // cheap; on failure we fall back to the cached kind.
  let kind = target.kind ?? kindCache.get(documentName);
  let current: { content: string; updatedAt: string | null } | null = null;
  try {
    const n = await vault.getNote(target.noteId);
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
    const baseline = reconcileBaseline(documentName);
    if (baseline > 0 && noteMs > baseline) {
      applyExternalContent(doc, kind, current.content);
      lastReconciled.set(documentName, noteMs);
    }
  }

  try {
    const content =
      kind === "code"
        ? yDocToCode(doc)
        : kind === "spreadsheet"
          ? yDocToCsv(doc)
          : kind === "canvas"
            ? yDocToScene(doc)
            : yDocToHtml(doc);
    const updated = await vault.updateNote(target.noteId, { content });
    sourceUpdatedAt = toMs(updated.updatedAt);
  } catch {
    /* vault write failed — still persist CRDT state below */
  }
  saveDocState(documentName, Y.encodeStateAsUpdate(doc), sourceUpdatedAt);
}

export const hocuspocus = new Hocuspocus({
  async onAuthenticate(data) {
    const cookie = headerGet(data.requestHeaders, "cookie");
    // Local (loopback) connections carry no proxy headers; the tunnel always does.
    // Only local connections may use the owner-token path (see resolveLevel).
    const isLocal = isLocalRequest((k) => headerGet(data.requestHeaders, k));
    const level = await authorizeConnection(data.documentName, data.token, cookie, data.connectionConfig, isLocal);
    return { level };
  },
  onLoadDocument: (data) => loadDocumentState(data.documentName, data.document),
  onStoreDocument: (data) => storeDocumentState(data.documentName, data.document),
});

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
