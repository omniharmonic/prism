import { useState } from "react";
import { X, Plus } from "lucide-react";
import { useTags } from "../../../app/hooks/useParachute";
import { Input } from "../../ui/Input";
import type { DataSource } from "../../../lib/dashboard/filter-engine";

interface DataSourceEditorProps {
  value: DataSource;
  onChange: (source: DataSource) => void;
}

const DATE_PRESETS = [
  { value: "all-time", label: "All Time" },
  { value: "today", label: "Today" },
  { value: "this-week", label: "This Week" },
  { value: "this-month", label: "This Month" },
  { value: "last-7-days", label: "Last 7 Days" },
  { value: "last-30-days", label: "Last 30 Days" },
];

export function DataSourceEditor({ value, onChange }: DataSourceEditorProps) {
  const { data: tagCounts } = useTags();
  const allTags = (tagCounts ?? []).map((tc) => tc.tag);
  const selectedTags = value.tags ?? [];

  const [tagInput, setTagInput] = useState("");
  const [showTagDropdown, setShowTagDropdown] = useState(false);

  const filteredTags = allTags.filter(
    (t) =>
      !selectedTags.includes(t) &&
      t.toLowerCase().includes(tagInput.toLowerCase()),
  );

  const addTag = (tag: string) => {
    onChange({ ...value, tags: [...selectedTags, tag] });
    setTagInput("");
    setShowTagDropdown(false);
  };

  const removeTag = (tag: string) => {
    onChange({ ...value, tags: selectedTags.filter((t) => t !== tag) });
  };

  // Metadata filters
  const metaFilters = value.metadataFilters ?? {};
  const metaEntries = Object.entries(metaFilters);
  const [newMetaKey, setNewMetaKey] = useState("");
  const [newMetaVal, setNewMetaVal] = useState("");

  const addMetaFilter = () => {
    if (!newMetaKey.trim()) return;
    onChange({
      ...value,
      metadataFilters: { ...metaFilters, [newMetaKey.trim()]: newMetaVal },
    });
    setNewMetaKey("");
    setNewMetaVal("");
  };

  const removeMetaFilter = (key: string) => {
    const next = { ...metaFilters };
    delete next[key];
    onChange({ ...value, metadataFilters: next });
  };

  return (
    <div className="space-y-4">
      {/* Tags */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--text-secondary)" }}>
          Tags (AND)
        </label>
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {selectedTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs"
              style={{
                background: "var(--color-accent)",
                color: "white",
              }}
            >
              {tag}
              <button
                onClick={() => removeTag(tag)}
                className="hover:opacity-70"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
        <div className="relative">
          <Input
            placeholder="Search tags..."
            value={tagInput}
            onChange={(e) => {
              setTagInput(e.target.value);
              setShowTagDropdown(true);
            }}
            onFocus={() => setShowTagDropdown(true)}
            onBlur={() => {
              // Delay to allow click on dropdown item
              setTimeout(() => setShowTagDropdown(false), 200);
            }}
          />
          {showTagDropdown && filteredTags.length > 0 && (
            <div
              className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg overflow-hidden max-h-40 overflow-y-auto"
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--glass-border)",
              }}
            >
              {filteredTags.slice(0, 20).map((tag) => (
                <button
                  key={tag}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => addTag(tag)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--glass-hover)] transition-colors"
                  style={{ color: "var(--text-primary)" }}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Path prefix */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--text-secondary)" }}>
          Path Prefix
        </label>
        <Input
          placeholder="e.g. projects/acme/"
          value={value.pathPrefix ?? ""}
          onChange={(e) =>
            onChange({ ...value, pathPrefix: e.target.value || undefined })
          }
        />
      </div>

      {/* Date range */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--text-secondary)" }}>
          Date Range
        </label>
        <select
          className="w-full h-8 rounded-lg px-3 text-sm outline-none"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
          value={value.dateRange?.preset ?? "all-time"}
          onChange={(e) => {
            const preset = e.target.value;
            if (preset === "all-time") {
              const next = { ...value };
              delete next.dateRange;
              onChange(next);
            } else {
              onChange({
                ...value,
                dateRange: {
                  field: value.dateRange?.field ?? "createdAt",
                  preset,
                },
              });
            }
          }}
        >
          {DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* Metadata filters */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--text-secondary)" }}>
          Metadata Filters
        </label>
        {metaEntries.length > 0 && (
          <div className="space-y-1 mb-2">
            {metaEntries.map(([key, val]) => (
              <div key={key} className="flex items-center gap-1.5">
                <span
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ background: "var(--glass)", color: "var(--text-secondary)" }}
                >
                  {key} = {String(val)}
                </span>
                <button
                  onClick={() => removeMetaFilter(key)}
                  className="p-0.5 rounded hover:bg-[var(--glass-hover)]"
                  style={{ color: "var(--text-muted)" }}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <Input
            placeholder="Key"
            value={newMetaKey}
            onChange={(e) => setNewMetaKey(e.target.value)}
            className="flex-1"
          />
          <Input
            placeholder="Value"
            value={newMetaVal}
            onChange={(e) => setNewMetaVal(e.target.value)}
            className="flex-1"
          />
          <button
            onClick={addMetaFilter}
            className="p-1.5 rounded-lg hover:bg-[var(--glass-hover)] transition-colors flex-shrink-0"
            style={{
              border: "1px solid var(--glass-border)",
              color: "var(--text-muted)",
            }}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Limit */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--text-secondary)" }}>
          Limit
        </label>
        <Input
          type="number"
          placeholder="No limit"
          value={value.limit ?? ""}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            onChange({ ...value, limit: isNaN(n) ? undefined : n });
          }}
        />
      </div>
    </div>
  );
}
