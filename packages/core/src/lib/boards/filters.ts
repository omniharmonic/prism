import type { DataSource } from "../dashboard/filter-engine";
import { safeBoardField } from "./config";

export type PropertyRule = {
  id: string;
  field: string;
  operator: "oneOf" | "greater" | "less";
  value: string;
};
export type FilterDraft = {
  rules: PropertyRule[];
  preserved: Record<string, unknown>;
  date: NonNullable<DataSource["dateRange"]> | undefined;
};
export const DATE_PRESETS = [
  ["today", "Today so far"],
  ["this-week", "This week so far"],
  ["this-month", "This month so far"],
  ["last-7-days", "Past 7 days"],
  ["last-30-days", "Past 30 days"],
] as const;

/** Only expose formats we can round-trip exactly. Older/advanced rules stay intact. */
export function readFilterDraft(source: DataSource): FilterDraft {
  const rules: PropertyRule[] = [];
  const preserved: Record<string, unknown> = Object.create(null);
  for (const [field, matcher] of Object.entries(source.metadataFilters ?? {})) {
    const entries =
      matcher && typeof matcher === "object" && !Array.isArray(matcher)
        ? Object.entries(matcher)
        : [];
    const [op, value] = entries[0] ?? [];
    if (
      safeBoardField(field) &&
      entries.length === 1 &&
      op === "$in" &&
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (v) =>
          typeof v === "string" &&
          !!v.trim() &&
          v === v.trim() &&
          !v.includes("\n"),
      )
    ) {
      rules.push({
        id: crypto.randomUUID(),
        field,
        operator: "oneOf",
        value: value.join("\n"),
      });
    } else if (
      safeBoardField(field) &&
      entries.length === 1 &&
      (op === "$gt" || op === "$lt") &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      rules.push({
        id: crypto.randomUUID(),
        field,
        operator: op === "$gt" ? "greater" : "less",
        value: String(value),
      });
    } else {
      preserved[field] = matcher;
    }
  }
  return { rules, preserved, date: source.dateRange };
}

export function propertyFilters(
  draft: FilterDraft,
): Record<string, unknown> | undefined {
  const entries: Array<[string, unknown]> = Object.entries(draft.preserved);
  const fields = new Set(entries.map(([key]) => key));
  for (const rule of draft.rules) {
    const field = rule.field.trim();
    if (!safeBoardField(field))
      throw new Error("Choose an ordinary property name for each filter.");
    if (fields.has(field))
      throw new Error(
        `Use one filter per property. ${field} already has a filter.`,
      );
    fields.add(field);
    if (rule.operator === "oneOf") {
      const values = [
        ...new Set(
          rule.value
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ];
      if (!values.length)
        throw new Error(`Enter at least one text value for ${field}.`);
      entries.push([field, { $in: values }]);
    } else {
      const value = Number(rule.value);
      if (!rule.value.trim() || !Number.isFinite(value))
        throw new Error(`Enter a number for ${field}.`);
      entries.push([
        field,
        { [rule.operator === "greater" ? "$gt" : "$lt"]: value },
      ]);
    }
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Whole local calendar days; ISO bounds keep the chosen time zone after saving. */
export function calendarDateRange(
  field: string,
  from: string,
  to: string,
): NonNullable<DataSource["dateRange"]> {
  if (!safeBoardField(field))
    throw new Error("Choose an ordinary date property name.");
  if (!from && !to) throw new Error("Choose a start or end date.");
  const parse = (value: string, end: boolean) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error("Choose a valid calendar date.");
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(
      year,
      month - 1,
      day,
      end ? 23 : 0,
      end ? 59 : 0,
      end ? 59 : 0,
      end ? 999 : 0,
    );
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    )
      throw new Error("Choose a valid calendar date.");
    return date.toISOString();
  };
  const start = from ? parse(from, false) : undefined;
  const end = to ? parse(to, true) : undefined;
  if (start && end && start > end)
    throw new Error("The end date must be on or after the start date.");
  return {
    field,
    ...(start ? { from: start } : {}),
    ...(end ? { to: end } : {}),
  };
}
