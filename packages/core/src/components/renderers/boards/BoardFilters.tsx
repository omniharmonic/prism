import { useState } from "react";
import { Plus, X } from "lucide-react";
import {
  calendarDateRange,
  DATE_PRESETS,
  type FilterDraft,
} from "../../../lib/boards/filters";
import { safeBoardField } from "../../../lib/boards/config";

import { formatDateTime as fmtDateTime } from "../../../lib/datetime/format";
const control =
  "min-h-11 min-w-0 w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] px-3 text-sm";
const remove =
  "grid min-h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--glass-hover)]";

function dateLabel(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? fmtDateTime(date, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : value;
}

export function BoardFilters({
  value,
  onChange,
  onDateEditing,
}: {
  value: FilterDraft;
  onChange: (value: FilterDraft) => void;
  onDateEditing: (editing: boolean) => void;
}) {
  const [addingDate, setAddingDate] = useState(false);
  const [dateField, setDateField] = useState("deadline");
  const [preset, setPreset] = useState("custom");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const addDate = () => {
    try {
      if (!safeBoardField(dateField.trim()))
        throw new Error("Choose an ordinary date property name.");
      const date =
        preset === "custom"
          ? calendarDateRange(dateField.trim(), from, to)
          : { field: dateField.trim(), preset };
      onChange({ ...value, date });
      setAddingDate(false);
      onDateEditing(false);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <fieldset className="min-w-0 space-y-3 rounded-xl border border-[var(--glass-border)] p-3">
      <legend className="px-1 text-sm font-medium">Filters</legend>
      <p className="text-xs text-[var(--text-secondary)]">
        Tasks must match every filter. Text values match exactly, including
        capitalization.
      </p>
      {value.rules.map((rule, index) => {
        const patch = (next: Partial<typeof rule>) =>
          onChange({
            ...value,
            rules: value.rules.map((r) =>
              r.id === rule.id ? { ...r, ...next } : r,
            ),
          });
        return (
          <fieldset
            key={rule.id}
            className="min-w-0 space-y-2 rounded-lg bg-[var(--glass)] p-3"
          >
            <legend className="sr-only">Property filter {index + 1}</legend>
            <div className="flex min-w-0 items-center gap-2">
              <input
                aria-label={`Filter ${index + 1} property`}
                className={control}
                placeholder="Property, e.g. project"
                value={rule.field}
                onChange={(e) => patch({ field: e.target.value })}
              />
              <button
                type="button"
                className={remove}
                aria-label={`Remove filter ${index + 1}`}
                onClick={() =>
                  onChange({
                    ...value,
                    rules: value.rules.filter((r) => r.id !== rule.id),
                  })
                }
              >
                <X size={16} />
              </button>
            </div>
            <select
              aria-label={`Filter ${index + 1} comparison`}
              className={control}
              value={rule.operator}
              onChange={(e) =>
                patch({ operator: e.target.value as typeof rule.operator })
              }
            >
              <option value="oneOf">Text is one of</option>
              <option value="greater">Number is greater than</option>
              <option value="less">Number is less than</option>
            </select>
            {rule.operator === "oneOf" ? (
              <textarea
                aria-label={`Filter ${index + 1} values (one per line)`}
                className={control + " py-2"}
                rows={2}
                placeholder="One exact value per line"
                value={rule.value}
                onChange={(e) => patch({ value: e.target.value })}
              />
            ) : (
              <input
                aria-label={`Filter ${index + 1} number`}
                type="number"
                step="any"
                className={control}
                value={rule.value}
                onChange={(e) => patch({ value: e.target.value })}
              />
            )}
          </fieldset>
        );
      })}
      {Object.entries(value.preserved).map(([field, matcher]) => (
        <div
          key={field}
          className="flex min-w-0 items-start gap-2 rounded-lg bg-[var(--glass)] p-3"
        >
          <div className="min-w-0 flex-1 text-xs">
            <p className="font-medium">{field} · Saved filter</p>
            <pre className="mt-1 whitespace-pre-wrap break-all font-sans text-[var(--text-secondary)]">
              {JSON.stringify(matcher)}
            </pre>
            <p className="mt-1 text-[var(--text-secondary)]">
              Kept exactly as saved. Remove it to define a new comparison.
            </p>
          </div>
          <button
            type="button"
            className={remove}
            aria-label={`Remove saved filter ${field}`}
            onClick={() =>
              onChange({
                ...value,
                preserved: Object.fromEntries(
                  Object.entries(value.preserved).filter(
                    ([key]) => key !== field,
                  ),
                ),
              })
            }
          >
            <X size={16} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={control + " flex items-center justify-center gap-2"}
        onClick={() =>
          onChange({
            ...value,
            rules: [
              ...value.rules,
              {
                id: crypto.randomUUID(),
                field: "",
                operator: "oneOf",
                value: "",
              },
            ],
          })
        }
      >
        <Plus size={15} />
        Add property filter
      </button>
      {value.date ? (
        <div className="flex min-w-0 items-start gap-2 rounded-lg bg-[var(--glass)] p-3">
          <div className="min-w-0 flex-1 text-xs">
            <p className="font-medium">{value.date.field} · Date filter</p>
            <p className="mt-1 break-all text-[var(--text-secondary)]">
              {value.date.from || value.date.to
                ? `${dateLabel(value.date.from, "Any start")} → ${dateLabel(value.date.to, "Any end")}`
                : (DATE_PRESETS.find(
                    ([key]) => key === value.date?.preset,
                  )?.[1] ??
                  value.date.preset ??
                  "All dates")}
            </p>
            <p className="mt-1 text-[var(--text-secondary)]">
              Kept as saved. Remove to choose a different range.
            </p>
          </div>
          <button
            type="button"
            className={remove}
            aria-label="Remove date filter"
            onClick={() => onChange({ ...value, date: undefined })}
          >
            <X size={16} />
          </button>
        </div>
      ) : addingDate ? (
        <fieldset className="min-w-0 space-y-2 rounded-lg bg-[var(--glass)] p-3">
          <legend className="sr-only">New date filter</legend>
          <input
            aria-label="Date property"
            className={control}
            value={dateField}
            onChange={(e) => setDateField(e.target.value)}
          />
          <select
            aria-label="Date range"
            className={control}
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            <option value="custom">Calendar dates</option>
            {DATE_PRESETS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          {preset === "custom" && (
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="min-w-0 text-xs">
                From
                <input
                  aria-label="From date"
                  type="date"
                  className={control}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="min-w-0 text-xs">
                Through
                <input
                  aria-label="Through date"
                  type="date"
                  className={control}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-[var(--color-error)]">
              {error}
            </p>
          )}
          <p className="text-xs text-[var(--text-secondary)]">
            Calendar ranges include the entire end day in your current time
            zone. Use Add date to include this filter before saving.
          </p>
          <div className="flex gap-2">
            <button type="button" className={control} onClick={addDate}>
              Add date
            </button>
            <button
              type="button"
              className={control}
              onClick={() => {
                setAddingDate(false);
                onDateEditing(false);
                setError("");
              }}
            >
              Cancel date
            </button>
          </div>
        </fieldset>
      ) : (
        <button
          type="button"
          className={control}
          onClick={() => {
            setAddingDate(true);
            onDateEditing(true);
          }}
        >
          Add date filter
        </button>
      )}
    </fieldset>
  );
}
