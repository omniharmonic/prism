/**
 * Properties under the page title (mockup 12) and the same fields in the side
 * panel. Schema-driven: every tag on the page contributes its vault-typed fields,
 * so a `task` page shows Status/Priority/Due as a select/select/date, not free
 * text. Empty properties hide behind "+ Add property"; values save on commit
 * with per-field compare-and-set (metadata-only — the body is never written, and
 * on a live collaborative document the server tells the reconciler).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Search, Check, Tag as TagIcon, X } from "lucide-react";
import type { Note } from "../../lib/types";
import { useVaultClient } from "../../data/VaultClientContext";
import { reviewMode } from "../../lib/governance/review";
import { noteAccess, useReverseRelations, useSchemas, usePropertyWriter, useScope, useUpdateSchema } from "../../lib/database/hooks";
import {
  isBlank,
  PROPERTY_KIND_LABELS,
  PROPERTY_KINDS,
  resolveProperties,
  VAULT_TYPE_FOR_KIND,
  type PropertyDef,
  type PropertyKind,
} from "../../lib/database/schema";
import { isFieldKey, noteTitle, runQuery, type QueryRow, type QuerySpec } from "../../lib/database/query";
import { asWikilink, linkLabel, linkTarget } from "../../lib/database/schema";
import { PropertyConflictError } from "../../data/VaultClient";
import { useUIStore } from "../../app/stores/ui";
import { queryKeys } from "../../lib/parachute/queries";
import { PropertyValue } from "./PropertyValue";
import { REVEAL_PROPERTY_EVENT } from "../../lib/notifications/anchor";
import { PropertyEditor } from "./PropertyEditor";
import { propertyFromField } from "../../lib/database/schema";
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
  const [editingProp, setEditingProp] = useState<{ tag: string; key: string } | null>(null);
  const deletedProps = useMemo(() => {
    const out: PropertyDef[] = [];
    for (const t of tags) for (const [k, f] of Object.entries(schemas[t]?.fields ?? {})) if (f.deleted && !out.some((p) => p.key === k)) out.push(propertyFromField(k, f, t));
    return out;
  }, [tags, schemas]);
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
  // An "assigned you" notification lands on its property: bring it out if it is folded away.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ noteId?: string; key?: string }>).detail;
      if (d?.noteId === note.id && typeof d.key === "string") setRevealed((r) => (r.includes(d.key!) ? r : [...r, d.key!]));
    };
    window.addEventListener(REVEAL_PROPERTY_EVENT, h);
    return () => window.removeEventListener(REVEAL_PROPERTY_EVENT, h);
  }, [note.id]);

  return (
    <div className={`db-props db-props-${layout}`} role="group" aria-label="Page properties">
      {shown.map((def) => (
        <div className="db-prop" key={def.key} data-kind={def.kind} data-property-key={def.key}>
          {canEditSchema && def.tag ? (
            <button type="button" className="db-prop-label db-prop-label-edit focus-ring" title={`Edit the “${def.label}” property`} aria-label={`Edit property ${def.label}`} onClick={() => setEditingProp({ tag: def.tag!, key: def.key })}>{def.label}</button>
          ) : <span className="db-prop-label" title={def.description || def.label}>{def.label}</span>}
          <PropertyValue
            def={def}
            value={meta[def.key]}
            noteId={note.id}
            readOnly={!editable}
            variant={layout === "panel" ? "panel" : "bar"}
            onCommit={commit(def)}
            onCreateOption={createOption(def)}
            autoOpen={justAdded === def.key}
            onDone={() => setJustAdded(null)}
          />
        </div>
      ))}
      <ReverseRelations note={note} editable={editable} />
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
              deleted={canEditSchema ? deletedProps : []}
              onManageDeleted={(p) => { if (p.tag) setEditingProp({ tag: p.tag, key: p.key }); }}
              hiddenCount={hiddenEmpty.length}
              onToggleEmpty={() => setShowEmpty((v) => !v)}
              onReveal={reveal}
              onCreateSchemaField={async (label, kind, tag, relation) => {
                const key = keyFromLabel(label);
                const ui = { kind, label: label.trim(), ...(relation?.target ? { relationTag: relation.target } : {}), ...(relation?.target && relation.reverse ? { reverseLabel: relation.reverse } : {}) };
                await schemaEdit.update(tag, { fields: { [key]: { type: VAULT_TYPE_FOR_KIND[kind] } }, ui: { [key]: ui } });
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
      {editingProp && schemas[editingProp.tag]?.fields[editingProp.key] && (
        <PropertyEditor propertyKey={editingProp.key} tag={editingProp.tag} field={schemas[editingProp.tag]!.fields[editingProp.key]!} rows={[note]} onClose={() => setEditingProp(null)} />
      )}
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

function AddProperty({ empty, canCreate, canEditSchema, firstTag, existing, showEmpty, hiddenCount, onToggleEmpty, onReveal, onCreateSchemaField, onCreateFree, deleted, onManageDeleted }: {
  deleted: PropertyDef[]; onManageDeleted: (p: PropertyDef) => void;
  empty: PropertyDef[]; canCreate: boolean; canEditSchema: boolean; firstTag: string | null; existing: string[];
  showEmpty: boolean; hiddenCount: number; onToggleEmpty: () => void; onReveal: (key: string) => void;
  onCreateSchemaField: (label: string, kind: PropertyKind, tag: string, relation?: { target: string; reverse: string }) => Promise<void>;
  onCreateFree: (label: string, kind: PropertyKind) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const schemaBacked = canEditSchema && !!firstTag;
  const kinds = schemaBacked ? [...PROPERTY_KINDS] : FREE_KINDS;
  const [kind, setKind] = useState<PropertyKind>("text");
  const [target, setTarget] = useState("");
  const [reverse, setReverse] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = keyFromLabel(name);
  const clash = !!name.trim() && existing.includes(key);
  const submit = async () => {
    if (!name.trim() || clash || !isFieldKey(key)) return;
    setBusy(true);
    setError("");
    try {
      if (schemaBacked) await onCreateSchemaField(name, kind, firstTag!, kind === "relation" && target.trim() ? { target: target.trim(), reverse: reverse.trim() } : undefined);
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
        {deleted.length > 0 && (
          <>
            <p className="db-pop-heading">Deleted properties</p>
            <ul className="db-pop-list" aria-label="Deleted properties">
              {deleted.map((p) => (
                <li key={p.key}>
                  <button type="button" aria-label={`Manage deleted property ${p.label}`} onClick={() => { onManageDeleted(p); setOpen(false); }}>
                    <span className="db-pop-title">{p.label}</span>
                    <span className="db-pop-path">Restore or remove…</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
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
            {schemaBacked && kind === "relation" && (
              <>
                <label className="db-field">
                  <span>Links to pages tagged</span>
                  <input aria-label="Related database tag" value={target} maxLength={128} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. project" />
                </label>
                <label className="db-field">
                  <span>Show on those pages as (optional)</span>
                  <input aria-label="Reverse property name" value={reverse} maxLength={80} disabled={!target.trim()} onChange={(e) => setReverse(e.target.value)} placeholder={firstTag ? `e.g. ${firstTag}s` : "e.g. Tasks"} />
                </label>
              </>
            )}
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

/**
 * Reverse relations (NP-DB-12): pages whose relation property points AT this
 * page, for relations whose schema asks for it (`reverseLabel`). Read-only and
 * computed by query — the forward value is the only thing ever written, so the
 * two sides cannot drift. Each chip opens the linking page.
 */
function ReverseRelations({ note, editable }: { note: Note; editable: boolean }) {
  const { data } = useSchemas();
  const schemas = data?.schemas ?? {};
  const reverse = useReverseRelations(note, schemas);
  if (!reverse.data?.length) return null;
  return (
    <>
      {reverse.data.map((r) => (
        <div className="db-prop db-prop-reverse" key={`${r.tag}:${r.key}`} data-kind="relation">
          <span className="db-prop-label" title={`Pages tagged #${r.tag} whose ${r.key} links here`}>{r.label}</span>
          <span className="db-chips" role="list" aria-label={r.label}>
            {r.rows.map((row) => (
              <span key={row.id} role="listitem">
                <button type="button" className="db-link-chip db-link-open" data-kind="relation"
                  onClick={() => useUIStore.getState().openTab(row.id, row.title, "document")}>{row.title}</button>
              </span>
            ))}
            {!r.rows.length && <span className="db-empty">Empty</span>}
            {r.more && <span className="db-pop-path">and more</span>}
          </span>
          {editable && note.path && <ReverseEditor note={note} tag={r.tag} propertyKey={r.key} label={r.label} multiple={schemas[r.tag]?.fields[r.key]?.type === "array"} />}
        </div>
      ))}
    </>
  );
}

/**
 * Editing the reverse side (NP-DB-12): the reverse property is the SAME relation
 * seen from the target, so adding or removing a page here writes that page's
 * forward value — with per-field compare-and-set against the value just shown —
 * and nothing on this page. One stored side means the two can never disagree.
 */
function ReverseEditor({ note, tag, propertyKey, label, multiple }: { note: Note; tag: string; propertyKey: string; label: string; multiple: boolean }) {
  const client = useVaultClient();
  const scope = useScope();
  const write = usePropertyWriter();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const here = note.path!;
  const candidates = useQuery({
    queryKey: ["vault", "notes", { reverseCandidates: scope, tag, propertyKey, q }],
    enabled: open,
    staleTime: 5_000,
    queryFn: async () => {
      const spec: QuerySpec = { tags: [tag], ...(q.trim() ? { search: q.trim() } : {}), sort: [{ key: "$title", dir: "asc" }], limit: 25, fields: ["title", propertyKey] };
      const page = client.queryNotes ? await client.queryNotes(spec) : runQuery(await client.listNotes({ tag, limit: 5000 }), spec, { limited: false });
      return page.rows.filter((r) => r.id !== note.id);
    },
  });
  const links = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
  const pointsHere = (v: unknown) => links(v).some((x) => linkTarget(x) === here);
  const toggle = async (row: QueryRow) => {
    const current = row.metadata[propertyKey] ?? null;
    const on = pointsHere(current);
    let next: unknown;
    if (on) {
      const rest = links(current).filter((x) => linkTarget(x) !== here);
      next = rest.length ? (multiple ? rest : rest[0]) : null;
    } else next = multiple ? [...links(current), asWikilink(here)] : asWikilink(here);
    setBusy(row.id);
    setError("");
    try {
      await write({ id: row.id, updatedAt: row.updatedAt }, { [propertyKey]: next }, { [propertyKey]: current });
    } catch (e) {
      setError(e instanceof PropertyConflictError ? `“${noteTitle(row)}” was changed somewhere else. The list is up to date now; try again.` : "That page could not be changed. You may not be able to edit it.");
    } finally {
      setBusy("");
      void candidates.refetch();
    }
  };
  return (
    <>
      <button ref={anchor} type="button" className="db-ghost focus-ring" aria-haspopup="dialog" aria-expanded={open} aria-label={`Edit ${label}`} onClick={() => setOpen((o) => !o)}><Plus size={13} aria-hidden="true" /> Edit</button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={`Edit ${label}`} width={320}>
        <div className="db-pop-search">
          <Search size={14} aria-hidden="true" />
          <input autoFocus aria-label={`Search #${tag} pages`} placeholder="Search pages…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="db-pop-list" role="listbox" aria-label={`${label} candidates`} aria-multiselectable="true">
          {(candidates.data ?? []).map((row) => {
            const on = pointsHere(row.metadata[propertyKey]);
            const elsewhere = !on && !multiple ? links(row.metadata[propertyKey])[0] : undefined;
            const can = row.canEdit !== false && (!row._caps || row._caps.includes("edit"));
            return (
              <li key={row.id} role="presentation">
                <button type="button" role="option" aria-selected={on} disabled={!can || busy !== ""} title={can ? undefined : "You can’t edit this page."} onClick={() => void toggle(row)}>
                  <span className="db-check" data-checked={on || undefined} aria-hidden="true">{on && <Check size={12} />}</span>
                  <span className="db-pop-title">{noteTitle(row)}</span>
                  {elsewhere && <span className="db-pop-path">now: {linkLabel(elsewhere)}</span>}
                </button>
              </li>
            );
          })}
          {candidates.isLoading && <li className="db-pop-empty">Searching…</li>}
          {!candidates.isLoading && !(candidates.data ?? []).length && <li className="db-pop-empty">No pages</li>}
        </ul>
        {error && <p role="alert" className="db-error">{error}</p>}
      </Popover>
    </>
  );
}
