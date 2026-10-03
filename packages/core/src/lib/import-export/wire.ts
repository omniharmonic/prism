/** Wire types shared by `apps/server/src/routes/{import,export}.ts` and the client. */

export type ExportFormat = "markdown" | "html";
export type ExportScope = "page" | "vault";

export interface ExportRequest {
  scope: ExportScope;
  /** Required for `scope: "page"`. */
  noteId?: string;
  format: ExportFormat;
  /** Page scope: include the page's sub-pages (default true). */
  subpages?: boolean;
  /** Include images and files the pages reference (default true). */
  attachments?: boolean;
}

export type TransferState = "queued" | "running" | "done" | "error" | "cancelled";

export interface ExportJob {
  id: string;
  state: TransferState;
  scope: ExportScope;
  format: ExportFormat;
  /** Pages written so far / pages to write. */
  done: number;
  total: number;
  attachments: number;
  /** Pages that could not be included (too large, unreadable). Never counts pages the caller cannot view. */
  skipped: number;
  bytes: number;
  fileName: string | null;
  error: string | null;
  expiresAt: number | null;
}

export interface ImportItem {
  path: string;
  kind: "page" | "database" | "row";
  action: "create" | "update" | "unchanged" | "conflict";
  reason?: string;
}

export interface ImportSummary {
  pages: number;
  databases: number;
  rows: number;
  attachments: number;
  links: number;
  create: number;
  update: number;
  unchanged: number;
  conflict: number;
  ignored: number;
}

export interface ImportPreview {
  dryRun: true;
  destination: string;
  summary: ImportSummary;
  /** The first items, parents first. */
  items: ImportItem[];
  problems: Array<{ entry: string; reason: string }>;
}

export interface ImportJob {
  id: string;
  state: TransferState;
  destination: string;
  done: number;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  attachments: number;
  failed: Array<{ path: string; reason: string }>;
  problems: Array<{ entry: string; reason: string }>;
  /** The first page written (to open when the import finishes). */
  firstId: string | null;
  error: string | null;
}
