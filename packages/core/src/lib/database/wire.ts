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
  summary: { create: number; update: number; unchanged: number; error: number };
  sample: CsvImportRow[];
  errors: CsvImportRow[];
  result?: { created: number; updated: number; failed: Array<{ row: number; error: string }> };
}
