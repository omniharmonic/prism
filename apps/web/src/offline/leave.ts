/**
 * Sign-out with unsent work (review M4). Rows queued for this account stay in
 * IndexedDB after sign-out (unencrypted, visible to whoever uses this browser
 * profile, and never sent from another account), so the user decides first:
 * stay, download them and leave, or discard them and leave.
 */
import { allQueued, discardAllCurrent, visibleWrites } from "./outbox";
import { captureWriteContext } from "./writeScope";

export type LeaveChoice = "stay" | "download" | "discard";
export const LEAVE_EVENT = "prism:leave-with-unsent";

function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Resolves true when it is fine to sign out now. Counts queued writes AND live
 * documents whose edits the server never took (review M3): both are unsent work
 * that would otherwise stay on — or silently vanish from — this device.
 * `discarded` tells the caller the person agreed to remove the unsynced documents.
 */
export async function confirmLeaveWithUnsent(): Promise<boolean> {
  const rows = await visibleWrites().catch(() => []);
  const { unsyncedDocs, exportUnsynced } = await import("../collab/unsynced");
  const context = await captureWriteContext().catch(() => null);
  const docs = await unsyncedDocs().catch(() => []);
  const count = rows.length + docs.length;
  if (!count) return true;
  const choice = await new Promise<LeaveChoice>((resolve) => {
    let handled = false;
    window.dispatchEvent(new CustomEvent(LEAVE_EVENT, { detail: { count, take: () => { handled = true; }, resolve } }));
    // No dialog host mounted (e.g. a bare page): ask in the app's own confirmation — never the
    // browser's `confirm()`, which the Prism Client's web view answers "no" without showing anything.
    if (!handled) void import("@prism/core/shell").then(({ askConfirm }) => askConfirm({
      title: "Sign out with unsent changes?",
      body: `${count} change${count === 1 ? " has" : "s have"} not reached the server yet. They are downloaded as a file first, then removed from this device.`,
      confirm: "Download and sign out",
      cancel: "Stay signed in",
    })).then((yes) => resolve(yes ? "download" : "stay"), () => resolve("stay"));
  });
  if (choice === "stay") return false;
  if (choice === "download") {
    const queued = (await allQueued()).filter((r) => rows.some((x) => x.id === r.id));
    // What could not be read cannot be handed over — and signing out deletes it. Stay signed in.
    let liveDocuments: Awaited<ReturnType<typeof exportUnsynced>> = [];
    try {
      if (docs.length) {
        if (!context) throw new Error("no scope");
        liveDocuments = await exportUnsynced(context.scope);
        if (liveDocuments.length < docs.length || liveDocuments.some((d) => !d.yjsUpdateBase64 && !d.pendingUpdateBase64)) throw new Error("incomplete");
      }
    } catch {
      window.dispatchEvent(new CustomEvent("prism:offline-refused", { detail: { message: "Your unsynced documents could not be read for the download, so you are not signed out and nothing was removed. Try again, or reconnect so they can sync." } }));
      return false;
    }
    // Queued writes as before; live documents as their Yjs state (base64) per note id.
    download(liveDocuments.length ? { queuedWrites: queued, liveDocuments } : queued, "prism-unsent-changes.json");
  }
  await discardAllCurrent().catch(() => undefined);
  return true;
}
