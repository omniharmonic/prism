/**
 * The five database layouts. Each renders the same rows (already filtered,
 * sorted and paged by the query engine) and edits through the same typed
 * PropertyValue, so a cell, a card and the page header behave identically.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ArrowUpRight, ChevronLeft, ChevronRight, EyeOff, Group, MoreHorizontal, Plus } from "lucide-react";
import type { QueryRow } from "../../lib/database/query";
import { noteTitle } from "../../lib/database/query";
import { isBlank, optionColor, type PropertyDef } from "../../lib/database/schema";
import { OptionChip, PropertyDisplay, PropertyValue } from "./PropertyValue";
import { Popover } from "./Popover";
import { applyRank, reorderRank, type DatabaseView } from "./config";

export interface ViewContext {
  view: DatabaseView;
  rows: QueryRow[];
  /** Every property of the source tag(s). */
  props: PropertyDef[];
  /** The view's visible properties, in order. */
  shown: PropertyDef[];
  canEditRow: (r: QueryRow) => boolean;
  canCreate: boolean;
  commit: (r: QueryRow, def: PropertyDef) => (next: unknown, base: unknown) => Promise<void>;
  createOption: (def: PropertyDef) => ((o: string) => Promise<void>) | undefined;
  open: (r: QueryRow) => void;
  create: (title: string, preset?: Record<string, unknown>) => Promise<void>;
  updateView: (patch: Partial<DatabaseView>) => void;
}

const title = (r: QueryRow) => noteTitle(r);

/** Inline "new row" title input. Enter creates, Escape cancels; failures keep the text. */
export function NewRowForm({ onCreate, onCancel, label = "New page title" }: { onCreate: (t: string) => Promise<void>; onCancel: () => void; label?: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(value.trim() || "Untitled");
      setValue("");
      onCancel();
    } catch (e) {
      setError(e instanceof Error && !/failed: \d{3}/.test(e.message) ? e.message : "The page could not be created. Your title is kept; try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="db-title-cell" style={{ flexWrap: "wrap" }}>
      <input autoFocus className="db-title-input" aria-label={label} placeholder="Untitled" value={value} disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => { if (!value.trim() && !busy) onCancel(); }} />
      {error && <span role="alert" className="db-error">{error}</span>}
    </span>
  );
}

function OpenTitle({ row, ctx }: { row: QueryRow; ctx: ViewContext }) {
  const icon = typeof row.metadata.icon === "string" ? row.metadata.icon : null;
  return (
    <span className="db-title-cell">
      {icon && <span aria-hidden="true">{icon}</span>}
      <button type="button" className="db-row-open focus-ring" onClick={() => ctx.open(row)}>{title(row)}</button>
      <ArrowUpRight size={13} className="db-row-open-icon" aria-hidden="true" />
    </span>
  );
}

// ── table ────────────────────────────────────────────────────────────────────

function groupRows(rows: QueryRow[], def: PropertyDef | undefined): Array<{ value: string | null; label: string; rows: QueryRow[] }> {
  if (!def) return [{ value: null, label: "", rows }];
  const order = def.kind === "checkbox" ? ["true", "false"] : def.options.map((o) => o.value);
  const buckets = new Map<string | null, QueryRow[]>();
  for (const v of order) buckets.set(v, []);
  for (const r of rows) {
    const raw = r.metadata[def.key];
    const vals = def.kind === "checkbox" ? [String(raw === true)] : Array.isArray(raw) ? raw.map(String) : isBlank(raw) ? [null] : [String(raw)];
    for (const v of vals.length ? vals : [null]) {
      if (!buckets.has(v)) buckets.set(v, []);
      buckets.get(v)!.push(r);
    }
  }
  const label = (v: string | null) => (v === null ? `No ${def.label}` : def.kind === "checkbox" ? (v === "true" ? "Checked" : "Unchecked") : def.kind === "person" || def.kind === "relation" ? v.replace(/^\[\[(.*)\]\]$/, "$1").split("/").pop()! : v);
  const out = [...buckets.entries()].map(([value, rs]) => ({ value, label: label(value), rows: rs }));
  // Like Notion, the empty group leads.
  return [...out.filter((g) => g.value === null), ...out.filter((g) => g.value !== null)];
}

function HeaderCell({ def, ctx, width, onResize }: { def: PropertyDef; ctx: ViewContext; width: number; onResize: (w: number, done: boolean) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const sorted = ctx.view.sort?.find((s) => s.key === def.key);
  const groupable = ["select", "status", "checkbox", "person"].includes(def.kind);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const el = e.currentTarget as HTMLElement;
    el.setAttribute("data-active", "");
    el.setPointerCapture?.(e.pointerId);
    let w = w0;
    const move = (ev: PointerEvent) => { w = Math.max(80, Math.min(800, w0 + ev.clientX - x0)); onResize(w, false); };
    const up = () => {
      el.removeAttribute("data-active");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResize(w, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <th scope="col" aria-sort={sorted ? (sorted.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button ref={anchor} type="button" className="db-th focus-ring" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="db-th-label">{def.label}</span>
        {sorted && (sorted.dir === "asc" ? <ArrowUpNarrowWide size={12} aria-hidden="true" /> : <ArrowDownWideNarrow size={12} aria-hidden="true" />)}
      </button>
      <span className="db-resize" role="separator" aria-orientation="vertical" aria-label={`Resize ${def.label}`} tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); onResize(Math.max(80, Math.min(800, width + (e.key === "ArrowRight" ? 20 : -20))), true); } }} />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={`${def.label} column`} width={220}>
        <div className="db-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { ctx.updateView({ sort: [{ key: def.key, dir: "asc" }] }); setOpen(false); }}><ArrowUpNarrowWide size={14} aria-hidden="true" /> Sort ascending</button>
          <button type="button" role="menuitem" onClick={() => { ctx.updateView({ sort: [{ key: def.key, dir: "desc" }] }); setOpen(false); }}><ArrowDownWideNarrow size={14} aria-hidden="true" /> Sort descending</button>
          {groupable && <button type="button" role="menuitem" onClick={() => { ctx.updateView({ groupBy: ctx.view.groupBy === def.key ? undefined : def.key }); setOpen(false); }}><Group size={14} aria-hidden="true" /> {ctx.view.groupBy === def.key ? "Ungroup" : "Group by this"}</button>}
          <hr />
          <button type="button" role="menuitem" onClick={() => { ctx.updateView({ visible: ctx.shown.map((p) => p.key).filter((k) => k !== def.key) }); setOpen(false); }}><EyeOff size={14} aria-hidden="true" /> Hide in this view</button>
        </div>
      </Popover>
    </th>
  );
}

function TableBlock({ ctx, rows, preset, label }: { ctx: ViewContext; rows: QueryRow[]; preset?: Record<string, unknown>; label: string }) {
  const [widths, setWidths] = useState<Record<string, number>>(ctx.view.widths ?? {});
  const [adding, setAdding] = useState(false);
  const w = (k: string, d: number) => widths[k] ?? ctx.view.widths?.[k] ?? d;
  const total = w("$title", 280) + ctx.shown.reduce((s, p) => s + w(p.key, 180), 0);
  return (
    <div className="db-table-wrap">
      <table className="db-table" style={{ width: total }} aria-label={label}>
        <colgroup>
          <col style={{ width: w("$title", 280) }} />
          {ctx.shown.map((p) => <col key={p.key} style={{ width: w(p.key, 180) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="db-sticky"><span className="db-th"><span className="db-th-label">Title</span></span></th>
            {ctx.shown.map((p) => (
              <HeaderCell key={p.key} def={p} ctx={ctx} width={w(p.key, 180)} onResize={(px, done) => {
                setWidths((cur) => ({ ...cur, [p.key]: px }));
                if (done) ctx.updateView({ widths: { ...(ctx.view.widths ?? {}), ...widths, [p.key]: px } });
              }} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-row-id={r.id}>
              <th scope="row" className="db-sticky" style={{ fontWeight: 400 }}><OpenTitle row={r} ctx={ctx} /></th>
              {ctx.shown.map((p) => (
                <td key={p.key}>
                  <PropertyValue def={p} value={r.metadata[p.key]} variant="cell" readOnly={!ctx.canEditRow(r)} onCommit={ctx.commit(r, p)} onCreateOption={ctx.createOption(p)} />
                </td>
              ))}
            </tr>
          ))}
          {ctx.canCreate && (
            <tr>
              <td className="db-sticky" colSpan={1 + ctx.shown.length} style={{ borderRight: 0 }}>
                {adding
                  ? <NewRowForm onCreate={(t) => ctx.create(t, preset)} onCancel={() => setAdding(false)} />
                  : <button type="button" className="db-new-row" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" /> New</button>}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function TableView({ ctx }: { ctx: ViewContext }) {
  const groupDef = ctx.props.find((p) => p.key === ctx.view.groupBy);
  if (!groupDef) return <TableBlock ctx={ctx} rows={ctx.rows} label={ctx.view.name} />;
  return (
    <>
      {groupRows(ctx.rows, groupDef).map((g) => (
        <section key={g.value ?? "∅"} aria-label={g.label}>
          <h3 className="db-group-head">
            {g.value !== null && groupDef.kind !== "checkbox" && groupDef.kind !== "person" ? <OptionChip value={g.value} color={groupDef.options.find((o) => o.value === g.value)?.color ?? optionColor(g.value)} /> : <span>{g.label}</span>}
            <span className="db-badge-count">{g.rows.length}</span>
          </h3>
          <TableBlock ctx={ctx} rows={g.rows} label={g.label} preset={g.value === null ? undefined : { [groupDef.key]: groupDef.kind === "checkbox" ? g.value === "true" : g.value }} />
        </section>
      ))}
    </>
  );
}

// ── board ────────────────────────────────────────────────────────────────────

const boardCollision: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  const hits = pointer.length ? pointer : rectIntersection(args);
  const cards = hits.filter((h) => String(h.id).startsWith("card:") && String(h.id) !== `card:${args.active.id}`);
  return cards.length ? cards : hits.filter((h) => String(h.id).startsWith("col:"));
};

function CardProps({ row, props, max = 4 }: { row: QueryRow; props: PropertyDef[]; max?: number }) {
  const filled = props.filter((p) => !isBlank(row.metadata[p.key])).slice(0, max);
  if (!filled.length) return null;
  return <span className="db-card-props">{filled.map((p) => <span key={p.key} title={p.label}><PropertyDisplay def={p} value={row.metadata[p.key]} /></span>)}</span>;
}

function BoardCard({ row, ctx, columns, groupDef, colRows }: {
  row: QueryRow; ctx: ViewContext; columns: Array<{ value: string | null; label: string }>; groupDef: PropertyDef; colRows: QueryRow[];
}) {
  const editable = ctx.canEditRow(row);
  const drag = useDraggable({ id: row.id, disabled: !editable });
  const drop = useDroppable({ id: `card:${row.id}`, data: { row } });
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const current = row.metadata[groupDef.key];
  const at = colRows.findIndex((r) => r.id === row.id);
  const shift = (dir: -1 | 1) => {
    const neighbor = colRows[at + dir];
    if (!neighbor) return;
    const next = reorderRank(ctx.view.order, ctx.rows.map((r) => r.id), row.id, neighbor.id, dir < 0 ? "before" : "after");
    if (next) ctx.updateView({ order: next });
  };
  return (
    <article
      ref={(el) => { drag.setNodeRef(el); drop.setNodeRef(el); }}
      className="db-card"
      aria-label={title(row)}
      data-dragging={drag.isDragging || undefined}
      style={drag.transform ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`, zIndex: 5 } : undefined}
      {...drag.attributes}
      {...drag.listeners}
      role="article"
      tabIndex={undefined}
    >
      <button type="button" className="db-row-open db-card-title focus-ring" style={{ whiteSpace: "normal", paddingRight: 26 }} onClick={() => ctx.open(row)}>{title(row)}</button>
      <CardProps row={row} props={ctx.shown.filter((p) => p.key !== groupDef.key)} />
      <button ref={menuAnchor} type="button" className="db-card-menu focus-ring" aria-label={`Actions for ${title(row)}`} aria-haspopup="menu" aria-expanded={menu}
        onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setMenu((o) => !o); }}>
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      <Popover anchor={menuAnchor} open={menu} onClose={() => { setMenu(false); setMoveOpen(false); }} label={`Actions for ${title(row)}`} width={220}>
        <div className="db-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenu(false); ctx.open(row); }}><ArrowUpRight size={14} aria-hidden="true" /> Open</button>
          {editable && <button type="button" role="menuitem" aria-expanded={moveOpen} onClick={() => setMoveOpen((o) => !o)}><ChevronRight size={14} aria-hidden="true" /> Move to…</button>}
          {editable && moveOpen && columns.filter((c) => c.value !== (isBlank(current) ? null : String(current))).map((c) => (
            <button key={c.value ?? "∅"} type="button" role="menuitem" style={{ paddingLeft: 28 }} onClick={() => {
              setMenu(false);
              void ctx.commit(row, groupDef)(c.value === null ? null : groupDef.kind === "checkbox" ? c.value === "true" : c.value, current ?? null).catch(() => {});
            }}>{c.label}</button>
          ))}
          {ctx.view.order !== undefined || at >= 0 ? <>
            <hr />
            <button type="button" role="menuitem" disabled={at <= 0} onClick={() => { setMenu(false); shift(-1); }}>Move earlier</button>
            <button type="button" role="menuitem" disabled={at < 0 || at >= colRows.length - 1} onClick={() => { setMenu(false); shift(1); }}>Move later</button>
          </> : null}
        </div>
      </Popover>
    </article>
  );
}

function BoardColumn({ value, label, def, children, count, onAdd }: { value: string | null; label: string; def: PropertyDef; children: ReactNode; count: number; onAdd?: () => void }) {
  const drop = useDroppable({ id: `col:${value ?? ""}`, data: { value } });
  const color = value === null ? "gray" : def.options.find((o) => o.value === value)?.color ?? optionColor(value);
  return (
    <section ref={drop.setNodeRef} className="db-col" aria-label={label} data-over={drop.isOver || undefined} style={{ ["--hue" as string]: `var(--db-hue-${color}, ${HUES[color]})` }}>
      <header className="db-col-head"><span className="db-dot" aria-hidden="true" /> {label} <span className="db-badge-count">{count}</span></header>
      {onAdd && <button type="button" className="db-col-add" onClick={onAdd}><Plus size={14} aria-hidden="true" /> Add {def.kind === "status" ? "item" : "page"}</button>}
      {children}
    </section>
  );
}
const HUES: Record<string, string> = { gray: "#8a8f98", brown: "#9a6b4f", orange: "#d9730d", yellow: "#c29a12", green: "#2f9e5a", blue: "#2f73d9", purple: "#8b56d9", pink: "#c94f8f", red: "#d64545" };

export function BoardView({ ctx, onPickGroup }: { ctx: ViewContext; onPickGroup: (key: string) => void }) {
  const groupDef = ctx.props.find((p) => p.key === ctx.view.groupBy);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );
  const [adding, setAdding] = useState<string | null | undefined>(undefined);
  const groups = useMemo(() => (groupDef ? groupRows(applyRank(ctx.rows, ctx.view.order), groupDef) : []), [ctx.rows, ctx.view.order, groupDef]);
  if (!groupDef) {
    const choices = ctx.props.filter((p) => p.kind === "select" || p.kind === "status" || p.kind === "checkbox" || p.kind === "person");
    return (
      <div className="db-state">
        <h2>Choose how to group this board</h2>
        <p>Boards group pages by a select, status, person or checkbox property.</p>
        {choices.length ? (
          <select aria-label="Group by" className="db-control" defaultValue="" onChange={(e) => e.target.value && onPickGroup(e.target.value)}>
            <option value="">Group by…</option>
            {choices.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        ) : <p>This tag has no groupable property yet. Add a Select or Status property first.</p>}
      </div>
    );
  }
  const columns = groups.map((g) => ({ value: g.value, label: g.label }));
  const onDragEnd = (e: DragEndEvent) => {
    const row = ctx.rows.find((r) => r.id === String(e.active.id));
    if (!row || !e.over) return;
    const overId = String(e.over.id);
    let target: string | null;
    let neighbor: QueryRow | undefined;
    if (overId.startsWith("card:")) {
      neighbor = (e.over.data.current as { row: QueryRow }).row;
      const nv = neighbor.metadata[groupDef.key];
      target = groupDef.kind === "checkbox" ? String(nv === true) : isBlank(nv) ? null : String(Array.isArray(nv) ? nv[0] : nv);
    } else target = (e.over.data.current as { value: string | null }).value;
    const cur = row.metadata[groupDef.key];
    const curKey = groupDef.kind === "checkbox" ? String(cur === true) : isBlank(cur) ? null : String(Array.isArray(cur) ? cur[0] : cur);
    if (neighbor && neighbor.id !== row.id) {
      const next = reorderRank(ctx.view.order, ctx.rows.map((r) => r.id), row.id, neighbor.id, "before");
      if (next) ctx.updateView({ order: next });
    }
    if (target !== curKey) {
      const value = target === null ? null : groupDef.kind === "checkbox" ? target === "true" : groupDef.kind === "multi_select" ? [target] : target;
      void ctx.commit(row, groupDef)(value, cur ?? null).catch(() => {});
    }
  };
  return (
    <DndContext sensors={sensors} collisionDetection={boardCollision} onDragEnd={onDragEnd}>
      <div className="db-board" role="list" aria-label={`${ctx.view.name} board`}>
        {groups.map((g) => (
          <BoardColumn key={g.value ?? "∅"} value={g.value} label={g.label} def={groupDef} count={g.rows.length}
            onAdd={ctx.canCreate ? () => setAdding(g.value) : undefined}>
            {adding === g.value && (
              <div className="db-card"><NewRowForm label={`New page in ${g.label}`} onCancel={() => setAdding(undefined)}
                onCreate={(t) => ctx.create(t, g.value === null ? undefined : { [groupDef.key]: groupDef.kind === "checkbox" ? g.value === "true" : g.value })} /></div>
            )}
            {g.rows.map((r) => <BoardCard key={r.id} row={r} ctx={ctx} columns={columns} groupDef={groupDef} colRows={g.rows} />)}
            {!g.rows.length && adding !== g.value && <p className="db-pop-empty">No pages</p>}
          </BoardColumn>
        ))}
      </div>
    </DndContext>
  );
}

// ── gallery / list ───────────────────────────────────────────────────────────

export function GalleryView({ ctx }: { ctx: ViewContext }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="db-gallery" role="list" aria-label={`${ctx.view.name} gallery`}>
      {ctx.rows.map((r) => {
        const cover = ctx.view.coverKey ? r.metadata[ctx.view.coverKey] : r.metadata.cover;
        const url = typeof cover === "string" && /^https:\/\//i.test(cover) ? cover : null;
        const icon = typeof r.metadata.icon === "string" ? r.metadata.icon : null;
        return (
          <article key={r.id} className="db-gcard" role="listitem" aria-label={title(r)}>
            <button type="button" className="db-cover" aria-hidden="true" tabIndex={-1} onClick={() => ctx.open(r)}>
              {url ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span>{icon ?? title(r).slice(0, 1).toUpperCase()}</span>}
            </button>
            <div className="db-gcard-body">
              <button type="button" className="db-row-open db-card-title focus-ring" style={{ whiteSpace: "normal" }} onClick={() => ctx.open(r)}>{title(r)}</button>
              <CardProps row={r} props={ctx.shown} max={3} />
            </div>
          </article>
        );
      })}
      {ctx.canCreate && (
        <article className="db-gcard" style={{ justifyContent: "center", minHeight: 120 }}>
          {adding ? <NewRowForm onCreate={(t) => ctx.create(t)} onCancel={() => setAdding(false)} /> : <button type="button" className="db-new-row" style={{ justifyContent: "center", minHeight: 120 }} onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" /> New</button>}
        </article>
      )}
    </div>
  );
}

export function ListView({ ctx }: { ctx: ViewContext }) {
  const [adding, setAdding] = useState(false);
  return (
    <ul className="db-list" aria-label={`${ctx.view.name} list`}>
      {ctx.rows.map((r) => (
        <li key={r.id}>
          {typeof r.metadata.icon === "string" && <span aria-hidden="true">{r.metadata.icon}</span>}
          <button type="button" className="db-row-open focus-ring" onClick={() => ctx.open(r)}>{title(r)}</button>
          <CardProps row={r} props={ctx.shown} max={3} />
        </li>
      ))}
      {ctx.canCreate && (
        <li>{adding ? <NewRowForm onCreate={(t) => ctx.create(t)} onCancel={() => setAdding(false)} /> : <button type="button" className="db-new-row" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" /> New</button>}</li>
      )}
    </ul>
  );
}

// ── calendar ─────────────────────────────────────────────────────────────────

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The 6-week grid for `month` (Monday-first). */
export function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + i));
}

export function CalendarView({ ctx, month, onMonth, onPickDate }: { ctx: ViewContext; month: Date; onMonth: (d: Date) => void; onPickDate: (key: string) => void }) {
  const key = ctx.view.dateKey;
  const [adding, setAdding] = useState<string | null>(null);
  const days = monthGrid(month);
  const byDay = useMemo(() => {
    const m = new Map<string, QueryRow[]>();
    if (!key) return m;
    for (const r of ctx.rows) {
      const v = key === "$createdAt" ? r.createdAt : r.metadata[key];
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
      const d = v.length > 10 && key === "$createdAt" ? ymd(new Date(v)) : v.slice(0, 10);
      m.set(d, [...(m.get(d) ?? []), r]);
    }
    return m;
  }, [ctx.rows, key]);
  if (!key) {
    const dates = ctx.props.filter((p) => p.kind === "date");
    return (
      <div className="db-state">
        <h2>Choose a date property</h2>
        <p>The calendar places each page on the day in that property.</p>
        <select aria-label="Date property" className="db-control" defaultValue="" onChange={(e) => e.target.value && onPickDate(e.target.value)}>
          <option value="">Show by…</option>
          {dates.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          <option value="$createdAt">Created</option>
        </select>
      </div>
    );
  }
  const today = ymd(new Date());
  const editableKey = key !== "$createdAt";
  return (
    <div>
      <div className="db-cal-head">
        <h3>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3>
        <button type="button" className="db-icon-btn" aria-label="Previous month" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
        <button type="button" className="db-control" onClick={() => onMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</button>
        <button type="button" className="db-icon-btn" aria-label="Next month" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
      </div>
      <div className="db-cal" role="grid" aria-label={`${ctx.view.name} calendar`}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="db-cal-dow" role="columnheader">{d}</div>)}
        {days.map((d) => {
          const k = ymd(d);
          const items = byDay.get(k) ?? [];
          return (
            <div key={k} role="gridcell" aria-label={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} className="db-cal-day" data-outside={d.getMonth() !== month.getMonth() || undefined} data-today={k === today || undefined}>
              <div className="db-cal-num"><span>{d.getDate()}</span>
                {ctx.canCreate && editableKey && <button type="button" className="db-cal-add" aria-label={`New page on ${k}`} onClick={() => setAdding(k)}><Plus size={13} aria-hidden="true" /></button>}
              </div>
              {adding === k && <NewRowForm label={`New page on ${k}`} onCreate={(t) => ctx.create(t, { [key]: k })} onCancel={() => setAdding(null)} />}
              {items.slice(0, 3).map((r) => <button key={r.id} type="button" className="db-cal-item" title={title(r)} onClick={() => ctx.open(r)}>{title(r)}</button>)}
              {items.length > 3 && <span className="db-pop-path" style={{ marginLeft: 4 }}>+{items.length - 3} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
