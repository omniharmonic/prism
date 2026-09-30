/**
 * Tree projection (Arch v2 WP7.1) — the lean, in-memory file-tree index that
 * backs `GET /api/tree`.
 *
 * WHY: every client's file tree used to fetch the FULL vault list
 * (`GET /notes?limit=50000`, ~14k notes, ~16 MB) — and vault ≥0.7.9 schema-validates
 * every note of every list, so each load cost the single-threaded vault seconds
 * (the 2026-09-30 stall). The tree only needs id/path/tags/type-ish fields, so the
 * server holds one per-vault projection of exactly those and serves it (small,
 * gzip-able, ETag'd). The vault is listed ONCE, not once per client load.
 *
 * FRESHNESS (three layers, all converge on the same row map):
 *  1. Live vault subscribe WebSocket (`GET /api/subscribe`, lean). Its snapshot
 *     IS the build; `upsert` / `remove` frames keep it current for writes made
 *     ANYWHERE (desktop, agents, ingesters). Reconnects with capped backoff; each
 *     reconnect's snapshot replaces the rows wholesale (self-correcting).
 *  2. Write-through: any write that passes through the gateway (owner passthrough
 *     + non-owner routes) updates the row immediately, so the writer's own next
 *     tree read is exact without waiting for the socket.
 *  3. Fallback: if the socket can't connect / snapshot stalls / the vault has no
 *     subscribe, a lean REST list rebuilds the projection, and a periodic rebuild
 *     (TREE_REBUILD_MS, default 5 min) runs whenever the socket is NOT live.
 *
 * The projection is NOT an authorization boundary. Non-owners are served a
 * per-request filter through the gateway's own capsFor (`view` cap) — rows hold
 * the creator/visibility the private-note rule needs, but never emit them.
 */
import { createHash } from "node:crypto";
import type { VaultEntry } from "./config";
import { vaultClient } from "./parachute";
import type { NoteRef } from "./permissions";

/** Metadata keys the projection reads — the ONLY ones requested from the vault. */
export const TREE_META_KEYS = ["type", "prism_type", "prism_creator", "prism_visibility"] as const;

/** What the client receives. `type`/`prismType` are the two metadata keys the tree's
 *  icon/renderer inference (`inferContentType`) actually reads; both omitted when unset. */
export interface TreeEntry {
  id: string;
  path: string | null;
  tags: string[];
  updatedAt: string | null;
  type?: string;
  prismType?: string;
}

/** Internal row: the entry plus what the private-note rule needs (never emitted). */
export interface TreeRow extends TreeEntry {
  creator: string | null;
  visibility: "workspace" | "private";
}

/** The subset of the WebSocket API the projection uses (injectable for tests). */
export interface TreeSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export type TreeSocketFactory = (url: string) => TreeSocket;

const opts = {
  subscribe: () => process.env.TREE_SUBSCRIBE !== "0",
  rebuildMs: () => Number(process.env.TREE_REBUILD_MS ?? 300_000),
  snapshotTimeoutMs: () => Number(process.env.TREE_SNAPSHOT_TIMEOUT_MS ?? 60_000),
  debounceMs: () => Number(process.env.TREE_DEBOUNCE_MS ?? 1500),
  log: () => process.env.PRISM_TREE_LOG === "1",
  factory: ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => TreeSocket }).WebSocket(url)) as TreeSocketFactory,
};

/** Test seam: swap the socket constructor. */
export function setTreeSocketFactory(f: TreeSocketFactory | null): void {
  opts.factory =
    f ?? ((url) => new (globalThis as unknown as { WebSocket: new (u: string) => TreeSocket }).WebSocket(url));
}

interface State {
  entry: VaultEntry;
  rows: Map<string, TreeRow>;
  version: number;
  loaded: boolean;
  started: boolean;
  ws: TreeSocket | null;
  wsLive: boolean;
  pending: TreeRow[] | null; // snapshot frames accumulating
  backoff: number;
  rebuilding: Promise<void> | null;
  rebuildAgain: boolean;
  waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
  timers: { reconnect?: NodeJS.Timeout; rebuild?: NodeJS.Timeout; dirty?: NodeJS.Timeout; snapshot?: NodeJS.Timeout; ping?: NodeJS.Timeout };
  cache?: { version: number; body: string; etag: string };
  stopped: boolean;
}

const states = new Map<string, State>();

// ── change emitter (WP7.2) ──────────────────────────────────────────────────
// ONE subscribe socket per vault feeds both the projection and the `/api/events`
// invalidation channel; listeners hang off the same State, never a second socket.

/** A projection change. `prev` is the row's state BEFORE the change (absent = new),
 *  which lets a listener decide visibility against old AND new state. */
export type TreeChange =
  | { kind: "upsert"; row: TreeRow; prev: TreeRow | undefined }
  | { kind: "remove"; id: string; prev: TreeRow }
  | { kind: "resync" };
export type TreeListener = (c: TreeChange) => void;
const listeners = new Map<string, Set<TreeListener>>();

function notify(vaultId: string, c: TreeChange): void {
  const set = listeners.get(vaultId);
  if (!set) return;
  for (const l of [...set]) {
    try {
      l(c);
    } catch (e) {
      console.warn(`[tree] listener failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Subscribe to a vault's projection changes (starting the projection + its single
 * subscribe socket if needed). Resolves to an unsubscribe. Rejects if the vault can't
 * be reached at all — the caller decides what to do (the events route returns 502).
 */
export async function subscribeTreeChanges(entry: VaultEntry, l: TreeListener): Promise<() => void> {
  await ensureTree(entry);
  let set = listeners.get(entry.id);
  if (!set) listeners.set(entry.id, (set = new Set()));
  set.add(l);
  return () => {
    const cur = listeners.get(entry.id);
    cur?.delete(l);
    if (cur && cur.size === 0) listeners.delete(entry.id);
  };
}

const log = (msg: string) => {
  if (opts.log()) console.log(`[tree] ${msg}`);
};

// ── row construction ────────────────────────────────────────────────────────

function rowFromNote(n: unknown): TreeRow | null {
  if (!n || typeof n !== "object") return null;
  const o = n as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  const m = (o.metadata && typeof o.metadata === "object" ? o.metadata : {}) as Record<string, unknown>;
  const row: TreeRow = {
    id: o.id,
    path: typeof o.path === "string" ? o.path : null,
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : [],
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : typeof o.createdAt === "string" ? o.createdAt : null,
    creator: typeof m.prism_creator === "string" ? m.prism_creator : null,
    visibility: m.prism_visibility === "private" ? "private" : "workspace",
  };
  if (typeof m.type === "string") row.type = m.type;
  if (typeof m.prism_type === "string") row.prismType = m.prism_type;
  return row;
}

/** The permission-math view of a row (same shape the gateway's `ref()` builds). */
export const rowRef = (r: TreeRow): NoteRef => ({ id: r.id, tags: r.tags, creator: r.creator, visibility: r.visibility });

function emit(r: TreeRow): TreeEntry {
  const e: TreeEntry = { id: r.id, path: r.path, tags: r.tags, updatedAt: r.updatedAt };
  if (r.type !== undefined) e.type = r.type;
  if (r.prismType !== undefined) e.prismType = r.prismType;
  return e;
}

// ── state + build ───────────────────────────────────────────────────────────

function replaceRows(st: State, rows: TreeRow[], src: string, ms: number): void {
  const m = new Map<string, TreeRow>();
  for (const r of rows) m.set(r.id, r);
  const wasLoaded = st.loaded;
  st.rows = m;
  st.version++;
  st.cache = undefined;
  st.loaded = true;
  if (wasLoaded) notify(st.entry.id, { kind: "resync" });
  log(`vault=${st.entry.id} src=${src} rows=${m.size} build=${ms}ms`);
  const w = st.waiters.splice(0);
  for (const x of w) x.resolve();
}

async function rebuild(st: State, why: string): Promise<void> {
  if (st.rebuilding) {
    st.rebuildAgain = true;
    return st.rebuilding;
  }
  const p = (async () => {
    do {
      st.rebuildAgain = false;
      const t0 = Date.now();
      try {
        const notes = await vaultClient(st.entry.id).listNotes({ includeContent: false, includeMetadata: [...TREE_META_KEYS] });
        const rows: TreeRow[] = [];
        for (const n of notes) {
          const r = rowFromNote(n);
          if (r) rows.push(r);
        }
        if (!st.stopped) replaceRows(st, rows, `list(${why})`, Date.now() - t0);
      } catch (e) {
        console.warn(`[tree] vault=${st.entry.id} lean list failed (${why}): ${(e as Error).message}`);
        if (!st.loaded) {
          // Nothing to serve and no socket snapshot coming → fail the waiting requests.
          if (!st.ws) {
            const w = st.waiters.splice(0);
            for (const x of w) x.reject(e);
          }
        }
        return;
      }
    } while (st.rebuildAgain && !st.stopped);
  })().finally(() => {
    st.rebuilding = null;
  });
  st.rebuilding = p;
  return p;
}

function wsUrl(entry: VaultEntry): string {
  return `${entry.url.replace(/^http/, "ws")}/vault/${entry.vault}/api/subscribe?include_content=false`;
}

function clearSocketTimers(st: State): void {
  clearTimeout(st.timers.snapshot);
  clearInterval(st.timers.ping);
}

function scheduleReconnect(st: State): void {
  if (st.stopped || st.timers.reconnect) return;
  const delay = st.backoff;
  st.backoff = Math.min(st.backoff * 2, 60_000);
  st.timers.reconnect = setTimeout(() => {
    st.timers.reconnect = undefined;
    connect(st);
  }, delay);
  st.timers.reconnect.unref?.();
}

function onClosed(st: State, ws: TreeSocket): void {
  if (st.ws !== ws) return; // a superseded socket
  clearSocketTimers(st);
  st.ws = null;
  st.wsLive = false;
  st.pending = null;
  // No socket → fall back to a lean REST build so the tree is never unavailable, then retry the socket.
  if (!st.loaded && !st.stopped && !st.rebuilding) void rebuild(st, "ws-unavailable");
  scheduleReconnect(st);
}

function connect(st: State): void {
  if (st.stopped || st.ws) return;
  let ws: TreeSocket;
  try {
    ws = opts.factory(wsUrl(st.entry));
  } catch (e) {
    log(`vault=${st.entry.id} ws construct failed: ${(e as Error).message}`);
    if (!st.loaded) void rebuild(st, "ws-unavailable");
    scheduleReconnect(st);
    return;
  }
  st.ws = ws;
  st.pending = null;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "auth", token: st.entry.token }));
    // If the snapshot never lands (vault busy / old vault), don't leave the tree hanging.
    st.timers.snapshot = setTimeout(() => {
      if (!st.wsLive) {
        log(`vault=${st.entry.id} snapshot timeout`);
        if (!st.loaded && !st.rebuilding) void rebuild(st, "snapshot-timeout");
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
    }, opts.snapshotTimeoutMs());
    st.timers.ping = setInterval(() => {
      try {
        ws.send("ping");
      } catch {
        /* onclose follows */
      }
    }, 30_000);
    st.timers.ping.unref?.();
  };
  ws.onmessage = (ev) => {
    if (st.ws !== ws || typeof ev.data !== "string" || ev.data === "pong") return;
    let f: { type?: string; notes?: unknown[]; note?: unknown; id?: unknown; done?: boolean };
    try {
      f = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (f.type === "snapshot") {
      const acc = (st.pending ??= []);
      const t0 = Date.now();
      for (const n of f.notes ?? []) {
        const r = rowFromNote(n);
        if (r) acc.push(r);
      }
      if (f.done) {
        st.pending = null;
        st.wsLive = true;
        st.backoff = 2000;
        clearTimeout(st.timers.snapshot);
        replaceRows(st, acc, "subscribe-snapshot", Date.now() - t0);
      }
    } else if (f.type === "upsert") {
      const r = rowFromNote(f.note);
      if (r) upsertRow(st, r);
    } else if (f.type === "remove" && typeof f.id === "string") {
      removeRow(st, f.id);
    }
  };
  ws.onerror = () => {
    /* close follows; handled there */
  };
  ws.onclose = () => onClosed(st, ws);
}

function startState(st: State): void {
  st.started = true;
  if (opts.subscribe()) connect(st);
  else void rebuild(st, "init");
  const every = opts.rebuildMs();
  if (every > 0) {
    st.timers.rebuild = setInterval(() => {
      if (!st.wsLive) void rebuild(st, "periodic");
    }, every);
    st.timers.rebuild.unref?.();
  }
}

function stopState(st: State): void {
  st.stopped = true;
  clearSocketTimers(st);
  for (const k of ["reconnect", "rebuild", "dirty"] as const) {
    clearTimeout(st.timers[k]);
    clearInterval(st.timers[k]);
  }
  const ws = st.ws;
  st.ws = null;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  states.delete(st.entry.id);
  notify(st.entry.id, { kind: "resync" });
}

function getState(entry: VaultEntry): State {
  let st = states.get(entry.id);
  // The registry entry was edited (new url/token/vault) → a projection of the old target is wrong.
  if (st && (st.entry.url !== entry.url || st.entry.vault !== entry.vault || st.entry.token !== entry.token)) {
    stopState(st);
    st = undefined;
  }
  if (!st) {
    st = {
      entry,
      rows: new Map(),
      version: 0,
      loaded: false,
      started: false,
      ws: null,
      wsLive: false,
      pending: null,
      backoff: 2000,
      rebuilding: null,
      rebuildAgain: false,
      waiters: [],
      timers: {},
      stopped: false,
    };
    states.set(entry.id, st);
  }
  return st;
}

/**
 * The projection for a vault, building it on first use. Resolves once rows exist
 * (from the socket snapshot, or the lean-list fallback); rejects if neither works.
 */
export async function ensureTree(entry: VaultEntry): Promise<{ version: number; entries: () => TreeEntry[]; rows: () => TreeRow[]; state: State }> {
  const st = getState(entry);
  if (!st.started) startState(st);
  else if (!st.loaded && !st.ws && !st.rebuilding) void rebuild(st, "retry");
  if (!st.loaded) await new Promise<void>((resolve, reject) => st.waiters.push({ resolve, reject }));
  return { version: st.version, entries: () => [...st.rows.values()].map(emit), rows: () => [...st.rows.values()], state: st };
}

/** Serialize (and ETag) the projection, optionally filtered to rows a viewer may see. */
export function renderTree(
  t: Awaited<ReturnType<typeof ensureTree>>,
  canView?: (r: NoteRef) => boolean,
): { body: string; etag: string; count: number } {
  const st = t.state;
  if (!canView && st.cache && st.cache.version === st.version) {
    return { body: st.cache.body, etag: st.cache.etag, count: st.rows.size };
  }
  const list: TreeEntry[] = [];
  for (const r of st.rows.values()) if (!canView || canView(rowRef(r))) list.push(emit(r));
  const body = JSON.stringify(list);
  const etag = `W/"${createHash("sha1").update(body).digest("hex").slice(0, 24)}"`;
  if (!canView) st.cache = { version: st.version, body, etag };
  log(`vault=${st.entry.id} serve rows=${list.length} bytes=${body.length}${canView ? " (filtered)" : ""}`);
  return { body, etag, count: list.length };
}

/** `If-None-Match` matching (weak comparison, list form). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (s: string) => s.trim().replace(/^W\//, "");
  return header.split(",").some((x) => x.trim() === "*" || strip(x) === strip(etag));
}

// ── write-through ───────────────────────────────────────────────────────────

function upsertRow(st: State, r: TreeRow): void {
  const old = st.rows.get(r.id);
  // Don't let a slower, older observation (a write-through racing the socket) clobber a newer row.
  if (old?.updatedAt && r.updatedAt && r.updatedAt < old.updatedAt) return;
  st.rows.set(r.id, r);
  st.version++;
  st.cache = undefined;
  if (st.rebuilding) st.rebuildAgain = true; // a list already in flight may predate this write
  notify(st.entry.id, { kind: "upsert", row: r, prev: old });
}

function removeRow(st: State, id: string): void {
  const prev = st.rows.get(id);
  if (st.rows.delete(id)) {
    st.version++;
    st.cache = undefined;
    if (prev) notify(st.entry.id, { kind: "remove", id, prev });
  }
  if (st.rebuilding) st.rebuildAgain = true;
}

const live = (vaultId: string | undefined | null): State | undefined => {
  if (!vaultId) return undefined;
  return states.get(vaultId);
};

/** A gateway write produced this note (full or lean) in `entry`'s vault. */
export function treeUpsertNote(entry: VaultEntry, note: unknown): void {
  const st = live(entry.id);
  const r = rowFromNote(note);
  if (st && st.loaded && r) upsertRow(st, r);
  else if (st && !r) treeMarkDirty(entry);
}

export function treeRemoveNote(entry: VaultEntry, id: string): void {
  const st = live(entry.id);
  if (st?.loaded) removeRow(st, id);
}

/** Something changed we can't apply precisely: rebuild from a lean list (debounced). */
export function treeMarkDirty(entry: VaultEntry): void {
  const st = live(entry.id);
  if (!st || !st.loaded || st.timers.dirty) return;
  st.timers.dirty = setTimeout(() => {
    st.timers.dirty = undefined;
    void rebuild(st, "dirty");
  }, opts.debounceMs());
}

async function refreshNote(entry: VaultEntry, id: string): Promise<void> {
  try {
    treeUpsertNote(entry, await vaultClient(entry.id).getNote(id));
  } catch {
    treeMarkDirty(entry);
  }
}

/**
 * Owner passthrough hook: a write to `path` (relative to /api) succeeded with
 * `responseBody`. Apply it to the projection — precisely when the response carries
 * the note, by re-reading the one note otherwise, by full rebuild for anything broad.
 */
export async function treeAfterOwnerWrite(entry: VaultEntry, method: string, path: string, responseBody: string): Promise<void> {
  const st = live(entry.id);
  if (!st || !st.loaded) return; // no projection yet → its first build will see the write
  const m = path.match(/^\/notes(?:\/([^/?]+))?(\/[^?]*)?/);
  if (!m) {
    if (/^\/tags(\/|\?|$)/.test(path)) treeMarkDirty(entry);
    return;
  }
  const id = m[1] ? decodeURIComponent(m[1]) : undefined;
  const sub = m[2];
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    parsed = undefined;
  }
  if (!id) {
    // POST /notes: a single created note echoes back; a batch / odd shape → rebuild.
    if (method === "POST" && parsed && !Array.isArray(parsed) && typeof (parsed as { id?: unknown }).id === "string") {
      treeUpsertNote(entry, parsed);
    } else treeMarkDirty(entry);
    return;
  }
  if (method === "DELETE" && !sub) return treeRemoveNote(entry, id);
  const p = parsed as { id?: unknown; tags?: unknown } | undefined;
  if (!sub && p && p.id === id && Array.isArray(p.tags)) return treeUpsertNote(entry, parsed);
  // Tag sub-routes, restore, PATCH responses without tags, id-less bulk verbs ("batch"): re-read the one note.
  await refreshNote(entry, id);
}

// ── lifecycle (tests / shutdown) ────────────────────────────────────────────

export function resetTreeForTests(): void {
  for (const st of [...states.values()]) stopState(st);
  states.clear();
  listeners.clear();
  setTreeSocketFactory(null);
}

/** Introspection for tests and ops. */
export function treeStatus(vaultId: string): { loaded: boolean; wsLive: boolean; rows: number; version: number } | null {
  const st = states.get(vaultId);
  return st ? { loaded: st.loaded, wsLive: st.wsLive, rows: st.rows.size, version: st.version } : null;
}
