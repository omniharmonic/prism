import { useEffect, useRef, useState } from "react";
import {
  allQueued,
  discard,
  flush,
  otherScopeWrites,
  renameQueuedCreate,
  resolveConflict,
  retrySafe,
  retryWrite,
  subscribe,
  visibleWrites,
  type QueuedWrite,
} from "./outbox";
import { LEAVE_EVENT, type LeaveChoice } from "./leave";
import { captureWriteContext, sameScope } from "./writeScope";
import { serverFetch } from "../transport";
import { getMe } from "../config";
import { reportPendingWrites, useSyncStore, OPEN_SAVED_CHANGES_EVENT } from "@prism/core/shell";
import { startOfflineAvailability } from "./availableOffline";
import { startUnsyncedDocs } from "../collab/unsynced";

const stateLabels = {
  queued: "Saved on this device",
  sending: "Confirming with the server",
  conflict: "Needs review",
  missing: "Original note unavailable",
  blocked: "Access changed",
  unknown: "Result unconfirmed",
  quarantined: "Older draft",
};
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Honest save status and recovery. Never discard content or retry uncertain writes implicitly. */
export function OfflineIndicator() {
  const [online, setOnline] = useState(navigator.onLine);
  const [items, setItems] = useState<QueuedWrite[]>([]);
  const [legacy, setLegacy] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<{
    item: QueuedWrite;
    current: Record<string, unknown>;
    revision: string;
  } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await visibleWrites();
        const old = getMe()?.isOwner
          ? (await allQueued()).filter((i) => !i.scope).length
          : 0;
        if (!disposed) {
          setItems(next);
          setLegacy(old);
        }
      } catch {
        if (!disposed)
          setError(
            "Offline storage is unavailable. Keep this tab open and copy any unsaved text.",
          );
      }
    };
    const change = () => {
      setOnline(navigator.onLine);
      void refresh();
    };
    const scopeChange = () => {
      setItems([]);
      setReview(null);
      setOpen(false);
      change();
    };
    window.addEventListener("online", change);
    window.addEventListener("offline", change);
    window.addEventListener("prism:vault-changed", scopeChange);
    const unsubscribe = subscribe(() => void refresh());
    void refresh();
    const timer = window.setInterval(change, 5000);
    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("online", change);
      window.removeEventListener("offline", change);
      window.removeEventListener("prism:vault-changed", scopeChange);
    };
  }, []);
  // Feed the shell's one sync state (header / sidebar footer) with the outbox.
  useEffect(() => {
    reportPendingWrites(
      items.length,
      items.filter((i) => i.state !== "queued" && i.state !== "sending").length,
    );
  }, [items]);
  useEffect(() => { startOfflineAvailability(); startUnsyncedDocs(); }, []);
  // Changes kept for ANOTHER account / vault / workspace: never sent from here, shown so they aren't forgotten.
  const [elsewhere, setElsewhere] = useState<{ count: number; expireSoon: number }>({ count: 0, expireSoon: 0 });
  useEffect(() => {
    const refresh = () => void otherScopeWrites().then(setElsewhere).catch(() => undefined);
    refresh();
    const stop = subscribe(refresh);
    window.addEventListener("prism:vault-changed", refresh);
    const timer = window.setInterval(refresh, 5000); // an account change has no event of its own
    return () => { stop(); window.clearInterval(timer); window.removeEventListener("prism:vault-changed", refresh); };
  }, []);
  // IndexedDB refused a write: say so until it works again (never a passing toast).
  const [storageBroken, setStorageBroken] = useState(false);
  const [storageTight, setStorageTight] = useState(false);
  useEffect(() => {
    const broken = () => setStorageBroken(true);
    window.addEventListener("prism:storage-failed", broken);
    const stop = subscribe(() => setStorageBroken(false)); // a later write reached the device
    void navigator.storage?.estimate?.().then((e) => setStorageTight(!!e.quota && !!e.usage && e.usage / e.quota > 0.9)).catch(() => undefined);
    return () => { window.removeEventListener("prism:storage-failed", broken); stop(); };
  }, []);
  // Sign-out with unsent changes: stay, download them, or discard them.
  const [leaving, setLeaving] = useState<{ count: number; resolve: (c: LeaveChoice) => void } | null>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const ask = (event: Event) => {
      const detail = (event as CustomEvent<{ count: number; take: () => void; resolve: (c: LeaveChoice) => void }>).detail;
      detail.take();
      setLeaving({ count: detail.count, resolve: detail.resolve });
    };
    window.addEventListener(LEAVE_EVENT, ask);
    return () => window.removeEventListener(LEAVE_EVENT, ask);
  }, []);
  useEffect(() => { if (leaving) leaveDialog.current?.showModal(); }, [leaving]);
  const answerLeave = (choice: LeaveChoice) => { leaving?.resolve(choice); leaveDialog.current?.close(); setLeaving(null); };
  // Writes Prism refuses to queue offline (rename, move, delete) say so plainly.
  const [refused, setRefused] = useState("");
  useEffect(() => {
    let timer: number | undefined;
    const show = (event: Event) => {
      setRefused(String((event as CustomEvent<{ message?: string }>).detail?.message ?? "You’re offline. Reconnect and try again."));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRefused(""), 6000);
    };
    window.addEventListener("prism:offline-refused", show);
    return () => { window.removeEventListener("prism:offline-refused", show); window.clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_SAVED_CHANGES_EVENT, show);
    return () => window.removeEventListener(OPEN_SAVED_CHANGES_EVENT, show);
  }, []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  const loadReview = async (item: QueuedWrite) => {
    setError("");
    setBusy(true);
    setReviewed(false);
    try {
      const context = await captureWriteContext(true);
      if (!sameScope(item.scope, context.scope))
        throw new Error("Return to this change’s original workspace.");
      const response = await serverFetch(`${context.scope.api}${item.path}`, {
        headers: context.headers,
      });
      if (!response.ok)
        throw new Error(
          "The current note is unavailable. You can still download your saved change.",
        );
      const current = (await response.json()) as Record<string, unknown>;
      if (!sameScope(context.scope, (await captureWriteContext()).scope))
        throw new Error("The workspace changed. Open recovery again.");
      if (typeof current.updatedAt !== "string")
        throw new Error("This note has no revision to compare safely.");
      setReview({ item, current, revision: current.updatedAt });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!review || !reviewed) return;
    setBusy(true);
    setError("");
    try {
      await resolveConflict(
        review.item.id!,
        review.item.body!,
        review.revision,
      );
      setReview(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const attention = items.filter(
    (i) => i.state !== "queued" && i.state !== "sending",
  ).length;
  // An edit typed a moment ago is on its way into the queue (autosave debounce): say so, never "No pending changes".
  const storing = useSyncStore((s) => s.inFlight > 0 || Object.keys(s.dirty).length > 0);
  const toast = refused && (
    <p role="status" className="offline-refused-toast fixed left-1/2 z-[101] -translate-x-1/2 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-elevated)] px-4 py-2 text-sm text-[var(--text-primary)] shadow-lg" style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 132px)", maxWidth: "min(92vw, 30rem)" }}>
      {refused}
    </p>
  );
  const storageBanner = (storageBroken || storageTight) && (
    <p role="alert" className="offline-storage-banner fixed left-1/2 top-2 z-[102] -translate-x-1/2 rounded-lg border border-[var(--color-danger)] bg-[var(--bg-elevated)] px-4 py-2 text-sm text-[var(--text-primary)] shadow-lg" style={{ maxWidth: "min(94vw, 34rem)" }}>
      {storageBroken
        ? "Changes are not being saved on this device. Keep this tab open and stay online, or copy your work somewhere safe."
        : "This device is almost out of storage. Offline changes may not be saved — free some space."}
    </p>
  );
  const leavePrompt = leaving && (
    <dialog ref={leaveDialog} onCancel={(e) => { e.preventDefault(); answerLeave("stay"); }} aria-labelledby="leave-unsent-title"
      className="m-auto w-[min(30rem,94vw)] rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-base)] p-6 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/50">
      <h2 id="leave-unsent-title" className="text-lg font-semibold">{leaving.count} change{leaving.count === 1 ? " hasn’t" : "s haven’t"} reached the server</h2>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">They are saved only on this device and can’t be sent after you sign out. Stay signed in to let them sync, or choose what happens to them.</p>
      <div className="mt-5 flex flex-wrap gap-3 text-sm">
        <button type="button" autoFocus className="rounded-lg border px-3 py-2" onClick={() => answerLeave("stay")}>Stay signed in</button>
        <button type="button" className="rounded-lg border px-3 py-2" onClick={() => answerLeave("download")}>Download and sign out</button>
        <button type="button" className="rounded-lg border px-3 py-2 text-[var(--color-danger)]" onClick={() => answerLeave("discard")}>Discard and sign out</button>
      </div>
    </dialog>
  );
  if (online && !items.length && !legacy && !error && !open && !elsewhere.count) return <>{toast}{storageBanner}{leavePrompt}</>;
  const label = error
    ? "Save needs attention"
    : attention
      ? `${attention} saved change${attention === 1 ? " needs" : "s need"} review`
      : items.length
        ? `${items.length} change${items.length === 1 ? "" : "s"} saved on this device`
        : legacy
          ? "Older drafts available"
          : !online
            ? "Offline"
            : `${elsewhere.count} change${elsewhere.count === 1 ? "" : "s"} waiting in another workspace`;
  return (
    <>
      {toast}{storageBanner}{leavePrompt}
      {/* The pill is for what the header's sync state cannot say or do. Plain "Offline" and healthy
          queued changes are the header's (it opens this same dialog): a second, floating "Offline"
          over the page said it twice. */}
      {(error || attention > 0 || legacy > 0 || elsewhere.count > 0) && <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={label}
        className="offline-indicator-pill fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 rounded-full border border-[var(--glass-border)] bg-[var(--bg-surface)] px-4 py-2 text-xs text-[var(--text-primary)] shadow-lg"
      >
        <span role="status">
          {!online && items.length ? "Offline · " : ""}
          {label}
        </span>
      </button>}
      <dialog
        ref={dialog}
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
        aria-labelledby="offline-recovery-title"
        className="m-auto max-h-[85dvh] w-[min(48rem,94vw)] overflow-y-auto rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-base)] p-6 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/50"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="offline-recovery-title" className="text-lg font-semibold">
              Saved changes
            </h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              Your changes stay on this device until the server confirms them.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg border px-3 py-1 text-sm"
          >
            Close
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-500">
            {error}
          </p>
        )}
        {legacy > 0 && (
          <div className="my-4 rounded-lg border p-3 text-sm">
            <p>
              {legacy} older draft{legacy === 1 ? " has" : "s have"} no recorded
              account or vault. They will not be sent automatically. Download
              them to identify their original destination.
            </p>
            <button
              type="button"
              className="mt-2 underline"
              onClick={() =>
                void allQueued()
                  .then((rows) => {
                    if (getMe()?.isOwner)
                      download(
                        rows.filter((r) => !r.scope),
                        "prism-older-drafts.json",
                      );
                  })
                  .catch(() => setError("Could not read older drafts."))
              }
            >
              Download older drafts
            </button>
          </div>
        )}
        {!items.length && (
          <p className="my-5 text-sm" role="status">
            {storing
              ? "Saving your latest edit on this device…"
              : "No pending changes for this account and workspace."}
          </p>
        )}
        {elsewhere.count > 0 && (
          <p role="note" className="my-4 rounded-lg border p-3 text-sm">
            {elsewhere.count} change{elsewhere.count === 1 ? " is" : "s are"} waiting in another workspace or account on this device. Switch back to send {elsewhere.count === 1 ? "it" : "them"}; unsent changes are kept for 30 days{elsewhere.expireSoon ? ` — ${elsewhere.expireSoon} will be removed within a week` : ""}.
          </p>
        )}
        <ul className="mt-4 space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-[var(--glass-border)] p-4"
            >
              <p className="text-sm font-medium">
                {stateLabels[item.state ?? "quarantined"]}
              </p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {new Date(item.queuedAt).toLocaleString()} ·{" "}
                {item.method === "POST"
                  ? "New note"
                  : item.method === "DELETE"
                    ? "Remove note"
                    : "Note update"}
              </p>
              {item.detail && <p className="mt-2 text-sm">{item.detail}</p>}
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                {item.method === "PATCH" &&
                  item.state !== "sending" &&
                  item.state !== "queued" && (
                    <button
                      type="button"
                      disabled={busy || !online}
                      className="underline"
                      onClick={() => void loadReview(item)}
                    >
                      Review against current note
                    </button>
                  )}
                {item.state !== "sending" && item.state !== "queued" && retrySafe(item) && (
                  <button type="button" disabled={busy || !online} className="underline"
                    onClick={() => { setError(""); void retryWrite(item.id!).catch((e: Error) => setError(e.message)); }}>
                    Retry
                  </button>
                )}
                {item.method === "POST" && item.path === "/notes" && item.state !== "sending" && item.state !== "queued" && (
                  <button type="button" disabled={busy || !online} className="underline"
                    onClick={() => { setError(""); void renameQueuedCreate(item.id!).catch((e: Error) => setError(e.message)); }}>
                    Create under another name
                  </button>
                )}
                <button
                  type="button"
                  className="underline"
                  onClick={() =>
                    download(
                      item,
                      `prism-saved-change-${item.operationId}.json`,
                    )
                  }
                >
                  Download saved change
                </button>
                {item.state !== "sending" && (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setDiscarding(item.id!)}
                  >
                    Discard…
                  </button>
                )}
              </div>
              {discarding === item.id && (
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  <span>Remove this saved change from this device?</span>
                  <button
                    type="button"
                    onClick={() =>
                      void discard(item.id!)
                        .then(() => setDiscarding(null))
                        .catch((e: Error) => setError(e.message))
                    }
                  >
                    Discard saved change
                  </button>
                  <button type="button" onClick={() => setDiscarding(null)}>
                    Keep it
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {review && (
          <section
            className="mt-5 border-t border-[var(--glass-border)] pt-4"
            aria-label="Compare saved change"
          >
            <h3 className="font-medium">Review before applying</h3>
            <p className="my-2 text-sm">
              Applying replaces the fields in your saved change. If the note
              changes again, it will need another review.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Current note", review.current],
                ["Your saved change", JSON.parse(review.item.body!) as unknown],
              ].map(([name, value]) => (
                <div key={name as string}>
                  <h4 className="mb-2 text-sm font-medium">{name as string}</h4>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/5 p-3 text-xs">
                    {JSON.stringify(value, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
            <label className="my-3 flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              I reviewed the saved change against the current note.
            </label>
            <div className="flex gap-3 text-sm">
              <button
                type="button"
                disabled={busy || !reviewed}
                className="rounded-lg border px-3 py-2 disabled:opacity-40"
                onClick={() => void apply()}
              >
                Apply reviewed change
              </button>
              <button type="button" onClick={() => setReview(null)}>
                Keep for later
              </button>
            </div>
          </section>
        )}
        {online && items.some((i) => i.state === "queued") && (
          <button
            type="button"
            className="mt-4 rounded-lg border px-3 py-2 text-sm"
            onClick={() => void flush()}
          >
            Sync queued changes
          </button>
        )}
      </dialog>
    </>
  );
}
