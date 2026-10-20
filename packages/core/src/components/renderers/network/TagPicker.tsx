// TagPicker — a searchable, multi- or single-select tag chooser for defining a
// "slice" of the vault (Federate spaces, Publish collections). Replaces flat
// walls of tag chips: type to filter, click to (de)select, selected tags show as
// removable chips above the list. Shares the look of the Publish picker.
import { useMemo, useState } from "react";
import { Search, Check, X } from "lucide-react";
import { Input } from "../../ui/Input";
import type { TagCount } from "../../../lib/types";

export function TagPicker({
  tags,
  selected,
  onChange,
  multiple = true,
  exclude,
  placeholder = "Search tags…",
  maxHeight = 200,
  autoFocus,
}: {
  tags: TagCount[];
  selected: string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  /** Tags to hide from the list (e.g. already-published). */
  exclude?: Set<string>;
  placeholder?: string;
  maxHeight?: number;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tags
      .filter((t) => !exclude?.has(t.tag))
      .filter((t) => (q ? t.tag.toLowerCase().includes(q) : true))
      .sort((a, b) => b.count - a.count)
      .slice(0, 60);
  }, [tags, exclude, query]);

  const toggle = (tag: string) => {
    if (selected.includes(tag)) onChange(selected.filter((x) => x !== tag));
    else onChange(multiple ? [...selected, tag] : [tag]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Selected tags as removable chips (multi-select). */}
      {multiple && selected.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {selected.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              aria-label={`Remove ${tag}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 12,
                padding: "3px 8px",
                borderRadius: 999,
                cursor: "pointer",
                border: "1px solid var(--accent)",
                background: "var(--accent-dim)",
                color: "var(--accent)",
              }}
            >
              #{tag}
              <X size={11} />
            </button>
          ))}
        </div>
      )}

      <Input
        icon={<Search size={14} />}
        placeholder={placeholder}
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div
        style={{
          maxHeight,
          overflowY: "auto",
          border: "1px solid var(--glass-border)",
          borderRadius: 10,
          background: "var(--bg-surface, var(--glass))",
        }}
      >
        {available.length === 0 ? (
          <div style={{ padding: "14px 12px", fontSize: 12.5, color: "var(--text-muted)" }}>
            {query ? "No matching tags." : "No tags found."}
          </div>
        ) : (
          available.map((t) => {
            const on = selected.includes(t.tag);
            return (
              <button
                key={t.tag}
                type="button"
                onClick={() => toggle(t.tag)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "8px 12px",
                  background: on ? "var(--glass-hover)" : "transparent",
                  border: "none",
                  borderLeft: on ? "2px solid var(--color-accent, var(--accent))" : "2px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 13,
                    color: on ? "var(--text-primary)" : "var(--text-secondary)",
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {on && <Check size={13} style={{ color: "var(--color-accent, var(--accent))" }} />}#{t.tag}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  {t.count} {t.count === 1 ? "note" : "notes"}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
