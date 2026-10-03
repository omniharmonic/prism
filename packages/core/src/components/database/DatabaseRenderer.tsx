/**
 * Database page (content type `database`): saved views over every note carrying
 * the source tag(s). See ./config.ts for the data model and
 * apps/server/src/routes/databases.ts for the query + write routes.
 *
 * Saving: view changes are written to the database note's `prism_database`
 * with `if_updated_at` (a stale config is never overwritten). People who cannot
 * edit the database page can still sort/filter for themselves — those changes
 * stay in this tab and say so.
 *
 * The same page renders EMBEDDED as an inline database block inside another
 * page (`DatabaseBlock` → `<DatabasePage embedded>`): a compact header linking to
 * the database, the chosen view first, and everything else unchanged.
 */
import "./database.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Calendar, ChevronRight, Database, Download, Filter, GalleryVerticalEnd, KanbanSquare, List as ListIcon, MoreHorizontal, Plus, Search, Settings2, SortAsc, Table2, Upload, ArrowUpRight } from "lucide-react";
import type { RendererProps } from "../renderers/RendererProps";
import type { Note } from "../../lib/types";
import { useVaultClient } from "../../data/VaultClientContext";
import { PropertyConflictError } from "../../data/VaultClient";
import { reviewMode } from "../../lib/governance/review";
import { useUIStore } from "../../app/stores/ui";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { inferContentType } from "../../lib/schemas/content-types";
import { queryKeys } from "../../lib/parachute/queries";
import { noteAccess, useDatabaseRows, usePropertyWriter, useSchemas, useScope, useUpdateSchema } from "../../lib/database/hooks";
import { filterConditions, noteTitle, QUERY_MAX_LIMIT, type QueryRow, type QuerySpec } from "../../lib/database/query";
import { deletedKeys, isSystemKey, propertyFromField, resolveProperties, SYSTEM_PROPERTIES, type PropertyDef } from "../../lib/database/schema";
import { PropertyEditor } from "./PropertyEditor";
import { BottomSheet } from "../ui/BottomSheet";
import { Popover } from "./Popover";
import { FilterEditor, SortEditor, ViewSettings } from "./ViewControls";
import { BoardView, CalendarView, GalleryView, ListView, TableView, monthGrid, type RowSelection, type ViewContext } from "./views";
import { defaultConfig, duplicateView, MAX_VIEWS, moveView, newViewId, readDatabaseConfig, rowPath, VIEW_LABELS, VIEW_TYPES, type DatabaseConfig, type DatabaseTemplate, type DatabaseView, type OpenMode, type ViewType } from "./config";
import { RowPeek } from "./RowPeek";
import { BulkBar, UndoToast, type UndoAction } from "./BulkBar";
import { createTemplateNote, isTemplateFor, NewButton, TemplateEditor, templateProps } from "./Templates";
import { allRows, CsvImportDialog, downloadText, rowsToCsv } from "./Csv";

const VIEW_ICONS: Record<ViewType, typeof Table2> = { table: Table2, board: KanbanSquare, gallery: GalleryVerticalEnd, list: ListIcon, calendar: Calendar };
const ROW_META = ["type", "prism_type", "icon", "cover", "coverY"];
/** System property keys that live in metadata (the others are note columns). */
const SYSTEM_META = SYSTEM_PROPERTIES.map((p) => p.key).filter((k) => !k.startsWith("$"));

export default function DatabaseRenderer(props: RendererProps) {
  const scope = useScope();
  // Remount per audience: nothing (drafts, open editors) crosses a vault switch.
  return <DatabasePage key={`${scope}|${props.note.id}`} {...props} />;
}

export function DatabasePage({ note, readOnly, embedded }: RendererProps & {
  /** Inline block inside another page: compact chrome; `viewId` = the view it shows first. */
  embedded?: { viewId?: string };
}) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const access = noteAccess(note);
  const canEditDb = !readOnly && reviewMode(note) === "none" && access.edit;

  let stored: DatabaseConfig | null = null;
  let configError = "";
  try {
    stored = readDatabaseConfig(note.metadata);
  } catch (e) {
    configError = (e as Error).message;
  }
  // Session-only edits for people who cannot save (and the optimistic copy while saving).
  const [local, setLocal] = useState<DatabaseConfig | null>(null);
  const config = local ?? stored;
  const viewKey = embedded ? `prism:db-view:${note.id}:block:${embedded.viewId ?? ""}` : `prism:db-view:${note.id}`;
  const [activeId, setActiveId] = useState<string>(() => {
    if (embedded?.viewId) return embedded.viewId;
    try { return localStorage.getItem(viewKey) ?? ""; } catch { return ""; }
  });
  const view = config?.views.find((v) => v.id === activeId) ?? config?.views[0];
  const [search, setSearch] = useState("");
  // The query follows the box 300 ms after typing stops (review L8).
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [saveState, setSaveState] = useState<"" | "saving" | "error" | "conflict" | "local">("");
  const saveSeq = useRef(0);
  // Config saves are chained: each uses the revision the previous save produced,
  // never the (possibly stale) prop (review L3).
  const revision = useRef<string | null>(note.updatedAt);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSaves = useRef(0);
  useEffect(() => {
    if (!pendingSaves.current) revision.current = note.updatedAt;
  }, [note.updatedAt]);
  // The optimistic copy is dropped only once the note PROP shows the save. Dropping it
  // when the request resolved showed the previous config for the tick before the query
  // cache notified — checkboxes flickered back, and a click in that tick was computed
  // from the stale config (it silently undid the change just saved).
  const propAtSave = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!local || saveState !== "" || pendingSaves.current) return;
    if (note.updatedAt !== propAtSave.current || JSON.stringify(stored) === JSON.stringify(local)) setLocal(null);
  });

  const { data: schemaData } = useSchemas();
  const schemas = schemaData?.schemas ?? {};
  const tags = config?.source.tags ?? [];
  const hasSchema = tags.some((t) => Object.keys(schemas[t]?.fields ?? {}).length > 0);

  const spec: QuerySpec | null = useMemo(() => {
    if (!config || !view) return null;
    const schemaKeys = tags.flatMap((t) => Object.keys(schemas[t]?.fields ?? {}));
    const wanted = new Set<string>([...schemaKeys, ...(view.visible ?? []), ...ROW_META]);
    for (const k of [view.groupBy, view.dateKey, view.coverKey]) if (k && !k.startsWith("$")) wanted.add(k);
    // System properties that live in metadata (created by / last edited by) are
    // fetched when the view shows, filters or sorts by them.
    for (const k of SYSTEM_META) if (view.visible?.includes(k) || filterConditions(view.filter).some((c) => c.key === k) || view.sort?.some((s) => s.key === k)) wanted.add(k);
    const fields = hasSchema ? [...wanted].filter((k) => !k.startsWith("$") && (!isSystemKey(k) || ROW_META.includes(k) || SYSTEM_META.includes(k))).slice(0, 40) : undefined;
    let filter = view.filter;
    if (view.type === "calendar" && view.dateKey && view.dateKey !== "$createdAt" && (!filter || filter.match === "all")) {
      const grid = monthGrid(month);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      // Date-only bounds: the engine compares a datetime by its LOCAL day (tzOffset).
      filter = { match: "all", conditions: [...(filter?.conditions ?? []), { key: view.dateKey, op: "gte", value: iso(grid[0]!) }, { key: view.dateKey, op: "lte", value: iso(grid[41]!) }], ...(filter?.groups ? { groups: filter.groups } : {}) };
    }
    const bulk = view.type === "board" || view.type === "calendar" || view.type === "gallery";
    return {
      tags,
      ...(filter ? { filter } : {}),
      ...(view.sort ? { sort: view.sort } : {}),
      ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
      ...(fields ? { fields } : {}),
      limit: bulk ? QUERY_MAX_LIMIT : 100,
    };
  }, [config, view, schemas, tags, hasSchema, debouncedSearch, month]);

  const rowsQuery = useDatabaseRows(spec);
  const pages = rowsQuery.data?.pages ?? [];
  const rows: QueryRow[] = useMemo(() => pages.flatMap((p) => p.rows), [pages]);
  const total = pages[0]?.total ?? 0;
  const limited = pages[0]?.limited ?? false;
  const truncated = pages[0]?.truncated ?? false;

  // Properties: every schema field of the source tags, then free keys seen in
  // rows, then the system properties (shown only when a view asks for them).
  const allProps: PropertyDef[] = useMemo(() => {
    const base = resolveProperties(tags, schemas, {});
    // A deleted property stays hidden even where rows still hold a value for it.
    const seen = new Set([...base.map((p) => p.key), ...deletedKeys(tags, schemas)]);
    for (const r of rows) for (const [k, v] of Object.entries(r.metadata)) {
      if (seen.has(k) || isSystemKey(k) || v === null || (typeof v === "object" && !Array.isArray(v))) continue;
      seen.add(k);
      base.push(propertyFromField(k, {}, null, v));
    }
    return [...base, ...SYSTEM_PROPERTIES];
  }, [tags, schemas, rows]);
  const shown = useMemo(() => {
    if (!view?.visible) return allProps.filter((p) => !p.system).slice(0, view?.type === "table" ? 12 : 4);
    return view.visible.map((k) => allProps.find((p) => p.key === k)).filter((p): p is PropertyDef => !!p);
  }, [allProps, view]);

  useEffect(() => {
    if (view && !embedded) try { localStorage.setItem(viewKey, view.id); } catch { /* private mode */ }
  }, [view, viewKey, embedded]);

  async function saveConfig(next: DatabaseConfig) {
    setLocal(next);
    if (!canEditDb) {
      setSaveState("local");
      return;
    }
    const seq = ++saveSeq.current;
    setSaveState("saving");
    if (!pendingSaves.current) propAtSave.current = note.updatedAt;
    pendingSaves.current += 1;
    const run = saving.current.catch(() => {}).then(async () => {
      const saved = await client.updateNote(note.id, { metadata: { prism_database: next }, ifUpdatedAt: revision.current ?? undefined });
      revision.current = saved.updatedAt ?? revision.current;
      qc.setQueryData<Note>(queryKeys.vault.note(note.id), (old) => (old ? { ...old, updatedAt: saved.updatedAt ?? old.updatedAt, metadata: { ...(old.metadata ?? {}), prism_database: next } } : old));
    });
    saving.current = run;
    try {
      await run;
      if (seq !== saveSeq.current) return;
      setSaveState(""); // `local` stays until the prop catches up (effect above)
    } catch (e) {
      if (seq !== saveSeq.current) return;
      setSaveState(/\b409\b|conflict|changed/i.test(String((e as Error).message)) ? "conflict" : "error");
    } finally {
      pendingSaves.current -= 1;
    }
  }
  const updateView = (patch: Partial<DatabaseView>) => {
    if (!config || !view) return;
    void saveConfig({ ...config, views: config.views.map((v) => (v.id === view.id ? { ...v, ...patch } : v)) });
  };

  // ── opening rows: side peek / center peek / full page ───────────────────────
  const openPrefKey = `prism:db-open:${note.id}`;
  const [localOpen, setLocalOpen] = useState<OpenMode | null>(() => {
    try { const v = localStorage.getItem(openPrefKey); return v === "side" || v === "center" || v === "page" ? v : null; } catch { return null; }
  });
  const openMode: OpenMode = localOpen ?? config?.openIn ?? "side";
  const [peek, setPeek] = useState<string | null>(null);
  const openFull = (r: Pick<QueryRow, "id" | "path" | "metadata" | "tags" | "createdAt" | "updatedAt">) => useUIStore.getState().openTab(r.id, noteTitle(r), inferContentType({ ...r, content: "" } as Note));
  const setOpenMode = (m: OpenMode) => {
    // The database's own preference when you may edit it; yours otherwise.
    if (canEditDb && config) {
      setLocalOpen(null);
      try { localStorage.removeItem(openPrefKey); } catch { /* private mode */ }
      if (config.openIn !== m) void saveConfig({ ...config, openIn: m });
    } else {
      setLocalOpen(m);
      try { localStorage.setItem(openPrefKey, m); } catch { /* private mode */ }
    }
  };

  // ── selection + bulk actions (table) ────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorId = useRef<string | null>(null);
  const [toast, setToast] = useState<{ message: string; undo: UndoAction | null } | null>(null);
  useEffect(() => { setSelected(new Set()); }, [view?.id, debouncedSearch]);
  const selection: RowSelection = {
    ids: selected,
    toggle: (id, shift, ordered) => {
      // Read the anchor NOW: the state updater runs later (and twice in StrictMode).
      const a = anchorId.current;
      anchorId.current = id;
      setSelected((cur) => {
        const next = new Set(cur);
        if (shift && a && ordered.includes(a) && ordered.includes(id)) {
          const [i, j] = [ordered.indexOf(a), ordered.indexOf(id)].sort((x, y) => x - y);
          for (const k of ordered.slice(i!, j! + 1)) next.add(k);
        } else if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    setAll: (ids, on) => setSelected((cur) => {
      const next = new Set(cur);
      for (const id of ids) if (on) next.add(id); else next.delete(id);
      return next;
    }),
  };
  const selectedRows = rows.filter((r) => selected.has(r.id));

  const write = usePropertyWriter();
  const schemaEdit = useUpdateSchema();
  const ownerish = schemaEdit.available && !!schemaData?.live && !!schemaData?.canEdit;
  const canCreate = !readOnly && access.create && access.edit;
  const canEditRow = (r: QueryRow) => !readOnly && (typeof r.canEdit === "boolean" ? r.canEdit : r._caps ? r._caps.includes("edit") : true);

  // ── creating rows (with page templates) ─────────────────────────────────────
  const invalidateRows = () => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "vault" && q.queryKey[1] === "notes" && typeof q.queryKey[2] !== "string" });
    void qc.invalidateQueries({ queryKey: ["vault", "tree"] });
  };
  const createRow = async (titleText: string, preset?: Record<string, unknown>, templateId?: string | null) => {
    const defaults: Record<string, unknown> = {};
    for (const t of tags) for (const [k, f] of Object.entries(schemas[t]?.fields ?? {})) if (f.default !== undefined && defaults[k] === undefined) defaults[k] = f.default;
    let content = "";
    let fromTemplate: Record<string, unknown> = {};
    const tid = templateId === undefined ? config?.defaultTemplate : templateId;
    let privateTo: string | null = null;
    if (tid && config?.templates?.some((t) => t.id === tid)) {
      // Read as the CURRENT user (the gateway enforces view), and only from a
      // real template of THIS database (review M3).
      const tpl = await client.getNote(tid, { fresh: true });
      if (!isTemplateFor(tpl, note)) throw new Error("That template is not part of this database, so nothing was copied from it.");
      content = tpl.content ?? "";
      fromTemplate = templateProps(tpl);
      // A private template's body stays private: the new row is private too.
      if (tpl.metadata?.prism_visibility === "private") privateTo = typeof tpl.metadata.prism_creator === "string" ? tpl.metadata.prism_creator : "";
    }
    const created = await client.createNote({ content, path: rowPath(note.path, titleText), tags: [...tags], metadata: { ...defaults, ...fromTemplate, ...(preset ?? {}), title: titleText, ...(privateTo !== null ? { prism_visibility: "private", ...(privateTo ? { prism_creator: privateTo } : {}) } : {}) } });
    invalidateRows();
    return created;
  };
  const [editingTemplate, setEditingTemplate] = useState<DatabaseTemplate | null>(null);
  // Property management (owner): the property being edited, by tag + key.
  const [editingProp, setEditingProp] = useState<{ tag: string; key: string } | null>(null);
  const deletedProps: PropertyDef[] = useMemo(() => {
    const out: PropertyDef[] = [];
    for (const t of tags) for (const [k, f] of Object.entries(schemas[t]?.fields ?? {})) if (f.deleted && !out.some((p) => p.key === k)) out.push(propertyFromField(k, f, t));
    return out;
  }, [tags, schemas]);
  const [importing, setImporting] = useState(false);

  const ctx: ViewContext | null = view ? {
    view,
    rows,
    props: allProps,
    shown,
    // The server's per-row answer wins; then the caps annotation (review L5).
    canEditRow,
    canCreate,
    commit: (r, def) => async (next, base) => {
      try {
        await write({ id: r.id, updatedAt: r.updatedAt }, { [def.key]: next }, { [def.key]: base ?? null });
      } catch (e) {
        // Changed elsewhere: show what is stored now (the editor keeps the person's own value to retry).
        if (e instanceof PropertyConflictError) invalidateRows();
        throw e;
      }
    },
    createOption: (def) => (ownerish && def.tag && def.kind !== "multi_select"
      ? async (o: string) => { await schemaEdit.update(def.tag!, { fields: { [def.key]: { enum: [...def.enumValues, o] } } }); }
      : undefined),
    open: (r, e) => {
      // ⌘/Ctrl-click, phones and the "Full page" preference open the page itself.
      if (e?.metaKey || e?.ctrlKey || isMobile || openMode === "page") openFull(r);
      else setPeek(r.id);
    },
    create: async (titleText, preset) => { await createRow(titleText, preset); },
    updateView,
    ...(ownerish && !readOnly ? { editProperty: (def: PropertyDef) => { if (def.tag) setEditingProp({ tag: def.tag, key: def.key }); } } : {}),
    // Selection only for people who can act on something (Notion viewers can't select).
    ...(view.type === "table" && !readOnly && (canCreate || rows.some(canEditRow)) ? { selection } : {}),
  } : null;

  // ⌘A selects every loaded row of a table view (unless typing somewhere).
  const onBodyKey = useCallback((e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const typing = t.closest("input, textarea, select, [contenteditable='true']") && !(t instanceof HTMLInputElement && t.type === "checkbox");
    if (typing || view?.type !== "table" || readOnly || !(canCreate || rows.some(canEditRow))) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(rows.map((r) => r.id)));
    } else if (e.key === "Escape" && selected.size && !peek) {
      e.preventDefault();
      setSelected(new Set());
    }
  }, [view?.type, readOnly, rows, selected.size, peek]);

  const title = noteTitle({ id: note.id, path: note.path, metadata: note.metadata });
  const description = note.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const crumbs = (note.path ?? "").replace(/^vault\//, "").split("/").slice(0, -1);

  const exportCsv = async () => {
    if (!spec || !view) return;
    try {
      const all = await allRows(client, { ...spec, cursor: null });
      downloadText(`${title} - ${view.name}.csv`.replace(/[\\/:*?"<>|]/g, "-"), rowsToCsv(all, shown));
      setToast({ message: `Exported ${all.length} ${all.length === 1 ? "row" : "rows"} to CSV.`, undo: null });
    } catch {
      setToast({ message: "The export could not be prepared. Try again.", undo: null });
    }
  };

  const content = (
    <>
      {embedded ? (
        <header className="db-block-head">
          <button type="button" className="db-block-title focus-ring" onClick={() => openFull({ id: note.id, path: note.path, metadata: { ...(note.metadata ?? {}), prism_type: "database" }, tags: note.tags ?? [], createdAt: note.createdAt, updatedAt: note.updatedAt })}>
            <span aria-hidden="true">{typeof note.metadata?.icon === "string" ? note.metadata.icon : <Database size={15} />}</span>
            {title}
            <ArrowUpRight size={13} aria-hidden="true" className="db-muted-icon" />
          </button>
        </header>
      ) : (
        <header className="db-head">
          {crumbs.length > 0 && <nav className="db-crumbs" aria-label="Database location">{crumbs.map((c, i) => <span key={i}>{i > 0 && <ChevronRight size={12} aria-hidden="true" />} {c}</span>)}</nav>}
          <div className="db-title-row">
            <span className="db-title-icon" aria-hidden="true">{typeof note.metadata?.icon === "string" ? note.metadata.icon : <Database size={18} />}</span>
            <h1 className="db-title">{title}</h1>
          </div>
          {description && <p className="db-desc">{description.slice(0, 400)}</p>}
          {config && <p className="db-source">Pages tagged {config.source.tags.map((t) => <code key={t}>#{t}</code>)}</p>}
        </header>
      )}
      <div className="db-body" onKeyDown={onBodyKey}>
        {configError ? (
          <div className="db-state" role="alert"><h2>This database can’t be shown</h2><p>{configError}</p></div>
        ) : !config ? (
          <SetupDatabase canEdit={canEditDb} onPick={(tag) => saveConfig(defaultConfig(tag))} />
        ) : view && ctx ? (
          <>
            <Toolbar
              config={config}
              view={view}
              props={allProps}
              search={search}
              onSearch={setSearch}
              isMobile={isMobile}
              canEditDb={canEditDb}
              canCreate={canCreate}
              canImport={ownerish && !!client.importCsv}
              onSelect={(id) => setActiveId(id)}
              onUpdate={updateView}
              onAddView={(type) => {
                const v: DatabaseView = { id: newViewId(), name: VIEW_LABELS[type], type, ...(type === "board" ? { groupBy: allProps.find((p) => p.kind === "status")?.key ?? allProps.find((p) => p.kind === "select")?.key } : {}), ...(type === "calendar" ? { dateKey: allProps.find((p) => p.kind === "date" && !p.system)?.key } : {}) };
                void saveConfig({ ...config, views: [...config.views, v] });
                setActiveId(v.id);
              }}
              onDeleteView={() => {
                if (config.views.length < 2) return;
                void saveConfig({ ...config, views: config.views.filter((v) => v.id !== view.id) });
                setActiveId(config.views.find((v) => v.id !== view.id)!.id);
              }}
              onDuplicateView={() => {
                const next = duplicateView(config, view.id);
                if (!next) return;
                void saveConfig(next.config);
                setActiveId(next.id);
              }}
              onMoveView={(id, to) => { const next = moveView(config, id, to); if (next) void saveConfig(next); }}
              onNew={(templateId) => void createRow("Untitled", undefined, templateId).then((n) => { if (!isMobile && openMode !== "page") setPeek(n.id); }).catch((e: unknown) => setToast({ message: e instanceof Error && /template/i.test(e.message) ? e.message : "The page could not be created. Try again.", undo: null }))}
              onCreateTemplate={async (name) => {
                const t = await createTemplateNote(client, note, name);
                await saveConfig({ ...config, templates: [...(config.templates ?? []), t] });
                setEditingTemplate(t);
              }}
              onEditTemplate={setEditingTemplate}
              onSetDefaultTemplate={(id) => void saveConfig({ ...config, defaultTemplate: id })}
              onRemoveTemplate={(t) => {
                const { defaultTemplate, ...rest } = config;
                void saveConfig({ ...rest, templates: (config.templates ?? []).filter((x) => x.id !== t.id), ...(defaultTemplate && defaultTemplate !== t.id ? { defaultTemplate } : {}) });
                if (client.trashPage) void client.trashPage(t.id).catch(() => {});
              }}
              onExport={() => void exportCsv()}
              onImport={() => setImporting(true)}
              deleted={ownerish && !readOnly ? { props: deletedProps, onOpen: (def) => { if (def.tag) setEditingProp({ tag: def.tag, key: def.key }); } } : undefined}
            />
            {saveState === "local" && <p className="db-notice" role="status">You can’t edit this database, so view changes stay in this tab.</p>}
            {saveState === "conflict" && <p className="db-notice" role="alert">This database was changed somewhere else, so your view change wasn’t saved. <button type="button" className="db-ghost" onClick={() => { setLocal(null); setSaveState(""); void qc.invalidateQueries({ queryKey: queryKeys.vault.note(note.id) }); }}>Reload views</button></p>}
            {saveState === "error" && <p className="db-notice" role="alert">The view change could not be saved. <button type="button" className="db-ghost" onClick={() => local && void saveConfig(local)}>Retry</button></p>}
            {selectedRows.length > 0 && (
              <BulkBar rows={selectedRows} props={allProps} dbPath={note.path} canEditRow={canEditRow} canCreate={canCreate}
                onClear={() => setSelected(new Set())}
                onDone={(message, undo) => setToast({ message, undo })} />
            )}
            {rowsQuery.isLoading ? (
              <div className="db-state" role="status">Loading pages…</div>
            ) : rowsQuery.isError ? (
              <div className="db-state" role="alert"><h2>Pages could not be loaded</h2><p>Check your connection and try again.</p><button type="button" className="db-control" onClick={() => void rowsQuery.refetch()}>Retry</button></div>
            ) : !rows.length && view.type !== "calendar" && view.type !== "board" ? (
              <EmptyRows ctx={ctx} filtered={!!(view.filter || search.trim())} tag={config.source.tags[0]!} />
            ) : (
              <>
                {view.type === "table" && <TableView ctx={ctx} />}
                {view.type === "board" && <BoardView ctx={ctx} onPickGroup={(k) => updateView({ groupBy: k })} />}
                {view.type === "gallery" && <GalleryView ctx={ctx} />}
                {view.type === "list" && <ListView ctx={ctx} />}
                {view.type === "calendar" && <CalendarView ctx={ctx} month={month} onMonth={setMonth} onPickDate={(k) => updateView({ dateKey: k })} />}
              </>
            )}
            <p className="db-count" role="status">
              {rows.length < total ? `Showing ${rows.length} of ${total}` : `${total} ${total === 1 ? "page" : "pages"}`}
              {limited && " · only pages you can see"}
              {truncated && " · this tag is very large; results cover the first 20,000 pages"}
              {rowsQuery.hasNextPage && <> · <button type="button" className="db-ghost" disabled={rowsQuery.isFetchingNextPage} onClick={() => void rowsQuery.fetchNextPage()}>{rowsQuery.isFetchingNextPage ? "Loading…" : "Load more"}</button></>}
            </p>
            {toast && <UndoToast message={toast.message} undo={toast.undo} onUndone={(m) => setToast({ message: m, undo: null })} onDismiss={() => setToast(null)} />}
          </>
        ) : null}
      </div>
      {peek && (
        <RowPeek noteId={peek} mode={openMode === "center" ? "center" : "side"} canSetMode={canEditDb}
          onMode={(m) => { setOpenMode(m); if (m === "page") setPeek(null); }}
          onClose={() => { setPeek(null); invalidateRows(); }} />
      )}
      {editingTemplate && config && (
        <TemplateEditor template={editingTemplate} db={note} props={allProps}
          onRename={(name) => void saveConfig({ ...config, templates: (config.templates ?? []).map((t) => (t.id === editingTemplate.id ? { ...t, name } : t)) })}
          onOpenBody={() => { const id = editingTemplate.id; setEditingTemplate(null); setPeek(id); }}
          onClose={() => setEditingTemplate(null)} />
      )}
      {editingProp && schemas[editingProp.tag]?.fields[editingProp.key] && (
        <PropertyEditor propertyKey={editingProp.key} tag={editingProp.tag} field={schemas[editingProp.tag]!.fields[editingProp.key]!} rows={rows} onClose={() => setEditingProp(null)} />
      )}
      {importing && config && <CsvImportDialog tag={config.source.tags[0]!} dbPath={note.path} props={allProps} onClose={() => setImporting(false)} />}
    </>
  );

  if (embedded) return <div className="db-page db-embedded" data-database-block={note.id}>{content}</div>;
  return (
    <div className="db-page">
      <div className="db-scroll">{content}</div>
    </div>
  );
}

function EmptyRows({ ctx, filtered, tag }: { ctx: ViewContext; filtered: boolean; tag: string }) {
  return (
    <div className="db-state">
      <h2>{filtered ? "No pages match this view" : "No pages yet"}</h2>
      <p>{filtered ? "Try clearing the search or a filter." : `Pages tagged #${tag} appear here.`}</p>
      {!filtered && ctx.canCreate && <button type="button" className="db-primary" onClick={() => void ctx.create("Untitled").catch(() => {})}><Plus size={14} aria-hidden="true" /> New page</button>}
    </div>
  );
}

function SetupDatabase({ canEdit, onPick }: { canEdit: boolean; onPick: (tag: string) => void }) {
  const client = useVaultClient();
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [value, setValue] = useState("");
  useEffect(() => { void client.getTags().then(setTags).catch(() => setTags([])); }, [client]);
  if (!canEdit) return <div className="db-state"><h2>This database has no source yet</h2><p>Someone who can edit it needs to choose which pages it shows.</p></div>;
  return (
    <form className="db-state" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onPick(value.trim()); }}>
      <h2>Which pages should this database show?</h2>
      <p>Every page carrying the tag becomes a row. Nothing is copied.</p>
      <input list="db-setup-tags" className="db-control" aria-label="Source tag" placeholder="Tag, e.g. task" value={value} onChange={(e) => setValue(e.target.value)} />
      <datalist id="db-setup-tags">{tags.map((t) => <option key={t.tag} value={t.tag}>{t.count}</option>)}</datalist>
      <button type="submit" className="db-primary" disabled={!value.trim()}>Create database</button>
    </form>
  );
}

function Toolbar({ config, view, props, search, onSearch, isMobile, canEditDb, canCreate, canImport, onSelect, onUpdate, onAddView, onDeleteView, onDuplicateView, onMoveView, onNew, onCreateTemplate, onEditTemplate, onSetDefaultTemplate, onRemoveTemplate, onExport, onImport, deleted }: {
  config: DatabaseConfig; view: DatabaseView; props: PropertyDef[]; search: string; onSearch: (s: string) => void; isMobile: boolean;
  canEditDb: boolean; canCreate: boolean; canImport: boolean; onSelect: (id: string) => void; onUpdate: (p: Partial<DatabaseView>) => void;
  onAddView: (t: ViewType) => void; onDeleteView: () => void; onDuplicateView: () => void; onMoveView: (id: string, to: number) => void; onNew: (templateId: string | null) => void;
  onCreateTemplate: (name: string) => Promise<void>; onEditTemplate: (t: DatabaseTemplate) => void; onSetDefaultTemplate: (id: string | undefined) => void; onRemoveTemplate: (t: DatabaseTemplate) => void;
  onExport: () => void; onImport: () => void;
  deleted?: { props: PropertyDef[]; onOpen: (def: PropertyDef) => void };
}) {
  const filterBtn = useRef<HTMLButtonElement>(null);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const settingsBtn = useRef<HTMLButtonElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<"" | "filter" | "sort" | "settings" | "add" | "more">("");
  const close = () => setPanel("");
  // Tabs reorder by drag (people who can save) as well as from View settings.
  const dragId = useRef<string | null>(null);
  const filterCount = filterConditions(view.filter).length;
  const body = panel === "filter" ? <FilterEditor filter={view.filter} props={props} onChange={(f) => onUpdate({ filter: f })} />
    : panel === "sort" ? <SortEditor sort={view.sort} props={props} onChange={(s) => onUpdate({ sort: s })} />
    : panel === "settings" ? <ViewSettings key={view.id} view={view} props={props} canDelete={canEditDb && config.views.length > 1} onChange={onUpdate} onDelete={() => { close(); onDeleteView(); }}
        tabs={{ index: config.views.findIndex((v) => v.id === view.id), count: config.views.length, canDuplicate: config.views.length < MAX_VIEWS, onDuplicate: onDuplicateView, onMove: (to) => onMoveView(view.id, to) }}
        deleted={deleted ? { props: deleted.props, onOpen: (def) => { close(); deleted.onOpen(def); } } : undefined} />
    : null;
  const titles = { filter: "Filter", sort: "Sort", settings: "View settings", add: "Add a view", more: "More", "": "" } as const;
  return (
    <div className="db-toolbar">
      <div className="db-tabs" role="tablist" aria-label="Views">
        {config.views.map((v) => {
          const Icon = VIEW_ICONS[v.type];
          return (
            <button key={v.id} type="button" role="tab" className="db-tab focus-ring" aria-selected={v.id === view.id} onClick={() => onSelect(v.id)}
              draggable={canEditDb && config.views.length > 1}
              onDragStart={(e) => { dragId.current = v.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", v.name); }}
              onDragOver={(e) => { if (dragId.current && dragId.current !== v.id) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
              onDrop={(e) => { e.preventDefault(); const id = dragId.current; dragId.current = null; if (id && id !== v.id) onMoveView(id, config.views.findIndex((x) => x.id === v.id)); }}
              onDragEnd={() => { dragId.current = null; }}>
              <Icon size={14} aria-hidden="true" /> {v.name}
            </button>
          );
        })}
        {canEditDb && (
          <button ref={addBtn} type="button" className="db-tab focus-ring" aria-label="Add a view" aria-haspopup="menu" aria-expanded={panel === "add"} onClick={() => setPanel(panel === "add" ? "" : "add")}><Plus size={14} aria-hidden="true" /></button>
        )}
      </div>
      <div className="db-actions">
        <label className="db-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search this database" placeholder="Search" value={search} onChange={(e) => onSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && search) { e.preventDefault(); onSearch(""); } }} /></label>
        <button ref={filterBtn} type="button" className="db-control focus-ring" data-active={filterCount || undefined} aria-haspopup="dialog" aria-expanded={panel === "filter"} onClick={() => setPanel(panel === "filter" ? "" : "filter")}>
          <Filter size={14} aria-hidden="true" /> Filter{filterCount ? ` · ${filterCount}` : ""}
        </button>
        <button ref={sortBtn} type="button" className="db-control focus-ring" data-active={view.sort?.length || undefined} aria-haspopup="dialog" aria-expanded={panel === "sort"} onClick={() => setPanel(panel === "sort" ? "" : "sort")}>
          <SortAsc size={14} aria-hidden="true" /> Sort
        </button>
        <button ref={settingsBtn} type="button" className="db-control focus-ring" aria-label="View settings" aria-haspopup="dialog" aria-expanded={panel === "settings"} onClick={() => setPanel(panel === "settings" ? "" : "settings")}>
          <Settings2 size={14} aria-hidden="true" />{!isMobile && " View settings"}
        </button>
        <button ref={moreBtn} type="button" className="db-control focus-ring" aria-label="More database actions" aria-haspopup="menu" aria-expanded={panel === "more"} onClick={() => setPanel(panel === "more" ? "" : "more")}>
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
        {canCreate && (
          <NewButton config={config} canManage={canEditDb} onNew={onNew} onCreateTemplate={onCreateTemplate} onEdit={onEditTemplate} onSetDefault={onSetDefaultTemplate} onRemove={onRemoveTemplate} />
        )}
      </div>
      <Popover anchor={addBtn} open={panel === "add"} onClose={close} label="Add a view" width={220}>
        <div className="db-menu" role="menu">
          {VIEW_TYPES.map((t) => {
            const Icon = VIEW_ICONS[t];
            return <button key={t} type="button" role="menuitem" onClick={() => { close(); onAddView(t); }}><Icon size={14} aria-hidden="true" /> {VIEW_LABELS[t]}</button>;
          })}
        </div>
      </Popover>
      <Popover anchor={moreBtn} open={panel === "more"} onClose={close} label="More database actions" width={240}>
        <div className="db-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { close(); onExport(); }}><Download size={14} aria-hidden="true" /> Export this view as CSV</button>
          {canImport && <button type="button" role="menuitem" onClick={() => { close(); onImport(); }}><Upload size={14} aria-hidden="true" /> Import CSV…</button>}
        </div>
      </Popover>
      {isMobile ? (
        <BottomSheet open={!!body} onClose={close} title={titles[panel]}>{body}</BottomSheet>
      ) : (
        <>
          <Popover anchor={filterBtn} open={panel === "filter"} onClose={close} label="Filter" width={560}>{panel === "filter" && body}</Popover>
          <Popover anchor={sortBtn} open={panel === "sort"} onClose={close} label="Sort" width={380}>{panel === "sort" && body}</Popover>
          <Popover anchor={settingsBtn} open={panel === "settings"} onClose={close} label="View settings" width={320}>{panel === "settings" && body}</Popover>
        </>
      )}
    </div>
  );
}
