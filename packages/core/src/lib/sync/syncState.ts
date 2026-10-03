import { create } from "zustand";
import type { VaultClient } from "../../data/VaultClient";

/**
 * One truthful save/sync state for the whole shell (NP-OF-01, NP-SB-15, NP-PG-06).
 *
 * Inputs, each reported by the layer that actually knows:
 * - `inFlight`: vault writes that have not settled AND whose outbox status has
 *   not been re-read yet (see {@link trackVaultWrites}). A write that the
 *   transport queued on this device resolves optimistically; we keep counting
 *   it until `hasPendingWrites()` answers, so the badge never flashes "Saved"
 *   for something only stored locally.
 * - `dirty`: editors with debounced edits not yet handed to the transport.
 * - `pending`/`attention`: the host's outbox (web: IndexedDB) — writes saved on
 *   this device that the server has not confirmed, and those needing review.
 * - `failures`: editor saves that failed with a retry callback.
 * - `sources`: live documents (collab) that report their own state.
 */
export type SyncSourceState = "saving" | "local" | "failed" | "idle";

export interface SyncFailure {
  message: string;
  retry?: () => void;
}

interface SyncStore {
  online: boolean;
  inFlight: number;
  dirty: Record<string, true>;
  pending: number;
  attention: number;
  failures: Record<string, SyncFailure>;
  sources: Record<string, SyncSourceState>;
  lastConfirmedAt: number | null;
}

export const useSyncStore = create<SyncStore>(() => ({
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  inFlight: 0,
  dirty: {},
  pending: 0,
  attention: 0,
  failures: {},
  sources: {},
  lastConfirmedAt: null,
}));

if (typeof window !== "undefined") {
  const update = () => useSyncStore.setState({ online: navigator.onLine });
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
}

export type SyncKind = "saved" | "saving" | "offline" | "local" | "waiting" | "review" | "failed";

export interface SyncStatus {
  kind: SyncKind;
  /** Header wording (desktop + phone). */
  label: string;
  /** Sidebar-footer wording. */
  footer: string;
  /** Present when the user can act on it (retry / review). */
  failure?: SyncFailure;
}

/** Pure: the single state shown everywhere. Order matters — the most urgent wins. */
export function deriveSyncStatus(s: Pick<SyncStore, "online" | "inFlight" | "dirty" | "pending" | "attention" | "failures" | "sources">): SyncStatus {
  const failure = Object.values(s.failures)[0];
  const sources = Object.values(s.sources);
  if (failure || sources.includes("failed")) {
    return { kind: "failed", label: "Save failed · Retry", footer: "Save failed", failure: failure ?? { message: "A live document could not be saved." } };
  }
  if (s.attention > 0) return { kind: "review", label: "Needs review", footer: "Saved changes need review" };
  const local = s.pending > 0 || sources.includes("local");
  if (!s.online) {
    return local || s.inFlight > 0 || Object.keys(s.dirty).length > 0
      ? { kind: "local", label: "Offline · changes saved on this device", footer: "Offline · saved on this device" }
      : { kind: "offline", label: "Offline", footer: "Offline" };
  }
  if (s.inFlight > 0 || Object.keys(s.dirty).length > 0 || sources.includes("saving")) {
    return { kind: "saving", label: "Saving…", footer: "Saving…" };
  }
  if (local) return { kind: "waiting", label: "Waiting for server", footer: "Waiting for server" };
  return { kind: "saved", label: "Saved", footer: "Synced" };
}

export function useSyncStatus(): SyncStatus {
  const s = useSyncStore();
  return deriveSyncStatus(s);
}

/** Editors: there are unsent local edits for `key` (debounced autosave). */
export function markDirty(key: string, dirty: boolean): void {
  useSyncStore.setState((s) => {
    if (dirty === !!s.dirty[key]) return s;
    const next = { ...s.dirty };
    if (dirty) next[key] = true;
    else delete next[key];
    return { dirty: next };
  });
}

export function reportSaveFailure(key: string, failure: SyncFailure | null): void {
  useSyncStore.setState((s) => {
    if (!failure && !s.failures[key]) return s;
    const next = { ...s.failures };
    if (failure) next[key] = failure;
    else delete next[key];
    return { failures: next };
  });
}

/** Live documents (collab) report their own state; `idle`/null clears it. */
export function reportSyncSource(key: string, state: SyncSourceState | null): void {
  useSyncStore.setState((s) => {
    if ((state ?? "idle") === (s.sources[key] ?? "idle")) return s;
    const next = { ...s.sources };
    if (state && state !== "idle") next[key] = state;
    else delete next[key];
    return { sources: next };
  });
}

/** Hosts with an outbox report how many writes wait on this device, and how many need review. */
export function reportPendingWrites(pending: number, attention = 0): void {
  useSyncStore.setState((s) => (s.pending === pending && s.attention === attention ? s : { pending, attention }));
}

const WRITE_METHODS = new Set([
  "createNote", "updateNote", "deleteNote", "addTags", "removeTags", "createLink", "deleteLink",
  "updateProperties", "restoreNoteVersion", "movePage", "setPageMeta", "trashPage",
  "restoreFromTrash", "deleteFromTrash", "savePreferences",
]);
const tracked = new WeakMap<VaultClient, VaultClient>();

/**
 * Wrap a VaultClient so every write moves the shared sync state. Reads and
 * identity-free helpers pass straight through; the wrapper is memoised per
 * client so React consumers see a stable object.
 */
export function trackVaultWrites(client: VaultClient): VaultClient {
  const existing = tracked.get(client);
  if (existing) return existing;
  const wrapped = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function" || !WRITE_METHODS.has(prop)) return value;
      return (...args: unknown[]) => {
        useSyncStore.setState((s) => ({ inFlight: s.inFlight + 1 }));
        let settled = false;
        const settle = async (ok: boolean) => {
          if (settled) return;
          settled = true;
          // A queued write resolves optimistically: re-read the outbox before
          // the in-flight count drops, so "Saved" is only ever shown after it.
          let pending: boolean | undefined;
          try { pending = await target.hasPendingWrites?.(); } catch { pending = undefined; }
          useSyncStore.setState((s) => ({
            inFlight: Math.max(0, s.inFlight - 1),
            ...(pending !== undefined ? { pending: pending ? Math.max(1, s.pending) : s.attention ? s.pending : 0 } : {}),
            ...(ok && !pending ? { lastConfirmedAt: Date.now() } : {}),
          }));
        };
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>).then(
              (v) => { void settle(true); return v; },
              (e) => { void settle(false); throw e; },
            );
          }
          void settle(true);
          return result;
        } catch (e) {
          void settle(false);
          throw e;
        }
      };
    },
  });
  tracked.set(client, wrapped);
  return wrapped;
}
