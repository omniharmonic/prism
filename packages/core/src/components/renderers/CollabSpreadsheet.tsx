import { useEffect, useState, useCallback } from "react";
import * as Y from "yjs";
import { Trash2 } from "lucide-react";
import { Button } from "../ui/Button";

/**
 * Real-time collaborative spreadsheet — an editable grid bound to a Yjs
 * `Y.Array<Y.Array<string>>` ("rows"), so concurrent edits to different
 * cells/rows merge cleanly (cell-level CRDT). The server seeds and persists this
 * structure as CSV. A cell edit is a delete+insert at the column index — Yjs has
 * no in-place array set, and this keeps each cell an independent CRDT slot.
 *
 * Comments/suggestions are prose-only and not shown here.
 */
export function CollabSpreadsheet({
  ydoc,
  editable = true,
}: {
  ydoc: Y.Doc;
  editable?: boolean;
}) {
  const rows = ydoc.getArray<Y.Array<string>>("rows");
  const [data, setData] = useState<string[][]>(() => snapshot(rows));

  // Mirror the CRDT into React state on any (local or remote) change.
  useEffect(() => {
    const update = () => setData(snapshot(rows));
    rows.observeDeep(update);
    update();
    return () => rows.unobserveDeep(update);
  }, [rows]);

  const setCell = useCallback(
    (r: number, c: number, value: string) => {
      if (!editable) return;
      const row = rows.get(r);
      if (!row) return;
      ydoc.transact(() => {
        row.delete(c, 1);
        row.insert(c, [value]);
      });
    },
    [rows, ydoc, editable],
  );

  const addRow = () => {
    const cols = data[0]?.length || 1;
    const yr = new Y.Array<string>();
    yr.insert(0, new Array(cols).fill(""));
    ydoc.transact(() => rows.push([yr]));
  };

  const addColumn = () => {
    ydoc.transact(() => rows.forEach((r) => r.push([""])));
  };

  const deleteRow = (index: number) => {
    if (rows.length <= 1) return;
    ydoc.transact(() => rows.delete(index, 1));
  };

  const colCount = data[0]?.length || 1;
  const isHeader = data.length > 1;

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {data.length} rows × {colCount} cols
        </span>
        {editable && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={addRow}>+ Row</Button>
            <Button size="sm" variant="ghost" onClick={addColumn}>+ Column</Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse" style={{ minWidth: colCount * 120 }}>
          <tbody>
            {data.map((row, ri) => (
              <tr key={ri}>
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
                      readOnly={!editable}
                      onChange={(e) => setCell(ri, ci, e.target.value)}
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
                {editable && (
                  <td className="w-6" style={{ borderBottom: "1px solid var(--glass-border)" }}>
                    <button
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
    </div>
  );
}

function snapshot(rows: Y.Array<Y.Array<string>>): string[][] {
  const out: string[][] = [];
  rows.forEach((r) => out.push(r.toArray()));
  return out.length ? out : [[""]];
}
