import { useState, useCallback, useMemo, useRef } from "react";
import { Trash2 } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";
import { Button } from "../ui/Button";

import { formatTime as fmtTime } from "../../lib/datetime/format";
// Parse CSV content into a 2D array
function parseCSV(content: string): string[][] {
  if (!content.trim()) return [[""]];
  return content.split("\n").map((row) => {
    // Simple CSV parsing (handles basic cases, not quoted commas)
    return row.split(",").map((cell) => cell.trim());
  });
}

function serializeCSV(data: string[][]): string {
  return data.map((row) => row.join(",")).join("\n");
}

export default function SpreadsheetRenderer({ note, readOnly }: RendererProps) {
  const initialData = useMemo(() => parseCSV(note.content), [note.id]);
  const [data, setData] = useState<string[][]>(initialData);

  const dataRef = useRef(data);
  dataRef.current = data;
  // A stable getter keeps autosave cleanup from flushing the previous render.
  const getContent = useCallback(() => serializeCSV(dataRef.current), []);
  const { isSaving, lastSaved, saveError, saveNow, scheduleSave: rawScheduleSave } = useAutoSave(note.id, getContent, undefined, undefined, { base: note.updatedAt, content: note.content, noWrite: !!readOnly });
  // Read-only surfaces (published Wiki / anonymous): never write back. Wrapping
  // scheduleSave keeps the cell/row handlers unchanged while blocking mutation.
  const scheduleSave = useCallback(() => { if (!readOnly) rawScheduleSave(); }, [readOnly, rawScheduleSave]);

  const updateCell = useCallback((row: number, col: number, value: string) => {
    if (readOnly) return;
    setData((prev) => {
      const next = prev.map((r) => [...r]);
      next[row][col] = value;
      return next;
    });
    scheduleSave();
  }, [scheduleSave, readOnly]);

  const addRow = () => {
    if (readOnly) return;
    setData((prev) => [...prev, new Array(prev[0]?.length || 1).fill("")]);
    scheduleSave();
  };

  const addColumn = () => {
    if (readOnly) return;
    setData((prev) => prev.map((row) => [...row, ""]));
    scheduleSave();
  };

  const deleteRow = (index: number) => {
    if (readOnly) return;
    if (data.length <= 1) return;
    setData((prev) => prev.filter((_, i) => i !== index));
    scheduleSave();
  };

  const colCount = data[0]?.length || 1;
  const isHeader = data.length > 1; // Treat first row as header if multiple rows

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {data.length} rows × {colCount} cols
        </span>
        {!readOnly && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={addRow}>+ Row</Button>
            <Button size="sm" variant="ghost" onClick={addColumn}>+ Column</Button>
          </div>
        )}
      </div>

      {saveError && <div role="alert" className="p-3 text-sm">{saveError} {!readOnly && <button onClick={saveNow}>Retry save</button>}</div>}
      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse" style={{ minWidth: colCount * 120 }}>
          <tbody>
            {data.map((row, ri) => (
              <tr key={ri}>
                {/* Row number */}
                <td
                  className="w-10 text-center text-xs select-none flex-shrink-0"
                  style={{
                    color: "var(--text-muted)",
                    borderRight: "1px solid var(--glass-border)",
                    borderBottom: "1px solid var(--glass-border)",
                    background: "var(--bg-surface)",
                  }}
                >
                  {ri + 1}
                </td>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    style={{
                      borderRight: "1px solid var(--glass-border)",
                      borderBottom: "1px solid var(--glass-border)",
                      background: isHeader && ri === 0 ? "var(--bg-surface)" : "transparent",
                    }}
                  >
                    <input
                      value={cell}
                      aria-label={`Row ${ri + 1}, column ${ci + 1}`}
                      onChange={(e) => updateCell(ri, ci, e.target.value)}
                      readOnly={readOnly}
                      className="w-full px-2 py-1 text-sm outline-none bg-transparent"
                      style={{
                        color: "var(--text-primary)",
                        fontWeight: isHeader && ri === 0 ? 600 : 400,
                        fontFamily: "var(--font-sans)",
                        minWidth: 80,
                      }}
                    />
                  </td>
                ))}
                {/* Delete row button (hidden on read-only surfaces) */}
                {!readOnly && (
                  <td className="w-6" style={{ borderBottom: "1px solid var(--glass-border)" }}>
                    <button
                      aria-label={`Delete row ${ri + 1}`}
                      onClick={() => deleteRow(ri)}
                      className="p-0.5 opacity-0 hover:opacity-100 transition-opacity"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <Trash2 size={10} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Status */}
      <div
        className="flex items-center justify-end px-4 py-1 text-xs"
        style={{ color: "var(--text-muted)", borderTop: "1px solid var(--glass-border)" }}
      >
        {isSaving ? "Saving..." : lastSaved ? `Saved ${fmtTime(lastSaved)}` : ""}
      </div>
    </div>
  );
}
