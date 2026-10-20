import { SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import type { SearchFilters } from "../../lib/search/match";

export type DateRange = "any" | "week" | "month" | "year";
export interface SearchFilterState {
  titleOnly: boolean;
  type: string;
  /** "Edited by": anyone, or pages this account last edited (the server's `editor=me`). */
  editor: "anyone" | "me";
  /** "Created by": anyone, or pages this account created (the server's `author=me`). Combines with `editor`. */
  creator: "anyone" | "me";
  date: DateRange;
  /** Order of the results. Not a filter: it narrows nothing and is not counted as one. */
  sort: "best" | "edited" | "created";
  /** "" = the vault you are in. */
  vault: string;
}
export interface SearchVault { id: string; label: string; active: boolean }
/** Which identity filters this viewer's search can answer (see `VaultClient.searchFilterSupport`). */
export interface SearchIdentitySupport { createdBy: boolean; editedBy: boolean }
const NO_IDENTITY: SearchIdentitySupport = { createdBy: false, editedBy: false };
export const EMPTY_FILTERS: SearchFilterState = { titleOnly: false, type: "", editor: "anyone", creator: "anyone", date: "any", sort: "best", vault: "" };

const TYPES: Array<[string, string]> = [
  ["", "Any type"], ["document", "Pages"], ["database", "Databases"], ["task", "Tasks"],
  ["meeting", "Meetings"], ["email", "Email"], ["message-thread", "Messages"], ["person", "People"],
  ["spreadsheet", "Spreadsheets"], ["canvas", "Canvases"], ["code", "Code"],
];

function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * What the search can filter by identity for this viewer. Nothing until the answer is in, in a
 * shell whose client cannot ask the server (`searchNotes` / `searchFilterSupport` missing), for a
 * share-link viewer, and — for "Edited by" — on a server too old to know `editor=`.
 */
export function useSearchIdentityFilters(): SearchIdentitySupport {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = client.scope?.() ?? audience;
  const able = !!client.searchNotes && !!client.searchFilterSupport;
  const { data } = useQuery({
    queryKey: ["vault", "search-filter-support", scope],
    enabled: able,
    queryFn: () => client.searchFilterSupport!(),
    staleTime: 10 * 60_000,
    retry: false,
  });
  return (able && data) || NO_IDENTITY;
}

/** UI state → the wire filters shared with the server. An identity filter the viewer is not offered is never sent. */
export function toSearchFilters(state: SearchFilterState, identity: SearchIdentitySupport = NO_IDENTITY): SearchFilters {
  const f: SearchFilters = {};
  if (state.titleOnly) f.titleOnly = true;
  if (state.type) f.types = [state.type];
  if (state.creator === "me" && identity.createdBy) f.author = "me";
  if (state.editor === "me" && identity.editedBy) f.editor = "me";
  if (state.date !== "any") f.after = isoDaysAgo(state.date === "week" ? 7 : state.date === "month" ? 30 : 365);
  if (state.vault) f.vault = state.vault;
  if (state.sort !== "best") f.sort = state.sort;
  return f;
}

export function activeFilterCount(state: SearchFilterState, identity: SearchIdentitySupport = NO_IDENTITY): number {
  return Number(state.titleOnly) + Number(!!state.type) + Number(state.editor !== "anyone" && identity.editedBy) + Number(state.creator !== "anyone" && identity.createdBy) + Number(state.date !== "any") + Number(!!state.vault);
}

/**
 * NP-SR-04: title-only, type, created-by, edited-by and date filters — plus the sort order
 * (best match / last edited / created) — for ⌘K and the phone Search tab. Native controls only, so keyboard and screen readers work as-is.
 */
export function SearchFilterBar({ value, onChange, onDone, vaults, identity = NO_IDENTITY }: { value: SearchFilterState; onChange: (next: SearchFilterState) => void; onDone?: () => void; vaults?: SearchVault[]; identity?: SearchIdentitySupport }) {
  const [open, setOpen] = useState(() => activeFilterCount(value, identity) > 0);
  const count = activeFilterCount(value, identity);
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
          {identity.createdBy && (
            <select aria-label="Created by" value={value.creator} onChange={(e) => set({ creator: e.target.value as SearchFilterState["creator"] })}>
              <option value="anyone">Created by anyone</option>
              <option value="me">Created by me</option>
            </select>
          )}
          {identity.editedBy && (
            <select aria-label="Edited by" value={value.editor} onChange={(e) => set({ editor: e.target.value as SearchFilterState["editor"] })}>
              <option value="anyone">Edited by anyone</option>
              <option value="me">Edited by me</option>
            </select>
          )}
          <select aria-label="Date" value={value.date} onChange={(e) => set({ date: e.target.value as DateRange })}>
            <option value="any">Any time</option>
            <option value="week">Edited in the past week</option>
            <option value="month">Edited in the past month</option>
            <option value="year">Edited in the past year</option>
          </select>
          <select aria-label="Sort" value={value.sort} onChange={(e) => set({ sort: e.target.value as SearchFilterState["sort"] })}>
            <option value="best">Best match</option>
            <option value="edited">Last edited</option>
            <option value="created">Created</option>
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
