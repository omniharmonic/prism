/**
 * Database page (content type `database`): saved views over every note carrying
 * the source tag(s). See ./config.ts for the data model and
 * apps/server/src/routes/databases.ts for the query + write routes.
 *
 * Saving: view changes are written to the database note's `prism_database`
 * with `if_updated_at` (a stale config is never overwritten). People who cannot
 * edit the database page can still sort/filter for themselves — those changes
 * stay in this tab and say so.
 */
import "./database.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Calendar, ChevronRight, Database, Filter, GalleryVerticalEnd, KanbanSquare, List as ListIcon, Plus, Search, Settings2, SortAsc, Table2 } from "lucide-react";
import type { RendererProps } from "../renderers/RendererProps";
import type { Note } from "../../lib/types";
import { useVaultClient } from "../../data/VaultClientContext";
import { noteCaps, reviewMode } from "../../lib/governance/review";
import { useUIStore } from "../../app/stores/ui";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { inferContentType } from "../../lib/schemas/content-types";
import { queryKeys } from "../../lib/parachute/queries";
import { useDatabaseRows, usePropertyWriter, useSchemas, useScope, useUpdateSchema } from "../../lib/database/hooks";
import { noteTitle, QUERY_MAX_LIMIT, type QueryRow, type QuerySpec } from "../../lib/database/query";
import { isSystemKey, propertyFromField, resolveProperties, type PropertyDef } from "../../lib/database/schema";
import { BottomSheet } from "../ui/BottomSheet";
import { Popover } from "./Popover";
import { FilterEditor, SortEditor, ViewSettings } from "./ViewControls";
import { BoardView, CalendarView, GalleryView, ListView, TableView, monthGrid, type ViewContext } from "./views";
import { defaultConfig, newViewId, readDatabaseConfig, rowPath, VIEW_LABELS, VIEW_TYPES, type DatabaseConfig, type DatabaseView, type ViewType } from "./config";

const VIEW_ICONS: Record<ViewType, typeof Table2> = { table: Table2, board: KanbanSquare, gallery: GalleryVerticalEnd, list: ListIcon, calendar: Calendar };
const ROW_META = ["type", "prism_type", "icon", "cover"];

export default function DatabaseRenderer(props: RendererProps) {
  const scope = useScope();
  // Remount per audience: nothing (drafts, open editors) crosses a vault switch.
  return <DatabasePage key={`${scope}|${props.note.id}`} {...props} />;
}

function DatabasePage({ note, readOnly }: RendererProps) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const caps = noteCaps(note);
  const canEditDb = !readOnly && reviewMode(note) === "none" && (caps?.has("edit") ?? true);

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
  const viewKey = `prism:db-view:${note.id}`;
  const [activeId, setActiveId] = useState<string>(() => {
    try { return localStorage.getItem(viewKey) ?? ""; } catch { return ""; }
  });
  const view = config?.views.find((v) => v.id === activeId) ?? config?.views[0];
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [saveState, setSaveState] = useState<"" | "saving" | "error" | "conflict" | "local">("");
  const saveSeq = useRef(0);

  const { data: schemaData } = useSchemas();
  const schemas = schemaData?.schemas ?? {};
  const tags = config?.source.tags ?? [];
  const hasSchema = tags.some((t) => Object.keys(schemas[t]?.fields ?? {}).length > 0);

  const spec: QuerySpec | null = useMemo(() => {
    if (!config || !view) return null;
    const schemaKeys = tags.flatMap((t) => Object.keys(schemas[t]?.fields ?? {}));
    const wanted = new Set<string>([...schemaKeys, ...(view.visible ?? []), ...ROW_META]);
    for (const k of [view.groupBy, view.dateKey, view.coverKey]) if (k && !k.startsWith("$")) wanted.add(k);
    const fields = hasSchema ? [...wanted].filter((k) => !isSystemKey(k) || ROW_META.includes(k)).slice(0, 40) : undefined;
    let filter = view.filter;
    if (view.type === "calendar" && view.dateKey && view.dateKey !== "$createdAt" && (!filter || filter.match === "all")) {
      const grid = monthGrid(month);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      filter = { match: "all", conditions: [...(filter?.conditions ?? []), { key: view.dateKey, op: "gte", value: iso(grid[0]!) }, { key: view.dateKey, op: "lte", value: `${iso(grid[41]!)}T23:59:59` }] };
    }
    const bulk = view.type === "board" || view.type === "calendar" || view.type === "gallery";
    return {
      tags,
      ...(filter ? { filter } : {}),
      ...(view.sort ? { sort: view.sort } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(fields ? { fields } : {}),
      limit: bulk ? QUERY_MAX_LIMIT : 100,
    };
  }, [config, view, schemas, tags, hasSchema, search, month]);

  const rowsQuery = useDatabaseRows(spec);
  const pages = rowsQuery.data?.pages ?? [];
  const rows: QueryRow[] = useMemo(() => pages.flatMap((p) => p.rows), [pages]);
  const total = pages[0]?.total ?? 0;
  const limited = pages[0]?.limited ?? false;
  const truncated = pages[0]?.truncated ?? false;

  // Properties: every schema field of the source tags, then free keys seen in rows.
  const allProps: PropertyDef[] = useMemo(() => {
    const base = resolveProperties(tags, schemas, {});
    const seen = new Set(base.map((p) => p.key));
    for (const r of rows) for (const [k, v] of Object.entries(r.metadata)) {
      if (seen.has(k) || isSystemKey(k) || v === null || (typeof v === "object" && !Array.isArray(v))) continue;
      seen.add(k);
      base.push(propertyFromField(k, {}, null, v));
    }
    return base;
  }, [tags, schemas, rows]);
  const shown = useMemo(() => {
    if (!view?.visible) return allProps.slice(0, view?.type === "table" ? 12 : 4);
    return view.visible.map((k) => allProps.find((p) => p.key === k)).filter((p): p is PropertyDef => !!p);
  }, [allProps, view]);

  useEffect(() => {
    if (view) try { localStorage.setItem(viewKey, view.id); } catch { /* private mode */ }
  }, [view, viewKey]);

  async function saveConfig(next: DatabaseConfig) {
    setLocal(next);
    if (!canEditDb) {
      setSaveState("local");
      return;
    }
    const seq = ++saveSeq.current;
    setSaveState("saving");
    try {
      const saved = await client.updateNote(note.id, { metadata: { prism_database: next }, ifUpdatedAt: note.updatedAt ?? undefined });
      if (seq !== saveSeq.current) return;
      qc.setQueryData<Note>(queryKeys.vault.note(note.id), (old) => (old ? { ...old, updatedAt: saved.updatedAt ?? old.updatedAt, metadata: { ...(old.metadata ?? {}), prism_database: next } } : old));
      setLocal(null);
      setSaveState("");
    } catch (e) {
      if (seq !== saveSeq.current) return;
      setSaveState(/\b409\b|conflict|changed/i.test(String((e as Error).message)) ? "conflict" : "error");
    }
  }
  const updateView = (patch: Partial<DatabaseView>) => {
    if (!config || !view) return;
    void saveConfig({ ...config, views: config.views.map((v) => (v.id === view.id ? { ...v, ...patch } : v)) });
  };

  const write = usePropertyWriter();
  const schemaEdit = useUpdateSchema();
  const ownerish = caps === null && schemaEdit.available && !!schemaData?.live;
  const canCreate = !readOnly && (caps?.has("create") ?? true) && caps?.has("edit") !== false;
  const ctx: ViewContext | null = view ? {
    view,
    rows,
    props: allProps,
    shown,
    canEditRow: (r) => !readOnly && (r._caps ? r._caps.includes("edit") : true),
    canCreate,
    commit: (r, def) => async (next, base) => {
      await write({ id: r.id, updatedAt: r.updatedAt }, { [def.key]: next }, { [def.key]: base ?? null });
    },
    createOption: (def) => (ownerish && def.tag && def.kind !== "multi_select"
      ? async (o: string) => { await schemaEdit.update(def.tag!, { fields: { [def.key]: { enum: [...def.options.map((x) => x.value), o] } } }); }
      : undefined),
    open: (r) => useUIStore.getState().openTab(r.id, noteTitle(r), inferContentType({ ...r, content: "" })),
    create: async (titleText, preset) => {
      const defaults: Record<string, unknown> = {};
      for (const t of tags) for (const [k, f] of Object.entries(schemas[t]?.fields ?? {})) if (f.default !== undefined && defaults[k] === undefined) defaults[k] = f.default;
      await client.createNote({ content: "", path: rowPath(note.path, titleText), tags: [...tags], metadata: { ...defaults, ...(preset ?? {}), title: titleText } });
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "vault" && q.queryKey[1] === "notes" && typeof q.queryKey[2] !== "string" });
      void qc.invalidateQueries({ queryKey: ["vault", "tree"] });
    },
    updateView,
  } : null;

  const title = noteTitle({ id: note.id, path: note.path, metadata: note.metadata });
  const description = note.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const crumbs = (note.path ?? "").replace(/^vault\//, "").split("/").slice(0, -1);

  return (
    <div className="db-page">
      <div className="db-scroll">
        <header className="db-head">
          {crumbs.length > 0 && <nav className="db-crumbs" aria-label="Database location">{crumbs.map((c, i) => <span key={i}>{i > 0 && <ChevronRight size={12} aria-hidden="true" />} {c}</span>)}</nav>}
          <div className="db-title-row">
            <span className="db-title-icon" aria-hidden="true">{typeof note.metadata?.icon === "string" ? note.metadata.icon : <Database size={18} />}</span>
            <h1 className="db-title">{title}</h1>
          </div>
          {description && <p className="db-desc">{description.slice(0, 400)}</p>}
          {config && <p className="db-source">Pages tagged {config.source.tags.map((t) => <code key={t}>#{t}</code>)}</p>}
        </header>
        <div className="db-body">
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
                onSelect={(id) => setActiveId(id)}
                onUpdate={updateView}
                onAddView={(type) => {
                  const v: DatabaseView = { id: newViewId(), name: VIEW_LABELS[type], type, ...(type === "board" ? { groupBy: allProps.find((p) => p.kind === "status")?.key ?? allProps.find((p) => p.kind === "select")?.key } : {}), ...(type === "calendar" ? { dateKey: allProps.find((p) => p.kind === "date")?.key } : {}) };
                  void saveConfig({ ...config, views: [...config.views, v] });
                  setActiveId(v.id);
                }}
                onDeleteView={() => {
                  if (config.views.length < 2) return;
                  void saveConfig({ ...config, views: config.views.filter((v) => v.id !== view.id) });
                  setActiveId(config.views.find((v) => v.id !== view.id)!.id);
                }}
                onNew={() => void ctx.create("Untitled").then(() => undefined).catch(() => undefined)}
              />
              {saveState === "local" && <p className="db-notice" role="status">You can’t edit this database, so view changes stay in this tab.</p>}
              {saveState === "conflict" && <p className="db-notice" role="alert">This database was changed somewhere else, so your view change wasn’t saved. <button type="button" className="db-ghost" onClick={() => { setLocal(null); setSaveState(""); void qc.invalidateQueries({ queryKey: queryKeys.vault.note(note.id) }); }}>Reload views</button></p>}
              {saveState === "error" && <p className="db-notice" role="alert">The view change could not be saved. <button type="button" className="db-ghost" onClick={() => local && void saveConfig(local)}>Retry</button></p>}
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
            </>
          ) : null}
        </div>
      </div>
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

function Toolbar({ config, view, props, search, onSearch, isMobile, canEditDb, canCreate, onSelect, onUpdate, onAddView, onDeleteView, onNew }: {
  config: DatabaseConfig; view: DatabaseView; props: PropertyDef[]; search: string; onSearch: (s: string) => void; isMobile: boolean;
  canEditDb: boolean; canCreate: boolean; onSelect: (id: string) => void; onUpdate: (p: Partial<DatabaseView>) => void;
  onAddView: (t: ViewType) => void; onDeleteView: () => void; onNew: () => void;
}) {
  const filterBtn = useRef<HTMLButtonElement>(null);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const settingsBtn = useRef<HTMLButtonElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<"" | "filter" | "sort" | "settings" | "add">("");
  const close = () => setPanel("");
  const filterCount = view.filter?.conditions.length ?? 0;
  const body = panel === "filter" ? <FilterEditor filter={view.filter} props={props} onChange={(f) => onUpdate({ filter: f })} />
    : panel === "sort" ? <SortEditor sort={view.sort} props={props} onChange={(s) => onUpdate({ sort: s })} />
    : panel === "settings" ? <ViewSettings key={view.id} view={view} props={props} canDelete={canEditDb && config.views.length > 1} onChange={onUpdate} onDelete={() => { close(); onDeleteView(); }} />
    : null;
  const titles = { filter: "Filter", sort: "Sort", settings: "View settings", add: "Add a view", "": "" } as const;
  return (
    <div className="db-toolbar">
      <div className="db-tabs" role="tablist" aria-label="Views">
        {config.views.map((v) => {
          const Icon = VIEW_ICONS[v.type];
          return (
            <button key={v.id} type="button" role="tab" className="db-tab focus-ring" aria-selected={v.id === view.id} onClick={() => onSelect(v.id)}>
              <Icon size={14} aria-hidden="true" /> {v.name}
            </button>
          );
        })}
        {canEditDb && (
          <button ref={addBtn} type="button" className="db-tab focus-ring" aria-label="Add a view" aria-haspopup="menu" aria-expanded={panel === "add"} onClick={() => setPanel(panel === "add" ? "" : "add")}><Plus size={14} aria-hidden="true" /></button>
        )}
      </div>
      <div className="db-actions">
        <label className="db-search"><Search size={14} aria-hidden="true" /><input aria-label="Search this database" placeholder="Search" value={search} onChange={(e) => onSearch(e.target.value)} /></label>
        <button ref={filterBtn} type="button" className="db-control focus-ring" data-active={filterCount || undefined} aria-haspopup="dialog" aria-expanded={panel === "filter"} onClick={() => setPanel(panel === "filter" ? "" : "filter")}>
          <Filter size={14} aria-hidden="true" /> Filter{filterCount ? ` · ${filterCount}` : ""}
        </button>
        <button ref={sortBtn} type="button" className="db-control focus-ring" data-active={view.sort?.length || undefined} aria-haspopup="dialog" aria-expanded={panel === "sort"} onClick={() => setPanel(panel === "sort" ? "" : "sort")}>
          <SortAsc size={14} aria-hidden="true" /> Sort
        </button>
        <button ref={settingsBtn} type="button" className="db-control focus-ring" aria-label="View settings" aria-haspopup="dialog" aria-expanded={panel === "settings"} onClick={() => setPanel(panel === "settings" ? "" : "settings")}>
          <Settings2 size={14} aria-hidden="true" />{!isMobile && " View settings"}
        </button>
        {canCreate && <button type="button" className="db-primary" onClick={onNew}><Plus size={14} aria-hidden="true" /> New</button>}
      </div>
      <Popover anchor={addBtn} open={panel === "add"} onClose={close} label="Add a view" width={220}>
        <div className="db-menu" role="menu">
          {VIEW_TYPES.map((t) => {
            const Icon = VIEW_ICONS[t];
            return <button key={t} type="button" role="menuitem" onClick={() => { close(); onAddView(t); }}><Icon size={14} aria-hidden="true" /> {VIEW_LABELS[t]}</button>;
          })}
        </div>
      </Popover>
      {isMobile ? (
        <BottomSheet open={!!body} onClose={close} title={titles[panel]}>{body}</BottomSheet>
      ) : (
        <>
          <Popover anchor={filterBtn} open={panel === "filter"} onClose={close} label="Filter" width={520}>{panel === "filter" && body}</Popover>
          <Popover anchor={sortBtn} open={panel === "sort"} onClose={close} label="Sort" width={380}>{panel === "sort" && body}</Popover>
          <Popover anchor={settingsBtn} open={panel === "settings"} onClose={close} label="View settings" width={320}>{panel === "settings" && body}</Popover>
        </>
      )}
    </div>
  );
}
