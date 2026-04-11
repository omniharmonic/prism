/**
 * Pure functions for client-side filtering, sorting, grouping, and aggregation of Notes.
 */
import type { Note } from "../types";

// ── Data source / config types ──────────────────────────────────────

export interface DataSource {
  tags?: string[];
  pathPrefix?: string;
  metadataFilters?: Record<string, unknown>;
  dateRange?: { field: string; preset?: string; from?: string; to?: string };
  limit?: number;
}

export interface SortConfig {
  field: string;
  direction: "asc" | "desc";
}

export interface GroupConfig {
  field: string;
  order?: string[];
}

export type AggregateType = "count" | "count-where" | "percentage-where";

// ── Helpers ─────────────────────────────────────────────────────────

/** Safely read a metadata value by field name. */
export function getMetadataValue(note: Note, field: string): unknown {
  if (!note.metadata) return undefined;
  return (note.metadata as Record<string, unknown>)[field];
}

/** Resolve special sentinel values (e.g. "today"). */
function resolveValue(value: unknown): unknown {
  if (value === "today") {
    return new Date().toISOString().slice(0, 10);
  }
  return value;
}

/**
 * Evaluate a condition object against a note.
 * Supports operators: $eq (default), $ne, $lt, $gt, $in.
 * Each key in `condition` is a field name; the value is either a literal
 * (shorthand for $eq) or an operator object like { $gt: 5 }.
 */
export function evaluateCondition(
  note: Note,
  condition: Record<string, unknown>,
): boolean {
  for (const [field, matcher] of Object.entries(condition)) {
    const noteVal = getFieldValue(note, field);

    if (
      matcher !== null &&
      typeof matcher === "object" &&
      !Array.isArray(matcher)
    ) {
      const ops = matcher as Record<string, unknown>;
      for (const [op, rawTarget] of Object.entries(ops)) {
        const target = resolveValue(rawTarget);
        switch (op) {
          case "$eq":
            if (noteVal !== target) return false;
            break;
          case "$ne":
            if (noteVal === target) return false;
            break;
          case "$lt":
            if (typeof noteVal !== "number" || typeof target !== "number")
              return false;
            if (noteVal >= target) return false;
            break;
          case "$gt":
            if (typeof noteVal !== "number" || typeof target !== "number")
              return false;
            if (noteVal <= target) return false;
            break;
          case "$in":
            if (!Array.isArray(target)) return false;
            if (!target.includes(noteVal)) return false;
            break;
          default:
            break;
        }
      }
    } else {
      // Shorthand: literal equality
      if (noteVal !== resolveValue(matcher)) return false;
    }
  }
  return true;
}

// ── Field accessor (works for built-in fields + metadata) ───────────

function getFieldValue(note: Note, field: string): unknown {
  switch (field) {
    case "createdAt":
      return note.createdAt;
    case "updatedAt":
      return note.updatedAt;
    case "path":
      return note.path;
    case "id":
      return note.id;
    case "content":
      return note.content;
    default:
      return getMetadataValue(note, field);
  }
}

// ── Date range helpers ──────────────────────────────────────────────

function getDateRangeBounds(
  dateRange: NonNullable<DataSource["dateRange"]>,
): { from: Date | null; to: Date | null } {
  if (dateRange.from || dateRange.to) {
    return {
      from: dateRange.from ? new Date(dateRange.from) : null,
      to: dateRange.to ? new Date(dateRange.to) : null,
    };
  }

  if (!dateRange.preset) return { from: null, to: null };

  const now = new Date();
  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );

  switch (dateRange.preset) {
    case "today":
      return { from: startOfDay, to: now };
    case "this-week": {
      const day = startOfDay.getDay();
      const monday = new Date(startOfDay);
      monday.setDate(monday.getDate() - ((day + 6) % 7));
      return { from: monday, to: now };
    }
    case "this-month":
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1),
        to: now,
      };
    case "last-7-days": {
      const d = new Date(startOfDay);
      d.setDate(d.getDate() - 7);
      return { from: d, to: now };
    }
    case "last-30-days": {
      const d = new Date(startOfDay);
      d.setDate(d.getDate() - 30);
      return { from: d, to: now };
    }
    case "all-time":
    default:
      return { from: null, to: null };
  }
}

// ── Core functions ──────────────────────────────────────────────────

/** Filter notes by tags (AND), pathPrefix, metadataFilters, and dateRange. */
export function filterNotes(notes: Note[], source: DataSource): Note[] {
  let result = notes;

  // Tags — AND semantics: note must have ALL specified tags
  if (source.tags && source.tags.length > 0) {
    result = result.filter((n) => {
      if (!n.tags) return false;
      return source.tags!.every((t) => n.tags!.includes(t));
    });
  }

  // Path prefix
  if (source.pathPrefix) {
    const prefix = source.pathPrefix;
    result = result.filter((n) => n.path != null && n.path.startsWith(prefix));
  }

  // Metadata filters (shallow equality per key)
  if (source.metadataFilters) {
    result = result.filter((n) =>
      evaluateCondition(n, source.metadataFilters!),
    );
  }

  // Date range
  if (source.dateRange) {
    const { from, to } = getDateRangeBounds(source.dateRange);
    const field = source.dateRange.field;
    if (from || to) {
      result = result.filter((n) => {
        const raw = getFieldValue(n, field);
        if (!raw || typeof raw !== "string") return false;
        const d = new Date(raw);
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
    }
  }

  // Limit
  if (source.limit && source.limit > 0) {
    result = result.slice(0, source.limit);
  }

  return result;
}

/** Sort notes by any built-in or metadata field. */
export function sortNotes(notes: Note[], sort: SortConfig): Note[] {
  const sorted = [...notes];
  const dir = sort.direction === "asc" ? 1 : -1;

  sorted.sort((a, b) => {
    const aVal = getFieldValue(a, sort.field);
    const bVal = getFieldValue(b, sort.field);

    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    if (typeof aVal === "string" && typeof bVal === "string") {
      return aVal.localeCompare(bVal) * dir;
    }
    if (typeof aVal === "number" && typeof bVal === "number") {
      return (aVal - bVal) * dir;
    }
    return String(aVal).localeCompare(String(bVal)) * dir;
  });

  return sorted;
}

/** Group notes by a metadata field value. Optionally reorder groups. */
export function groupNotes(
  notes: Note[],
  group: GroupConfig,
): Map<string, Note[]> {
  const groups = new Map<string, Note[]>();

  for (const note of notes) {
    const raw = getFieldValue(note, group.field);
    const key = raw != null ? String(raw) : "—";
    const list = groups.get(key);
    if (list) {
      list.push(note);
    } else {
      groups.set(key, [note]);
    }
  }

  // Apply custom order if provided
  if (group.order && group.order.length > 0) {
    const ordered = new Map<string, Note[]>();
    for (const key of group.order) {
      const list = groups.get(key);
      if (list) ordered.set(key, list);
    }
    // Append remaining groups not in the order list
    for (const [key, list] of groups) {
      if (!ordered.has(key)) ordered.set(key, list);
    }
    return ordered;
  }

  return groups;
}

/** Aggregate notes into a single number. */
export function aggregateNotes(
  notes: Note[],
  type: AggregateType,
  condition?: Record<string, unknown>,
): number {
  switch (type) {
    case "count":
      return notes.length;
    case "count-where": {
      if (!condition) return 0;
      return notes.filter((n) => evaluateCondition(n, condition)).length;
    }
    case "percentage-where": {
      if (!condition || notes.length === 0) return 0;
      const matching = notes.filter((n) =>
        evaluateCondition(n, condition),
      ).length;
      return Math.round((matching / notes.length) * 100);
    }
  }
}
