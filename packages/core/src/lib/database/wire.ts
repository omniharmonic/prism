/**
 * Wire types for the database depth routes (apps/server/src/routes/databases.ts):
 * `POST /api/properties/batch` and `POST /api/databases/import/csv`.
 */

export interface PropertyBatchItem {
  id: string;
  set: Record<string, unknown>;
  /** The values the caller last saw (per-field CAS). */
  expect?: Record<string, unknown>;
}

export type PropertyBatchResult =
  | { id: string; ok: true; updatedAt: string | null; metadata: Record<string, unknown> }
  | { id: string; ok: false; error: "not_found" | "forbidden" | "locked" | "conflict" | "vault_rejected" | "vault_error" | string; reason?: string; fields?: string[]; current?: Record<string, unknown> };

export interface CsvImportRequest {
  tag: string;
  csv: string;
  /** Column header → "$title" | property key | "" (skip). */
  mapping: Record<string, string>;
  /** Column whose property identifies an existing page (default: the title column). */
  keyColumn?: string;
  /** Folder for created pages (the database page's folder). */
  pathPrefix: string;
  /** Default true: plan only. */
  dryRun?: boolean;
}

export interface CsvImportRow {
  row: number;
  action: "create" | "update" | "unchanged" | "error";
  title: string;
  id?: string;
  changes?: string[];
  error?: string;
}

export interface CsvImportResponse {
  dryRun: boolean;
  tag: string;
  rows: number;
  key: string;
  summary: { create: number; update: number; unchanged: number; error: number; /** Rows where a cell was NOT applied because the page holds a structured value (objects) there. */ structuredKept?: number };
  sample: CsvImportRow[];
  errors: CsvImportRow[];
  result?: { created: number; updated: number; failed: Array<{ row: number; error: string }> };
}

/** `POST /api/schemas/:tag/fields/:field/remove-values` (owner-only; dry-run by default). */
export interface RemoveValuesResult {
  dryRun: boolean;
  tag: string;
  field: string;
  /** Pages whose value would be / was targeted. */
  total: number;
  /** Pages holding a value that are left alone, by reason. */
  skipped: { trashed: number; shared: number; system: number; ingest: number; private: number };
  truncated: boolean;
  /** A write run stopped at its page/time limit: ask again (each run re-lists). */
  more?: boolean;
  removed?: number;
  conflicts?: number;
  failed?: number;
  remaining?: number;
}

/**
 * `POST /api/schemas/:tag/fields/:field/convert` (owner-only; dry-run by default):
 * "change type" across vault types as a conversion into a NEW field.
 */
export interface ConvertPropertyResult {
  dryRun: boolean;
  tag: string;
  /** The property being converted, and the type it becomes. */
  field: string;
  to: string;
  /** The key of the new field the values are converted into. */
  target: string;
  /** Pages whose value converts. */
  total: number;
  /** Pages whose value has no faithful reading as the new type: left on the old property. */
  uncoercible: number;
  /** A few of those values (≤ 5, shortened), for the owner to judge. */
  samples: string[];
  /** Pages holding a value that are left alone, by reason. */
  skipped: { trashed: number; shared: number; system: number; ingest: number; private: number };
  truncated: boolean;
  /** A select-like target: how many options the converted values give it. */
  options?: number;
  /** Convertible pages not yet written. */
  pending: number;
  converted?: number;
  conflicts?: number;
  failed?: number;
  /** A write run stopped before every page was done: ask again (each run re-lists). */
  more?: boolean;
  /** The new property is shown and the old one is marked deleted. */
  done?: boolean;
}
