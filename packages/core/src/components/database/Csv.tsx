/**
 * CSV for databases: export any view (client-side, formula-safe), and import a
 * file into the database's tag through the owner/admin server route
 * (`POST /api/databases/import/csv`): choose a file → map columns to
 * properties (+ the key column that identifies existing pages) → preview (a
 * dry run: what would be created/updated/unchanged, and per-row problems) →
 * import. Re-importing the same file converges instead of duplicating.
 */
import { saveTextFile, type SaveOutcome } from "../../lib/saveFile";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { coerceCsvValue, CsvError, parseCsv, toCsv, type CsvCellValue } from "../../lib/database/csv";
import { isStructuredValue, scalarText, valueText } from "../../lib/database/structured";
import { formatValue, isSystemKey, looksLikeEmail, PROPERTY_KIND_LABELS, propertyValue, VAULT_TYPE_FOR_KIND, type PropertyDef, type PropertyKind, type SchemaPatch } from "../../lib/database/schema";
import { isFieldKey } from "../../lib/database/query";
import { queryKeys } from "../../lib/parachute/queries";
import type { Note } from "../../lib/types";
import { createBlankDatabase, NewDatabaseError, newDatabaseErrorDetail, type NewDatabaseProgress } from "./createDatabase";
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
  const cellText = (r: QueryRow, p: PropertyDef): CsvCellValue => {
    const v = propertyValue(r, p.key);
    if (p.system === "created_time" || p.system === "edited_time") return typeof v === "string" ? v : "";
    if (p.kind === "date" && typeof v === "string") return v;
    // Numbers are data, not formulas: written raw so `-5` round-trips (review L3).
    if (p.kind === "number" && typeof v === "number") return { number: v };
    // Options are exported as STORED (a renamed option round-trips through an import).
    // A value holding objects is exported as people read it ("Ada — delegate"); a re-import never writes that text over the objects (server rule).
    if (isStructuredValue(v)) return valueText(v);
    if (p.kind === "select" || p.kind === "status" || p.kind === "multi_select") return Array.isArray(v) ? v.map(scalarText).join(", ") : v === null || v === undefined ? "" : scalarText(v);
    return formatValue(p, v);
  };
  return toCsv([["Title", ...props.map((p) => p.label)], ...rows.map((r) => [noteTitle(r), ...props.map((p) => cellText(r, p))])]);
}

/**
 * Hand the CSV to the person: a browser download, or the Prism Client's save panel / share sheet
 * (its web view cancels downloads — `lib/saveFile.ts`). Resolves what happened; throws on failure.
 */
export function downloadText(name: string, text: string): Promise<SaveOutcome> {
  return saveTextFile(name, `\ufeff${text}`, "csv");
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
                {!!plan.summary.structuredKept && <p className="db-pop-path" data-structured-kept>{plan.summary.structuredKept} {plan.summary.structuredKept === 1 ? "row keeps" : "rows keep"} a structured value as it is stored; the file’s text does not replace it.</p>}
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

// ── CSV → a NEW database (NP-DB-25) ──────────────────────────────────────────

/** Kinds a CSV column can become (each maps to one vault type; see VAULT_TYPE_FOR_KIND). */
export const CSV_COLUMN_KINDS: PropertyKind[] = ["text", "number", "select", "multi_select", "date", "checkbox", "url", "email"];
export interface CsvColumnPlan {
  /** The header text (the mapping key the import route uses). */
  name: string;
  /** "title" = the page title; "skip" = not imported; else the property kind to create. */
  as: "title" | "skip" | PropertyKind;
  /** The metadata key for a property column. */
  key: string;
}
export interface CsvNewDatabasePlan {
  header: string[];
  rows: string[][];
  columns: CsvColumnPlan[];
}

const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9_/-]{0,63}$/;
const YES_NO = new Set(["true", "false", "yes", "no", "1", "0", "checked", "unchecked"]);

/** A unique, valid property key for a column header. */
function keyForHeader(header: string, taken: Set<string>): string {
  let k = slug(header).slice(0, 56);
  if (!/^[a-z]/.test(k)) k = `p_${k}`;
  if (!isFieldKey(k) || isSystemKey(k)) k = `p_${k}`.slice(0, 60);
  let out = k;
  for (let i = 2; taken.has(out); i++) out = `${k}_${i}`;
  taken.add(out);
  return out;
}

/** Guess what a column holds from its values (the person can change it before anything is written). */
export function guessColumnKind(values: string[]): PropertyKind {
  const v = values.map((x) => x.trim()).filter(Boolean);
  if (!v.length) return "text";
  if (v.every((x) => Number.isFinite(Number(x.replace(/,/g, ""))) && /\d/.test(x))) return "number";
  if (v.every((x) => YES_NO.has(x.toLowerCase()))) return "checkbox";
  if (v.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))) return "date";
  if (v.every((x) => /^https?:\/\//i.test(x))) return "url";
  if (v.every(looksLikeEmail)) return "email";
  const distinct = new Set(v);
  if (v.length >= 4 && distinct.size <= 12 && distinct.size <= v.length / 2 && v.every((x) => x.length <= 40)) return "select";
  return "text";
}

/** Read a CSV and propose a title column and a property per other column. Pure: nothing is written. */
export function planNewDatabase(csv: string): CsvNewDatabasePlan {
  const all = parseCsv(csv, { maxRows: 2001, maxCols: 60 });
  const header = (all[0] ?? []).map((h) => h.trim());
  const rows = all.slice(1);
  const titleAt = Math.max(0, header.findIndex((h) => /^(name|title|page)$/i.test(h)));
  const taken = new Set<string>();
  const seen = new Set<string>();
  const columns = header.map((name, i): CsvColumnPlan => {
    // A repeated or empty header cannot be mapped (the import addresses columns by name).
    if (!name || seen.has(name)) return { name, as: "skip", key: "" };
    seen.add(name);
    if (i === titleAt) return { name, as: "title", key: "" };
    return { name, as: guessColumnKind(rows.map((r) => r[i] ?? "")), key: keyForHeader(name, taken) };
  });
  return { header, rows, columns };
}

/** The vault field a column creates (a select gets its distinct values as options). */
function fieldFor(col: CsvColumnPlan, values: string[]): { type: string; enum?: string[] } {
  const kind = col.as as PropertyKind;
  const type = VAULT_TYPE_FOR_KIND[kind];
  if (kind !== "select") return { type };
  const options = [...new Set(values.map((x) => x.trim()).filter(Boolean))].slice(0, 100);
  return options.length ? { type, enum: options } : { type };
}

/** Rows whose value does not fit its column's type (they would be reported, not imported). */
export function newDatabaseProblems(plan: CsvNewDatabasePlan): Array<{ row: number; column: string; error: string }> {
  const out: Array<{ row: number; column: string; error: string }> = [];
  plan.columns.forEach((col, i) => {
    if (col.as === "title" || col.as === "skip") return;
    const field = fieldFor(col, plan.rows.map((r) => r[i] ?? ""));
    plan.rows.forEach((r, n) => {
      const c = coerceCsvValue(r[i] ?? "", field);
      if ("error" in c) out.push({ row: n + 2, column: col.name, error: c.error });
    });
  });
  return out;
}

// The page → schema → view steps are `createBlankDatabase` (shared with "New database"); the
// progress/error types live there and are re-exported for existing callers.
export { NewDatabaseError, type NewDatabaseProgress } from "./createDatabase";

/**
 * Create a database from a CSV. Order matters:
 *   1. the database PAGE (unconfigured) — or `adopt` an empty one;
 *   2. the tag's properties, with `requireNew`: the SERVER refuses a tag that is
 *      used, shared, published or an integration's (if it does, a page made in
 *      step 1 is put in the Trash again — a schema, once written, cannot be undone,
 *      so it comes after the page);
 *   3. the page's view config, against the page's CURRENT revision;
 *   4. the rows, through the same owner/admin import route as "Import CSV…".
 * A failure throws {@link NewDatabaseError} carrying the progress; pass it back
 * as `resume` to continue (nothing is created twice; rows are matched by title).
 */
export async function importCsvAsNewDatabase(client: VaultClient, opts: {
  csv: string; plan: CsvNewDatabasePlan; tag: string; title: string;
  /** Folder for the new database page (ignored with `adopt`). */
  folder?: string;
  /** An existing, still unconfigured database page to turn into this database. */
  adopt?: Pick<Note, "id" | "path">;
  resume?: NewDatabaseProgress;
}): Promise<{ note: Pick<Note, "id" | "path">; result: CsvImportResponse }> {
  if (!client.updateSchema || !client.importCsv) throw new Error("Importing a CSV as a database needs the Prism Server.");
  const cols = opts.plan.columns.filter((c) => c.as !== "title" && c.as !== "skip");
  const index = (c: CsvColumnPlan) => opts.plan.header.indexOf(c.name);
  // 1–3. The page, the tag's properties (requireNew), the view config.
  const { note, progress } = await createBlankDatabase(client, {
    tag: opts.tag, title: opts.title, folder: opts.folder, adopt: opts.adopt,
    properties: cols.map((c) => ({
      key: c.key,
      field: fieldFor(c, opts.plan.rows.map((r) => r[index(c)] ?? "")) as NonNullable<SchemaPatch["fields"]>[string],
      ui: { kind: c.as as PropertyKind, label: c.name.slice(0, 80) },
    })),
  }, opts.resume);
  // 4. The rows.
  const mapping: Record<string, string> = {};
  for (const c of opts.plan.columns) if (c.name) mapping[c.name] = c.as === "title" ? "$title" : c.as === "skip" ? "" : c.key;
  const pathPrefix = (note.path ?? `vault/${opts.tag}`).replace(/\.[^./]+$/, "");
  try {
    const result = await client.importCsv({ tag: opts.tag, csv: opts.csv, mapping, pathPrefix, dryRun: false });
    return { note, result };
  } catch (e) {
    throw new NewDatabaseError("import", progress, newDatabaseErrorDetail(e));
  }
}

/**
 * "Import a CSV as a new database" — for an import entry (pass `folder`) or an
 * empty database page (`adopt`). Choose a file → name it and its tag → check each
 * column's type → Preview (nothing is written) → create + import.
 */
export function CsvNewDatabaseDialog({ folder = "", adopt, onClose, onCreated }: {
  folder?: string;
  adopt?: Pick<Note, "id" | "path"> & { title?: string };
  onClose: () => void;
  /** The new database page, once it exists (open it). */
  onCreated?: (note: Pick<Note, "id" | "path">, title: string) => void;
}) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState<CsvNewDatabasePlan | null>(null);
  const [title, setTitle] = useState(adopt?.title ?? "");
  const [tag, setTag] = useState("");
  const [checked, setChecked] = useState<{ problems: ReturnType<typeof newDatabaseProblems> } | null>(null);
  const [done, setDone] = useState<{ note: Pick<Note, "id" | "path">; result: CsvImportResponse } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // What a failed attempt already made: a retry continues from there.
  const [progress, setProgress] = useState<NewDatabaseProgress | null>(null);
  const available = !!client.updateSchema && !!client.importCsv;

  const load = async (file: File) => {
    setError(""); setChecked(null); setPlan(null);
    if (file.size > 2 * 1024 * 1024) { setError("The file is larger than 2 MB. Split it and import the parts."); return; }
    const text = await file.text();
    try {
      const p = planNewDatabase(text);
      if (!p.header.length || !p.rows.length) { setError("This file has no rows to import."); return; }
      const base = file.name.replace(/\.csv$/i, "").trim() || "Imported";
      setCsv(text);
      setFileName(file.name);
      setPlan(p);
      if (!adopt?.title) setTitle((t) => t || base);
      setTag((t) => t || slug(base).replace(/_/g, "-").slice(0, 40) || "imported");
    } catch (e) {
      setError(e instanceof CsvError ? e.message : "This file is not valid CSV.");
    }
  };
  const setColumn = (i: number, as: CsvColumnPlan["as"]) => {
    if (!plan) return;
    setChecked(null);
    // One title column: choosing another turns the previous one into text.
    const taken = new Set(plan.columns.map((c) => c.key).filter(Boolean));
    setPlan({ ...plan, columns: plan.columns.map((c, j) => {
      if (j === i) return { ...c, as, key: as === "title" || as === "skip" ? c.key : c.key || keyForHeader(c.name, taken) };
      if (as === "title" && c.as === "title") return { ...c, as: "text", key: c.key || keyForHeader(c.name, taken) };
      return c;
    }) });
  };
  const hasTitle = !!plan?.columns.some((c) => c.as === "title");
  const tagOk = TAG_NAME.test(tag.trim());
  const ready = !!plan && hasTitle && tagOk && !!title.trim();

  const preview = async () => {
    if (!plan) return;
    setBusy(true); setError("");
    try {
      // The tag must be new. The SERVER decides (it also knows who a tag is shared with or
      // published to); the schema write enforces the same rule again at import time.
      const t = tag.trim();
      if (client.checkNewTag) {
        const a = await client.checkNewTag(t);
        if (!a.available) {
          setError(`#${t} can’t start a new database: ${a.detail ?? "it is already in use"}. Choose a new tag${a.reason === "tag_in_use" ? ", or open that tag’s database and use “Import CSV…” there" : ""}.`);
          return;
        }
      } else {
        const [schemas, tags] = await Promise.all([client.getSchemas ? client.getSchemas([t]) : Promise.resolve({ schemas: {} }), client.getTags()]);
        const used = tags.find((x) => x.tag === t)?.count ?? 0;
        if (used > 0 || Object.keys((schemas.schemas as Record<string, { fields?: object }>)[t]?.fields ?? {}).length) {
          setError(`#${t} is already in use${used ? ` by ${used} ${used === 1 ? "page" : "pages"}` : ""}. Choose a new tag, or open that tag’s database and use “Import CSV…” there.`);
          return;
        }
      }
      setChecked({ problems: newDatabaseProblems(plan) });
    } catch {
      setError("Prism could not check that tag. Nothing was created.");
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!plan) return;
    setBusy(true); setError("");
    try {
      const out = await importCsvAsNewDatabase(client, { csv, plan, tag: tag.trim(), title: title.trim(), folder, adopt, resume: progress ?? undefined });
      setProgress(null);
      setDone(out);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "vault" && (q.queryKey[1] === "notes" || q.queryKey[1] === "tree" || q.queryKey[1] === "schemas" || q.queryKey[1] === "tags") });
      if (adopt) void qc.invalidateQueries({ queryKey: queryKeys.vault.note(adopt.id) });
    } catch (e) {
      const name = title.trim();
      if (!(e instanceof NewDatabaseError)) setError("The import could not start. Nothing was created.");
      else {
        // Say exactly what exists now — never point at a page that was not made (or was taken back).
        const p = e.progress;
        setProgress(p.note || p.schemaDone ? p : null);
        const why = e.detail ? `${e.detail.charAt(0).toUpperCase()}${e.detail.slice(1)}. ` : "";
        if (e.stage === "page") setError(`${why}The database page could not be created. Nothing was created.`);
        else if (e.stage === "schema") {
          if (!p.note || e.pageRemoved) setError(`${why}Nothing was created.`);
          else if (adopt) setError(`${why}This page is unchanged and nothing was imported.`);
          else setError(`${why}An empty database page “${name}” was created but could not be removed; nothing was imported into it.`);
          setChecked(null);
          if (!p.schemaBatches) setProgress(null);
        } else if (e.stage === "config") setError(`${why}The properties were created, but the database page could not be set up and no rows were imported. Try again.`);
        else setError(`${why}“${name}” was created with its properties, but the rows were not imported. Try again — rows are matched by title, so nothing is duplicated.`);
      }
      if (adopt) void qc.invalidateQueries({ queryKey: queryKeys.vault.note(adopt.id) });
      void qc.invalidateQueries({ queryKey: ["vault", "tree"] });
    } finally {
      setBusy(false);
    }
  };
  const propCount = plan?.columns.filter((c) => c.as !== "title" && c.as !== "skip").length ?? 0;
  const badRows = new Set(checked?.problems.map((p) => p.row)).size;

  return (
    <div className="db-dialog-wrap" role="presentation" onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); onClose(); } }}>
      <div className="db-dialog db-dialog-wide" role="dialog" aria-modal="true" aria-label="Import CSV as a new database">
        <header className="db-dialog-head"><h2>Import a CSV as a new database</h2><button type="button" className="db-icon-btn" aria-label="Close" onClick={onClose}>×</button></header>
        {!available ? (
          <p className="db-pop-empty">Importing a CSV as a database needs the Prism Server and an owner account.</p>
        ) : done ? (
          <div className="db-settings" role="status">
            <p><strong>“{title.trim()}” is ready.</strong> Created {done.result.result?.created ?? 0} {(done.result.result?.created ?? 0) === 1 ? "page" : "pages"}{done.result.result?.updated ? `, updated ${done.result.result.updated}` : ""} with {propCount} {propCount === 1 ? "property" : "properties"}.</p>
            {done.result.errors.length > 0 && <p className="db-error">Skipped rows: {done.result.errors.slice(0, 12).map((f) => `row ${f.row}${f.error ? ` (${f.error})` : ""}`).join(", ")}</p>}
            {(done.result.result?.failed.length ?? 0) > 0 && <p className="db-error">Not written: {done.result.result!.failed.map((f) => `row ${f.row}`).join(", ")}</p>}
            <div className="db-settings-row"><span /><button type="button" className="db-primary" onClick={() => { onCreated?.(done.note, title.trim()); onClose(); }}>{onCreated ? "Open database" : "Done"}</button></div>
          </div>
        ) : (
          <>
            <label className="db-file">
              <Upload size={14} aria-hidden="true" />
              <span>{fileName || "Choose a .csv file (≤ 2 MB, 2,000 rows)"}</span>
              <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); }} />
            </label>
            {plan && (
              <>
                <div className="db-date-row">
                  <label className="db-field"><span>Database name</span><input aria-label="Database name" value={title} maxLength={120} disabled={busy || !!adopt?.title} onChange={(e) => { setTitle(e.target.value); setChecked(null); }} /></label>
                  <label className="db-field"><span>Tag for its pages</span><input aria-label="Tag for its pages" value={tag} maxLength={64} disabled={busy} spellCheck={false} onChange={(e) => { setTag(e.target.value); setChecked(null); }} /></label>
                </div>
                {!tagOk && tag !== "" && <p className="db-error" role="alert">Use a tag name: letters, numbers, - or _.</p>}
                <p className="db-pop-heading">{plan.rows.length} {plan.rows.length === 1 ? "row" : "rows"} · every row becomes a page tagged #{tag.trim() || "…"}; choose what each column becomes</p>
                <table className="db-map" aria-label="Columns">
                  <thead><tr><th scope="col">Column</th><th scope="col">Example</th><th scope="col">Becomes</th></tr></thead>
                  <tbody>
                    {plan.columns.map((c, i) => (
                      <tr key={c.name + i}>
                        <th scope="row">{c.name || <em>(no name)</em>}</th>
                        <td className="db-map-example">{plan.rows.find((r) => (r[i] ?? "").trim())?.[i] ?? ""}</td>
                        <td>
                          <select aria-label={`Column ${c.name}`} value={c.as} disabled={busy || !c.name || plan.columns.findIndex((x) => x.name === c.name) !== i} onChange={(e) => setColumn(i, e.target.value as CsvColumnPlan["as"])}>
                            <option value="title">Title</option>
                            {CSV_COLUMN_KINDS.map((k) => <option key={k} value={k}>{PROPERTY_KIND_LABELS[k]}</option>)}
                            <option value="skip">Skip</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!hasTitle && <p className="db-error" role="alert">Choose which column is the Title.</p>}
              </>
            )}
            {error && <p className="db-error" role="alert">{error}</p>}
            {checked && plan && (
              <div className="db-plan" role="status" aria-label="Import preview">
                <p><strong>Preview:</strong> a new database “{title.trim()}” with {propCount} {propCount === 1 ? "property" : "properties"}, and {plan.rows.length - badRows} of {plan.rows.length} rows as pages tagged #{tag.trim()}{badRows ? `; ${badRows} ${badRows === 1 ? "row has" : "rows have"} a value that does not fit its column and will be skipped` : ""}.</p>
                {checked.problems.length > 0 && <ul>{checked.problems.slice(0, 8).map((p, i) => <li key={i} className="db-error">Row {p.row}, {p.column}: {p.error}</li>)}</ul>}
              </div>
            )}
            <div className="db-settings-row">
              <span className="db-pop-empty">Nothing is created until you import.</span>
              {checked
                ? progress?.configDone
                  ? <button type="button" className="db-primary" disabled={busy} onClick={() => void run()}>{busy ? "Importing…" : "Try the import again"}</button>
                  : <button type="button" className="db-primary" disabled={busy || !ready} onClick={() => void run()}>{busy ? "Importing…" : `Create database and import ${plan!.rows.length - badRows} ${plan!.rows.length - badRows === 1 ? "row" : "rows"}`}</button>
                : <button type="button" className="db-primary" disabled={busy || !ready} onClick={() => void preview()}>{busy ? "Checking…" : "Preview"}</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
