import { SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import type { SearchFilters } from "../../lib/search/match";

export type DateRange = "any" | "week" | "month" | "year";
export interface SearchFilterState {
  titleOnly: boolean;
  type: string;
  author: "anyone" | "me";
  date: DateRange;
  /** "" = the vault you are in. */
  vault: string;
}
export interface SearchVault { id: string; label: string; active: boolean }
export const EMPTY_FILTERS: SearchFilterState = { titleOnly: false, type: "", author: "anyone", date: "any", vault: "" };

const TYPES: Array<[string, string]> = [
  ["", "Any type"], ["document", "Pages"], ["database", "Databases"], ["task", "Tasks"],
  ["meeting", "Meetings"], ["email", "Email"], ["message-thread", "Messages"], ["person", "People"],
  ["spreadsheet", "Spreadsheets"], ["canvas", "Canvases"], ["code", "Code"],
];

function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/** UI state → the wire filters shared with the server. */
export function toSearchFilters(state: SearchFilterState): SearchFilters {
  const f: SearchFilters = {};
  if (state.titleOnly) f.titleOnly = true;
  if (state.type) f.types = [state.type];
  if (state.author === "me") f.author = "me";
  if (state.date !== "any") f.after = isoDaysAgo(state.date === "week" ? 7 : state.date === "month" ? 30 : 365);
  if (state.vault) f.vault = state.vault;
  return f;
}

export function activeFilterCount(state: SearchFilterState): number {
  return Number(state.titleOnly) + Number(!!state.type) + Number(state.author !== "anyone") + Number(state.date !== "any") + Number(!!state.vault);
}

/**
 * NP-SR-04: title-only, type, edited-by and date filters for ⌘K and the phone
 * Search tab. Native controls only, so keyboard and screen readers work as-is.
 */
export function SearchFilterBar({ value, onChange, onDone, vaults }: { value: SearchFilterState; onChange: (next: SearchFilterState) => void; onDone?: () => void; vaults?: SearchVault[] }) {
  const [open, setOpen] = useState(() => activeFilterCount(value) > 0);
  const count = activeFilterCount(value);
  const set = (patch: Partial<SearchFilterState>) => { onChange({ ...value, ...patch }); onDone?.(); };
  return (
    <div className="prism-search-filterbar">
      <button type="button" className="prism-search-filter-toggle focus-ring" aria-expanded={open} aria-controls="prism-search-filter-panel"
        onClick={() => setOpen((o) => !o)}>
        <SlidersHorizontal size={14} aria-hidden /> Filters{count ? ` · ${count}` : ""}
      </button>
      {open && (
        <div id="prism-search-filter-panel" role="group" aria-label="Search filters" className="prism-search-filter-panel">
          <label className="prism-search-filter-check">
            <input type="checkbox" checked={value.titleOnly} onChange={(e) => set({ titleOnly: e.target.checked })} />
            Title only
          </label>
          <select aria-label="Type" value={value.type} onChange={(e) => set({ type: e.target.value })}>
            {TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <select aria-label="Edited by" value={value.author} onChange={(e) => set({ author: e.target.value as SearchFilterState["author"] })}>
            <option value="anyone">Anyone</option>
            <option value="me">Created or edited by me</option>
          </select>
          <select aria-label="Date" value={value.date} onChange={(e) => set({ date: e.target.value as DateRange })}>
            <option value="any">Any time</option>
            <option value="week">Edited in the past week</option>
            <option value="month">Edited in the past month</option>
            <option value="year">Edited in the past year</option>
          </select>
          {vaults && vaults.length > 1 && (
            <select aria-label="Vault" value={value.vault} onChange={(e) => set({ vault: e.target.value })}>
              {vaults.map((v) => <option key={v.id} value={v.active ? "" : v.id}>{v.label}{v.active ? " (current)" : ""}</option>)}
            </select>
          )}
          {count > 0 && (
            <button type="button" className="prism-search-filter-clear focus-ring" onClick={() => set(EMPTY_FILTERS)}>
              <X size={13} aria-hidden /> Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
