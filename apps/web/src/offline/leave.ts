/**
 * Sign-out with unsent work (review M4). Rows queued for this account stay in
 * IndexedDB after sign-out (unencrypted, visible to whoever uses this browser
 * profile, and never sent from another account), so the user decides first:
 * stay, download them and leave, or discard them and leave.
 */
import { allQueued, discardAllCurrent, visibleWrites } from "./outbox";

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

/** Resolves true when it is fine to sign out now. */
export async function confirmLeaveWithUnsent(): Promise<boolean> {
  const rows = await visibleWrites().catch(() => []);
  if (!rows.length) return true;
  const choice = await new Promise<LeaveChoice>((resolve) => {
    let handled = false;
    window.dispatchEvent(new CustomEvent(LEAVE_EVENT, { detail: { count: rows.length, take: () => { handled = true; }, resolve } }));
    // No dialog host mounted (e.g. a bare page): fall back to the browser's own prompt.
    if (!handled) resolve(window.confirm(`${rows.length} change${rows.length === 1 ? " has" : "s have"} not reached the server yet and will stay on this device, unsent. Sign out anyway?`) ? "download" : "stay");
  });
  if (choice === "stay") return false;
  if (choice === "download") download((await allQueued()).filter((r) => rows.some((x) => x.id === r.id)), "prism-unsent-changes.json");
  await discardAllCurrent().catch(() => undefined);
  return true;
}
