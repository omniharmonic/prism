import { leafTitle } from "../pages/containerTitle";
import type { Note } from "../types";
import {
  filterNotes,
  sortNotes,
  type DataSource,
  type SortConfig,
} from "../dashboard/filter-engine";

export interface BoardConfig {
  version: 1;
  source: DataSource;
  groupBy: string;
  columns: Array<{ id: string; label: string }>;
  cardFields: string[];
  sort: SortConfig;
  view: "board" | "list";
  /** Optional view-local rank; task notes are never rewritten to reorder. */
  order?: string[];
}
export const DEFAULT_BOARD: BoardConfig = {
  version: 1,
  source: { tags: ["task"] },
  groupBy: "status",
  columns: [
    { id: "todo", label: "To do" },
    { id: "in-progress", label: "In progress" },
    { id: "blocked", label: "Blocked" },
    { id: "done", label: "Done" },
  ],
  cardFields: ["priority", "deadline", "project"],
  sort: { field: "createdAt", direction: "desc" },
  view: "board",
};
export const safeBoardField = (value: string) =>
  /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) &&
  !/^(prism_|__|constructor$|prototype$|type$)/i.test(value);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 128);

/** Fail closed on unfamiliar configuration; never overwrite it with defaults. */
export function readBoardConfig(note: Pick<Note, "metadata">): BoardConfig {
  const raw = note.metadata?.prism_board;
  if (raw == null) return DEFAULT_BOARD;
  if (
    !record(raw) ||
    raw.version !== 1 ||
    typeof raw.groupBy !== "string" ||
    !safeBoardField(raw.groupBy) ||
    !Array.isArray(raw.columns) ||
    !raw.columns.length ||
    raw.columns.length > 24 ||
    !raw.columns.every(
      (c) =>
        record(c) &&
        typeof c.id === "string" &&
        !!c.id.trim() &&
        c.id.length <= 80 &&
        typeof c.label === "string" &&
        !!c.label.trim() &&
        c.label.length <= 80,
    ) ||
    new Set(raw.columns.map((c) => c.id)).size !== raw.columns.length ||
    !strings(raw.cardFields) ||
    raw.cardFields.length > 8 ||
    !raw.cardFields.every(safeBoardField) ||
    !record(raw.source) ||
    (raw.source.tags !== undefined && !strings(raw.source.tags)) ||
    (raw.source.pathPrefix !== undefined &&
      typeof raw.source.pathPrefix !== "string") ||
    (raw.source.metadataFilters !== undefined &&
      !record(raw.source.metadataFilters)) ||
    (raw.order !== undefined &&
      (!strings(raw.order) ||
        raw.order.length > 10000 ||
        new Set(raw.order).size !== raw.order.length)) ||
    !record(raw.sort) ||
    typeof raw.sort.field !== "string" ||
    !safeBoardField(raw.sort.field) ||
    !["asc", "desc"].includes(String(raw.sort.direction)) ||
    !["board", "list"].includes(String(raw.view))
  ) {
    throw new Error(
      "This board has an unsupported configuration. Its saved settings have been preserved.",
    );
  }
  return raw as unknown as BoardConfig;
}
export function boardTitle(note: Note): string {
  return (
    (typeof note.metadata?.title === "string" && note.metadata.title.trim()) ||
    leafTitle(note.path, note.metadata) ||
    "Untitled task"
  );
}
export function boardTasks(
  notes: Note[],
  config: BoardConfig,
  query: string,
): Note[] {
  const selected = filterNotes(notes, config.source);
  const needle = query.trim().toLocaleLowerCase();
  const sorted = sortNotes(
    needle
      ? selected.filter((n) =>
          boardTitle(n).toLocaleLowerCase().includes(needle),
        )
      : selected,
    config.sort,
  );
  if (!config.order) return sorted;
  const rank = new Map(config.order.map((id, index) => [id, index]));
  return sorted.sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}
export function boardStatus(note: Note, config: BoardConfig): string | null {
  const value = note.metadata?.[config.groupBy];
  return typeof value === "string" && config.columns.some((c) => c.id === value)
    ? value
    : null;
}

/** Move one view rank around a visible neighbor while retaining every hidden ID. */
export function reorderBoardTasks(
  config: BoardConfig,
  inventory: Note[],
  taskId: string,
  neighborId: string,
  direction: "earlier" | "later",
): string[] | null {
  if (!config.order || taskId === neighborId) return null;
  const order = [
    ...new Set([
      ...config.order,
      ...boardTasks(inventory, config, "").map((note) => note.id),
    ]),
  ].filter((id) => id !== taskId);
  const target = order.indexOf(neighborId);
  if (target < 0) return null;
  order.splice(target + (direction === "later" ? 1 : 0), 0, taskId);
  return order;
}
