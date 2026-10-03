/**
 * Properties under the page title (mockup 12) and the same fields in the side
 * panel. Schema-driven: every tag on the page contributes its vault-typed fields,
 * so a `task` page shows Status/Priority/Due as a select/select/date, not free
 * text. Empty properties hide behind "+ Add property"; values save on commit
 * with per-field compare-and-set (metadata-only — the body is never written, and
 * on a live collaborative document the server tells the reconciler).
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Search, Check, Tag as TagIcon, X } from "lucide-react";
import type { Note } from "../../lib/types";
import { useVaultClient } from "../../data/VaultClientContext";
import { reviewMode } from "../../lib/governance/review";
import { noteAccess, useSchemas, usePropertyWriter, useScope, useUpdateSchema } from "../../lib/database/hooks";
import {
  isBlank,
  PROPERTY_KIND_LABELS,
  PROPERTY_KINDS,
  resolveProperties,
  VAULT_TYPE_FOR_KIND,
  type PropertyDef,
  type PropertyKind,
} from "../../lib/database/schema";
import { isFieldKey } from "../../lib/database/query";
import { useUIStore } from "../../app/stores/ui";
import { queryKeys } from "../../lib/parachute/queries";
import { PropertyValue } from "./PropertyValue";
import { Popover } from "./Popover";
import "./database.css";

const FREE_KINDS: PropertyKind[] = ["text", "number", "checkbox", "url"];

function keyFromLabel(label: string): string {
  const k = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return /^[a-z]/.test(k) ? k : `p_${k}`;
}

export function PropertyBar({ note, readOnly, onOpenAll, layout = "bar", trailing, schemaOnly = false, showTags = true }: {
  note: Note;
  /** Only schema-declared fields (the side panel lists free keys itself). */
  schemaOnly?: boolean;
  showTags?: boolean;
  readOnly?: boolean;
  /** Replaces the built-in Updated + "All properties" items (e.g. the page's details disclosure). */
  trailing?: ReactNode;
  /** Opens the full properties panel (the page's side panel). */
  onOpenAll?: () => void;
  layout?: "bar" | "panel";
}) {
  const { data } = useSchemas();
  const write = usePropertyWriter();
  const schemaEdit = useUpdateSchema();
  const access = noteAccess(note);
  const editable = !readOnly && reviewMode(note) === "none" && access.edit;
  const canOrganize = !readOnly && reviewMode(note) === "none" && access.organize;
  // The server says who may change schemas (owner role); never guess from `_caps`.
  const canEditSchema = editable && schemaEdit.available && !!data?.live && !!data?.canEdit;
  const tags = note.tags ?? [];
  const schemas = data?.schemas ?? {};
  const props = useMemo(() => {
    const all = resolveProperties(tags, schemas, note.metadata);
    return schemaOnly ? all.filter((p) => p.tag !== null) : all;
  }, [tags, schemas, note.metadata, schemaOnly]);
  const [revealed, setRevealed] = useState<string[]>([]);
  const [showEmpty, setShowEmpty] = useState(layout === "panel");
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [freeDraft, setFreeDraft] = useState<FreeDraft>(null);
  const meta = note.metadata ?? {};

  const shown = props.filter((p) => showEmpty || !isBlank(meta[p.key]) || revealed.includes(p.key));
  const hiddenEmpty = props.filter((p) => isBlank(meta[p.key]) && !revealed.includes(p.key));

  const commit = (def: PropertyDef) => async (next: unknown, base: unknown) => {
    await write(note, { [def.key]: next }, { [def.key]: base ?? null });
  };
  const createOption = (def: PropertyDef) =>
    canEditSchema && def.tag
      ? async (option: string) => {
          if (def.kind === "multi_select") return; // free values; colour hints only
          // Only the vault enum is extended — colour-hint keys are presentation (review L7).
          await schemaEdit.update(def.tag!, { fields: { [def.key]: { enum: [...def.enumValues, option] } } });
        }
      : undefined;

  const reveal = (key: string) => {
    setRevealed((r) => (r.includes(key) ? r : [...r, key]));
    setJustAdded(key);
  };

  return (
    <div className={`db-props db-props-${layout}`} role="group" aria-label="Page properties">
      {shown.map((def) => (
        <div className="db-prop" key={def.key} data-kind={def.kind}>
          <span className="db-prop-label" title={def.description || def.label}>{def.label}</span>
          <PropertyValue
            def={def}
            value={meta[def.key]}
            readOnly={!editable}
            variant={layout === "panel" ? "panel" : "bar"}
            onCommit={commit(def)}
            onCreateOption={createOption(def)}
            autoOpen={justAdded === def.key}
            onDone={() => setJustAdded(null)}
          />
        </div>
      ))}
      {showTags && (
        <div className="db-prop db-prop-tags">
          <span className="db-prop-label">Tags</span>
          <TagChips note={note} editable={canOrganize} />
        </div>
      )}
      {layout === "bar" && !trailing && note.updatedAt && !Number.isNaN(Date.parse(note.updatedAt)) && (
        <div className="db-prop db-prop-updated">
          <span className="db-prop-label">Updated</span>
          <time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString()}>{relativeDay(note.updatedAt)}</time>
        </div>
      )}
      {(editable || (onOpenAll && !trailing)) && (
        <div className="db-prop-actions">
          {editable && (
            <AddProperty
              empty={editable ? hiddenEmpty : []}
              canCreate={editable}
              canEditSchema={canEditSchema}
              firstTag={tags[0] ?? null}
              existing={props.map((p) => p.key)}
              showEmpty={showEmpty}
              hiddenCount={hiddenEmpty.length}
              onToggleEmpty={() => setShowEmpty((v) => !v)}
              onReveal={reveal}
              onCreateSchemaField={async (label, kind, tag) => {
                const key = keyFromLabel(label);
                await schemaEdit.update(tag, { fields: { [key]: { type: VAULT_TYPE_FOR_KIND[kind] } }, ui: { [key]: { kind, label: label.trim() } } });
                reveal(key);
              }}
              onCreateFree={(label, kind) => {
                // A free property exists once it has a value; seed the editor with the kind's empty value.
                const key = keyFromLabel(label);
                if (kind === "checkbox") void write(note, { [key]: false }, { [key]: null }).then(() => reveal(key));
                else {
                  setFreeDraft({ key, label: label.trim(), kind });
                }
              }}
            />
          )}
          {onOpenAll && layout === "bar" && !trailing && (
            <button type="button" className="db-ghost focus-ring" onClick={onOpenAll}>All properties <ChevronRight size={13} aria-hidden="true" /></button>
          )}
        </div>
      )}
      {freeDraftNode()}
      {trailing && <div className="db-prop db-prop-trailing">{trailing}</div>}
    </div>
  );

  // A brand-new free property: an editor for its first value (nothing is written until committed).
  function freeDraftNode() {
    if (!freeDraft) return null;
    const def: PropertyDef = { key: freeDraft.key, label: freeDraft.label, kind: freeDraft.kind, options: [], tag: null, multiple: false, enumValues: [] };
    return (
      <div className="db-prop" data-kind={def.kind}>
        <span className="db-prop-label">{def.label}</span>
        <PropertyValue def={def} value={null} variant={layout === "panel" ? "panel" : "bar"} onCommit={commit(def)} autoOpen onDone={() => setFreeDraft(null)} />
      </div>
    );
  }
}

type FreeDraft = { key: string; label: string; kind: PropertyKind } | null;

function relativeDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}

function AddProperty({ empty, canCreate, canEditSchema, firstTag, existing, showEmpty, hiddenCount, onToggleEmpty, onReveal, onCreateSchemaField, onCreateFree }: {
  empty: PropertyDef[]; canCreate: boolean; canEditSchema: boolean; firstTag: string | null; existing: string[];
  showEmpty: boolean; hiddenCount: number; onToggleEmpty: () => void; onReveal: (key: string) => void;
  onCreateSchemaField: (label: string, kind: PropertyKind, tag: string) => Promise<void>;
  onCreateFree: (label: string, kind: PropertyKind) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const schemaBacked = canEditSchema && !!firstTag;
  const kinds = schemaBacked ? [...PROPERTY_KINDS] : FREE_KINDS;
  const [kind, setKind] = useState<PropertyKind>("text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = keyFromLabel(name);
  const clash = !!name.trim() && existing.includes(key);
  const submit = async () => {
    if (!name.trim() || clash || !isFieldKey(key)) return;
    setBusy(true);
    setError("");
    try {
      if (schemaBacked) await onCreateSchemaField(name, kind, firstTag!);
      else onCreateFree(name, kind);
      setName("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error && !/failed: \d{3}/.test(e.message) ? e.message : "The property could not be added.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button ref={anchor} type="button" className="db-ghost focus-ring" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Plus size={13} aria-hidden="true" /> Add property
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Add a property" width={300}>
        {empty.length > 0 && (
          <>
            <p className="db-pop-heading">{firstTag ? `From ${firstTag}` : "Suggested"}</p>
            <ul className="db-pop-list" aria-label="Empty properties">
              {empty.map((p) => (
                <li key={p.key}>
                  <button type="button" onClick={() => { onReveal(p.key); setOpen(false); }}>
                    <span className="db-kind-badge">{PROPERTY_KIND_LABELS[p.kind]}</span>
                    <span className="db-pop-title">{p.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {hiddenCount > 0 && (
          <button type="button" className="db-pop-clear" onClick={() => { onToggleEmpty(); setOpen(false); }}>
            {showEmpty ? "Hide empty properties" : `Show ${hiddenCount} empty ${hiddenCount === 1 ? "property" : "properties"}`}
          </button>
        )}
        {canCreate && (
          <form className="db-new-prop" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <p className="db-pop-heading">New property{schemaBacked ? ` on every “${firstTag}” page` : " on this page"}</p>
            <label className="db-field">
              <span>Name</span>
              <input aria-label="Property name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Estimate" />
            </label>
            <label className="db-field">
              <span>Type</span>
              <select aria-label="Property type" value={kind} onChange={(e) => setKind(e.target.value as PropertyKind)}>
                {kinds.map((k) => <option key={k} value={k}>{PROPERTY_KIND_LABELS[k]}</option>)}
              </select>
            </label>
            {clash && <p className="db-error" role="alert">This page already has that property.</p>}
            {error && <p className="db-error" role="alert">{error}</p>}
            <button type="submit" className="db-primary" disabled={busy || !name.trim() || clash}>{busy ? "Adding…" : "Add property"}</button>
          </form>
        )}
      </Popover>
    </>
  );
}

/** Tag chips + a searchable checklist of the vault's tags (mockup 12). */
function TagChips({ note, editable }: { note: Note; editable: boolean }) {
  const client = useVaultClient();
  const scope = useScope();
  const qc = useQueryClient();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tags = note.tags ?? [];
  const all = useQuery({ queryKey: ["vault", "tags", scope], queryFn: () => client.getTags(), enabled: open });
  const options = useMemo(() => {
    const names = new Map<string, number>((all.data ?? []).map((t) => [t.tag, t.count]));
    for (const t of tags) if (!names.has(t)) names.set(t, 0);
    const needle = q.trim().toLowerCase();
    return [...names.entries()]
      .filter(([t]) => !needle || t.toLowerCase().includes(needle))
      .sort((a, b) => Number(tags.includes(b[0])) - Number(tags.includes(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 50);
  }, [all.data, tags, q]);
  const toggle = async (tag: string) => {
    const t = tag.trim();
    if (!t || /[\r\n\u0000-\u001f]/.test(t) || busy) return;
    setBusy(true);
    setError("");
    try {
      if (tags.includes(t)) await client.removeTags(note.id, [t]);
      else await client.addTags(note.id, [t]);
      qc.setQueryData<Note>(queryKeys.vault.note(note.id), (old) => old ? { ...old, tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] } : old);
      void qc.invalidateQueries({ queryKey: queryKeys.vault.note(note.id) });
      void qc.invalidateQueries({ queryKey: ["vault", "tags"] });
      setQ("");
    } catch {
      setError("The tag could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const exact = options.some(([t]) => t.toLowerCase() === q.trim().toLowerCase());
  return (
    <span className="db-chips db-tag-chips">
      {tags.map((t) => (
        <span key={t} className="db-tag">
          <button type="button" className="db-tag-name" onClick={() => useUIStore.getState().openTab(`tag:${t}`, `Tag: ${t}`, "document")}>{t}</button>
          {editable && <button type="button" className="db-opt-remove" aria-label={`Remove tag ${t}`} disabled={busy} onClick={() => void toggle(t)}><X size={11} aria-hidden="true" /></button>}
        </span>
      ))}
      {!tags.length && !editable && <span className="db-empty">No tags</span>}
      {editable && (
        <button ref={anchor} type="button" className="db-add-tag focus-ring" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <TagIcon size={12} aria-hidden="true" /> Add tag
        </button>
      )}
      {error && <span role="alert" className="db-error">{error}</span>}
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Choose tags" width={260}>
        <div className="db-pop-search">
          <Search size={14} aria-hidden="true" />
          <input autoFocus aria-label="Search tags" placeholder="Search tags…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && q.trim()) { e.preventDefault(); void toggle(options.length === 1 ? options[0]![0] : q.trim()); } }} />
        </div>
        <ul className="db-pop-list" aria-label="Tags">
          {options.map(([t, count]) => (
            <li key={t}>
              <button type="button" role="menuitemcheckbox" aria-checked={tags.includes(t)} disabled={busy} onClick={() => void toggle(t)}>
                <span className="db-check" data-checked={tags.includes(t) || undefined} aria-hidden="true">{tags.includes(t) && <Check size={12} />}</span>
                <span className="db-pop-title">{t}</span>
                {count > 0 && <span className="db-pop-path">{count}</span>}
              </button>
            </li>
          ))}
          {all.isLoading && <li className="db-pop-empty">Loading tags…</li>}
        </ul>
        {q.trim() && !exact && (
          <button type="button" className="db-pop-create" disabled={busy} onClick={() => void toggle(q.trim())}><Plus size={14} aria-hidden="true" /> Add “{q.trim()}”</button>
        )}
      </Popover>
    </span>
  );
}
