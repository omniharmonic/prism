import { useState, useCallback, useMemo } from "react";
import { ArrowUp, ArrowDown } from "lucide-react";
import { useWidgetData } from "../../../app/hooks/useWidgetData";
import { useUIStore } from "../../../app/stores/ui";
import { inferContentType } from "../../../lib/schemas/content-types";
import { sortNotes } from "../../../lib/dashboard/filter-engine";
import type { DashboardWidgetConfig, WidgetColumn } from "../../../lib/dashboard/widget-registry";
import type { Note } from "../../../lib/types";

interface ListWidgetProps {
  config: DashboardWidgetConfig;
}

function getCellValue(note: Note, field: string): string {
  switch (field) {
    case "path": {
      return note.path?.split("/").pop() ?? note.content?.split("\n")[0]?.slice(0, 60) ?? note.id;
    }
    case "createdAt":
    case "updatedAt": {
      const val = field === "createdAt" ? note.createdAt : note.updatedAt;
      if (!val) return "—";
      try {
        return new Date(val).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      } catch {
        return "—";
      }
    }
    default: {
      const v = note.metadata ? (note.metadata as Record<string, unknown>)[field] : undefined;
      if (v == null) return "—";
      return String(v);
    }
  }
}

export function ListWidget({ config }: ListWidgetProps) {
  const { items, isLoading } = useWidgetData(config);
  const openTab = useUIStore((s) => s.openTab);

  const columns: WidgetColumn[] = config.columns ?? [
    { field: "path", label: "Title" },
    { field: "updatedAt", label: "Updated" },
  ];

  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const handleSort = useCallback(
    (field: string) => {
      if (sortField === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDir("asc");
      }
    },
    [sortField],
  );

  const sorted = useMemo(() => {
    if (!sortField) return items;
    return sortNotes(items, { field: sortField, direction: sortDir });
  }, [items, sortField, sortDir]);

  const handleOpen = (note: Note) => {
    const type = inferContentType(note);
    const title =
      note.path?.split("/").pop() ??
      note.content?.split("\n")[0]?.slice(0, 60) ??
      note.id;
    openTab(note.id, title, type);
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-8 rounded animate-pulse"
            style={{ background: "var(--glass)" }}
          />
        ))}
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>
        No matching notes
      </div>
    );
  }

  return (
    <div className="overflow-auto max-h-80">
      <table className="w-full text-sm" style={{ color: "var(--text-primary)" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--glass-border)" }}>
            {columns.map((col) => (
              <th
                key={col.field}
                className="text-left px-2 py-1.5 text-xs font-medium cursor-pointer select-none hover:bg-[var(--glass-hover)] transition-colors"
                style={{ color: "var(--text-secondary)", width: col.width ? `${col.width}px` : undefined }}
                onClick={() => handleSort(col.field)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {sortField === col.field &&
                    (sortDir === "asc" ? (
                      <ArrowUp size={11} />
                    ) : (
                      <ArrowDown size={11} />
                    ))}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((note) => (
            <tr
              key={note.id}
              className="hover:bg-[var(--glass-hover)] transition-colors cursor-pointer"
              style={{ borderBottom: "1px solid var(--glass-border)" }}
              onClick={() => handleOpen(note)}
            >
              {columns.map((col) => (
                <td key={col.field} className="px-2 py-1.5 truncate max-w-[200px]">
                  {getCellValue(note, col.field)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
