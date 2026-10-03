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
 *  - any note event            -> note LISTS (keys ["vault","notes",<filters>] only,
 *                                 never the per-id keys), search, tags, stats, graph,
 *                                 plus the vault-derived views in EXTRA_LIVE_KEYS
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
  | { type: "note"; id: string; op: "upsert" | "remove"; tree?: boolean }
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
  predicate?: (q: { queryKey: readonly unknown[]; state: { dataUpdatedAt: number } }) => boolean;
}

/** Non-`vault.*` views that are derived from vault notes (refetched together). */
export const EXTRA_LIVE_KEYS: ReadonlyArray<readonly unknown[]> = [
  ["matrix", "rooms"],
  ["agent", "dispatches"],
  ["agent", "skills"],
];

/** More touched ids than this in one batch -> just refresh everything. */
export const MAX_IDS = 50;

const TREE_KEY = ["vault", "tree"] as const;

const isNoteListKey = (k: readonly unknown[]) => k[0] === "vault" && k[1] === "notes" && typeof k[2] !== "string";

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
  /** A tree refresh that arrived while the tab was hidden. */
  let treeDue = false;
  const visible = opts.visible ?? (() => true);
  const refreshTree = () => {
    if (!visible()) { treeDue = true; return; }
    treeDue = false;
    opts.invalidate({ queryKey: TREE_KEY });
  };

  const flush = () => {
    if (timer != null) clearT(timer);
    timer = null;
    const all = everything || ids.size > MAX_IDS;
    const touched = [...ids];
    const hadNote = anyNote;
    const hadTree = treeHint;
    ids = new Set();
    anyNote = false;
    everything = false;
    treeHint = false;
    if (all) {
      treeDue = false;
      opts.invalidate({ queryKey: queryKeys.vault.all });
      for (const k of EXTRA_LIVE_KEYS) opts.invalidate({ queryKey: k });
      return;
    }
    if (!hadNote) return;
    for (const id of touched) { markFreshRead(id); opts.invalidate({ queryKey: queryKeys.vault.note(id) }); }
    opts.invalidate({ predicate: (q) => isNoteListKey(q.queryKey) });
    const inTree = opts.inTree;
    if (hadTree || (inTree && touched.some((id) => !inTree(id)))) refreshTree();
    opts.invalidate({ queryKey: ["vault", "search"] });
    opts.invalidate({ queryKey: queryKeys.vault.tags() });
    opts.invalidate({ queryKey: queryKeys.vault.stats() });
    opts.invalidate({ queryKey: queryKeys.vault.graph() });
    for (const k of EXTRA_LIVE_KEYS) opts.invalidate({ queryKey: k });
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
      timer = null;
    },
  };
}

/** Parse one SSE `data:` payload; null for anything that isn't an invalidation hint. */
export function parseInvalidationEvent(data: string): InvalidationEvent | null {
  try {
    const o = JSON.parse(data) as { type?: unknown; id?: unknown; op?: unknown };
    if (o.type === "resync") return { type: "resync" };
    if (o.type === "note" && typeof o.id === "string" && (o.op === "upsert" || o.op === "remove")) {
      return (o as { tree?: unknown }).tree === true ? { type: "note", id: o.id, op: o.op, tree: true } : { type: "note", id: o.id, op: o.op };
    }
  } catch {
    /* ignore */
  }
  return null;
}
