import { useState, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, X, RefreshCw, Cloud, Trash2, Check, AlertTriangle, ChevronDown, ChevronRight, GitFork } from "lucide-react";
import type { Note, ContentType } from "../../lib/types";
import { useUpdateNote, useTags, useNotes } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { vaultApi } from "../../lib/parachute/client";
import { CONTENT_TYPE_LABELS } from "../../lib/schemas/content-types";
import { syncApi, type SyncStatus } from "../../lib/sync/client";
import { githubSyncApi } from "../../lib/parachute/client";
import { GitHubSyncModal } from "./GitHubSyncModal";
import { cn } from "../../lib/cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface MetadataPanelProps {
  note: Note;
}

const CONTENT_TYPES = Object.entries(CONTENT_TYPE_LABELS) as [ContentType, string][];

// Fields that are managed by the system, not user-editable in tag sections
const SYSTEM_FIELDS = new Set(["type", "sync", "prism_type"]);

// Heuristic: is this field name date-like?
function isDateField(name: string): boolean {
  const lower = name.toLowerCase();
  return /date|due|deadline|created|updated|start|end|scheduled|completed/.test(lower);
}

// Heuristic: is this value an array?
function isArrayValue(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// Heuristic: is this a boolean?
function isBooleanValue(value: unknown): value is boolean {
  return typeof value === "boolean";
}

interface DiscoveredField {
  name: string;
  uniqueValues: Set<string>;
  isDate: boolean;
  isArray: boolean;
  isBoolean: boolean;
}

/**
 * Scan all notes with the same tag to discover what metadata fields exist
 * and what values they have (for building dropdowns, etc.)
 */
function useDiscoveredFields(tag: string, allNotesForTag: Note[]): DiscoveredField[] {
  return useMemo(() => {
    const fieldMap = new Map<string, DiscoveredField>();

    for (const note of allNotesForTag) {
      const meta = note.metadata as Record<string, unknown> | null;
      if (!meta) continue;

      for (const [key, value] of Object.entries(meta)) {
        if (SYSTEM_FIELDS.has(key)) continue;

        if (!fieldMap.has(key)) {
          fieldMap.set(key, {
            name: key,
            uniqueValues: new Set(),
            isDate: isDateField(key),
            isArray: false,
            isBoolean: false,
          });
        }

        const field = fieldMap.get(key)!;

        if (isBooleanValue(value)) {
          field.isBoolean = true;
        } else if (isArrayValue(value)) {
          field.isArray = true;
          for (const item of value) {
            if (typeof item === "string") field.uniqueValues.add(item);
          }
        } else if (typeof value === "string" && value.length > 0) {
          field.uniqueValues.add(value);
        }
      }
    }

    return Array.from(fieldMap.values());
  }, [tag, allNotesForTag]);
}

export function MetadataPanel({ note }: MetadataPanelProps) {
  const updateNote = useUpdateNote();
  const { data: allTags } = useTags();
  const currentType = ((note.metadata as Record<string, unknown>)?.type as ContentType) || "document";
  const noteTags = note.tags || [];
  const meta = (note.metadata || {}) as Record<string, unknown>;

  // Word count
  const wordCount = note.content.trim().split(/\s+/).filter(Boolean).length;
  const readingTime = Math.max(1, Math.ceil(wordCount / 200));

  // Collapsible state
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());

  const toggleTag = useCallback((tag: string) => {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const handleTypeChange = useCallback((newType: string) => {
    updateNote.mutate({
      id: note.id,
      metadata: { ...meta, type: newType },
    });
  }, [note, meta, updateNote]);

  const handleMetadataFieldChange = useCallback((fieldName: string, value: unknown) => {
    updateNote.mutate({
      id: note.id,
      metadata: { ...meta, [fieldName]: value },
    });
  }, [note, meta, updateNote]);

  // Separate this note's own metadata fields into "properties" (non-system, non-empty)
  const noteProperties = useMemo(() => {
    return Object.entries(meta)
      .filter(([key, val]) => !SYSTEM_FIELDS.has(key) && val != null && val !== "")
      .map(([key]) => key);
  }, [meta]);

  return (
    <div className="space-y-3">
      {/* ── Core Info ─────────────────────────── */}
      <div className="flex items-center gap-2">
        <select
          value={currentType}
          onChange={(e) => handleTypeChange(e.target.value)}
          className="flex-1 h-7 rounded-md px-2 text-sm outline-none cursor-pointer"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
        >
          {CONTENT_TYPES.map(([value, label]) => (
            <option key={value} value={value} style={{ background: "var(--bg-elevated)" }}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
        {note.path || "\u2014"}
      </div>

      {/* Tags */}
      <TagEditor noteId={note.id} tags={noteTags} allTags={allTags?.map((t) => t.tag) || []} />

      {/* ── Properties (this note's metadata) ── */}
      {noteProperties.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Properties</div>
          {noteProperties.map((key) => (
            <PropertyRow
              key={key}
              fieldName={key}
              value={meta[key]}
              allNotesForTag={null}
              onChange={(val) => handleMetadataFieldChange(key, val)}
            />
          ))}
        </div>
      )}

      {/* ── Tag Schemas (collapsible) ────────── */}
      {noteTags.length > 0 && (
        <div className="space-y-1">
          {noteTags.map((tag) => (
            <CollapsibleTagSection
              key={tag}
              tag={tag}
              note={note}
              isExpanded={expandedTags.has(tag)}
              onToggle={() => toggleTag(tag)}
              existingFields={noteProperties}
              onFieldChange={handleMetadataFieldChange}
            />
          ))}
        </div>
      )}

      {/* ── Info row ─────────────────────────── */}
      <div className="flex gap-3 text-xs" style={{ color: "var(--text-muted)" }}>
        <span>{wordCount.toLocaleString()} words</span>
        <span>{readingTime} min</span>
      </div>
      <div className="text-xs space-y-0.5" style={{ color: "var(--text-muted)" }}>
        <div>Created {formatDate(note.createdAt)}</div>
        {note.updatedAt && <div>Updated {formatDate(note.updatedAt)}</div>}
      </div>

      {/* Sync */}
      <SyncSection noteId={note.id} metadata={note.metadata} notePath={note.path} />

      {/* Advanced JSON (collapsible) */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex items-center gap-1 text-xs hover:text-[var(--text-primary)] transition-colors"
        style={{ color: "var(--text-muted)" }}
      >
        {showAdvanced ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        Raw JSON
      </button>
      {showAdvanced && (
        <pre
          className="glass-inset p-2 text-xs overflow-auto rounded max-h-40"
          style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}
        >
          {JSON.stringify(note.metadata, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ─── Collapsible Tag Section ─────────────────────────────────
// Shows discovered fields for a tag, collapsed by default.
// Skips fields already shown in the Properties section above.

function CollapsibleTagSection({
  tag,
  note,
  isExpanded,
  onToggle,
  existingFields,
  onFieldChange,
}: {
  tag: string;
  note: Note;
  isExpanded: boolean;
  onToggle: () => void;
  existingFields: string[];
  onFieldChange: (field: string, value: unknown) => void;
}) {
  const { data: notesWithTag } = useNotes({ tag });
  const discoveredFields = useDiscoveredFields(tag, notesWithTag || []);

  // Filter out fields already shown in Properties section
  const existingSet = new Set(existingFields);
  const newFields = discoveredFields.filter((f) => !existingSet.has(f.name));

  // Don't render if no additional fields to show
  if (newFields.length === 0 && discoveredFields.length === 0) return null;

  const meta = (note.metadata || {}) as Record<string, unknown>;

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 py-1 text-xs transition-colors hover:text-[var(--text-primary)]"
        style={{ color: "var(--text-secondary)" }}
      >
        {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="font-medium">{tag}</span>
        {newFields.length > 0 && (
          <span
            className="ml-auto px-1.5 py-0.5 rounded-full text-[10px]"
            style={{ background: "var(--glass)", color: "var(--text-muted)" }}
          >
            {newFields.length} field{newFields.length !== 1 ? "s" : ""}
          </span>
        )}
      </button>
      {isExpanded && newFields.length > 0 && (
        <div className="pl-4 pb-2 space-y-1.5">
          {newFields.map((field) => (
            <PropertyRow
              key={field.name}
              fieldName={field.name}
              value={meta[field.name]}
              allNotesForTag={notesWithTag || null}
              onChange={(val) => onFieldChange(field.name, val)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Property Row ────────────────────────────────────────────
// Inline key-value row: label on left, smart input on right.
// Used for both the Properties section and expanded tag sections.

function PropertyRow({
  fieldName,
  value,
  allNotesForTag,
  onChange,
}: {
  fieldName: string;
  value: unknown;
  allNotesForTag: Note[] | null;
  onChange: (value: unknown) => void;
}) {
  const label = fieldName.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // Discover unique values if we have sibling notes
  const uniqueValues = useMemo(() => {
    if (!allNotesForTag) return new Set<string>();
    const vals = new Set<string>();
    for (const n of allNotesForTag) {
      const meta = (n.metadata || {}) as Record<string, unknown>;
      const v = meta[fieldName];
      if (typeof v === "string" && v) vals.add(v);
    }
    return vals;
  }, [allNotesForTag, fieldName]);

  // Boolean toggle
  if (isBooleanValue(value)) {
    return (
      <div className="flex items-center justify-between py-0.5">
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
        <button
          onClick={() => onChange(!value)}
          className="w-7 h-3.5 rounded-full relative transition-colors"
          style={{ background: value ? "var(--color-accent)" : "var(--glass-border)" }}
        >
          <span
            className="absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all"
            style={{ left: value ? 14 : 2 }}
          />
        </button>
      </div>
    );
  }

  // Date field
  if (isDateField(fieldName)) {
    const dateVal = typeof value === "string" ? value.slice(0, 10) : "";
    return (
      <div className="flex items-center gap-2 py-0.5">
        <span className="text-xs shrink-0 w-20" style={{ color: "var(--text-muted)" }}>{label}</span>
        <input
          type="date"
          value={dateVal}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 h-6 rounded px-1.5 text-xs outline-none min-w-0"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
        />
      </div>
    );
  }

  // Array (chip list)
  if (isArrayValue(value)) {
    return (
      <div className="py-0.5">
        <span className="text-xs block mb-1" style={{ color: "var(--text-muted)" }}>{label}</span>
        <ChipList
          items={value as string[]}
          suggestions={Array.from(uniqueValues)}
          onChange={onChange}
        />
      </div>
    );
  }

  // Dropdown for small enum sets
  if (uniqueValues.size > 1 && uniqueValues.size < 10) {
    const strValue = typeof value === "string" ? value : "";
    return (
      <div className="flex items-center gap-2 py-0.5">
        <span className="text-xs shrink-0 w-20" style={{ color: "var(--text-muted)" }}>{label}</span>
        <select
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 h-6 rounded px-1.5 text-xs outline-none cursor-pointer min-w-0"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
        >
          <option value="" style={{ background: "var(--bg-elevated)" }}>—</option>
          {Array.from(uniqueValues).sort().map((v) => (
            <option key={v} value={v} style={{ background: "var(--bg-elevated)" }}>{v}</option>
          ))}
        </select>
      </div>
    );
  }

  // Default: inline text input
  const strValue = value != null ? String(value) : "";
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-xs shrink-0 w-20" style={{ color: "var(--text-muted)" }}>{label}</span>
      <input
        value={strValue}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onChange(e.target.value)}
        className="flex-1 h-6 rounded px-1.5 text-xs outline-none min-w-0"
        style={{
          background: "var(--glass)",
          border: "1px solid var(--glass-border)",
          color: "var(--text-primary)",
        }}
      />
    </div>
  );
}

// SchemaField replaced by PropertyRow above

// ─── Chip List for Array Fields ──────────────────────────────

function ChipList({
  items,
  suggestions,
  onChange,
}: {
  items: string[];
  suggestions: string[];
  onChange: (value: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const filtered = input.length > 0
    ? suggestions.filter((s) => s.toLowerCase().includes(input.toLowerCase()) && !items.includes(s)).slice(0, 5)
    : [];

  const addItem = (item: string) => {
    if (item && !items.includes(item)) {
      onChange([...items, item]);
    }
    setInput("");
    setShowSuggestions(false);
  };

  const removeItem = (item: string) => {
    onChange(items.filter((i) => i !== item));
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 glass px-1.5 py-0.5 rounded text-xs"
            style={{ color: "var(--text-secondary)" }}
          >
            {item}
            <button onClick={() => removeItem(item)} className="hover:text-[var(--color-danger)] transition-colors">
              <X size={9} />
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setShowSuggestions(true); }}
          onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) { e.preventDefault(); addItem(input.trim()); } }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder="Add..."
          className="w-full h-6 rounded-md px-2 text-xs outline-none"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
        />
        {showSuggestions && filtered.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-0.5 py-0.5 glass-elevated z-10 rounded-md overflow-hidden">
            {filtered.map((s) => (
              <button
                key={s}
                onMouseDown={() => addItem(s)}
                className="w-full text-left px-2 py-1 text-xs hover:bg-[var(--glass-hover)] transition-colors"
                style={{ color: "var(--text-secondary)" }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shared Components ──────────────────────────────────────

function TagEditor({
  noteId,
  tags,
  allTags,
}: {
  noteId: string;
  tags: string[];
  allTags: string[];
}) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const openTab = useUIStore((s) => s.openTab);

  const suggestions = input.length > 0
    ? allTags.filter((t) => t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t)).slice(0, 5)
    : [];

  const addTag = async (tag: string) => {
    await vaultApi.addTags(noteId, [tag]);
    setInput("");
    setShowSuggestions(false);
  };

  const removeTag = async (tag: string) => {
    await vaultApi.removeTags(noteId, [tag]);
  };

  const handleTagClick = (tag: string) => {
    openTab(`tag:${tag}`, `Tag: ${tag}`, "document");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && input.trim()) {
      e.preventDefault();
      addTag(input.trim());
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 glass px-2 py-0.5 rounded text-xs"
            style={{ color: "var(--text-secondary)" }}
          >
            <button
              onClick={() => handleTagClick(tag)}
              className="hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              {tag}
            </button>
            <button
              onClick={() => removeTag(tag)}
              className="hover:text-[var(--color-danger)] transition-colors"
            >
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder="Add tag..."
          className="w-full h-7 rounded-md px-2 text-xs outline-none"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
        />
        {showSuggestions && suggestions.length > 0 && (
          <div
            className="absolute top-full left-0 right-0 mt-0.5 py-0.5 glass-elevated z-10 rounded-md overflow-hidden"
          >
            {suggestions.map((s) => (
              <button
                key={s}
                onMouseDown={() => addTag(s)}
                className={cn(
                  "w-full text-left px-2 py-1 text-xs hover:bg-[var(--glass-hover)] transition-colors",
                )}
                style={{ color: "var(--text-secondary)" }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const SYNC_ADAPTERS = [
  { id: "google-docs", label: "Google Docs", icon: Cloud },
  { id: "notion", label: "Notion", icon: Cloud },
  { id: "github", label: "GitHub", icon: GitFork },
];

function SyncSection({ noteId, metadata, notePath }: { noteId: string; metadata: Record<string, unknown> | null; notePath: string | null }) {
  const [showAdd, setShowAdd] = useState(false);
  const queryClient = useQueryClient();

  const { data: statuses } = useQuery({
    queryKey: ["sync", "status", noteId],
    queryFn: () => syncApi.status(noteId),
    retry: false,
  });

  const syncConfigs = ((metadata as Record<string, unknown>)?.sync as Array<Record<string, unknown>>) || [];

  const [syncError, setSyncError] = useState<string | null>(null);

  const [showNotionSetup, setShowNotionSetup] = useState(false);
  const [showGitHubSetup, setShowGitHubSetup] = useState(false);

  // Check if this note is in a directory with an active GitHub sync
  const [githubConfig, setGithubConfig] = useState<{ id: string; vaultPath: string } | null>(null);
  useEffect(() => {
    try {
      githubSyncApi.status().then((configs) => {
        const match = configs.find((c) => notePath?.startsWith(c.vaultPath));
        setGithubConfig(match ? { id: match.id, vaultPath: match.vaultPath } : null);
      }).catch(() => {});
    } catch { /* not in Tauri */ }
  }, [notePath]);

  const handleAddSync = async (adapter: string) => {
    setSyncError(null);
    try {
      if (adapter === "notion") {
        setShowNotionSetup(true);
        setShowAdd(false);
        return;
      }
      if (adapter === "github") {
        if (githubConfig) {
          // Directory already has GitHub sync — push this file
          await githubSyncApi.pushFile(githubConfig.id, noteId);
          setSyncError(null);
          setShowAdd(false);
        } else {
          // No GitHub sync for this directory — open setup modal
          setShowGitHubSetup(true);
          setShowAdd(false);
        }
        return;
      }
      await syncApi.addConfig(noteId, adapter);
      queryClient.invalidateQueries({ queryKey: ["sync", "status", noteId] });
      queryClient.invalidateQueries({ queryKey: ["vault"] });
      setShowAdd(false);
    } catch (e) {
      setSyncError(`Failed to add ${adapter}: ${e}`);
    }
  };

  const handleSync = async () => {
    setSyncError(null);
    try {
      const results = await syncApi.trigger(noteId);
      const errors = results.filter((r: { status: string }) => r.status === "error");
      if (errors.length > 0) {
        setSyncError(errors.map((e: { message?: string }) => e.message).join("; "));
      }
      queryClient.invalidateQueries({ queryKey: ["sync", "status", noteId] });
    } catch (e) {
      setSyncError(`Sync failed: ${e}`);
    }
  };

  const handleRemove = async (adapter: string, remoteId: string) => {
    await syncApi.removeConfig(noteId, adapter, remoteId);
    queryClient.invalidateQueries({ queryKey: ["sync", "status", noteId] });
    queryClient.invalidateQueries({ queryKey: ["vault"] });
  };

  return (
    <div className="space-y-2">
      {/* Error display */}
      {syncError && (
        <div className="text-xs p-2 rounded-md" style={{ background: "rgba(235,87,87,0.1)", color: "var(--color-danger)" }}>
          {syncError}
        </div>
      )}
      {/* Existing sync configs */}
      {(statuses || []).map((s: SyncStatus) => (
        <div
          key={`${s.adapter}-${s.remote_id}`}
          className="glass p-2 rounded-md flex items-center gap-2 text-xs"
        >
          <SyncStateIcon state={s.state} />
          <div className="flex-1 min-w-0">
            <div style={{ color: "var(--text-primary)" }}>
              {SYNC_ADAPTERS.find((a) => a.id === s.adapter)?.label || s.adapter}
            </div>
            {s.last_synced && (
              <div style={{ color: "var(--text-muted)" }}>
                Last: {formatDate(s.last_synced)}
              </div>
            )}
            {s.error && (
              <div style={{ color: "var(--color-danger)" }}>{s.error}</div>
            )}
          </div>
          <button
            onClick={() => handleRemove(s.adapter, s.remote_id)}
            className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}

      {/* Sync buttons */}
      {syncConfigs.length > 0 && (
        <div className="flex gap-1.5">
          <button
            onClick={handleSync}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--glass-hover)]"
            style={{ color: "var(--text-secondary)" }}
          >
            <RefreshCw size={11} />
            Push
          </button>
          <button
            onClick={async () => {
              setSyncError(null);
              try {
                const result = await syncApi.pull(noteId);
                if (result.status === "error") {
                  setSyncError((result as { message?: string }).message || "Pull failed");
                } else {
                  queryClient.invalidateQueries({ queryKey: ["vault"] });
                  alert("Pulled from Google Docs. Close and reopen the tab to see updated content.");
                }
              } catch (e) {
                setSyncError(`Pull failed: ${e}`);
              }
            }}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--glass-hover)]"
            style={{ color: "var(--text-secondary)" }}
          >
            <RefreshCw size={11} style={{ transform: "scaleX(-1)" }} />
            Pull
          </button>
        </div>
      )}

      {/* Add sync destination */}
      <div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors hover:bg-[var(--glass-hover)]"
          style={{ color: "var(--text-muted)", border: "1px dashed var(--glass-border)" }}
        >
          <Plus size={13} />
          Add sync destination
        </button>
        {showAdd && (
          <div className="mt-1 py-1 glass-elevated rounded-md overflow-hidden">
            {SYNC_ADAPTERS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => handleAddSync(id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--glass-hover)] transition-colors"
                style={{ color: "var(--text-primary)" }}
              >
                <Icon size={12} style={{ color: "var(--text-secondary)" }} />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Notion setup -- page picker */}
      {showNotionSetup && (
        <NotionPagePicker
          noteId={noteId}
          metadata={metadata}
          onDone={() => {
            setShowNotionSetup(false);
            queryClient.invalidateQueries({ queryKey: ["sync", "status", noteId] });
            queryClient.invalidateQueries({ queryKey: ["vault"] });
          }}
          onCancel={() => setShowNotionSetup(false)}
          onError={(msg) => setSyncError(msg)}
        />
      )}

      {/* GitHub sync status indicator for notes in synced directories */}
      {githubConfig && (
        <div className="glass p-2 rounded-md flex items-center gap-2 text-xs">
          <GitFork size={12} style={{ color: "var(--text-secondary)" }} />
          <div className="flex-1 min-w-0">
            <div style={{ color: "var(--text-primary)" }}>GitHub</div>
            <div style={{ color: "var(--text-muted)" }}>Synced via {githubConfig.vaultPath}</div>
          </div>
          <button
            onClick={async () => {
              try {
                await githubSyncApi.pushFile(githubConfig.id, noteId);
              } catch (e) {
                setSyncError(`GitHub push failed: ${e}`);
              }
            }}
            className="px-2 py-1 rounded text-[10px] hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-secondary)" }}
          >
            Push
          </button>
        </div>
      )}

      {/* GitHub sync setup modal */}
      {showGitHubSetup && (
        <GitHubSyncModal
          isOpen={true}
          onClose={() => {
            setShowGitHubSetup(false);
            // Refresh GitHub config
            try {
              githubSyncApi.status().then((configs) => {
                const match = configs.find((c) => notePath?.startsWith(c.vaultPath));
                setGithubConfig(match ? { id: match.id, vaultPath: match.vaultPath } : null);
              }).catch(() => {});
            } catch { /* not in Tauri */ }
          }}
          vaultPath={notePath?.split("/").slice(0, -1).join("/") || "vault"}
        />
      )}
    </div>
  );
}

function SyncStateIcon({ state }: { state: string }) {
  switch (state) {
    case "synced":
      return <Check size={12} style={{ color: "var(--color-success)" }} />;
    case "syncing":
      return <RefreshCw size={12} className="animate-spin" style={{ color: "var(--color-accent)" }} />;
    case "conflict":
      return <AlertTriangle size={12} style={{ color: "var(--color-warning)" }} />;
    case "error":
      return <X size={12} style={{ color: "var(--color-danger)" }} />;
    default:
      return <Cloud size={12} style={{ color: "var(--text-muted)" }} />;
  }
}

function NotionPagePicker({ noteId, metadata, onDone, onCancel, onError }: {
  noteId: string;
  metadata: Record<string, unknown> | null;
  onDone: () => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  const [pages, setPages] = useState<Array<{ id: string; title: string; url: string; icon: string | null }>>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback((query: string) => {
    setLoading(true);
    invoke<Array<{ id: string; title: string; url: string; icon: string | null }>>(
      "notion_list_pages", { query: query || null }
    )
      .then((results) => { setPages(results); setSearched(true); })
      .catch((e) => onError(`Failed to search Notion: ${e}`))
      .finally(() => setLoading(false));
  }, [onError]);

  // Load initial results
  useEffect(() => { doSearch(""); }, [doSearch]);

  const handleSelect = async (pageId: string) => {
    try {
      const currentSync = ((metadata as Record<string, unknown>)?.sync as Array<Record<string, unknown>>) || [];
      await invoke("vault_update_note", {
        id: noteId,
        metadata: {
          ...((metadata || {}) as Record<string, unknown>),
          sync: [
            ...currentSync.filter((s) => s.adapter !== "notion"),
            { adapter: "notion", remote_id: pageId, last_synced: "", direction: "push", conflict_strategy: "ask", auto_sync: false }
          ]
        }
      });
      onDone();
    } catch (e) {
      onError(`Failed to configure: ${e}`);
    }
  };

  return (
    <div className="glass p-3 rounded-lg space-y-2">
      <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
        Choose a Notion page to sync to
      </div>

      {/* Search box */}
      <div className="flex gap-1">
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") doSearch(searchQuery); }}
          placeholder="Search Notion pages..."
          className="flex-1 h-7 rounded-md px-2 text-xs outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          autoFocus
        />
        <button
          onClick={() => doSearch(searchQuery)}
          className="px-2 h-7 rounded-md text-xs"
          style={{ background: "var(--color-accent)", color: "white" }}
        >
          Search
        </button>
      </div>

      {/* Results */}
      {loading ? (
        <div className="text-xs py-2" style={{ color: "var(--text-muted)" }}>Searching...</div>
      ) : pages.length === 0 && searched ? (
        <div className="text-xs py-2" style={{ color: "var(--text-muted)" }}>
          No pages found. Try a different search term.
        </div>
      ) : (
        <div className="max-h-48 overflow-auto space-y-0.5">
          {pages.map((page) => (
            <button
              key={page.id}
              onClick={() => handleSelect(page.id)}
              className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors truncate"
              style={{ color: "var(--text-primary)" }}
            >
              {page.icon && <span className="mr-1">{page.icon}</span>}
              {page.title}
            </button>
          ))}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={onCancel}
          className="px-2 py-1 rounded text-xs hover:bg-[var(--glass-hover)]"
          style={{ color: "var(--text-secondary)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
