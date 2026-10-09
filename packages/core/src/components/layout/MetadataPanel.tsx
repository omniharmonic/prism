import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { isStructuredValue, scalarText, STRUCTURED_HINT, structuredItems, valueText } from "../../lib/database/structured";
import { invoke } from "@tauri-apps/api/core";
import { Plus, X, RefreshCw, Cloud, Trash2, Check, AlertTriangle, ChevronDown, ChevronRight, GitFork } from "lucide-react";
import type { Note, ContentType } from "../../lib/types";
import { useUpdateNote } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { reviewMode } from "../../lib/governance/review";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import "./context-panels.css";
import { CONTENT_TYPE_LABELS } from "../../lib/schemas/content-types";
import { syncApi, type SyncStatus } from "../../lib/sync/client";
import { useGitHubSyncApi } from "../../lib/host/folderSync";
import { GitHubSyncModal } from "./GitHubSyncModal";
import { useIsWeb } from "../../data/Platform";
import { DesktopOnlyNotice } from "../ui/DesktopOnlyNotice";
import { useHostServices } from "../../data/HostServicesContext";
import { useVaultClient } from "../../data/VaultClientContext";
import { hostServiceErrorText } from "../../lib/host/services";
import { addSyncConfig, removeSyncConfig, syncStatusFromNote, SERVER_NOTE_SYNC_ADAPTERS } from "../../lib/host/vaultOps";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PropertyBar } from "../database/PropertyBar";
import { useSchemas } from "../../lib/database/hooks";
import { resolveProperties } from "../../lib/database/schema";

import { formatDate as fmtDate } from "../../lib/datetime/format";
import { showMessage } from "../ui/ConfirmDialog";
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
  const client = useVaultClient();
  const audience = useAgentChatStore((state) => state.scope);
  const scope = client.scope?.() ?? audience;
  return reviewMode(note) === "none" ? (
    <EditableMetadata key={JSON.stringify([scope, note.id])} note={note} scope={scope} />
  ) : (
    <ReadOnlyMetadata key={JSON.stringify([scope, note.id])} note={note} />
  );
}

function ReadOnlyMetadata({ note }: MetadataPanelProps) {
  const metadata = note.metadata ?? {};
  const properties = Object.entries(metadata).filter(
    ([key, value]) => !SYSTEM_FIELDS.has(key) && value != null && value !== "",
  );
  const destinations = Array.isArray(metadata.sync) ? (metadata.sync as Array<{ adapter?: string }>) : [];
  return (
    <section className="prism-context-metadata" aria-label="Page properties">
      <header>
        <h2>Properties</h2>
        <p>View this page’s details. Editing requires edit access.</p>
      </header>
      <dl className="prism-context-properties">
        <div>
          <dt>Type</dt>
          <dd>{CONTENT_TYPE_LABELS[metadata.type as ContentType] || "Document"}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{note.path || "Untitled"}</dd>
        </div>
        {properties.map(([key, value]) => (
          <div key={key}>
            <dt>{key.replace(/[_-]/g, " ")}</dt>
            <dd>{valueText(value)}</dd>
          </div>
        ))}
      </dl>
      <h3>Tags</h3>
      <div className="prism-context-tags">
        {note.tags?.length ? (
          note.tags.map((tag) => (
            <button
              type="button"
              key={tag}
              onClick={() => useUIStore.getState().openTab(`tag:${tag}`, `Tag: ${tag}`, "document")}
            >
              {tag}
            </button>
          ))
        ) : (
          <p>No tags</p>
        )}
      </div>
      <h3>Activity</h3>
      <p className="prism-context-caption">
        Created {formatDate(note.createdAt)}
        {note.updatedAt && (
          <>
            <br />
            Updated {formatDate(note.updatedAt)}
          </>
        )}
      </p>
      {!!destinations.length && (
        <>
          <h3>Sync destinations</h3>
          <p className="prism-context-caption">
            {destinations.map((config) => config.adapter || "Configured destination").join(", ")}
          </p>
        </>
      )}
    </section>
  );
}

function EditableMetadata({ note, scope }: MetadataPanelProps & {scope:string|null}) {
  const updateNote = useUpdateNote();
  const client = useVaultClient();
  const { data: allTags } = useQuery({queryKey:["vault","tags",scope],queryFn:()=>client.getTags()});
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
      id: note.id, expectedScope:scope ?? undefined,
      metadata: { ...meta, type: newType },
    });
  }, [note, meta, updateNote, scope]);

  const handleMetadataFieldChange = useCallback(async (fieldName: string, value: unknown) => {
    await updateNote.mutateAsync({
      id: note.id, expectedScope:scope ?? undefined,
      metadata: { ...meta, [fieldName]: value },
    });
  }, [note, meta, updateNote, scope]);

  // Fields a tag schema declares are edited by the typed property list above;
  // everything else stays a free "property" row below.
  const { data: schemaData } = useSchemas();
  const schemaKeys = useMemo(
    () => new Set(resolveProperties(noteTags, schemaData?.schemas ?? {}, meta).filter((p) => p.tag !== null).map((p) => p.key)),
    [noteTags, schemaData, meta],
  );
  // Separate this note's own metadata fields into "properties" (non-system, non-empty)
  const noteProperties = useMemo(() => {
    return Object.entries(meta)
      .filter(([key, val]) => !SYSTEM_FIELDS.has(key) && !schemaKeys.has(key) && val != null && val !== "")
      .map(([key]) => key);
  }, [meta, schemaKeys]);

  return (
    <section className="prism-context-metadata space-y-3" aria-label="Page properties">
      <header><h2>Properties</h2><p>Details that help organize this page</p></header>
      {updateNote.isError && <p role="alert" className="prism-context-state">The property could not be saved. Check your access and try again.</p>}
      {/* ── Core Info ─────────────────────────── */}
      <div className="flex items-center gap-2">
        <select
          aria-label="Page type"
          disabled={updateNote.isPending}
          value={currentType}
          onChange={(e) => handleTypeChange(e.target.value)}
          className="flex-1 h-7 rounded-md px-2 text-sm outline-none cursor-pointer"
          style={{
            backgroundColor: "var(--glass)",
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

      {/* Typed properties from the page's tag schemas (same editor as under the title) */}
      <PropertyBar note={note} layout="panel" schemaOnly showTags={false} />

      {/* Tags */}
      <TagEditor key={JSON.stringify([scope,note.id])} scope={scope} noteId={note.id} tags={noteTags} allTags={allTags?.map((t) => t.tag) || []} />

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
      <div className="prism-context-sync"><h3>Sync destinations</h3><SyncSection noteId={note.id} metadata={note.metadata} notePath={note.path} /></div>

      {/* Advanced JSON (collapsible) */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="prism-context-raw-toggle flex items-center gap-1 text-xs hover:text-[var(--text-primary)] transition-colors"
        style={{ color: "var(--text-muted)" }}
        aria-expanded={showAdvanced}
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
    </section>
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
  onFieldChange: (field: string, value: unknown) => Promise<void>;
}) {
  const client = useVaultClient();
  const audience = useAgentChatStore(state => state.scope);
  const scope = client.scope?.() ?? audience;
  const related = useQuery({ queryKey: ["vault", "metadata-fields", scope, tag], queryFn: () => client.listNotes({ tag }) });
  const notesWithTag = !related.isFetching && !related.isError ? related.data : undefined;
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
            style={{ backgroundColor: "var(--glass)", color: "var(--text-muted)" }}
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
  onChange: (value: unknown) => Promise<void>;
}) {
  const label = fieldName.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const [draft, setDraft] = useState(value != null ? scalarText(value) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const attempted = useRef<unknown>(value);
  useEffect(()=>{ if(!pending.current) setDraft(value != null ? scalarText(value) : ""); },[value]);
  async function save(next:unknown) {
    if(pending.current) return;
    pending.current=true;attempted.current=next;setBusy(true);setError("");
    try { await onChange(next); return true; } catch { setError("Not saved. Your value is kept; try again."); return false; }
    finally { pending.current=false;setBusy(false); }
  }
  const failure = error ? <span role="alert" className="prism-context-field-error">{error}<button type="button" onClick={()=>void save(attempted.current)}>Retry</button></span> : null;


  const structured = isStructuredValue(value);

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

  // A value holding objects (`members: [{name, role}]`) is shown, never edited here:
  // every input below works on text and would write the text back over the objects.
  if (structured) {
    return (
      <div className="prism-context-property-row py-0.5" data-structured>
        <span className="text-xs block mb-1" style={{ color: "var(--text-muted)" }}>{label}</span>
        <ul className="text-xs space-y-0.5" aria-label={label} style={{ color: "var(--text-primary)" }}>
          {structuredItems(value).map((it, i) => <li key={i}>{it.text}</li>)}
        </ul>
        <p className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>{STRUCTURED_HINT}</p>
      </div>
    );
  }

  // Boolean toggle
  if (isBooleanValue(value)) {
    return (
      <div className="flex items-center justify-between py-0.5">
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
        <button
          aria-label={label}
          role="switch" aria-checked={value} disabled={busy}
          onClick={() => void save(!value)}
          className="prism-context-switch"
        >
          <span className="prism-context-switch-track" style={{ background: value ? "var(--color-accent)" : "var(--glass-border)" }}>
            <span style={{ transform: value ? "translateX(12px)" : undefined }} />
          </span>
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
          type="date" aria-label={label} disabled={busy}
          value={dateVal}
          onChange={(e) => void save(e.target.value)}
          className="flex-1 h-6 rounded px-1.5 text-xs outline-none min-w-0"
          style={{
            backgroundColor: "var(--glass)",
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
          label={label}
          disabled={busy}
          items={value as string[]}
          suggestions={Array.from(uniqueValues)}
          onChange={save}
        />
        {failure}
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
          aria-label={label} disabled={busy}
          value={strValue}
          onChange={(e) => void save(e.target.value)}
          className="flex-1 h-6 rounded px-1.5 text-xs outline-none cursor-pointer min-w-0"
          style={{
            backgroundColor: "var(--glass)",
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
  const strValue = value != null ? scalarText(value) : "";
  return (
    <div className="prism-context-property-row flex items-center gap-2 py-0.5">
      <span className="text-xs shrink-0 w-20" style={{ color: "var(--text-muted)" }}>{label}</span>
      <input
        aria-label={label} disabled={busy}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {if(draft!==strValue)void save(draft);}}
        onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.blur();}}}
        className="flex-1 h-6 rounded px-1.5 text-xs outline-none min-w-0"
        style={{
          backgroundColor: "var(--glass)",
          border: "1px solid var(--glass-border)",
          color: "var(--text-primary)",
        }}
      />
      {failure}
    </div>
  );
}

// SchemaField replaced by PropertyRow above

// ─── Chip List for Array Fields ──────────────────────────────

function ChipList({
  items,
  suggestions,
  onChange,
  label,
  disabled,
}: {
  items: string[];
  suggestions: string[];
  label: string;
  disabled: boolean;
  onChange: (value: string[]) => Promise<boolean | undefined>;
}) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const filtered = input.length > 0
    ? suggestions.filter((s) => s.toLowerCase().includes(input.toLowerCase()) && !items.includes(s)).slice(0, 5)
    : [];

  const addItem = async (item: string) => {
    if (!disabled && item && !items.includes(item) && await onChange([...items, item])) {
      setInput("");
      setShowSuggestions(false);
    }
  };

  const removeItem = (item: string) => {
    void onChange(items.filter((i) => i !== item));
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
            <button type="button" disabled={disabled} aria-label={`Remove ${item} from ${label}`} onClick={() => removeItem(item)} className="prism-context-chip-remove hover:text-[var(--color-danger)] transition-colors">
              <X size={9} />
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          aria-label={`Add ${label}`} disabled={disabled}
          value={input}
          onChange={(e) => { setInput(e.target.value); setShowSuggestions(true); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && input.trim()) { e.preventDefault(); void addItem(input.trim()); } }}
          onFocus={() => setShowSuggestions(true)}
          placeholder="Add..."
          className="w-full h-6 rounded-md px-2 text-xs outline-none"
          style={{
            backgroundColor: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
        />
        {showSuggestions && filtered.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-0.5 py-0.5 glass-elevated z-10 rounded-md overflow-hidden">
            {filtered.map((s) => (
              <button
                key={s}
                type="button" disabled={disabled} onClick={() => void addItem(s)}
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
  scope,
}: {
  noteId: string;
  tags: string[];
  allTags: string[];
  scope: string | null;
}) {
  const client = useVaultClient();
  const queries = useQueryClient();
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(false),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && (client.scope?.() ?? useAgentChatStore.getState().scope) === scope;
  const suggestions = input.trim()
    ? allTags
        .filter((tag) => tag.toLowerCase().includes(input.trim().toLowerCase()) && !tags.includes(tag))
        .slice(0, 5)
    : [];
  async function change(raw: string, remove = false) {
    const tag = raw.trim();
    if (!current() || lock.current) return;
    if (!tag || /[\r\n\u0000-\u001f]/.test(tag)) {
      setError("Enter a tag on one line.");
      return;
    }
    if (!remove && tags.includes(tag)) {
      setError("This page already has that tag.");
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (remove) await client.removeTags(noteId, [tag]);
      else await client.addTags(noteId, [tag]);
      if (!current()) return;
      if (!remove) setInput("");
      setShowSuggestions(false);
      void queries.invalidateQueries({ queryKey: ["vault", "notes", noteId] });
      void queries.invalidateQueries({ queryKey: ["vault", "tags"] });
    } catch {
      if (current()) setError("The tag could not be saved. Your input is kept; try again.");
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <section className="prism-context-tag-editor" aria-label="Page tags">
      <h3>Tags</h3>
      <div className="prism-context-tags">
        {tags.map((tag) => (
          <span key={tag}>
            <button
              type="button"
              onClick={() => useUIStore.getState().openTab(`tag:${tag}`, `Tag: ${tag}`, "document")}
            >
              {tag}
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label={`Remove tag ${tag}`}
              onClick={() => void change(tag, true)}
            >
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
      <div className="prism-context-tag-input">
        <input
          aria-label="Add tag"
          value={input}
          disabled={busy}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setShowSuggestions(false);
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void change(input);
            }
          }}
          placeholder="Add tag…"
        />
        <button type="button" disabled={busy || !input.trim()} onClick={() => void change(input)}>
          {busy ? "Saving…" : "Add"}
        </button>
      </div>
      {error && (
        <p role="alert" className="prism-context-field-error">
          {error}
        </p>
      )}
      {showSuggestions && suggestions.length > 0 && (
        <div className="prism-context-tag-suggestions" aria-label="Suggested tags">
          {suggestions.map((tag) => (
            <button type="button" key={tag} disabled={busy} onClick={() => void change(tag)}>
              {tag}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

const SYNC_ADAPTERS = [
  { id: "google-docs", label: "Google Docs", icon: Cloud },
  { id: "notion", label: "Notion", icon: Cloud },
  { id: "github", label: "GitHub", icon: GitFork },
];

function SyncSection({ noteId, metadata, notePath }: { noteId: string; metadata: Record<string, unknown> | null; notePath: string | null }) {
  const isWeb = useIsWeb();
  // Thin client (WP4.3): the server pushes/pulls (POST /api/sync/note/:id/*) with
  // ITS stored credentials; the config lives in metadata.sync[] like on desktop.
  // Only the server owner gets a HostServices client.
  const host = useHostServices();
  const vaultClient = useVaultClient();
  const viaServer = isWeb && !!host;
  // Stable identities: the picker re-searches whenever these change.
  const notionSearch = useCallback((q: string) => host!.notionPages(q), [host]);
  const notionBind = useCallback(
    (pageId: string) => addSyncConfig(vaultClient, noteId, "notion", { remote_id: pageId, direction: "push" }).then(() => undefined),
    [vaultClient, noteId],
  );
  const [showAdd, setShowAdd] = useState(false);
  const queryClient = useQueryClient();

  const { data: desktopStatuses } = useQuery({
    queryKey: ["sync", "status", noteId],
    queryFn: () => syncApi.status(noteId),
    retry: false,
    enabled: !isWeb,
  });
  const statuses: SyncStatus[] | undefined = viaServer ? syncStatusFromNote({ metadata }) : desktopStatuses;

  const syncConfigs = ((metadata as Record<string, unknown>)?.sync as Array<Record<string, unknown>>) || [];

  const [syncError, setSyncError] = useState<string | null>(null);

  const [showNotionSetup, setShowNotionSetup] = useState(false);
  const [showGitHubSetup, setShowGitHubSetup] = useState(false);

  // Check if this note is in a directory with an active GitHub sync. Desktop →
  // Tauri; thin client → the server's folder syncs (owner; Client parity B).
  const { api: ghApi } = useGitHubSyncApi();
  const [githubConfig, setGithubConfig] = useState<{ id: string; vaultPath: string } | null>(null);
  const refreshGithubConfig = useCallback(() => {
    if (!ghApi) return;
    try {
      ghApi.status().then((configs) => {
        const under = (base: string) => !!notePath && (notePath === base.replace(/\/+$/, "") || notePath.startsWith(`${base.replace(/\/+$/, "")}/`));
        const match = configs.find((c) => under(c.vaultPath));
        setGithubConfig(match ? { id: match.id, vaultPath: match.vaultPath } : null);
      }).catch(() => {});
    } catch { /* not in Tauri */ }
  }, [notePath, ghApi]);
  useEffect(() => {
    refreshGithubConfig();
  }, [refreshGithubConfig]);

  const handleAddSync = async (adapter: string) => {
    setSyncError(null);
    try {
      if (adapter === "notion") {
        setShowNotionSetup(true);
        setShowAdd(false);
        return;
      }
      if (adapter === "github") {
        if (!ghApi) return;
        if (githubConfig) {
          // Directory already has GitHub sync — push this file
          await ghApi.pushFile(githubConfig.id, noteId);
          setSyncError(null);
          setShowAdd(false);
        } else {
          // No GitHub sync for this directory — open setup modal
          setShowGitHubSetup(true);
          setShowAdd(false);
        }
        return;
      }
      if (viaServer) await addSyncConfig(vaultClient, noteId, adapter);
      else await syncApi.addConfig(noteId, adapter);
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
      const results: Array<{ status: string; message?: string }> = viaServer ? await host!.notePush(noteId) : await syncApi.trigger(noteId);
      if (viaServer) queryClient.invalidateQueries({ queryKey: ["vault"] });
      const errors = results.filter((r: { status: string }) => r.status === "error");
      if (errors.length > 0) {
        setSyncError(errors.map((e: { message?: string }) => e.message).join("; "));
      }
      queryClient.invalidateQueries({ queryKey: ["sync", "status", noteId] });
    } catch (e) {
      setSyncError(`Sync failed: ${viaServer ? hostServiceErrorText(e) : e}`);
    }
  };

  const handleRemove = async (adapter: string, remoteId: string) => {
    if (viaServer) await removeSyncConfig(vaultClient, noteId, adapter, remoteId);
    else await syncApi.removeConfig(noteId, adapter, remoteId);
    queryClient.invalidateQueries({ queryKey: ["sync", "status", noteId] });
    queryClient.invalidateQueries({ queryKey: ["vault"] });
  };

  // Without a HostServices client (a non-owner, a capability viewer) there is
  // nothing that may push this note anywhere: show a notice, not dead controls.
  if (isWeb && !host) {
    return (
      <DesktopOnlyNotice
        feature="Note sync"
        detail="Syncing a note to Google Docs, Notion or GitHub runs on the Prism Server with its stored credentials, so only the server owner can set it up."
      />
    );
  }
  // On the server: per-note Google Docs / Notion, plus GitHub (folder sync, owner).
  const adapters = viaServer
    ? SYNC_ADAPTERS.filter((a) => (SERVER_NOTE_SYNC_ADAPTERS as readonly string[]).includes(a.id) || (a.id === "github" && !!ghApi))
    : SYNC_ADAPTERS;

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
                const result: { status: string; message?: string } = viaServer ? await host!.notePull(noteId) : await syncApi.pull(noteId);
                if (result.status === "error") {
                  setSyncError((result as { message?: string }).message || "Pull failed");
                } else {
                  queryClient.invalidateQueries({ queryKey: ["vault"] });
                  void showMessage("Close and reopen the tab to see the updated content.", "Pulled from Google Docs");
                }
              } catch (e) {
                setSyncError(`Pull failed: ${viaServer ? hostServiceErrorText(e) : e}`);
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
            {adapters.map(({ id, label, icon: Icon }) => (
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
          search={viaServer ? notionSearch : undefined}
          bind={viaServer ? notionBind : undefined}
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
                await ghApi!.pushFile(githubConfig.id, noteId);
              } catch (e) {
                setSyncError(`GitHub push failed: ${viaServer ? hostServiceErrorText(e) : e}`);
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
            refreshGithubConfig();
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

function NotionPagePicker({ noteId, metadata, search, bind, onDone, onCancel, onError }: {
  noteId: string;
  metadata: Record<string, unknown> | null;
  /** Thin client: search through the server (GET /api/sync/notion/pages). */
  search?: (query: string) => Promise<Array<{ id: string; title: string; url: string; icon: string | null }>>;
  /** Thin client: write the binding through the VaultClient seam. */
  bind?: (pageId: string) => Promise<void>;
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
    (search
      ? search(query)
      : invoke<Array<{ id: string; title: string; url: string; icon: string | null }>>("notion_list_pages", { query: query || null }))
      .then((results) => { setPages(results); setSearched(true); })
      .catch((e) => onError(`Failed to search Notion: ${search ? hostServiceErrorText(e) : e}`))
      .finally(() => setLoading(false));
  }, [onError, search]);

  // Load initial results
  useEffect(() => { doSearch(""); }, [doSearch]);

  const handleSelect = async (pageId: string) => {
    if (bind) {
      try {
        await bind(pageId);
        onDone();
      } catch (e) {
        onError(`Failed to configure: ${e}`);
      }
      return;
    }
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
          style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
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
    return fmtDate(new Date(iso), {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }, { locale: "en-US" });
  } catch {
    return iso;
  }
}
