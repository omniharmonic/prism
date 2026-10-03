import { AddSavedNoteContextButton } from "../agent/SavedNoteHandoff";
import "./search-workspace.css";
import { FileText, MessageSquare } from "lucide-react";
import { useVaultSearch } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { Spinner } from "../ui/Spinner";
import { searchModeLabel, searchResultGroup } from "./searchPresentation";
import { Highlighted, resultHighlights } from "./searchHighlight";
import { useMemo, useState } from "react";
import { EMPTY_FILTERS, SearchFilterBar, toSearchFilters } from "./searchFilters";
import { rememberSearch } from "./searchRecents";
import { useAgentChatStore } from "../../lib/agent/chatStore";

interface SearchPanelProps { query: string; onClose: () => void }

export function SearchPanel({ query, onClose }: SearchPanelProps) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const wire = useMemo(() => toSearchFilters(filters), [filters]);
  const { data: results, isFetching, isError, mode, refetch } = useVaultSearch(query, wire);
  const openTab = useUIStore((s) => s.openTab);
  const scope = useAgentChatStore((s) => s.scope);
  return <section aria-label="Search results" className="min-w-0 flex-1 overflow-auto">
    {query.trim() && <SearchFilterBar value={filters} onChange={setFilters} />}
    <div role="status" className="px-3 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
      {!query.trim() ? "Search your workspace" : isFetching ? "Searching…" : isError ? "Search unavailable" : `${results?.length ?? 0} results shown · ${searchModeLabel(mode)}`}
    </div>
    {isFetching && <div className="flex justify-center py-4"><Spinner size={16} /></div>}
    {isError && <div role="alert" className="px-3 py-4 text-sm">Couldn't search this workspace. <button className="focus-ring min-h-11 px-2 underline" onClick={() => void refetch()}>Try again</button></div>}
    {!isFetching && !isError && query.trim() && results?.length === 0 && <p className="px-3 py-5 text-sm" style={{ color: "var(--text-secondary)" }}>No matching notes. Try a name, phrase, or related idea.</p>}
    {results?.map(note => {
      const title = note.path?.split("/").pop() || note.id;
      const marks = resultHighlights(note, title, query);
      const type = inferContentType(note);
      const updated = note.updatedAt ? new Date(note.updatedAt) : null;
      return <div key={note.id} className="border-b" style={{ borderColor: "var(--glass-border)" }}><button onClick={() => { rememberSearch(scope, query); openTab(note.id, title, type); onClose(); }} className="prism-search-result interactive focus-ring flex w-full min-w-0 items-start gap-3 border-b px-3 py-4 text-left" style={{ borderColor: "var(--glass-border)" }}>
        {searchResultGroup(note) === "messages" ? <MessageSquare size={18} className="mt-0.5 shrink-0" /> : <FileText size={18} className="mt-0.5 shrink-0" />}
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium [overflow-wrap:anywhere]" style={{ color: "var(--text-primary)" }}><Highlighted text={title} ranges={marks.title} /></span>
          {note.path && <span className="mt-1 block truncate text-xs" style={{ color: "var(--text-muted)" }}>{note.path}</span>}
          <span className="mt-2 block line-clamp-3 break-words text-xs leading-relaxed [overflow-wrap:anywhere]" style={{ color: "var(--text-secondary)" }}><Highlighted text={marks.snippet} ranges={marks.snippetRanges} /></span>
          <span className="mt-2 block text-[11px] capitalize" style={{ color: "var(--text-muted)" }}>{type.replace(/-/g, " ")}{updated && Number.isFinite(updated.getTime()) ? ` · Updated ${updated.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}</span>
        </span>
      </button><div className="flex justify-end px-3"><AddSavedNoteContextButton noteId={note.id} label={title} onAdded={onClose} /></div></div>;
    })}
  </section>;
}
