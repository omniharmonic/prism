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
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, EyeOff, Group, MoreHorizontal, Pencil, Plus } from "lucide-react";
import type { QueryRow } from "../../lib/database/query";
import { noteTitle, unwrapLink } from "../../lib/database/query";
import { formatDate, integrationOwned, isBlank, optionColor, optionLabel, propertyValue, type PropertyDef } from "../../lib/database/schema";
import { dayDiff, daySpan, shiftDateValue } from "../../lib/database/dates";
import { OptionChip, PropertyDisplay, PropertyValue } from "./PropertyValue";
import { Popover } from "./Popover";
import { applyRank, reorderRank, type DatabaseView } from "./config";
import { coverForNote, firstFileUrl } from "../../lib/media/attachments";

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
  /** Open a row (peek or page per the database preference; ⌘/Ctrl-click = full page). */
  open: (r: QueryRow, e?: { metaKey?: boolean; ctrlKey?: boolean }) => void;
  /** Row selection for bulk actions (table only; absent = no selection UI). */
  selection?: RowSelection;
  create: (title: string, preset?: Record<string, unknown>) => Promise<void>;
  updateView: (patch: Partial<DatabaseView>) => void;
  /** Open the property editor (only for people who may change the schema). */
  editProperty?: (def: PropertyDef) => void;
}

const title = (r: QueryRow) => noteTitle(r);
/** A cell's value: metadata, or a note column for system properties. */
export const cell = (r: QueryRow, def: PropertyDef) => propertyValue(r, def.key);

export interface RowSelection {
  ids: Set<string>;
  /** Click on a row's checkbox; shift extends from the last clicked row over `ordered`. */
  toggle: (id: string, shift: boolean, ordered: string[]) => void;
  setAll: (ids: string[], on: boolean) => void;
}

/** Collapsed group keys, per view, for this session. */
function useCollapsed(viewId: string) {
  const key = `prism:db-collapsed:${viewId}`;
  const [set, setSet] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[]); } catch { return new Set(); }
  });
  const toggle = (g: string) => setSet((cur) => {
    const next = new Set(cur);
    if (next.has(g)) next.delete(g); else next.add(g);
    try { sessionStorage.setItem(key, JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  });
  return { collapsed: set, toggle };
}

/** A collapsible group header with its count (table and list). */
function GroupHeader({ g, def, open, onToggle }: { g: { value: string | null; label: string; rows: QueryRow[] }; def: PropertyDef; open: boolean; onToggle: () => void }) {
  return (
    <h3 className="db-group-head">
      <button type="button" className="db-group-toggle focus-ring" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${g.label}`} onClick={onToggle}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {g.value !== null && def.kind !== "checkbox" && def.kind !== "person" ? <OptionChip value={g.value} label={g.label} color={def.options.find((o) => o.value === g.value)?.color ?? optionColor(g.value)} /> : <span>{g.label}</span>}
      <span className="db-badge-count" aria-label={`${g.rows.length} ${g.rows.length === 1 ? "page" : "pages"}`}>{g.rows.length}</span>
    </h3>
  );
}
const groupKey = (v: string | null) => v ?? "∅";
/** The view's groups, without the empty ones when it hides them (NP-DB-04). `keep`: a group being added to. */
function shownGroups<T extends { value: string | null; rows: QueryRow[] }>(groups: T[], view: DatabaseView, keep?: string | null): T[] {
  return view.hideEmptyGroups ? groups.filter((g) => g.rows.length > 0 || (keep !== undefined && g.value === keep)) : groups;
}
/** Shift state of the click that is about to toggle a row checkbox (click fires before change). */
let lastShift = false;
const groupPreset = (def: PropertyDef, v: string | null) => (v === null ? undefined : { [def.key]: def.kind === "checkbox" ? v === "true" : def.kind === "multi_select" ? [v] : v });

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

function OpenTitle({ row, ctx, select }: { row: QueryRow; ctx: ViewContext; select?: ReactNode }) {
  const icon = typeof row.metadata.icon === "string" ? row.metadata.icon : null;
  return (
    <span className="db-title-cell">
      {select}
      {icon && <span aria-hidden="true">{icon}</span>}
      <button type="button" className="db-row-open focus-ring" onClick={(e) => ctx.open(row, e)}>{title(row)}</button>
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
    const raw = cell(r, def);
    const vals = def.kind === "checkbox" ? [String(raw === true)] : Array.isArray(raw) ? raw.map(String) : isBlank(raw) ? [null] : [String(raw)];
    for (const v of vals.length ? vals : [null]) {
      if (!buckets.has(v)) buckets.set(v, []);
      buckets.get(v)!.push(r);
    }
  }
  const label = (v: string | null) => (v === null ? `No ${def.label}` : def.kind === "checkbox" ? (v === "true" ? "Checked" : "Unchecked") : def.kind === "person" || def.kind === "relation" ? unwrapLink(v).split("/").pop()! : optionLabel(def, v));
  const out = [...buckets.entries()].map(([value, rs]) => ({ value, label: label(value), rows: rs }));
  // Like Notion, the empty group leads.
  return [...out.filter((g) => g.value === null), ...out.filter((g) => g.value !== null)];
}

function HeaderCell({ def, ctx, width, onResize }: { def: PropertyDef; ctx: ViewContext; width: number; onResize: (w: number, done: boolean) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const sorted = ctx.view.sort?.find((s) => s.key === def.key);
  const groupable = ["select", "status", "checkbox", "person", "multi_select"].includes(def.kind) && !def.system;
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
      <span className="db-resize" role="separator" aria-orientation="vertical" aria-label={`Resize ${def.label}`} aria-valuenow={Math.round(width)} aria-valuemin={80} aria-valuemax={800} tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); onResize(Math.max(80, Math.min(800, width + (e.key === "ArrowRight" ? 20 : -20))), true); } }} />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={`${def.label} column`} width={220}>
        <div className="db-menu" role="menu">
          {ctx.editProperty && def.tag && !def.system && <>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); ctx.editProperty!(def); }}><Pencil size={14} aria-hidden="true" /> Edit property…</button>
            <hr />
          </>}
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

/**
 * Spreadsheet-style keyboard navigation (NP-DB-03): arrow keys move between the
 * cells of a table body; Enter on a cell edits it (the cell's own button), Esc
 * leaves the editor and returns to the cell, Tab walks cells in reading order
 * (native tab order). Keys typed inside an editor or a popover are never taken.
 */
function onGridKey(e: React.KeyboardEvent<HTMLTableElement>) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const dir = e.key === "ArrowLeft" ? [0, -1] : e.key === "ArrowRight" ? [0, 1] : e.key === "ArrowUp" ? [-1, 0] : e.key === "ArrowDown" ? [1, 0] : null;
  if (!dir) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select, [contenteditable='true']")) return;
  const cellEl = t.closest("td, th");
  const rowEl = cellEl?.parentElement;
  // Portaled popovers bubble here through React but are not inside a cell.
  if (!cellEl || !rowEl || !rowEl.hasAttribute("data-row-id") || !e.currentTarget.contains(cellEl)) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("tbody > tr[data-row-id]"));
  const r = rows.indexOf(rowEl as HTMLElement) + dir[0]!;
  const c = Array.from(rowEl.children).indexOf(cellEl) + dir[1]!;
  const target = rows[r]?.children[c]?.querySelector<HTMLElement>(".db-value-button:not(:disabled), .db-row-open");
  e.preventDefault();
  target?.focus();
}

function TableBlock({ ctx, rows, preset, label }: { ctx: ViewContext; rows: QueryRow[]; preset?: Record<string, unknown>; label: string }) {
  const [widths, setWidths] = useState<Record<string, number>>(ctx.view.widths ?? {});
  const [adding, setAdding] = useState(false);
  const w = (k: string, d: number) => widths[k] ?? ctx.view.widths?.[k] ?? d;
  const sel = ctx.selection;
  const ids = rows.map((r) => r.id);
  const total = w("$title", 280) + ctx.shown.reduce((s, p) => s + w(p.key, 180), 0);
  const allOn = !!sel && rows.length > 0 && rows.every((r) => sel.ids.has(r.id));
  const someOn = !!sel && rows.some((r) => sel.ids.has(r.id));
  return (
    <div className="db-table-wrap">
      <table className="db-table" style={{ width: total }} aria-label={label} data-multiselect={sel ? "" : undefined} onKeyDown={onGridKey}>
        <colgroup>
          <col className="db-col-title" style={{ width: w("$title", 280) }} />
          {ctx.shown.map((p) => <col key={p.key} style={{ width: w(p.key, 180) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="db-sticky">
              <span className="db-th">
                {sel && <input type="checkbox" className="db-sel" aria-label={`Select all in ${label}`} checked={allOn} ref={(el) => { if (el) el.indeterminate = someOn && !allOn; }} onChange={(e) => sel.setAll(ids, e.target.checked)} />}
                <span className="db-th-label">Title</span>
              </span>
            </th>
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
            <tr key={r.id} data-row-id={r.id} aria-selected={sel ? sel.ids.has(r.id) : undefined}>
              <th scope="row" className="db-sticky" style={{ fontWeight: 400 }}>
                <OpenTitle row={r} ctx={ctx} select={sel ? (
                  <input type="checkbox" className="db-sel" aria-label={`Select ${title(r)}`} checked={sel.ids.has(r.id)}
                    onClick={(e) => { lastShift = e.shiftKey; }} onChange={() => { sel.toggle(r.id, lastShift, ids); lastShift = false; }} />
                ) : undefined} />
              </th>
              {ctx.shown.map((p) => (
                <td key={p.key}>
                  <PropertyValue def={p} value={cell(r, p)} variant="cell" noteId={r.id} readOnly={!ctx.canEditRow(r) || !!p.system} onCommit={ctx.commit(r, p)} onCreateOption={ctx.createOption(p)} />
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
  const { collapsed, toggle } = useCollapsed(ctx.view.id);
  if (!groupDef) return <TableBlock ctx={ctx} rows={ctx.rows} label={ctx.view.name} />;
  return (
    <>
      {shownGroups(groupRows(ctx.rows, groupDef), ctx.view).map((g) => {
        const open = !collapsed.has(groupKey(g.value));
        return (
          <section key={groupKey(g.value)} aria-label={g.label} className="db-group">
            <GroupHeader g={g} def={groupDef} open={open} onToggle={() => toggle(groupKey(g.value))} />
            {open && <TableBlock ctx={ctx} rows={g.rows} label={g.label} preset={groupPreset(groupDef, g.value)} />}
          </section>
        );
      })}
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
  const filled = props.filter((p) => !isBlank(cell(row, p))).slice(0, max);
  if (!filled.length) return null;
  return <span className="db-card-props">{filled.map((p) => <span key={p.key} title={p.label}><PropertyDisplay def={p} value={cell(row, p)} /></span>)}</span>;
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
      <button type="button" className="db-row-open db-card-title focus-ring" style={{ whiteSpace: "normal", paddingRight: 26 }} onClick={(e) => ctx.open(row, e)}>{title(row)}</button>
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
              void ctx.commit(row, groupDef)(c.value === null ? null : groupDef.kind === "checkbox" ? c.value === "true" : groupDef.kind === "multi_select" ? [c.value] : c.value, current ?? null).catch(() => {});
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
    /* The board is a list of columns: each column region sits in a box-less list item. */
    <div role="listitem" style={{ display: "contents" }}>
    <section ref={drop.setNodeRef} className="db-col" aria-label={label} data-over={drop.isOver || undefined} style={{ ["--hue" as string]: `var(--db-hue-${color}, ${HUES[color]})` }}>
      <header className="db-col-head"><span className="db-dot" aria-hidden="true" /> {label} <span className="db-badge-count">{count}</span></header>
      {onAdd && <button type="button" className="db-col-add" onClick={onAdd}><Plus size={14} aria-hidden="true" /> Add {def.kind === "status" ? "item" : "page"}</button>}
      {children}
    </section>
    </div>
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
        {shownGroups(groups, ctx.view, adding).map((g) => (
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
    <div className="db-gallery" data-size={ctx.view.cardSize ?? "medium"}>
      {/* The list owns the page cards only (box-less, so the grid is unchanged); the New tile sits beside it. */}
      <div role="list" aria-label={`${ctx.view.name} gallery`} data-size={ctx.view.cardSize ?? "medium"} style={{ display: "contents" }}>
      {ctx.rows.map((r) => {
        // Cover (NP-DB-05): the chosen property (a URL or a files value), else the page cover
        // (image or brand gradient) — one resolver shared with the page header (`coverForNote`).
        const picked = ctx.view.coverKey ? { metadata: { cover: firstFileUrl(r.metadata[ctx.view.coverKey]) } } : r;
        const cover = coverForNote(picked);
        const url = cover?.src ?? null;
        const icon = typeof r.metadata.icon === "string" ? r.metadata.icon : null;
        return (
          <div key={r.id} className="db-gcard" role="listitem" aria-label={title(r)}>
            <button type="button" className="db-cover" aria-hidden="true" tabIndex={-1} onClick={(e) => ctx.open(r, e)}>
              {url ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ objectPosition: `50% ${cover!.y}%` }} />
                : cover?.gradient ? <span className="db-cover-gradient" style={{ background: cover.gradient, width: "100%", height: "100%" }} />
                : <span>{icon ?? title(r).slice(0, 1).toUpperCase()}</span>}
            </button>
            <div className="db-gcard-body">
              <button type="button" className="db-row-open db-card-title focus-ring" style={{ whiteSpace: "normal" }} onClick={(e) => ctx.open(r, e)}>{title(r)}</button>
              <CardProps row={r} props={ctx.shown} max={3} />
            </div>
          </div>
        );
      })}
      </div>
      {ctx.canCreate && (
        <article className="db-gcard" style={{ justifyContent: "center", minHeight: 120 }}>
          {adding ? <NewRowForm onCreate={(t) => ctx.create(t)} onCancel={() => setAdding(false)} /> : <button type="button" className="db-new-row" style={{ justifyContent: "center", minHeight: 120 }} onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" /> New</button>}
        </article>
      )}
    </div>
  );
}

function ListRows({ ctx, rows, preset, label }: { ctx: ViewContext; rows: QueryRow[]; preset?: Record<string, unknown>; label: string }) {
  const [adding, setAdding] = useState(false);
  return (
    <ul className="db-list" aria-label={label}>
      {rows.map((r) => (
        <li key={r.id}>
          {typeof r.metadata.icon === "string" && <span aria-hidden="true">{r.metadata.icon}</span>}
          <button type="button" className="db-row-open focus-ring" onClick={(e) => ctx.open(r, e)}>{title(r)}</button>
          <CardProps row={r} props={ctx.shown} max={3} />
        </li>
      ))}
      {ctx.canCreate && (
        <li>{adding ? <NewRowForm onCreate={(t) => ctx.create(t, preset)} onCancel={() => setAdding(false)} /> : <button type="button" className="db-new-row" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" /> New</button>}</li>
      )}
    </ul>
  );
}

export function ListView({ ctx }: { ctx: ViewContext }) {
  const groupDef = ctx.props.find((p) => p.key === ctx.view.groupBy);
  const { collapsed, toggle } = useCollapsed(ctx.view.id);
  if (!groupDef) return <ListRows ctx={ctx} rows={ctx.rows} label={`${ctx.view.name} list`} />;
  return (
    <>
      {shownGroups(groupRows(ctx.rows, groupDef), ctx.view).map((g) => {
        const open = !collapsed.has(groupKey(g.value));
        return (
          <section key={groupKey(g.value)} aria-label={g.label} className="db-group">
            <GroupHeader g={g} def={groupDef} open={open} onToggle={() => toggle(groupKey(g.value))} />
            {open && <ListRows ctx={ctx} rows={g.rows} label={`${g.label} list`} preset={groupPreset(groupDef, g.value)} />}
          </section>
        );
      })}
    </>
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

type CalItem = { row: QueryRow; first: string; last: string };
/** One week's multi-day bars: the visible stretch of each item, packed into lanes. */
function weekBars(items: CalItem[], week: string[]): Array<{ item: CalItem; from: number; len: number; lane: number; before: boolean; after: boolean }> {
  const out: Array<{ item: CalItem; from: number; len: number; lane: number; before: boolean; after: boolean }> = [];
  const laneEnd: number[] = [];
  const inWeek = items.filter((it) => it.first !== it.last && it.first <= week[6]! && it.last >= week[0]!).sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.last < b.last ? 1 : -1));
  for (const item of inWeek) {
    const from = item.first < week[0]! ? 0 : week.indexOf(item.first);
    const to = item.last > week[6]! ? 6 : week.indexOf(item.last);
    let lane = laneEnd.findIndex((end) => end < from);
    if (lane < 0) lane = laneEnd.length;
    laneEnd[lane] = to;
    out.push({ item, from, len: to - from + 1, lane, before: item.first < week[0]!, after: item.last > week[6]! });
  }
  return out;
}

const LOCKED_WHY = "kept in sync by an integration, so its date is changed where it comes from";
function CalChip({ row, ctx, anchorDay, className, style, label, editable, onLocked }: { row: QueryRow; ctx: ViewContext; anchorDay: string; className: string; style?: React.CSSProperties; label?: string; editable: boolean; /** Set when the row cannot be dragged because an integration owns it (hover / long-press says why). */ onLocked?: () => void }) {
  // One draggable per visible piece of an item (a bar has one per week it crosses).
  const drag = useDraggable({ id: `${row.id}@${anchorDay}`, data: { row, anchorDay }, disabled: !editable });
  return (
    <button ref={drag.setNodeRef} type="button" className={className} title={onLocked ? `${title(row)} — ${LOCKED_WHY}` : title(row)} aria-label={label}
      data-dragging={drag.isDragging || undefined} data-cal-item={row.id} data-locked={onLocked ? "" : undefined}
      onContextMenu={onLocked ? (e) => { e.preventDefault(); onLocked(); } : undefined}
      style={{ ...style, ...(drag.transform ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`, zIndex: 6, position: "relative" } : {}) }}
      {...drag.listeners}
      onClick={(e) => { if (isDragRelease(e)) { e.preventDefault(); return; } ctx.open(row, e); }}>{title(row)}</button>
  );
}
/** Where and when the last calendar drag was released. The click a browser sends after that
 *  mouseup must not open the page: dnd-kit swallows it only for 50 ms and Safari can deliver it
 *  later. Only a click at the release point, right after it, is that click. */
let lastCalendarDrop = { at: 0, x: NaN, y: NaN };
const noteCalendarDrop = (e: { activatorEvent: Event | null; delta: { x: number; y: number } }) => {
  const start = e.activatorEvent as MouseEvent | null;
  lastCalendarDrop = { at: Date.now(), x: (start?.clientX ?? NaN) + e.delta.x, y: (start?.clientY ?? NaN) + e.delta.y };
};
const isDragRelease = (e: { clientX: number; clientY: number }) =>
  Date.now() - lastCalendarDrop.at < 400 && Math.abs(e.clientX - lastCalendarDrop.x) <= 4 && Math.abs(e.clientY - lastCalendarDrop.y) <= 4;

function CalDay({ k, col, children, ...rest }: { k: string; col: number; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const drop = useDroppable({ id: `day:${k}`, data: { day: k } });
  return <div ref={drop.setNodeRef} {...rest} data-over={drop.isOver || undefined} data-day={k} style={{ gridColumn: col + 1 }}>{children}</div>;
}

export function CalendarView({ ctx, month, onMonth, onPickDate }: { ctx: ViewContext; month: Date; onMonth: (d: Date) => void; onPickDate: (key: string) => void }) {
  const key = ctx.view.dateKey;
  const [adding, setAdding] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );
  const days = monthGrid(month);
  // Every row with a date: the local day(s) it covers (a range spans first → last).
  const items = useMemo(() => {
    const out: CalItem[] = [];
    if (!key) return out;
    for (const r of ctx.rows) {
      const v = propertyValue(r, key);
      const span = typeof v === "string" ? daySpan(v) : null;
      if (span) out.push({ row: r, first: span[0], last: span[1] });
    }
    return out;
  }, [ctx.rows, key]);
  const byDay = useMemo(() => {
    const m = new Map<string, QueryRow[]>();
    for (const it of items) if (it.first === it.last) m.set(it.first, [...(m.get(it.first) ?? []), it.row]);
    return m;
  }, [items]);
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
  const dateDef = ctx.props.find((p) => p.key === key) ?? ({ key, label: key, kind: "date", options: [], tag: null, multiple: false, enumValues: [] } satisfies PropertyDef);
  // A page an integration keeps in sync (a calendar event, a ClickUp task, any ingest source)
  // is never rescheduled here: its date would be overwritten on the next sync, or drift from it.
  const locked = (r: QueryRow) => editableKey && !dateDef.system && ctx.canEditRow(r) && integrationOwned(r);
  const canMove = (r: QueryRow) => editableKey && !dateDef.system && ctx.canEditRow(r) && !integrationOwned(r);
  const whyLocked = (r: QueryRow) => (locked(r) ? () => setProblem(`“${title(r)}” is ${LOCKED_WHY}.`) : undefined);
  // Drag to reschedule (NP-DB-07): the item moves by whole days — its time of day and a
  // range's length are kept — through the same per-field compare-and-set as a cell edit.
  const onDragEnd = (e: DragEndEvent) => {
    noteCalendarDrop(e);
    const data = e.active.data.current as { row: QueryRow; anchorDay: string } | undefined;
    const target = (e.over?.data.current as { day?: string } | undefined)?.day;
    if (!data || !target || !canMove(data.row)) return;
    const current = propertyValue(data.row, key);
    const delta = dayDiff(data.anchorDay, target);
    if (typeof current !== "string" || !delta) return;
    setProblem("");
    ctx.commit(data.row, dateDef)(shiftDateValue(current, delta), current).catch((err: unknown) => {
      setProblem(err instanceof Error && /conflict|changed/i.test(`${err.name} ${err.message}`) ? `“${title(data.row)}” was changed somewhere else, so it was not moved. Try again.` : `“${title(data.row)}” could not be moved. Try again.`);
    });
  };
  const weeks = Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7));
  return (
    <div>
      <div className="db-cal-head">
        <h2>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <button type="button" className="db-icon-btn" aria-label="Previous month" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
        <button type="button" className="db-control" onClick={() => onMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</button>
        <button type="button" className="db-icon-btn" aria-label="Next month" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
      </div>
      {problem && <p className="db-notice" role="alert">{problem}</p>}
      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd} onDragCancel={noteCalendarDrop}>
        <div className="db-cal" role="grid" aria-label={`${ctx.view.name} calendar`}>
          <div className="db-cal-week db-cal-dows" role="row">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="db-cal-dow" role="columnheader">{d}</div>)}
          </div>
          {weeks.map((week) => {
            const keys = week.map(ymd);
            const bars = weekBars(items, keys);
            const lanes = bars.reduce((n, b) => Math.max(n, b.lane + 1), 0);
            return (
              <div key={keys[0]} className="db-cal-week" role="row">
                {week.map((d, col) => {
                  const k = keys[col]!;
                  const dayItems = byDay.get(k) ?? [];
                  return (
                    <CalDay key={k} k={k} col={col} role="gridcell" aria-label={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} className="db-cal-day" data-outside={d.getMonth() !== month.getMonth() || undefined} data-today={k === today || undefined}>
                      <div className="db-cal-num"><span>{d.getDate()}</span>
                        {ctx.canCreate && editableKey && <button type="button" className="db-cal-add" aria-label={`New page on ${k}`} onClick={() => setAdding(k)}><Plus size={13} aria-hidden="true" /></button>}
                      </div>
                      {/* Room for this week's multi-day bars, which are laid over the row. */}
                      {lanes > 0 && <div aria-hidden="true" style={{ height: lanes * 24, flex: "none" }} />}
                      {adding === k && <NewRowForm label={`New page on ${k}`} onCreate={(t) => ctx.create(t, { [key]: k })} onCancel={() => setAdding(null)} />}
                      {dayItems.slice(0, 3).map((r) => <CalChip key={r.id} row={r} ctx={ctx} anchorDay={k} className="db-cal-item" editable={canMove(r)} onLocked={whyLocked(r)} />)}
                      {dayItems.length > 3 && <span className="db-pop-path" style={{ marginLeft: 4 }}>+{dayItems.length - 3} more</span>}
                    </CalDay>
                  );
                })}
                {bars.map((b) => (
                  <CalChip key={`${b.item.row.id}@${keys[b.from]}`} row={b.item.row} ctx={ctx} anchorDay={keys[b.from]!} editable={canMove(b.item.row)} onLocked={whyLocked(b.item.row)}
                    className="db-cal-item db-cal-bar"
                    label={`${title(b.item.row)}, ${formatDate(`${b.item.first}/${b.item.last}`)}`}
                    style={{ gridColumn: `${b.from + 1} / span ${b.len}`, marginTop: 30 + b.lane * 24, ...(b.before ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 } : {}), ...(b.after ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : {}) }} />
                ))}
              </div>
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}
