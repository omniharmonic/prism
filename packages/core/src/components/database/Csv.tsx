/**
 * CSV for databases: export any view (client-side, formula-safe), and import a
 * file into the database's tag through the owner/admin server route
 * (`POST /api/databases/import/csv`): choose a file → map columns to
 * properties (+ the key column that identifies existing pages) → preview (a
 * dry run: what would be created/updated/unchanged, and per-row problems) →
 * import. Re-importing the same file converges instead of duplicating.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { CsvError, parseCsv, toCsv } from "../../lib/database/csv";
import { formatValue, propertyValue, type PropertyDef } from "../../lib/database/schema";
import { noteTitle, runQuery, type QueryRow, type QuerySpec } from "../../lib/database/query";
import type { CsvImportResponse } from "../../lib/database/wire";
import type { VaultClient } from "../../data/VaultClient";

const EXPORT_MAX = 10_000;

/** Every row of a view (all pages), bounded. */
export async function allRows(client: VaultClient, spec: QuerySpec): Promise<QueryRow[]> {
  const out: QueryRow[] = [];
  if (client.queryNotes) {
    let cursor: string | null = null;
    do {
      const page = await client.queryNotes({ ...spec, limit: 500, cursor, tzOffset: new Date().getTimezoneOffset() });
      out.push(...page.rows);
      cursor = page.next;
    } while (cursor && out.length < EXPORT_MAX);
    return out;
  }
  return collect(await client.listNotes({ tag: spec.tags[0], limit: 5000 }), spec);
}
function collect(notes: Parameters<typeof runQuery>[0], spec: QuerySpec): QueryRow[] {
  const out: QueryRow[] = [];
  let cursor: string | null = null;
  do {
    const page = runQuery(notes, { ...spec, limit: 500, cursor }, { limited: false });
    out.push(...page.rows);
    cursor = page.next;
  } while (cursor && out.length < EXPORT_MAX);
  return out;
}

/** The CSV text for rows × (Title + props), values as people read them. */
export function rowsToCsv(rows: QueryRow[], props: PropertyDef[]): string {
  const cellText = (r: QueryRow, p: PropertyDef) => {
    const v = propertyValue(r, p.key);
    if (p.system === "created_time" || p.system === "edited_time") return typeof v === "string" ? v : "";
    if (p.kind === "date" && typeof v === "string") return v;
    if (p.kind === "number" && typeof v === "number") return String(v);
    return formatValue(p, v);
  };
  return toCsv([["Title", ...props.map((p) => p.label)], ...rows.map((r) => [noteTitle(r), ...props.map((p) => cellText(r, p))])]);
}

export function downloadText(name: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** First guess at a mapping: Name/Title → title; a property whose label or key matches. */
export function guessMapping(header: string[], props: PropertyDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  let titled = false;
  for (const h of header) {
    if (!titled && /^(name|title|page|task)$/i.test(h.trim())) {
      out[h] = "$title";
      titled = true;
      continue;
    }
    const p = props.find((x) => !x.system && (x.label.toLowerCase() === h.trim().toLowerCase() || x.key === slug(h)));
    out[h] = p ? p.key : "";
  }
  if (!titled && header[0] && !out[header[0]]) out[header[0]] = "$title";
  return out;
}

export function CsvImportDialog({ tag, dbPath, props, onClose }: { tag: string; dbPath: string | null; props: PropertyDef[]; onClose: () => void }) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [keyColumn, setKeyColumn] = useState("");
  const [plan, setPlan] = useState<CsvImportResponse | null>(null);
  const [result, setResult] = useState<CsvImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parsed = useMemo((): { header: string[]; count: number; preview: string[][] } | { error: string } | null => {
    if (!csv) return null;
    try {
      const rows = parseCsv(csv, { maxRows: 2001, maxCols: 60 });
      return { header: (rows[0] ?? []).map((h) => h.trim()), count: Math.max(0, rows.length - 1), preview: rows.slice(1, 4) };
    } catch (e) {
      return { error: e instanceof CsvError ? e.message : "This file is not valid CSV." };
    }
  }, [csv]);
  const pathPrefix = (dbPath ?? `vault/${tag}`).replace(/\.[^./]+$/, "");
  const editable = props.filter((p) => !p.system);

  const load = async (file: File) => {
    setError("");
    setPlan(null);
    setResult(null);
    if (file.size > 2 * 1024 * 1024) { setError("The file is larger than 2 MB. Split it and import the parts."); return; }
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    try {
      const header = (parseCsv(text, { maxRows: 2001, maxCols: 60 })[0] ?? []).map((h) => h.trim());
      const m = guessMapping(header, editable);
      setMapping(m);
      setKeyColumn(Object.entries(m).find(([, k]) => k === "$title")?.[0] ?? "");
    } catch {
      setMapping({});
    }
  };
  const run = async (dryRun: boolean) => {
    if (!client.importCsv) return;
    setBusy(true);
    setError("");
    try {
      const out = await client.importCsv({ tag, csv, mapping, keyColumn: keyColumn || undefined, pathPrefix, dryRun });
      if (dryRun) setPlan(out);
      else {
        setResult(out);
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "vault" && (q.queryKey[1] === "notes" || q.queryKey[1] === "tree") });
      }
    } catch (e) {
      const raw = String((e as Error).message ?? "");
      const detail = raw.slice(raw.indexOf("{")).match(/"(?:detail|reason)":"([^"]+)"/)?.[1];
      setError(detail ?? "The import could not be prepared. Check the file and try again.");
    } finally {
      setBusy(false);
    }
  };
  const mapped = Object.values(mapping);
  const hasTitle = mapped.includes("$title");
  const dupTargets = mapped.filter((k) => k && mapped.indexOf(k) !== mapped.lastIndexOf(k));

  return (
    <div className="db-dialog-wrap" role="presentation" onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); onClose(); } }}>
      <div className="db-dialog db-dialog-wide" role="dialog" aria-modal="true" aria-label="Import CSV">
        <header className="db-dialog-head"><h2>Import CSV into #{tag}</h2><button type="button" className="db-icon-btn" aria-label="Close" onClick={onClose}>×</button></header>
        {result ? (
          <div className="db-settings" role="status">
            <p><strong>Import finished.</strong> Created {result.result?.created ?? 0}, updated {result.result?.updated ?? 0}{result.summary.unchanged ? `, ${result.summary.unchanged} already up to date` : ""}.</p>
            {(result.result?.failed.length ?? 0) > 0 && <p className="db-error">Not written: {result.result!.failed.map((f) => `row ${f.row} (${f.error})`).join(", ")}</p>}
            {result.errors.length > 0 && <p className="db-error">Skipped rows: {result.errors.map((f) => `row ${f.row}`).join(", ")}</p>}
            <div className="db-settings-row"><span /><button type="button" className="db-primary" onClick={onClose}>Done</button></div>
          </div>
        ) : (
          <>
            <label className="db-file">
              <Upload size={14} aria-hidden="true" />
              <span>{fileName || "Choose a .csv file (≤ 2 MB, 2,000 rows)"}</span>
              <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); }} />
            </label>
            {parsed && "error" in parsed && <p className="db-error" role="alert">{parsed.error}</p>}
            {parsed && "header" in parsed && (
              <>
                <p className="db-pop-heading">{parsed.count} {parsed.count === 1 ? "row" : "rows"} · map each column to a property</p>
                <table className="db-map" aria-label="Column mapping">
                  <thead><tr><th scope="col">Column</th><th scope="col">Example</th><th scope="col">Property</th></tr></thead>
                  <tbody>
                    {parsed.header.map((h, i) => (
                      <tr key={h + i}>
                        <th scope="row">{h}</th>
                        <td className="db-map-example">{parsed.preview[0]?.[i] ?? ""}</td>
                        <td>
                          <select aria-label={`Map ${h}`} value={mapping[h] ?? ""} onChange={(e) => { setPlan(null); setMapping({ ...mapping, [h]: e.target.value }); }}>
                            <option value="">Skip</option>
                            <option value="$title">Title</option>
                            {editable.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <label className="db-field">
                  <span>Match existing pages by</span>
                  <select aria-label="Key column" value={keyColumn} onChange={(e) => { setPlan(null); setKeyColumn(e.target.value); }}>
                    {parsed.header.filter((h) => mapping[h]).map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </label>
                {!hasTitle && <p className="db-error" role="alert">Map one column to Title.</p>}
                {dupTargets.length > 0 && <p className="db-error" role="alert">Two columns map to the same property.</p>}
              </>
            )}
            {error && <p className="db-error" role="alert">{error}</p>}
            {plan && (
              <div className="db-plan" role="status" aria-label="Import preview">
                <p><strong>Preview:</strong> {plan.summary.create} new, {plan.summary.update} updated, {plan.summary.unchanged} unchanged{plan.summary.error ? `, ${plan.summary.error} with problems` : ""}.</p>
                <ul>
                  {plan.sample.filter((s) => s.action !== "unchanged").slice(0, 8).map((s) => (
                    <li key={s.row}>Row {s.row}: <strong>{s.action === "create" ? "New" : "Update"}</strong> {s.title}{s.changes?.length ? ` — ${s.changes.join(", ")}` : ""}</li>
                  ))}
                  {plan.errors.slice(0, 8).map((s) => <li key={`e${s.row}`} className="db-error">Row {s.row}: {s.error}</li>)}
                </ul>
              </div>
            )}
            <div className="db-settings-row">
              <span className="db-pop-empty">Nothing is written until you import.</span>
              {plan
                ? <button type="button" className="db-primary" disabled={busy || plan.summary.create + plan.summary.update === 0} onClick={() => void run(false)}>{busy ? "Importing…" : `Import ${plan.summary.create + plan.summary.update} ${plan.summary.create + plan.summary.update === 1 ? "row" : "rows"}`}</button>
                : <button type="button" className="db-primary" disabled={busy || !csv || !hasTitle || dupTargets.length > 0 || !!(parsed && "error" in parsed)} onClick={() => void run(true)}>{busy ? "Checking…" : "Preview import"}</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
