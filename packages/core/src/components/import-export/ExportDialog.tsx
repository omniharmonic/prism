import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, Printer } from "lucide-react";
import { useVaultTree } from "../../app/hooks/useParachute";
import { isUnder } from "../../lib/pages/model";
import { usePageActions } from "../../lib/pages/usePageActions";
import { canDownloadDirectly, DIRECT_DOWNLOAD_BYTES, downloadExportDirectly, EXPORT_SAVE_PROGRESS_EVENT, nativeExportSaver, pollJob, saveBlob, transferApi, transferAvailable, TransferError } from "../../lib/import-export/client";
import { printCurrentPage, type ExportTarget } from "../../lib/import-export/store";
import type { ExportJob } from "../../lib/import-export/wire";
import { useUIStore } from "../../app/stores/ui";
import { plural, ProgressBar, TransferDialog } from "./TransferDialog";

const formatBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

type Format = "markdown" | "html" | "pdf";
const FORMATS: Array<{ id: Format; label: string }> = [
  { id: "markdown", label: "Markdown" },
  { id: "html", label: "HTML" },
  { id: "pdf", label: "PDF" },
];

/**
 * Export a page (optionally with its sub-pages and the images/files it uses) or
 * the whole workspace. One page as plain Markdown/HTML is made on this device
 * (works offline); anything with sub-pages or files is a ZIP built by the server
 * from what THIS account can view. PDF = the browser's print dialog.
 */
export function ExportDialog({ target, onClose }: { target: ExportTarget; onClose: () => void }) {
  const vault = target.scope === "vault";
  const server = transferAvailable();
  const actions = usePageActions();
  const { data: tree } = useVaultTree();
  const path = target.page?.path ?? tree?.find((t) => t.id === target.page?.id)?.path ?? null;
  const subCount = useMemo(() => (vault || !path ? 0 : (tree ?? []).filter((t) => isUnder(t.path, path)).length), [tree, path, vault]);
  const [format, setFormat] = useState<Format>("markdown");
  const [subpages, setSubpages] = useState(true);
  const [files, setFiles] = useState(true);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [phase, setPhase] = useState<"form" | "running" | "saving" | "done">("form");
  // Native shell only: the shell saves the archive itself (see nativeExportSaver).
  const [saved, setSaved] = useState<{ name: string | null; error: string | null } | null>(null);
  const [saveBytes, setSaveBytes] = useState<{ received: number; total: number | null }>({ received: 0, total: null });
  const saving = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const blob = useRef<{ name: string; data: Blob | null; id: string } | null>(null);
  useEffect(() => () => {
    abort.current?.abort();
    if (saving.current) nativeExportSaver()?.cancel(saving.current);
  }, []);
  useEffect(() => {
    const onProgress = (e: Event) => {
      const d = (e as CustomEvent<{ jobId?: unknown; received?: unknown; total?: unknown }>).detail;
      if (!d || d.jobId !== saving.current || typeof d.received !== "number") return;
      setSaveBytes({ received: d.received, total: typeof d.total === "number" ? d.total : null });
    };
    window.addEventListener(EXPORT_SAVE_PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(EXPORT_SAVE_PROGRESS_EVENT, onProgress);
  }, []);

  /** Native shell: ask where to save, then let the shell stream the archive there. Never throws. */
  const saveNatively = async (id: string, name: string) => {
    const native = nativeExportSaver();
    if (!native || saving.current) return;
    saving.current = id;
    setSaveBytes({ received: 0, total: null });
    setPhase("saving");
    try {
      const file = await native.save(id, name);
      setSaved({ name: file, error: null });
    } catch (e) {
      setSaved({ name: null, error: e instanceof TransferError ? e.message : "The export couldn’t be saved. Try again." });
    } finally {
      saving.current = null;
      setPhase("done");
    }
  };

  const pdf = format === "pdf";
  const withSub = !vault && subpages && subCount > 0;
  const zip = !pdf && server && (vault || withSub || files);
  const title = vault ? "Export workspace" : `Export “${target.page?.title ?? "page"}”`;

  const start = async () => {
    setError(null);
    if (pdf) {
      // Print the page itself: make sure it is the open one, then hand over to the print dialog.
      if (target.page) useUIStore.getState().openTab(target.page.id, target.page.title, "document");
      onClose();
      printCurrentPage();
      return;
    }
    if (!zip) {
      if (target.page) await actions.exportPage({ id: target.page.id, title: target.page.title, path: target.page.path }, format);
      onClose();
      return;
    }
    const ctl = new AbortController();
    abort.current = ctl;
    setPhase("running");
    let id: string | null = null;
    try {
      const started = await transferApi.startExport({ scope: target.scope, ...(target.page ? { noteId: target.page.id } : {}), format, subpages: vault ? true : withSub, attachments: files });
      id = started.jobId;
      setJob({ id, state: "queued", scope: target.scope, format, done: 0, total: started.total, attachments: 0, skipped: 0, bytes: 0, fileName: null, error: null, expiresAt: null });
      const done = await pollJob(() => transferApi.exportStatus(id!), setJob, ctl.signal);
      if (done.state !== "done") throw new TransferError(0, done.error ?? done.state, done.error === "too_large" ? "This export is too large for one archive. Export a smaller part, or leave out images and files." : done.state === "cancelled" ? "Export stopped." : "The export couldn’t be finished. Try again.");
      if (nativeExportSaver()) {
        // The Prism Client: the shell downloads and saves the archive (no bytes pass through the page).
        blob.current = { name: done.fileName ?? "export.zip", data: null, id };
        await saveNatively(id, blob.current.name);
        return;
      }
      if (done.bytes > DIRECT_DOWNLOAD_BYTES && canDownloadDirectly()) {
        // A large archive goes straight from the server to disk.
        blob.current = { name: done.fileName ?? "export.zip", data: null, id };
        downloadExportDirectly(id);
      } else {
        const data = await transferApi.exportDownload(id);
        blob.current = { name: done.fileName ?? "export.zip", data, id };
        saveBlob(blob.current.name, data);
      }
      setPhase("done");
    } catch (e) {
      if (id && ctl.signal.aborted) void transferApi.cancelExport(id).catch(() => {});
      if (!ctl.signal.aborted) {
        setError(e instanceof TransferError ? e.message : "The export couldn’t be finished. Try again.");
        setPhase("form");
      }
    }
  };
  const close = () => {
    if (saving.current) nativeExportSaver()?.cancel(saving.current);
    if (phase === "running") {
      abort.current?.abort();
      if (job) void transferApi.cancelExport(job.id).catch(() => {});
    }
    onClose();
  };

  return (
    <TransferDialog title={title} labelId="export-dialog-title" subtitle={vault ? "Every page you can open, as files you can keep anywhere." : undefined} onClose={close}>
      {phase === "form" && (
        <>
          <div className="transfer-body">
            <div className="transfer-field">
              <span className="transfer-label" id="export-format-label">Format</span>
              <div className="transfer-segment" role="radiogroup" aria-labelledby="export-format-label">
                {FORMATS.filter((f) => !(vault && f.id === "pdf")).map((f) => (
                  <button key={f.id} type="button" role="radio" aria-checked={format === f.id} className="focus-ring" onClick={() => setFormat(f.id)}>
                    {f.label}
                  </button>
                ))}
              </div>
              <p className="transfer-hint">
                {pdf ? "Opens your print dialog — choose “Save as PDF”. Prints this page as it appears, without the app around it." : format === "markdown" ? "Plain text files with properties as front matter. Opens in any editor and imports back into Prism." : "Standalone web pages you can open in any browser."}
              </p>
            </div>
            {!pdf && server && (
              <div className="transfer-field">
                <span className="transfer-label">Include</span>
                {!vault && (
                  <label className="transfer-check" data-disabled={subCount === 0}>
                    <input type="checkbox" checked={subpages && subCount > 0} disabled={subCount === 0} onChange={(e) => setSubpages(e.target.checked)} />
                    <span>
                      Sub-pages
                      <small>{subCount === 0 ? "This page has no sub-pages." : `${plural(subCount, "page")} inside this one, in matching folders.`}</small>
                    </span>
                  </label>
                )}
                <label className="transfer-check">
                  <input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} />
                  <span>
                    Images and files
                    <small>Saved alongside the pages, with links that work offline.</small>
                  </span>
                </label>
              </div>
            )}
            {error && <div className="transfer-note" data-tone="error" role="alert">{error}</div>}
          </div>
          <div className="transfer-foot">
            <span className="spacer">{pdf ? "" : zip ? "Downloads a .zip" : `Downloads one .${format === "markdown" ? "md" : "html"} file`}</span>
            <button type="button" className="transfer-btn focus-ring" onClick={close}>Cancel</button>
            <button type="button" className="transfer-btn focus-ring" data-primary="true" onClick={() => void start()}>
              {pdf ? <Printer size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
              {pdf ? "Print…" : "Export"}
            </button>
          </div>
        </>
      )}
      {phase === "running" && (
        <>
          <div className="transfer-body">
            <ProgressBar done={job?.done ?? 0} total={job?.total ?? 0} label={job && job.total ? `Exporting ${Math.min(job.done, job.total).toLocaleString()} of ${plural(job.total, "page")}…` : "Preparing…"} />
            <p className="transfer-hint">Keep this window open. Only pages you can open are included.</p>
          </div>
          <div className="transfer-foot">
            <button type="button" className="transfer-btn focus-ring" onClick={close}>Stop</button>
          </div>
        </>
      )}
      {phase === "saving" && (
        <>
          <div className="transfer-body">
            <ProgressBar
              done={saveBytes.received}
              total={saveBytes.total ?? 0}
              label={saveBytes.total ? `Saving ${formatBytes(saveBytes.received)} of ${formatBytes(saveBytes.total)}…` : saveBytes.received ? `Saving ${formatBytes(saveBytes.received)}…` : "Choose where to save the archive…"}
            />
            <p className="transfer-hint">The archive is saved straight to the place you choose.</p>
          </div>
          <div className="transfer-foot">
            <button type="button" className="transfer-btn focus-ring" onClick={() => saving.current && nativeExportSaver()?.cancel(saving.current)}>Stop</button>
          </div>
        </>
      )}
      {phase === "done" && job && (
        <>
          <div className="transfer-body">
            <div className="transfer-done" role="status">
              <CheckCircle2 size={28} aria-hidden="true" />
              <h3>{saved?.name ? "Export saved" : "Export ready"}</h3>
              <p>
                {plural(job.total - job.skipped, "page")}
                {job.attachments > 0 ? ` and ${plural(job.attachments, "file")}` : ""} in {saved?.name ?? blob.current?.name ?? "the archive"}.
              </p>
              {saved && !saved.name && !saved.error && <p className="transfer-hint" data-export-unsaved>Not saved yet. Choose “Save…” to pick a place for it.</p>}
              {job.skipped > 0 && <p className="transfer-hint">{plural(job.skipped, "page")} couldn’t be included; they are listed in _export.json inside the archive.</p>}
            </div>
          </div>
          <div className="transfer-foot">
            {saved?.error && <div className="transfer-note" data-tone="error" role="alert" style={{ flex: 1 }}>{saved.error}</div>}
            {saved ? (
              <button type="button" className="transfer-btn focus-ring" onClick={() => blob.current && void saveNatively(blob.current.id, blob.current.name)}>
                <Download size={15} aria-hidden="true" /> {saved.name ? "Save another copy…" : "Save…"}
              </button>
            ) : (
              <button type="button" className="transfer-btn focus-ring" onClick={() => blob.current && (blob.current.data ? saveBlob(blob.current.name, blob.current.data) : downloadExportDirectly(blob.current.id))}>
                <Download size={15} aria-hidden="true" /> Download again
              </button>
            )}
            <button type="button" className="transfer-btn focus-ring" data-primary="true" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </TransferDialog>
  );
}
