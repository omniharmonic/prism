import { FileText } from "lucide-react";
import { useVaultSearch } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { Spinner } from "../ui/Spinner";

interface SearchPanelProps {
  query: string;
  onClose: () => void;
}

export function SearchPanel({ query, onClose }: SearchPanelProps) {
  const { data: results, isLoading } = useVaultSearch(query);
  const openTab = useUIStore((s) => s.openTab);

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-3 py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
        {isLoading ? "Searching..." : `${results?.length ?? 0} results`}
      </div>
      {isLoading && (
        <div className="flex justify-center py-4">
          <Spinner size={16} />
        </div>
      )}
      {results?.map((note) => {
        const title = note.path?.split("/").pop() || note.id;
        const type = inferContentType(note);
        return (
          <button
            key={note.id}
            onClick={() => {
              openTab(note.id, title, type);
              onClose();
            }}
            className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--glass-hover)] transition-colors"
          >
            <FileText size={14} className="mt-0.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} />
            <div className="min-w-0">
              <div className="text-sm truncate" style={{ color: "var(--text-primary)" }}>
                {title}
              </div>
              {note.path && (
                <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
                  {note.path}
                </div>
              )}
              <div className="text-xs mt-0.5 line-clamp-2" style={{ color: "var(--text-secondary)" }}>
                {note.content.slice(0, 120)}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
