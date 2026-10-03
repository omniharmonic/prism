import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileArchive, FileText, Upload } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { pageTitle } from "../../lib/pages/model";
import { stripNotionId } from "../../lib/import-export/markdown";
import { pollJob, transferApi, TransferError } from "../../lib/import-export/client";
import type { ImportAudienceInfo, ImportItem, ImportJob, ImportPreview } from "../../lib/import-export/wire";
import { plural, ProgressBar, TransferDialog } from "./TransferDialog";

const ACCEPT = ".zip,.md,.markdown,.html,.htm,.csv";
const ACTION_LABEL: Record<ImportItem["action"], string> = { create: "New", update: "Update", unchanged: "No change", conflict: "Skipped" };
const KIND_LABEL: Record<ImportItem["kind"], string> = { page: "", database: "Database", row: "Row" };

const sizeText = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const isArchive = (name: string) => name.toLowerCase().endsWith(".zip");
/** One honest sentence about who gets access when the pages are NOT imported as private. */
export function audienceText(a: ImportAudienceInfo): string {
  const parts: string[] = [];
  if (a.people > 0) parts.push(a.people === 1 ? "1 person" : `${a.people.toLocaleString()} people`);
  if (a.links > 0) parts.push(a.links === 1 ? "anyone with 1 share link" : `anyone with ${a.links.toLocaleString()} share links`);
  if (a.sharedPage) return `This folder is inside a shared page: ${parts.join(" and ") || "the people it is shared with"} will be able to open every imported page, and so will workspace members.`;
  return parts.length ? `Workspace members and ${parts.join(" and ")} with access to the whole workspace can open them.` : "Anyone in this workspace can open them, like any other page here.";
}

/** Where an upload lands by default: its own folder for an archive, the shared Imports folder for one file. */
export function defaultImportFolder(fileName: string, base = "vault/Imports"): string {
  if (!isArchive(fileName)) return base;
  let stem = stripNotionId(fileName.slice(0, fileName.lastIndexOf(".")));
  // Notion names its archives `Export-<uuid>.zip` (sometimes `…-Part-1`): not a name anyone wants as a folder.
  if (stem.startsWith("Export-") && stem.length >= 39) {
    let idChars = 0;
    for (const ch of stem.slice(7, 43)) if ("0123456789abcdefABCDEF-".includes(ch)) idChars++;
    if (idChars >= 32) stem = "Notion export";
  }
  let clean = "";
  for (const ch of stem) clean += ch === "/" || ch === "\\" || ch.charCodeAt(0) < 32 ? "-" : ch;
  return `${base}/${clean.trim().slice(0, 80) || "Import"}`;
}

/**
 * Import Markdown, HTML, CSV or a Notion export ZIP. Always two steps: the
 * server first says exactly what it WOULD do (nothing is written), then the
 * person confirms. Running the same file again only adds what is new.
 */
export function ImportDialog({ parent, onClose }: { parent?: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [folder, setFolder] = useState(parent ?? "vault/Imports");
  const [over, setOver] = useState(false);
  const [phase, setPhase] = useState<"pick" | "checking" | "preview" | "running" | "done">("pick");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Who sees what is imported: private to me, or visible like any other page there.
  const [visibility, setVisibility] = useState<"private" | "shared">("shared");
  const picker = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const choose = (f: File | null | undefined) => {
    if (!f) return;
    setFile(f);
    setError(null);
    setPreview(null);
    setFolder(defaultImportFolder(f.name, parent ?? "vault/Imports"));
  };
  const check = async () => {
    if (!file) return;
    setError(null);
    setPhase("checking");
    try {
      const next = await transferApi.importPreview(file, folder.trim());
      setPreview(next);
      // Under a page somebody shares, the safe choice is the default.
      setVisibility(next.audience?.sharedPage ? "private" : "shared");
      setPhase("preview");
    } catch (e) {
      setError(e instanceof TransferError ? e.message : "That file couldn’t be read. Try again.");
      setPhase("pick");
    }
  };
  const run = async () => {
    if (!file || !preview) return;
    setError(null);
    setPhase("running");
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const started = await transferApi.importStart(file, preview.destination, visibility === "private" ? { private: true } : { confirmShared: !!preview.audience?.sharedPage });
      const total = started.preview.summary.create + started.preview.summary.update + started.preview.summary.unchanged + started.preview.summary.conflict;
      setJob({ id: started.jobId, state: "queued", destination: preview.destination, done: 0, total, created: 0, updated: 0, unchanged: 0, conflicts: 0, attachments: 0, failed: [], problems: [], firstId: null, error: null });
      const done = await pollJob(() => transferApi.importStatus(started.jobId), setJob, ctl.signal);
      setJob(done);
      setPhase("done");
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
    } catch (e) {
      if (ctl.signal.aborted) return;
      setError(e instanceof TransferError ? e.message : "The import couldn’t be finished. Run it again — pages already imported are kept and not duplicated.");
      setPhase("preview");
    }
  };
  const stop = () => {
    if (job) void transferApi.cancelImport(job.id).catch(() => {});
  };
  const busy = phase === "checking" || phase === "running";
  const s = preview?.summary;
  const writes = s ? s.create + s.update : 0;

  return (
    <TransferDialog title="Import" labelId="import-dialog-title" subtitle="Markdown, HTML, CSV, or a Notion export (.zip)." busy={busy} onClose={onClose}>
      {(phase === "pick" || phase === "checking") && (
        <>
          <div className="transfer-body">
            <input ref={picker} type="file" accept={ACCEPT} hidden aria-label="File to import" onChange={(e) => choose(e.target.files?.[0])} />
            {!file ? (
              <div
                className="transfer-drop"
                data-over={over}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files?.[0]); }}
              >
                <Upload size={22} aria-hidden="true" />
                <strong>Drop a file here</strong>
                <span>In Notion: Settings → Export → Markdown &amp; CSV, then drop the .zip here.</span>
                <button type="button" className="transfer-btn focus-ring" onClick={() => picker.current?.click()}>Choose a file</button>
              </div>
            ) : (
              <div className="transfer-file">
                {isArchive(file.name) ? <FileArchive size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                <span>{file.name}</span>
                <small>{sizeText(file.size)}</small>
                <button type="button" className="transfer-btn focus-ring" disabled={busy} onClick={() => picker.current?.click()}>Change</button>
              </div>
            )}
            <label className="transfer-field">
              <span className="transfer-label">Import into</span>
              <input className="transfer-input" value={folder} disabled={busy} spellCheck={false} autoCapitalize="off" onChange={(e) => setFolder(e.target.value)} />
              <span className="transfer-hint">A folder for the imported pages. Nothing that is already there is replaced.</span>
            </label>
            {error && <div className="transfer-note" data-tone="error" role="alert">{error}</div>}
          </div>
          <div className="transfer-foot">
            <span className="spacer">{phase === "checking" ? "Reading the file…" : "Nothing is imported until you confirm."}</span>
            <button type="button" className="transfer-btn focus-ring" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="transfer-btn focus-ring" data-primary="true" disabled={!file || !folder.trim() || busy} onClick={() => void check()}>
              {phase === "checking" ? "Checking…" : "Preview import"}
            </button>
          </div>
        </>
      )}
      {phase === "preview" && preview && s && (
        <>
          <div className="transfer-body" data-testid="import-preview">
            <p className="transfer-hint">Into <strong style={{ color: "var(--text-primary)" }}>{preview.destination}</strong>. Nothing has been imported yet.</p>
            <div className="transfer-stats" aria-label="What this file contains">
              <span className="transfer-stat"><b>{s.pages}</b> {s.pages === 1 ? "page" : "pages"}</span>
              {s.databases > 0 && <span className="transfer-stat"><b>{s.databases}</b> {s.databases === 1 ? "database" : "databases"} · <b>{s.rows}</b> {s.rows === 1 ? "row" : "rows"}</span>}
              {s.attachments > 0 && <span className="transfer-stat"><b>{s.attachments}</b> {s.attachments === 1 ? "image or file" : "images and files"}</span>}
              {s.links > 0 && <span className="transfer-stat"><b>{s.links}</b> {s.links === 1 ? "link" : "links"} between pages</span>}
            </div>
            <div className="transfer-list" role="list" aria-label="Pages to import">
              {preview.items.map((item) => (
                <div className="transfer-row" role="listitem" key={item.path}>
                  <span className="path" title={item.path}>
                    {pageTitle(item.path)} <small>{KIND_LABEL[item.kind] ? `· ${KIND_LABEL[item.kind]} ` : ""}{item.reason ? `· ${item.reason}` : ""}</small>
                  </span>
                  <span className="transfer-badge" data-action={item.action}>{ACTION_LABEL[item.action]}</span>
                </div>
              ))}
            </div>
            {writes + s.unchanged + s.conflict > preview.items.length && <p className="transfer-hint">Showing the first {preview.items.length}.</p>}
            {(s.unchanged > 0 || s.conflict > 0) && (
              <div className="transfer-note">
                {s.unchanged > 0 && <div>{plural(s.unchanged, "page")} already imported and unchanged.</div>}
                {s.conflict > 0 && <div>{plural(s.conflict, "page")} will be skipped so nothing existing is overwritten.</div>}
              </div>
            )}
            {preview.problems.length > 0 && (
              <details className="transfer-details">
                <summary>{plural(preview.problems.length, "note")} about this file</summary>
                <div className="transfer-note"><ul>{preview.problems.slice(0, 30).map((p, i) => <li key={i}>{p.entry.split("/").pop()}: {p.reason}</li>)}</ul></div>
              </details>
            )}
            {preview.audience && (
              <fieldset className="transfer-field transfer-audience" data-shared={preview.audience.sharedPage}>
                <legend className="transfer-label">Who can see the imported pages</legend>
                <label className="transfer-check">
                  <input type="radio" name="import-visibility" checked={visibility === "shared"} onChange={() => setVisibility("shared")} />
                  <span>
                    {preview.audience.sharedPage ? "Everyone this folder is shared with" : "Workspace members"}
                    <small>{audienceText(preview.audience)}</small>
                  </span>
                </label>
                <label className="transfer-check">
                  <input type="radio" name="import-visibility" checked={visibility === "private"} onChange={() => setVisibility("private")} />
                  <span>
                    Only me
                    <small>Imported as private pages. You can share them later.</small>
                  </span>
                </label>
              </fieldset>
            )}
            {error && <div className="transfer-note" data-tone="error" role="alert">{error}</div>}
          </div>
          <div className="transfer-foot">
            <button type="button" className="transfer-btn focus-ring" onClick={() => setPhase("pick")}>Back</button>
            <button type="button" className="transfer-btn focus-ring" data-primary="true" disabled={writes === 0} onClick={() => void run()}>
              {writes === 0 ? "Nothing to import" : `Import ${plural(writes, "page")}`}
            </button>
          </div>
        </>
      )}
      {phase === "running" && (
        <>
          <div className="transfer-body">
            <ProgressBar done={job?.done ?? 0} total={job?.total ?? 0} label={job && job.total ? `Importing ${Math.min(job.done, job.total).toLocaleString()} of ${job.total.toLocaleString()}…` : "Starting…"} />
            <p className="transfer-hint">You can stop at any time. Running the same file again picks up where it left off.</p>
          </div>
          <div className="transfer-foot">
            <button type="button" className="transfer-btn focus-ring" onClick={stop}>Stop</button>
          </div>
        </>
      )}
      {phase === "done" && job && (
        <>
          <div className="transfer-body">
            <div className="transfer-done" role="status">
              <CheckCircle2 size={28} aria-hidden="true" />
              <h3>{job.state === "done" ? "Import finished" : job.state === "cancelled" ? "Import stopped" : "Import stopped early"}</h3>
              <p>
                {plural(job.created, "page")} added
                {job.updated > 0 ? `, ${job.updated.toLocaleString()} updated` : ""}
                {job.attachments > 0 ? `, ${plural(job.attachments, "file")} attached` : ""}.
              </p>
              {(job.unchanged > 0 || job.conflicts > 0) && <p className="transfer-hint">{job.unchanged > 0 ? `${job.unchanged.toLocaleString()} unchanged. ` : ""}{job.conflicts > 0 ? `${job.conflicts.toLocaleString()} skipped.` : ""}</p>}
            </div>
            {(job.failed.length > 0 || job.problems.length > 0) && (
              <details className="transfer-details" open={job.failed.length > 0}>
                <summary>{plural(job.failed.length + job.problems.length, "item")} to look at</summary>
                <div className="transfer-note">
                  <ul>
                    {job.failed.slice(0, 20).map((f, i) => <li key={`f${i}`}>{pageTitle(f.path)}: {f.reason}</li>)}
                    {job.problems.slice(0, 20).map((p, i) => <li key={`p${i}`}>{p.entry.split("/").pop()}: {p.reason}</li>)}
                  </ul>
                </div>
              </details>
            )}
          </div>
          <div className="transfer-foot">
            {job.firstId && (
              <button type="button" className="transfer-btn focus-ring" onClick={() => { useUIStore.getState().openTab(job.firstId!, "Imported page", "document"); onClose(); }}>
                Open the first page
              </button>
            )}
            <button type="button" className="transfer-btn focus-ring" data-primary="true" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </TransferDialog>
  );
}
