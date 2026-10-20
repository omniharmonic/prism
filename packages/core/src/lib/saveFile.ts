/**
 * Hand a file to the person.
 *
 * In a browser that is a download (`<a download>` on a `blob:` URL). In the Prism Client
 * (macOS and iOS) it is NOT: the web view cancels downloads on purpose (no download handler —
 * one would let page script fetch arbitrary URLs) and refuses `blob:` navigations, so the
 * anchor silently does nothing. There the shell does it:
 *  - one of OUR attachments → `__PRISM_SHELL__.saveAttachment(id, name)`: the shell fetches
 *    `/api/attachments/<id>` itself (its own bearer, no redirect) and shows the native save
 *    panel (macOS) or the share sheet (iOS). The page passes the id and a name, nothing else.
 *  - text the page built (CSV, JSON) → `__PRISM_SHELL__.exportNote(text, name, "csv" | "json")`.
 *
 * Every function answers what really happened: "saved", "cancelled" (the person closed the
 * panel / sheet), or "started" (a browser download was handed over — the browser owns the rest).
 * A failure throws; callers say so. Never report "saved" for "started".
 */
export type SaveOutcome = "saved" | "cancelled" | "started";

interface SaveShell {
  saveAttachment?: (attachmentId: string, suggestedName: string) => Promise<string | null>;
  exportNote?: (content: string, suggestedName: string, format: string) => Promise<string | null>;
}
const shell = (): SaveShell | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { __PRISM_SHELL__?: SaveShell }).__PRISM_SHELL__);

/** True in the Prism Client: saving goes through the shell, never through a download. */
export const savesThroughShell = (): boolean => typeof shell()?.saveAttachment === "function";

const OWN_ATTACHMENT = /^\/api\/attachments\/([A-Za-z0-9_-]{1,64})$/;
const safeName = (name: string, fallback: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || fallback;
const shellError = (e: unknown, fallback: string) => new Error(typeof e === "string" && e ? e : e instanceof Error && e.message ? e.message : fallback);

/** A browser download of bytes this page already holds. */
export function downloadBlob(name: string, blob: Blob): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = safeName(name, "download");
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

/**
 * Save one of OUR attachments (`/api/attachments/<id>`). `fetcher` is the installed server
 * transport (cookie in the PWA); the app's shell fetches it itself.
 */
export async function saveOwnAttachment(fetcher: (path: string) => Promise<Response>, url: string, name: string): Promise<SaveOutcome> {
  const id = OWN_ATTACHMENT.exec(url)?.[1];
  if (!id) throw new Error("not an attachment");
  const native = shell();
  if (typeof native?.saveAttachment === "function") {
    try {
      return (await native.saveAttachment(id, name || "file")) ? "saved" : "cancelled";
    } catch (e) {
      throw shellError(e, "Couldn’t save this file.");
    }
  }
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  downloadBlob(name || "download", await res.blob());
  return "started";
}

/** Save text the page built itself. `format` picks the file's extension in the app's save panel. */
export async function saveTextFile(name: string, text: string, format: "csv" | "json", type = format === "csv" ? "text/csv;charset=utf-8" : "application/json"): Promise<SaveOutcome> {
  const native = shell();
  if (typeof native?.exportNote === "function") {
    try {
      return (await native.exportNote(text, safeName(name, `export.${format}`), format)) ? "saved" : "cancelled";
    } catch (e) {
      throw shellError(e, "Couldn’t save this file.");
    }
  }
  downloadBlob(safeName(name, `export.${format}`), new Blob([text], { type }));
  return "started";
}
