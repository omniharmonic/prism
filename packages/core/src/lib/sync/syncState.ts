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
/** `device`: a live document NOT open right now still has edits only on this device. */
/** `unsaved`: the server holds a live document's changes but CANNOT write them to the stored page (too large / refused). */
/** `retrying`: the server holds a live document's changes and has not been able to write them to the stored page YET (the vault is unreachable, the converter is busy) — it keeps trying. */
export type SyncSourceState = "saving" | "local" | "device" | "failed" | "unsaved" | "retrying" | "idle";

/** What the badge says while a live page's changes cannot be written to the stored page (WHY is the page's own notice: `unsavedExplanation`). */
export const NOT_SAVED_TO_PAGE = "Not saved to the page";
/** …and while the server is still trying to write them. */
export const SAVING_TO_PAGE = "Saving to the page — retrying";

/**
 * Why a live page's changes are not in the stored page, and what helps — by the
 * server's reason (`prism:unsaved`): a converter refusal (`too_large`,
 * `too_complex`, `too_many_nodes`), `vault <status>`, `gave_up`. The advice
 * "make it smaller" is only given where a smaller page would in fact be saved.
 */
export function unsavedExplanation(reason: string | null | undefined, permanent = true): string {
  const kept = "Your changes are kept on the server and open with this page";
  if (!permanent) return `The server has not been able to write this page's latest changes to the stored page yet, and keeps trying. ${kept}.`;
  if (reason === "vault 413") return `The stored page would be larger than the vault accepts. ${kept}, but the stored page does not have them until the page is smaller — split it, or copy your changes somewhere safe.`;
  if (reason === "vault 400" || reason === "vault 422") return `The vault refuses this page's content. ${kept}, but the stored page does not have them — and making the page smaller may not help. Copy your changes somewhere safe and tell the workspace owner.`;
  if (reason === "gave_up") return `Saving this page was tried for two weeks without success and has stopped. ${kept}, but the stored page does not have them. Copy your changes somewhere safe and tell the workspace owner.`;
  return `This page is too large or complex to be stored. ${kept}, but the stored page does not have them until the page is smaller — split it, or copy your changes somewhere safe.`;
}

/** What pressing the badge does — and so what its accessible name may promise. `null`: nothing to press. */
export function syncBadgeAction(status: Pick<SyncStatus, "kind" | "failure">): "retry" | "review" | null {
  if (status.kind === "failed") return status.failure?.retry ? "retry" : null;
  return status.kind === "review" || status.kind === "local" || status.kind === "waiting" ? "review" : null;
}

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
  // The server told a live document that its changes are NOT in the stored page and
  // cannot be written as the page is. Never "Saved" (they are safe on the server, and
  // reopen with the page — but the page itself does not have them).
  if (sources.includes("unsaved")) {
    return { kind: "failed", label: NOT_SAVED_TO_PAGE, footer: "Not saved to the page", failure: { message: `${NOT_SAVED_TO_PAGE}.` } };
  }
  if (s.attention > 0) return { kind: "review", label: "Needs review", footer: "Saved changes need review" };
  const local = s.pending > 0 || sources.includes("local");
  if (!s.online) {
    if (local || sources.includes("device")) return { kind: "local", label: "Offline · changes saved on this device", footer: "Offline · saved on this device" };
    // Typed, not yet stored: "saved on this device" would be untrue until the change is in the
    // on-device queue (the recovery dialog, which lists that queue, said "No pending changes").
    return s.inFlight > 0 || Object.keys(s.dirty).length > 0
      ? { kind: "saving", label: "Offline · saving on this device…", footer: "Offline · saving on this device…" }
      : { kind: "offline", label: "Offline", footer: "Offline" };
  }
  if (s.inFlight > 0 || Object.keys(s.dirty).length > 0 || sources.includes("saving")) {
    return { kind: "saving", label: "Saving…", footer: "Saving…" };
  }
  // The server has a live document's changes but could not write the stored page
  // yet (vault unreachable, converter busy) and keeps trying: not "Saved".
  if (sources.includes("retrying")) return { kind: "saving", label: SAVING_TO_PAGE, footer: "Saving to the page…" };
  // A live document whose socket is down while the browser thinks it is online
  // is, for the user, offline: its edits are on this device only.
  if (sources.includes("local")) return { kind: "local", label: "Offline · changes saved on this device", footer: "Offline · saved on this device" };
  if (local) return { kind: "waiting", label: "Waiting for server", footer: "Waiting for server" };
  // Never "Saved" while a live document's edits exist only here (re-review M1).
  if (sources.includes("device")) return { kind: "waiting", label: "Changes on this device — will sync", footer: "Changes on this device — will sync" };
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
  "createNote", "updateNote", "deleteNote", "addTags", "removeTags", "changeTags", "createLink", "deleteLink",
  "updateProperties", "restoreNoteVersion", "movePage", "duplicatePage", "setPageMeta", "trashPage",
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
