import { useState, useCallback } from "react";
import { Plus, X, RefreshCw, Cloud, Trash2, Check, AlertTriangle } from "lucide-react";
import type { Note, ContentType } from "../../lib/types";
import { useUpdateNote, useTags } from "../../app/hooks/useParachute";
import { vaultApi } from "../../lib/parachute/client";
import { CONTENT_TYPE_LABELS } from "../../lib/schemas/content-types";
import { syncApi, type SyncStatus } from "../../lib/sync/client";
import { cn } from "../../lib/cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface MetadataPanelProps {
  note: Note;
}

const CONTENT_TYPES = Object.entries(CONTENT_TYPE_LABELS) as [ContentType, string][];

export function MetadataPanel({ note }: MetadataPanelProps) {
  const updateNote = useUpdateNote();
  const { data: allTags } = useTags();
  const currentType = ((note.metadata as Record<string, unknown>)?.type as ContentType) || "document";

  // Word count
  const wordCount = note.content.trim().split(/\s+/).filter(Boolean).length;
  const readingTime = Math.max(1, Math.ceil(wordCount / 200));

  const handleTypeChange = useCallback((newType: string) => {
    const currentMeta = (note.metadata || {}) as Record<string, unknown>;
    updateNote.mutate({
      id: note.id,
      metadata: { ...currentMeta, type: newType },
    });
  }, [note, updateNote]);

  return (
    <div className="space-y-4">
      {/* Type selector */}
      <Field label="Type">
        <select
          value={currentType}
          onChange={(e) => handleTypeChange(e.target.value)}
          className="w-full h-7 rounded-md px-2 text-sm outline-none cursor-pointer"
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
      </Field>

      {/* Path */}
      <Field label="Path">
        <div className="text-sm truncate" style={{ color: "var(--text-secondary)" }}>
          {note.path || "—"}
        </div>
      </Field>

      {/* Tags */}
      <Field label="Tags">
        <TagEditor noteId={note.id} tags={note.tags || []} allTags={allTags?.map((t) => t.tag) || []} />
      </Field>

      {/* Timestamps */}
      <Field label="Created">
        <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {formatDate(note.createdAt)}
        </div>
      </Field>
      <Field label="Updated">
        <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {note.updatedAt ? formatDate(note.updatedAt) : "—"}
        </div>
      </Field>

      {/* Stats */}
      <Field label="Stats">
        <div className="flex gap-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          <span>{wordCount.toLocaleString()} words</span>
          <span>{readingTime} min read</span>
        </div>
      </Field>

      {/* Sync destinations */}
      <Field label="Sync">
        <SyncSection noteId={note.id} metadata={note.metadata} />
      </Field>

      {/* Raw metadata */}
      <Field label="Raw Metadata">
        <pre
          className="glass-inset p-2 text-xs overflow-auto rounded max-h-40"
          style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}
        >
          {JSON.stringify(note.metadata, null, 2)}
        </pre>
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-label mb-1">{label}</div>
      {children}
    </div>
  );
}

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
            {tag}
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
];

function SyncSection({ noteId, metadata }: { noteId: string; metadata: Record<string, unknown> | null }) {
  const [showAdd, setShowAdd] = useState(false);
  const queryClient = useQueryClient();

  const { data: statuses } = useQuery({
    queryKey: ["sync", "status", noteId],
    queryFn: () => syncApi.status(noteId),
    retry: false,
  });

  const syncConfigs = ((metadata as Record<string, unknown>)?.sync as Array<Record<string, unknown>>) || [];

  const [syncError, setSyncError] = useState<string | null>(null);

  const handleAddSync = async (adapter: string) => {
    setSyncError(null);
    try {
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

      {/* Sync now button */}
      {syncConfigs.length > 0 && (
        <button
          onClick={handleSync}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--glass-hover)]"
          style={{ color: "var(--text-secondary)" }}
        >
          <RefreshCw size={12} />
          Sync Now
        </button>
      )}

      {/* Add sync destination */}
      <div className="relative">
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors hover:bg-[var(--glass-hover)]"
          style={{ color: "var(--text-muted)", border: "1px dashed var(--glass-border)" }}
        >
          <Plus size={13} />
          Add sync destination
        </button>
        {showAdd && (
          <div className="absolute top-full left-0 right-0 mt-1 py-1 glass-elevated rounded-md overflow-hidden z-10">
            {SYNC_ADAPTERS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => handleAddSync(id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--glass-hover)] transition-colors"
                style={{ color: "var(--text-primary)" }}
              >
                <Icon size={12} style={{ color: "var(--text-secondary)" }} />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
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
