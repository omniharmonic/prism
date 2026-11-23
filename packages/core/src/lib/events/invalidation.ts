/**
 * Server invalidation channel -> TanStack Query (Arch v2 WP7.2).
 *
 * The Prism Server's `GET /api/events` (SSE) sends ids-only hints:
 *   {type:"note", id, op:"upsert"|"remove"}   |   {type:"resync"}
 * This module is the pure, React-free half: it batches those hints (default 500 ms)
 * and turns them into `invalidateQueries` calls using the `queryKeys.vault.*`
 * helpers. The shell injects the transport (web: `streamServerSSE`); desktop has
 * none and keeps its own polling.
 *
 * Mapping (per flushed batch):
 *  - each touched note id      -> queryKeys.vault.note(id)   (also its versions)
 *  - note LISTS (keys ["vault","notes",<filters>], never the per-id keys): TARGETED (L-1,
 *    2026-11-08 — an agent's 42 edits to one open page refetched every mounted multi-MB list
 *    42 times and stalled the Mac client). The server's frame carries the `tags` / `paths` of
 *    the note's viewable states; a list is REFETCHED only when it can hold the note (its tag
 *    filter meets those tags and/or its path prefix covers one of those paths — `listScope`).
 *    Every other list, and a list whose key this module cannot read, is only marked STALE
 *    (refetched when it is next mounted / focused). A frame without `tags` (older server) =
 *    the old behaviour: every list matches.
 *  - search / graph            -> on any note event; tags + stats only when a row's shape
 *                                 changed (`tree`: create, remove, retag, move)
 *  - EXTRA_LIVE_KEYS           -> only for their own tags (Matrix rooms ← message-thread, …)
 *  - RATE LIMIT per query key (`gate`): the first refetch after a quiet spell is immediate
 *    (one edit still feels live); further ones within the window are folded into ONE
 *    trailing refetch at the window's end (the query is marked stale meanwhile). Window
 *    `REFETCH_MIN_MS` (5 s), `BIG_REFETCH_MIN_MS` (30 s) for big data: an unfiltered list,
 *    a list of more than BIG_LIST_ROWS rows, the graph.
 *  - the sidebar tree ["vault","tree"] (NP-OF-05): only when the server says this
 *    viewer's ROW changed (`tree: true` — created, removed, renamed/moved, retagged,
 *    icon/order/type/trash), at once; never for a plain content edit (the tree's
 *    ETag would never match — rows carry `updatedAt` — so every autosave anywhere
 *    would re-download it). Fallback for a server without the flag: an id the
 *    cached tree has never listed, or a remove. While the tab is hidden the
 *    refresh waits until it is visible again.
 *  - each touched id is also marked for a FRESH re-read (`takeFreshRead`): the
 *    gateway must not answer "this note changed" from its 5 s reuse window.
 *  - resync / >MAX_IDS touched -> queryKeys.vault.all + EXTRA_LIVE_KEYS
 * Invalidation only refetches ACTIVE (mounted) queries; the rest are just marked stale.
 */
import { queryKeys } from "../parachute/queries";
import { markFreshRead } from "./freshReads";

export type InvalidationEvent =
  | { type: "note"; id: string; op: "upsert" | "remove"; tree?: boolean; tags?: string[]; paths?: string[] }
  | { type: "resync" };

/** Hooks the shell's transport calls. `onOpen` fires on every (re)connection. */
export interface InvalidationHandlers {
  onEvent(ev: InvalidationEvent): void;
  onOpen(): void;
  /** The channel dropped (will retry) or ended for good. */
  onDown(): void;
}

/** Opens the channel; returns a closer. Null source (desktop) = no channel. */
export interface InvalidationSource {
  open(h: InvalidationHandlers): () => void;
}

export interface InvalidateFilter {
  queryKey?: readonly unknown[];
  predicate?: (q: { queryKey: readonly unknown[]; state: { dataUpdatedAt: number; data?: unknown } }) => boolean;
  /** TanStack: "none" = mark stale only (refetched when next used). Default: refetch active queries. */
  refetchType?: "active" | "none";
}

/** Non-`vault.*` views that are derived from vault notes, with the tags whose notes feed them. */
export const EXTRA_LIVE_KEYS: ReadonlyArray<readonly unknown[]> = [
  ["matrix", "rooms"],
  ["agent", "dispatches"],
  ["agent", "skills"],
];
const EXTRA_LIVE_TAGS: ReadonlyArray<readonly string[]> = [
  ["message-thread"],
  ["agent-dispatch", "agent-session", "agent-output"],
  ["agent-skill"],
];

/** More touched ids than this in one batch -> just refresh everything. */
export const MAX_IDS = 50;
/** One refetch per query key per window (leading + one trailing). */
export const REFETCH_MIN_MS = 5_000;
export const BIG_REFETCH_MIN_MS = 30_000;
/** A list with more rows than this counts as big. */
export const BIG_LIST_ROWS = 1_000;

const TREE_KEY = ["vault", "tree"] as const;

const isNoteListKey = (k: readonly unknown[]) => k[0] === "vault" && k[1] === "notes" && typeof k[2] !== "string";

/** What a note list can hold: every note, notes with one of `tags` and/or under one of
 *  `prefixes`, or null when this module cannot read the key (such a list is only marked stale). */
export type ListScope = "all" | { tags: string[]; prefixes: string[] } | null;

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function listScope(filters: unknown): ListScope {
  if (filters === undefined) return "all"; // ["vault","notes"] = every note
  if (!filters || typeof filters !== "object") return null;
  const o = filters as Record<string, unknown>;
  // A reverse-relation list depends on links, not on a filter its key names (its `path` is the page's own).
  if ("reverse" in o) return null;
  const spec = o.spec && typeof o.spec === "object" ? (o.spec as Record<string, unknown>) : null;
  if (spec?.includeTypedTasks) return "all"; // also notes typed task by metadata, without the tag
  const tags = [...(typeof o.tag === "string" ? [o.tag] : []), ...strs(o.tags), ...strs(spec?.tags)];
  if ("emailThread" in o) tags.push("email");
  const prefixes = [o.path, o.path_prefix, o.pathPrefix].filter((p): p is string => typeof p === "string" && p !== "");
  if (!tags.length && !prefixes.length) return null;
  return { tags, prefixes };
}

/** Can a list of this scope hold a note with these (viewable) tags / paths? */
export function scopeMatches(scope: ListScope, tags: ReadonlySet<string>, paths: readonly string[]): boolean {
  if (scope === "all") return true;
  if (scope === null) return false;
  const tagOk = !scope.tags.length || scope.tags.some((t) => tags.has(t));
  // A plain string prefix, like the vault's `path_prefix` (over-matching only costs a refetch).
  const pathOk = !scope.prefixes.length || scope.prefixes.some((pre) => paths.some((p) => p.startsWith(pre)));
  return tagOk && pathOk;
}

export interface Invalidator {
  handleEvent(ev: InvalidationEvent): void;
  /** Channel (re)established. First open refreshes only what loaded before we were listening. */
  handleOpen(): void;
  /** The tab became visible again: run a tree refresh that was held back while hidden. */
  handleVisible(): void;
  /** Flush now (tests / teardown). */
  flush(): void;
  dispose(): void;
}

export function createInvalidator(opts: {
  invalidate: (f: InvalidateFilter) => void;
  /** Is this id in the cached sidebar tree? An unknown id refreshes the tree even without the server's flag. */
  inTree?: (id: string) => boolean;
  /** Is the page visible? A hidden tab defers the tree refresh until `handleVisible()`. Default: always. */
  visible?: () => boolean;
  debounceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): Invalidator {
  const debounce = opts.debounceMs ?? 500;
  const now = opts.now ?? Date.now;
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const connectStartedAt = now();
  let opened = false;
  let timer: unknown = null;
  let ids = new Set<string>();
  let anyNote = false;
  let everything = false;
  let treeHint = false;
  /** Tags / paths of the batch's notes (viewable states); `unshaped` = some frame had none (older server). */
  let tags = new Set<string>();
  let paths: string[] = [];
  let unshaped = false;
  /** A tree refresh that arrived while the tab was hidden. */
  let treeDue = false;
  const visible = opts.visible ?? (() => true);
  const refreshTree = () => {
    if (!visible()) { treeDue = true; return; }
    treeDue = false;
    opts.invalidate({ queryKey: TREE_KEY });
  };

  // ── per-key rate limit ──
  const lastRefetch = new Map<string, number>();
  /** Keys whose refetch was held back → when it is due. */
  const deferred = new Map<string, number>();
  let deferTimer: unknown = null;
  const hashOf = (k: readonly unknown[]) => JSON.stringify(k);
  const windowOf = (q: { queryKey: readonly unknown[]; state: { data?: unknown } }) => {
    const k = q.queryKey;
    if (k[0] === "vault" && k[1] === "graph") return BIG_REFETCH_MIN_MS;
    if (isNoteListKey(k)) {
      if (k[2] === undefined) return BIG_REFETCH_MIN_MS;
      const d = q.state.data;
      if (Array.isArray(d) && d.length > BIG_LIST_ROWS) return BIG_REFETCH_MIN_MS;
    }
    return REFETCH_MIN_MS;
  };
  /** True = refetch now (and remember it); false = held back (one trailing refetch is scheduled). */
  const gate = (q: { queryKey: readonly unknown[]; state: { data?: unknown } }): boolean => {
    const h = hashOf(q.queryKey);
    const t = now();
    const last = lastRefetch.get(h);
    const win = windowOf(q);
    if (last === undefined || t - last >= win) {
      lastRefetch.set(h, t);
      deferred.delete(h);
      return true;
    }
    if (!deferred.has(h)) deferred.set(h, last + win);
    armDeferred();
    return false;
  };
  const armDeferred = () => {
    if (deferTimer != null || deferred.size === 0) return;
    const next = Math.min(...deferred.values());
    deferTimer = setT(runDeferred, Math.max(0, next - now()));
  };
  const runDeferred = () => {
    deferTimer = null;
    const t = now();
    const due = new Set([...deferred].filter(([, at]) => at <= t).map(([h]) => h));
    for (const h of due) { deferred.delete(h); lastRefetch.set(h, t); }
    if (due.size) opts.invalidate({ predicate: (q) => due.has(hashOf(q.queryKey)) });
    armDeferred();
  };
  /** Invalidate the queries `pick` selects: gated ones refetch, held-back ones are only marked stale. */
  const refetchGated = (pick: (k: readonly unknown[]) => boolean) => {
    const held = new Set<string>();
    // TanStack evaluates a predicate more than once per call (invalidate, then pick what to refetch):
    // decide once per key, or the second pass would see "just refetched" and hold it back.
    const decided = new Map<string, boolean>();
    opts.invalidate({
      predicate: (q) => {
        if (!pick(q.queryKey)) return false;
        const h = hashOf(q.queryKey);
        let go = decided.get(h);
        if (go === undefined) {
          go = gate(q);
          decided.set(h, go);
          if (!go) held.add(h);
        }
        return go;
      },
    });
    if (held.size) opts.invalidate({ predicate: (q) => held.has(hashOf(q.queryKey)), refetchType: "none" });
  };
  const keyIs = (want: readonly unknown[]) => (k: readonly unknown[]) => want.every((w, i) => k[i] === w);

  const flush = () => {
    if (timer != null) clearT(timer);
    timer = null;
    const all = everything || ids.size > MAX_IDS;
    const touched = [...ids];
    const hadNote = anyNote;
    const hadTree = treeHint;
    const batchTags = tags;
    const batchPaths = paths;
    const anyUnshaped = unshaped;
    ids = new Set();
    anyNote = false;
    everything = false;
    treeHint = false;
    tags = new Set();
    paths = [];
    unshaped = false;
    if (all) {
      treeDue = false;
      opts.invalidate({ queryKey: queryKeys.vault.all });
      for (const k of EXTRA_LIVE_KEYS) opts.invalidate({ queryKey: k });
      return;
    }
    if (!hadNote) return;
    // The note itself (and its versions): immediately the first time, then at most once per window —
    // an agent writing one open page 42 times re-downloaded its 171 KB body 42 times (L-1).
    for (const id of touched) {
      markFreshRead(id);
      refetchGated((k) => k[0] === "vault" && k[1] === "notes" && k[2] === id);
    }
    // Lists that can hold one of these notes refetch (gated); every other list is only marked stale.
    const holds = (k: readonly unknown[]) => anyUnshaped || scopeMatches(listScope(k[2]), batchTags, batchPaths);
    refetchGated((k) => isNoteListKey(k) && holds(k));
    opts.invalidate({ predicate: (q) => isNoteListKey(q.queryKey) && !holds(q.queryKey), refetchType: "none" });
    const inTree = opts.inTree;
    if (hadTree || (inTree && touched.some((id) => !inTree(id)))) refreshTree();
    refetchGated(keyIs(["vault", "search"]));
    refetchGated(keyIs(queryKeys.vault.graph()));
    // Tag counts and note totals move only when a row's shape does (create, remove, retag, move).
    if (hadTree || anyUnshaped) {
      refetchGated(keyIs(queryKeys.vault.tags()));
      refetchGated(keyIs(queryKeys.vault.stats()));
    }
    EXTRA_LIVE_KEYS.forEach((k, i) => {
      if (anyUnshaped || EXTRA_LIVE_TAGS[i]!.some((t) => batchTags.has(t))) refetchGated(keyIs(k));
    });
  };
  const schedule = () => {
    if (timer == null) timer = setT(flush, debounce);
  };

  return {
    handleEvent(ev) {
      if (ev.type === "resync") everything = true;
      else if (ev.type === "note" && typeof ev.id === "string") {
        anyNote = true;
        if (ev.tree === true || ev.op === "remove") treeHint = true;
        ids.add(ev.id);
        if (Array.isArray(ev.tags)) {
          for (const t of ev.tags) tags.add(t);
          for (const p of ev.paths ?? []) if (!paths.includes(p)) paths.push(p);
        } else unshaped = true;
      } else return;
      schedule();
    },
    handleOpen() {
      if (opened) {
        // Reconnect: anything could have changed while we were deaf.
        everything = true;
        schedule();
        return;
      }
      opened = true;
      // First open: only data fetched before we started listening can be stale.
      opts.invalidate({ predicate: (q) => q.queryKey[0] === "vault" && q.state.dataUpdatedAt < connectStartedAt });
    },
    flush,
    handleVisible() {
      if (treeDue) refreshTree();
    },
    dispose() {
      if (timer != null) clearT(timer);
      if (deferTimer != null) clearT(deferTimer);
      timer = null;
      deferTimer = null;
      deferred.clear();
    },
  };
}

/** Parse one SSE `data:` payload; null for anything that isn't an invalidation hint. */
export function parseInvalidationEvent(data: string): InvalidationEvent | null {
  try {
    const o = JSON.parse(data) as { type?: unknown; id?: unknown; op?: unknown; tree?: unknown; tags?: unknown; paths?: unknown };
    if (o.type === "resync") return { type: "resync" };
    if (o.type === "note" && typeof o.id === "string" && (o.op === "upsert" || o.op === "remove")) {
      const ev: InvalidationEvent = { type: "note", id: o.id, op: o.op };
      if (o.tree === true) ev.tree = true;
      // Shape only when it is well-formed (bounded); otherwise the frame counts as an older server's.
      if (Array.isArray(o.tags) && o.tags.length <= 200 && o.tags.every((t) => typeof t === "string")) {
        ev.tags = o.tags as string[];
        ev.paths = Array.isArray(o.paths) ? strs(o.paths).slice(0, 10) : [];
      }
      return ev;
    }
  } catch {
    /* ignore */
  }
  return null;
}
