/**
 * Import / export — the client half of `apps/server/src/routes/{import,export}.ts`.
 * Reaches the Prism Server through the `serverFetch` seam (PWA cookie or native
 * device bearer). The legacy desktop has no Prism Server: `transferAvailable()`
 * is false there and every entry point hides.
 */
import { serverFetch } from "../transport/serverFetch";
import { isDesktop } from "../platform";
import type { ExportJob, ExportRequest, ImportJob, ImportPreview } from "./wire";

export class TransferError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "TransferError";
  }
}

/** Extra request headers (the active vault): installed by the web shell. */
let contextHeaders: () => Record<string, string> = () => ({});
export function setTransferContextHeaders(fn: () => Record<string, string>): void {
  contextHeaders = fn;
}
/** The shell's active-vault headers, for other owner tools that act on "the vault I am looking at" (Recovered text). */
export const serverContextHeaders = (): Record<string, string> => contextHeaders();

export const transferAvailable = (): boolean => !isDesktop;

const COPY: Record<string, string> = {
  too_complex: "That file takes too long to read. Import it in smaller parts.",
  confirm_shared: "That folder is shared with other people. Choose who should see the imported pages.",
  busy: "Another import or export is still running. Try again when it finishes.",
  rate_limited: "That’s a lot of imports and exports in a short time. Try again in a little while.",
  too_large: "That’s too large to handle in one go.",
  too_many_entries: "That archive has too many files to import in one go.",
  unsupported_type: "Choose a .zip, .md, .html or .csv file.",
  unsupported: "That archive uses a format Prism can’t read (ZIP64, multi-part or an unusual compression).",
  encrypted: "Password-protected archives can’t be imported.",
  corrupt: "That archive is damaged and can’t be read.",
  not_zip: "That file isn’t a zip archive.",
  forbidden: "You don’t have permission to do that here.",
  not_found: "That page isn’t available.",
  unauthorized: "Sign in again to continue.",
  protected: "That location is kept in sync by an integration. Choose another folder.",
  path_conflict: "That location isn’t available. Choose another folder.",
  vault_unreachable: "The workspace couldn’t be reached. Try again.",
};

async function fail(res: Response): Promise<never> {
  let code = `http_${res.status}`;
  let detail = "";
  try {
    const b = (await res.json()) as { error?: unknown; detail?: unknown; reason?: unknown };
    if (typeof b.error === "string") code = b.error;
    detail = typeof b.reason === "string" ? b.reason : typeof b.detail === "string" ? b.detail : "";
  } catch {
    /* no JSON body */
  }
  throw new TransferError(res.status, code, COPY[code] ?? (detail && detail.length < 200 ? detail : "Something went wrong. Try again."));
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await serverFetch(path, { ...init, headers: { ...contextHeaders(), ...(init.headers as Record<string, string> | undefined) } });
  } catch {
    throw new TransferError(0, "offline", "You’re offline. Connect and try again.");
  }
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

const TYPES: Record<string, string> = { zip: "application/zip", md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", csv: "text/csv" };
const typeFor = (name: string): string => TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

export interface ImportWriteOptions {
  /** Create the pages private to the importing account. */
  private?: boolean;
  /** "Yes, share them": required when the destination lies under a shared page (unless private). */
  confirmShared?: boolean;
}

function importUrl(file: File, parent: string, dryRun: boolean, opts: ImportWriteOptions = {}): string {
  const q = new URLSearchParams({ name: file.name, parent });
  if (!dryRun) q.set("dryRun", "0");
  if (opts.private) q.set("private", "1");
  if (opts.confirmShared) q.set("confirmShared", "1");
  return `/api/import?${q.toString()}`;
}

export const transferApi = {
  startExport: (req: ExportRequest) =>
    json<{ jobId: string; total: number }>("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) }),
  exportStatus: (id: string) => json<ExportJob>(`/api/export/${encodeURIComponent(id)}`),
  cancelExport: (id: string) => json<{ ok: boolean }>(`/api/export/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** The finished ZIP. The credential rides in a header, never in the URL. */
  async exportDownload(id: string): Promise<Blob> {
    let res: Response;
    try {
      res = await serverFetch(`/api/export/${encodeURIComponent(id)}/download`, { headers: contextHeaders() });
    } catch {
      throw new TransferError(0, "offline", "You’re offline. Connect and try again.");
    }
    if (!res.ok) return fail(res);
    return res.blob();
  },
  importPreview: (file: File, parent: string) =>
    json<ImportPreview>(importUrl(file, parent, true), { method: "POST", headers: { "Content-Type": typeFor(file.name), "X-Prism-Import": "1" }, body: file }),
  importStart: (file: File, parent: string, opts: ImportWriteOptions = {}) =>
    json<{ jobId: string; preview: ImportPreview }>(importUrl(file, parent, false, opts), { method: "POST", headers: { "Content-Type": typeFor(file.name), "X-Prism-Import": "1" }, body: file }),
  importStatus: (id: string) => json<ImportJob>(`/api/import/${encodeURIComponent(id)}`),
  cancelImport: (id: string) => json<{ ok: boolean }>(`/api/import/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/**
 * Above this size a PWA downloads straight from the server (a same-origin
 * navigation with the session cookie) instead of holding the archive in memory.
 * The native shell always fetches (its credential is a header).
 */
export const DIRECT_DOWNLOAD_BYTES = 150 * 1024 * 1024;
export const canDownloadDirectly = (): boolean => typeof window !== "undefined" && !("__PRISM_HOST__" in window);
/** Start a browser download of a finished export without buffering it. */
export function downloadExportDirectly(id: string): void {
  const a = document.createElement("a");
  a.href = `/api/export/${encodeURIComponent(id)}/download`;
  a.rel = "noopener";
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}

/** Hand a finished file to the person: the browser's download (or the native shell's save panel when it offers one). */
export function saveBlob(name: string, blob: Blob): void {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-") || "export.zip";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safe;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Poll a job until it leaves queued/running. `onTick` sees every status; abort with the signal. */
export async function pollJob<T extends { state: string }>(read: () => Promise<T>, onTick: (job: T) => void, signal: AbortSignal, everyMs = 700): Promise<T> {
  let failures = 0;
  for (;;) {
    if (signal.aborted) throw new TransferError(0, "aborted", "Stopped.");
    try {
      const job = await read();
      failures = 0;
      onTick(job);
      if (job.state !== "queued" && job.state !== "running") return job;
    } catch (e) {
      // A transient failure while polling is not the job failing: retry a few times.
      if (e instanceof TransferError && (e.status === 404 || e.status === 403 || e.status === 401)) throw e;
      if (++failures > 8) throw e;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, everyMs);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
