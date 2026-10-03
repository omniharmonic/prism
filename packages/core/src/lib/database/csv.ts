/**
 * CSV — PURE, shared by the database CSV import (server: `POST
 * /api/databases/import/csv`, client: the mapping preview) and the CSV export
 * of a view (client only).
 *
 * Parsing is RFC 4180: comma separated, `"` quoting with `""` escapes, CRLF or
 * LF rows, a UTF-8 BOM ignored. It is a single linear scan (no regex over the
 * input), bounded by `maxRows` / `maxCols` / `maxCell`; going over a bound is an
 * error, never a silent truncation.
 */

export interface CsvLimits {
  maxRows?: number;
  maxCols?: number;
  maxCell?: number;
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

/** Parse CSV text into rows of cells. Throws {@link CsvError} on a bound or an unterminated quote. */
export function parseCsv(text: string, limits: CsvLimits = {}): string[][] {
  const maxRows = limits.maxRows ?? 10_000;
  const maxCols = limits.maxCols ?? 200;
  const maxCell = limits.maxCell ?? 10_000;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const pushCell = () => {
    if (cell.length > maxCell) throw new CsvError(`a cell is longer than ${maxCell} characters (row ${rows.length + 1})`);
    row.push(cell);
    cell = "";
    if (row.length > maxCols) throw new CsvError(`more than ${maxCols} columns (row ${rows.length + 1})`);
  };
  const pushRow = () => {
    pushCell();
    // A blank line (one empty cell) is skipped, like spreadsheets do.
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
      if (rows.length > maxRows) throw new CsvError(`more than ${maxRows} rows`);
    }
    row = [];
  };
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        cell += ch;
        if (cell.length > maxCell) throw new CsvError(`a cell is longer than ${maxCell} characters (row ${rows.length + 1})`);
      }
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") pushCell();
    else if (ch === "\n") pushRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else {
      cell += ch;
      if (cell.length > maxCell) throw new CsvError(`a cell is longer than ${maxCell} characters (row ${rows.length + 1})`);
    }
  }
  if (quoted) throw new CsvError("a quoted cell is not closed");
  if (cell !== "" || row.length) pushRow();
  return rows;
}

/**
 * One CSV cell. Values a spreadsheet would run as a formula (`=`, `+`, `-`, `@`,
 * tab, CR at the start) are prefixed with `'` (OWASP CSV injection guidance) —
 * an export must never carry an executable formula from someone else's page.
 */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A cell: text (formula-guarded) or a number (written as-is — review L3: `-5` stays `-5`). */
export type CsvCellValue = string | { number: number };

export function toCsv(rows: CsvCellValue[][]): string {
  return rows.map((r) => r.map((c) => (typeof c === "string" ? csvCell(c) : Number.isFinite(c.number) ? String(c.number) : "")).join(",")).join("\r\n") + "\r\n";
}

/** Coerce one CSV text cell to a vault field type. `{error}` when it cannot be. */
export function coerceCsvValue(raw: string, field: { type?: string; enum?: string[] } | undefined): { value: unknown } | { error: string } {
  const s = raw.trim();
  if (s === "") return { value: null };
  const type = field?.type;
  if (type === "number" || type === "integer") {
    const n = Number(s.replace(/,/g, ""));
    if (!Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) return { error: `“${s.slice(0, 40)}” is not a ${type}` };
    return { value: n };
  }
  if (type === "boolean") {
    const l = s.toLowerCase();
    if (["true", "yes", "1", "checked", "x", "✓"].includes(l)) return { value: true };
    if (["false", "no", "0", "unchecked"].includes(l)) return { value: false };
    return { error: `“${s.slice(0, 40)}” is not yes/no` };
  }
  if (type === "array") {
    const parts = s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
    return { value: [...new Set(parts)].slice(0, 200) };
  }
  if (field?.enum?.length && !field.enum.includes(s)) {
    const ci = field.enum.find((e) => e.toLowerCase() === s.toLowerCase());
    if (ci) return { value: ci };
    return { error: `“${s.slice(0, 40)}” is not an option` };
  }
  return { value: s };
}
