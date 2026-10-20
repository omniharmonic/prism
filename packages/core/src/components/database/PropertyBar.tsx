/**
 * Properties under the page title (mockup 12) and the same fields in the side
 * panel. Schema-driven: every tag on the page contributes its vault-typed fields,
 * so a `task` page shows Status/Priority/Due as a select/select/date, not free
 * text. Empty properties hide behind "+ Add property" — unless a tag PINS properties
 * (its `pinned` hint, "Customize…" for owners): then the bar shows exactly those, in
 * that order, empty ones included, and the rest behind "N more properties". Values save on commit
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
  isSystemKey,
  pinnedKeys,
  splitPinned,
  keyFromLabel,
  PROPERTY_KIND_LABELS,
  resolveProperties,
  type PropertyDef,
  type PropertyKind,
  type SchemaPatch,
} from "../../lib/database/schema";
import { NewPropertyForm } from "./NewPropertyForm";
import { noteTitle, runQuery, type QueryRow, type QuerySpec } from "../../lib/database/query";
import { asWikilink, linkLabel, linkTarget } from "../../lib/database/schema";
import { PropertyConflictError } from "../../data/VaultClient";
import { useUIStore } from "../../app/stores/ui";
import { queryKeys } from "../../lib/parachute/queries";
import { PropertyValue } from "./PropertyValue";
import { REVEAL_PROPERTY_EVENT } from "../../lib/notifications/anchor";
import { PropertyEditor } from "./PropertyEditor";
import { propertyFromField } from "../../lib/database/schema";
import { Popover } from "./Popover";
import { PropertyDisplay } from "./PropertyDisplay";
import { usePropertyPresentation } from "./propertyPresentation";
import { CustomizeProperties } from "./PinnedProperties";
import "./database.css";

import { formatDateTime as fmtDateTime } from "../../lib/datetime/format";

export function PropertyBar({ note, readOnly, onOpenAll, layout = "bar", trailing, detailsContent, schemaOnly = false, showTags = true }: {
  note: Note;
  /** Only schema-declared fields (the side panel lists free keys itself). */
  schemaOnly?: boolean;
  showTags?: boolean;
  readOnly?: boolean;
  /** Replaces the built-in Updated + "All properties" items (e.g. the page's details disclosure). */
  trailing?: ReactNode;
  /** Read-only details placed inside the single Properties disclosure. */
  detailsContent?: ReactNode;
  /** Opens the full properties panel (the page's side panel). */
  onOpenAll?: () => void;
  layout?: "bar" | "panel";
}) {
  const { data } = useSchemas();
  const scope = useScope();
  const presentation = usePropertyPresentation(scope, note.id);
  const write = usePropertyWriter();
  const schemaEdit = useUpdateSchema();
  const access = noteAccess(note);
  const editable = !readOnly && reviewMode(note) === "none" && access.edit;
  const canOrganize = !readOnly && reviewMode(note) === "none" && access.organize;
  // The server says who may change schemas (owner role); never guess from `_caps`.
  const canEditSchema = editable && schemaEdit.available && !!data?.live && !!data?.canEdit;
  const tags = note.tags ?? [];
  const schemas = data?.schemas ?? {};
  const resolved = useMemo(() => resolveProperties(tags, schemas, note.metadata), [tags, schemas, note.metadata]);
  const props = useMemo(() => {
    // A page's tags are the note's own `tags`, edited in the Tags row below. An imported page often
    // keeps its frontmatter `tags:` list in metadata too; listed as a free property it was a second "Tags".
    const all = showTags ? resolved.filter((p) => !isShadowTagsKey(p)) : resolved;
    return schemaOnly ? all.filter((p) => p.tag !== null) : all;
  }, [resolved, schemaOnly, showTags]);
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

  // Pinned layout (the page's tags choose what sits at the top). The side panel lists everything.
  const { top, rest } = useMemo(
    () => splitPinned(props, layout === "bar" ? pinnedKeys(tags, schemas) : []),
    [props, layout, tags, schemas],
  );
  const personal = layout === "bar" ? presentation.value : null;
  const kept = personal?.visible ? personal.visible.flatMap(key => props.filter(p => p.key === key)) : top;
  const remaining = personal?.visible ? props.filter(p => !personal.visible!.includes(p.key)) : personal && !top.length ? props : rest;
  const pinMode = personal !== null || top.length > 0;
  const [moreOpen, setMoreOpen] = useState(false);
  const expanded = personal ? !personal.collapsed : pinMode ? moreOpen : true;
  const toggleExpanded = () => {
    if (layout === "bar" && presentation.available) presentation.save({ visible: personal?.visible ?? null, collapsed: expanded });
    else setMoreOpen(v => !v);
  };
  const visible = (p: PropertyDef) => showEmpty || !isBlank(meta[p.key]) || revealed.includes(p.key);
  const more = pinMode ? remaining.filter(visible) : [];
  const shown = pinMode ? [...kept, ...(expanded ? more : [])] : props.filter(visible);
  const hiddenEmpty = (pinMode ? remaining : props).filter((p) => isBlank(meta[p.key]) && !revealed.includes(p.key));
  // "Customize…": the server says who may change a tag's presentation (owner role).
  const customTags = useMemo(
    () => tags.filter((t) => Object.entries(schemas[t]?.fields ?? {}).some(([k, f]) => !f.deleted && !isSystemKey(k))),
    [tags, schemas],
  );
  const canCustomize = !readOnly && layout === "bar" && schemaEdit.available && !!data?.live && !!data?.canEdit && customTags.length > 0;

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
    setMoreOpen(true); // a property brought out is never left folded away
    if (personal) presentation.save({ ...personal, collapsed: false });
  };
  // An "assigned you" notification lands on its property: bring it out if it is folded away.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ noteId?: string; key?: string }>).detail;
      if (d?.noteId === note.id && typeof d.key === "string") { setRevealed((r) => (r.includes(d.key!) ? r : [...r, d.key!])); setMoreOpen(true); if (personal) presentation.save({ ...personal, collapsed: false }); }
    };
    window.addEventListener(REVEAL_PROPERTY_EVENT, h);
    return () => window.removeEventListener(REVEAL_PROPERTY_EVENT, h);
  }, [note.id, personal, scope]);

  return (
    <div className={`db-props db-props-${layout}`} role="group" aria-label="Page properties" data-pinned={pinMode || undefined}>
      {shown.map((def) => (
        <div className="db-prop" key={def.key} data-kind={def.kind} data-property-key={def.key} data-pinned-property={kept.includes(def) || undefined}>
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
      {(editable || canCustomize || detailsContent || (layout === "bar" && presentation.available && props.length > 0) || (onOpenAll && !trailing)) && (
        <div className="db-prop-actions db-property-toolbar">
          {(more.length > 0 || (!pinMode && layout === "bar" && presentation.available && props.length > 0)) && <button type="button" className="db-ghost focus-ring db-property-expand" aria-expanded={expanded} onClick={toggleExpanded}>
            <ChevronRight size={13} aria-hidden="true" className="db-more-chevron" /> {expanded ? (kept.length ? "Hide extra fields" : "Hide fields") : more.length ? `Show ${more.length} more ${more.length === 1 ? "field" : "fields"}` : "Show all fields"}
          </button>}
          <details className="db-properties-menu" open={layout === "panel" || undefined} onKeyDown={event => { if (layout === "bar" && event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
            <summary className="db-ghost focus-ring">Property options <ChevronRight size={13} aria-hidden="true" /></summary>
            <div className="db-properties-menu-content">
              {layout === "bar" && presentation.available && props.length > 0 && <PropertyDisplay properties={props} visible={personal?.visible ?? (pinMode ? top : props.filter(visible)).map(p => p.key)} onChange={keys => presentation.save({ visible: keys, collapsed: personal?.collapsed ?? true })} onReset={() => presentation.save(null)} />}
              {editable && (
                <AddProperty
                  empty={editable ? hiddenEmpty : []}
                  canCreate={editable}
                  canEditSchema={canEditSchema}
                  firstTag={tags[0] ?? null}
                  existing={[...props.map((p) => p.key), ...resolved.filter(isShadowTagsKey).map((p) => p.key)]}
                  showEmpty={showEmpty}
                  deleted={canEditSchema ? deletedProps : []}
                  onManageDeleted={(p) => { if (p.tag) setEditingProp({ tag: p.tag, key: p.key }); }}
                  hiddenCount={hiddenEmpty.length}
                  onToggleEmpty={() => setShowEmpty((v) => !v)}
                  onReveal={reveal}
                  knownTags={Object.keys(schemas)}
                  onCreateSchema={async (tag, key, patch) => {
                    await schemaEdit.update(tag, patch);
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
              {canCustomize && (
                <CustomizeProperties tags={customTags} schemas={schemas} onSave={(tag, pinned) => schemaEdit.update(tag, { pinned })} />
              )}
              {onOpenAll && layout === "bar" && !trailing && (
                <button type="button" className="db-ghost focus-ring" onClick={onOpenAll}>Open property panel <ChevronRight size={13} aria-hidden="true" /></button>
              )}
              {detailsContent}
              {layout === "bar" && !detailsContent && !trailing && note.updatedAt && !Number.isNaN(Date.parse(note.updatedAt)) && <p className="db-property-updated-detail">Updated <time dateTime={note.updatedAt}>{fmtDateTime(new Date(note.updatedAt))}</time></p>}
            </div>
          </details>
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

/** A free `tags` metadata key (no schema declares it): the note's real tags already have their own row. */
const isShadowTagsKey = (p: PropertyDef): boolean => p.tag === null && p.key.toLowerCase() === "tags";

type FreeDraft = { key: string; label: string; kind: PropertyKind } | null;

function AddProperty({ empty, canCreate, canEditSchema, firstTag, existing, knownTags, showEmpty, hiddenCount, onToggleEmpty, onReveal, onCreateSchema, onCreateFree, deleted, onManageDeleted }: {
  deleted: PropertyDef[]; onManageDeleted: (p: PropertyDef) => void;
  empty: PropertyDef[]; canCreate: boolean; canEditSchema: boolean; firstTag: string | null; existing: string[]; knownTags: string[];
  showEmpty: boolean; hiddenCount: number; onToggleEmpty: () => void; onReveal: (key: string) => void;
  onCreateSchema: (tag: string, key: string, patch: SchemaPatch) => Promise<void>;
  onCreateFree: (label: string, kind: PropertyKind) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const schemaBacked = canEditSchema && !!firstTag;
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
          <NewPropertyForm
            tags={firstTag ? [firstTag] : []}
            schemaBacked={schemaBacked}
            knownTags={knownTags}
            existing={existing}
            freeNote={firstTag ? `Only the workspace owner can add a property to every “${firstTag}” page, so this one is added to this page only.` : undefined}
            onCreateSchema={onCreateSchema}
            onCreateFree={onCreateFree}
            onDone={() => setOpen(false)}
          />
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
