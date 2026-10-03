/**
 * Filter builder, sort builder and view settings for a database view. Each edits
 * a draft of the view and hands it back through `onChange`; the renderer decides
 * whether that is saved to the database note or kept for this session only.
 */
import { useState } from "react";
import { ArrowLeft, ArrowRight, Copy, Plus, Trash2, X } from "lucide-react";
import type { QueryCondition, QueryFilter, QueryFilterGroup, QueryOp, QuerySort } from "../../lib/database/query";
import { STATUS_GROUP_LABELS, STATUS_GROUPS, SYSTEM_PROPERTIES, type PropertyDef } from "../../lib/database/schema";
import { VIEW_LABELS, VIEW_TYPES, type DatabaseView, type ViewType } from "./config";

/** Title + timestamps + every property, as filter/sort targets. */
export function filterTargets(props: PropertyDef[]): Array<{ key: string; label: string; def?: PropertyDef }> {
  const own = props.filter((p) => !p.system);
  return [
    { key: "$title", label: "Title" },
    ...own.map((p) => ({ key: p.key, label: p.label, def: p })),
    // System properties (created/edited time/by) are always filterable and sortable.
    ...SYSTEM_PROPERTIES.map((p) => ({ key: p.key, label: p.label, def: p })),
  ];
}

const OP_LABELS: Record<QueryOp, string> = {
  eq: "is", ne: "is not", in: "is any of", nin: "is none of", contains: "contains", not_contains: "does not contain",
  gt: "is after / above", gte: "is on or after", lt: "is before / below", lte: "is on or before",
  exists: "is not empty", not_exists: "is empty",
};

function opsFor(def?: PropertyDef): QueryOp[] {
  if (!def) return ["contains", "not_contains", "eq", "ne", "gt", "lt", "exists", "not_exists"];
  switch (def.kind) {
    case "checkbox": return ["eq"];
    case "number":
    case "date": return ["eq", "ne", "gt", "gte", "lt", "lte", "exists", "not_exists"];
    case "select":
    case "status": return ["eq", "ne", "exists", "not_exists"];
    case "email":
    case "phone":
    case "url": return ["contains", "not_contains", "eq", "ne", "exists", "not_exists"];
    case "files": return ["exists", "not_exists"];
    case "multi_select":
    case "person":
    case "relation": return ["contains", "not_contains", "exists", "not_exists"];
    default: return ["contains", "not_contains", "eq", "ne", "exists", "not_exists"];
  }
}

function ValueInput({ def, cond, onChange }: { def?: PropertyDef; cond: QueryCondition; onChange: (v: unknown) => void }) {
  if (cond.op === "exists" || cond.op === "not_exists") return <span />;
  if (def?.kind === "checkbox") {
    return (
      <select aria-label="Filter value" value={String(cond.value ?? "true")} onChange={(e) => onChange(e.target.value === "true")}>
        <option value="true">Checked</option>
        <option value="false">Unchecked</option>
      </select>
    );
  }
  if ((def?.kind === "select" || def?.kind === "status") && def.options.length) {
    return (
      <select aria-label="Filter value" value={String(cond.value ?? "")} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {def.kind === "status" && def.options.some((o) => o.group)
          ? STATUS_GROUPS.map((g) => {
              const inGroup = def.options.filter((o) => (o.group ?? "in_progress") === g);
              return inGroup.length ? <optgroup key={g} label={STATUS_GROUP_LABELS[g]}>{inGroup.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup> : null;
            })
          : def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  const date = def?.kind === "date" || cond.key === "$createdAt" || cond.key === "$updatedAt";
  return (
    <input aria-label="Filter value" type={date ? "date" : def?.kind === "number" ? "number" : "text"}
      value={String(cond.value ?? "")} onChange={(e) => onChange(def?.kind === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />
  );
}

function ConditionRow({ c, i, prefix, targets, onChange, onRemove }: {
  c: QueryCondition; i: number; prefix: string; targets: ReturnType<typeof filterTargets>;
  onChange: (patch: Partial<QueryCondition>) => void; onRemove: () => void;
}) {
  const defOf = (key: string) => targets.find((t) => t.key === key)?.def;
  const def = defOf(c.key);
  return (
    <div className="db-cond">
      <select aria-label={`${prefix}${i + 1} property`} value={c.key} onChange={(e) => {
        const nd = defOf(e.target.value);
        onChange({ key: e.target.value, op: opsFor(nd)[0]!, value: nd?.kind === "checkbox" ? true : "" });
      }}>
        {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
      <select aria-label={`${prefix}${i + 1} operator`} value={c.op} onChange={(e) => onChange({ op: e.target.value as QueryOp })}>
        {opsFor(def).map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
      </select>
      <ValueInput def={def} cond={c} onChange={(value) => onChange({ value })} />
      <button type="button" className="db-icon-btn" aria-label={`Remove ${prefix.toLowerCase()}${i + 1}`} onClick={onRemove}><X size={14} /></button>
    </div>
  );
}

/**
 * Simple filter chips plus advanced AND/OR groups (one level, like Notion's
 * "Add filter group"): the top-level match combines conditions AND groups, each
 * group combines its own conditions. Saved per view by the caller.
 */
export function FilterEditor({ filter, props, onChange }: { filter?: QueryFilter; props: PropertyDef[]; onChange: (f: QueryFilter | undefined) => void }) {
  const targets = filterTargets(props);
  const f: QueryFilter = filter ?? { match: "all", conditions: [] };
  const groups = f.groups ?? [];
  const emit = (next: QueryFilter) => onChange(next.conditions.length || next.groups?.length ? { match: next.match, conditions: next.conditions, ...(next.groups?.length ? { groups: next.groups } : {}) } : undefined);
  const set = (conditions: QueryCondition[], match = f.match) => emit({ match, conditions, groups });
  const setGroups = (gs: QueryFilterGroup[]) => emit({ match: f.match, conditions: f.conditions, groups: gs });
  const fresh = (): QueryCondition => {
    const t = targets[1] ?? targets[0]!;
    return { key: t.key, op: opsFor(t.def)[0]!, value: t.def?.kind === "checkbox" ? true : "" };
  };
  const terms = f.conditions.length + groups.length;
  return (
    <div className="db-settings" aria-label="Filter">
      {terms > 1 && (
        <div className="db-settings-row">
          <span>Show rows matching</span>
          <select aria-label="Match" value={f.match} onChange={(e) => emit({ ...f, groups, match: e.target.value as "all" | "any" })}>
            <option value="all">all of these</option>
            <option value="any">any of these</option>
          </select>
        </div>
      )}
      {f.conditions.map((c, i) => (
        <ConditionRow key={i} c={c} i={i} prefix="Condition " targets={targets}
          onChange={(patch) => set(f.conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
          onRemove={() => set(f.conditions.filter((_, j) => j !== i))} />
      ))}
      {groups.map((g, gi) => {
        const setG = (patch: Partial<QueryFilterGroup>) => setGroups(groups.map((x, j) => (j === gi ? { ...x, ...patch } : x)));
        return (
          <fieldset key={gi} className="db-filter-group" aria-label={`Filter group ${gi + 1}`}>
            <div className="db-settings-row">
              <span>Group {gi + 1}: rows matching</span>
              <select aria-label={`Group ${gi + 1} match`} value={g.match} onChange={(e) => setG({ match: e.target.value as "all" | "any" })}>
                <option value="all">all</option>
                <option value="any">any</option>
              </select>
              <button type="button" className="db-icon-btn" aria-label={`Remove group ${gi + 1}`} onClick={() => setGroups(groups.filter((_, j) => j !== gi))}><Trash2 size={13} /></button>
            </div>
            {g.conditions.map((c, i) => (
              <ConditionRow key={i} c={c} i={i} prefix={`Group ${gi + 1} condition `} targets={targets}
                onChange={(patch) => setG({ conditions: g.conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)) })}
                onRemove={() => setG({ conditions: g.conditions.filter((_, j) => j !== i) })} />
            ))}
            <button type="button" className="db-ghost" onClick={() => setG({ conditions: [...g.conditions, fresh()] })}><Plus size={13} aria-hidden="true" /> Add condition to group {gi + 1}</button>
          </fieldset>
        );
      })}
      {!terms && <p className="db-pop-empty">No filters. Every row is shown.</p>}
      <div className="db-settings-row">
        <button type="button" className="db-ghost" onClick={() => set([...f.conditions, fresh()])}><Plus size={13} aria-hidden="true" /> Add filter</button>
        {groups.length < 5 && <button type="button" className="db-ghost" onClick={() => setGroups([...groups, { match: "any", conditions: [fresh()] }])}><Plus size={13} aria-hidden="true" /> New filter group</button>}
        {terms > 0 && <button type="button" className="db-ghost" onClick={() => onChange(undefined)}>Clear all</button>}
      </div>
    </div>
  );
}

export function SortEditor({ sort, props, onChange }: { sort?: QuerySort[]; props: PropertyDef[]; onChange: (s: QuerySort[] | undefined) => void }) {
  const targets = filterTargets(props);
  const list = sort ?? [];
  const set = (next: QuerySort[]) => onChange(next.length ? next : undefined);
  return (
    <div className="db-settings" aria-label="Sort">
      {list.map((s, i) => (
        <div className="db-cond" key={i} style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr) 32px" }}>
          <select aria-label={`Sort ${i + 1} property`} value={s.key} onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}>
            {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <select aria-label={`Sort ${i + 1} direction`} value={s.dir} onChange={(e) => set(list.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button type="button" className="db-icon-btn" aria-label={`Remove sort ${i + 1}`} onClick={() => set(list.filter((_, j) => j !== i))}><X size={14} /></button>
        </div>
      ))}
      {!list.length && <p className="db-pop-empty">Sorted by last edited.</p>}
      {list.length < 3 && (
        <button type="button" className="db-ghost" onClick={() => set([...list, { key: targets[1]?.key ?? "$title", dir: "asc" }])}><Plus size={13} aria-hidden="true" /> Add sort</button>
      )}
    </div>
  );
}

/** Properties (visible + order), grouping, date/cover keys, rename/delete. */
export function ViewSettings({ view, props, canDelete, onChange, onDelete, tabs, deleted }: {
  view: DatabaseView; props: PropertyDef[]; canDelete: boolean;
  onChange: (patch: Partial<DatabaseView>) => void; onDelete: () => void;
  /** Duplicate / reorder this view among the tabs (NP-DB-16). */
  tabs?: { index: number; count: number; canDuplicate: boolean; onDuplicate: () => void; onMove: (to: number) => void };
  /** Deleted (hidden-everywhere) properties the viewer may restore, and how to open one. */
  deleted?: { props: PropertyDef[]; onOpen: (def: PropertyDef) => void };
}) {
  const [name, setName] = useState(view.name);
  const visible = view.visible ?? props.map((p) => p.key);
  const groupable = props.filter((p) => !p.system && (p.kind === "select" || p.kind === "status" || p.kind === "checkbox" || p.kind === "person" || (view.type !== "board" && p.kind === "multi_select")));
  const dates = props.filter((p) => p.kind === "date");
  const urls = props.filter((p) => p.kind === "url" || /cover|image|thumbnail/i.test(p.key));
  const toggle = (key: string) => {
    const next = visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key];
    onChange({ visible: next });
  };
  const move = (key: string, dir: -1 | 1) => {
    const i = visible.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= visible.length) return;
    const next = [...visible];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange({ visible: next });
  };
  return (
    <div className="db-settings" aria-label="View settings">
      <label className="db-field">
        <span>View name</span>
        <input aria-label="View name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name.trim() && name.trim() !== view.name) onChange({ name: name.trim() }); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </label>
      <label className="db-field">
        <span>Layout</span>
        <select aria-label="Layout" value={view.type} onChange={(e) => onChange({ type: e.target.value as ViewType })}>
          {VIEW_TYPES.map((t) => <option key={t} value={t}>{VIEW_LABELS[t]}</option>)}
        </select>
      </label>
      {(view.type === "board" || view.type === "table" || view.type === "list") && (
        <label className="db-field">
          <span>Group by</span>
          <select aria-label="Group by" value={view.groupBy ?? ""} onChange={(e) => onChange({ groupBy: e.target.value || undefined })}>
            {view.type !== "board" && <option value="">None</option>}
            {view.type === "board" && !view.groupBy && <option value="">Choose…</option>}
            {groupable.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
      )}
      {view.type === "calendar" && (
        <label className="db-field">
          <span>Show by date</span>
          <select aria-label="Date property" value={view.dateKey ?? ""} onChange={(e) => onChange({ dateKey: e.target.value || undefined })}>
            <option value="">Choose…</option>
            {dates.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            <option value="$createdAt">Created</option>
          </select>
        </label>
      )}
      {view.type === "gallery" && (
        <label className="db-field">
          <span>Card cover</span>
          <select aria-label="Card cover" value={view.coverKey ?? ""} onChange={(e) => onChange({ coverKey: e.target.value || undefined })}>
            <option value="">Page icon</option>
            {urls.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
      )}
      <div>
        <p className="db-pop-heading">Properties</p>
        <ul className="db-visible-list" aria-label="Visible properties">
          {[...visible.filter((k) => props.some((p) => p.key === k)), ...props.map((p) => p.key).filter((k) => !visible.includes(k))].map((key) => {
            const p = props.find((x) => x.key === key)!;
            const on = visible.includes(key);
            return (
              <li key={key} style={{ display: "flex", alignItems: "center" }}>
                <label style={{ flex: 1 }}>
                  <input type="checkbox" checked={on} onChange={() => toggle(key)} />
                  {p.label}
                </label>
                {on && <>
                  <button type="button" className="db-icon-btn" aria-label={`Move ${p.label} earlier`} onClick={() => move(key, -1)}>↑</button>
                  <button type="button" className="db-icon-btn" aria-label={`Move ${p.label} later`} onClick={() => move(key, 1)}>↓</button>
                </>}
              </li>
            );
          })}
          {!props.length && <li className="db-pop-empty">This tag has no properties yet.</li>}
        </ul>
      </div>
      {deleted && deleted.props.length > 0 && (
        <div>
          <p className="db-pop-heading">Deleted properties</p>
          <ul className="db-visible-list" aria-label="Deleted properties">
            {deleted.props.map((p) => (
              <li key={p.key} style={{ display: "flex", alignItems: "center" }}>
                <span style={{ flex: 1 }} className="db-pop-empty">{p.label}</span>
                <button type="button" className="db-ghost" aria-label={`Manage deleted property ${p.label}`} onClick={() => deleted.onOpen(p)}>Restore or remove…</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tabs && (
        <div className="db-settings-row" role="group" aria-label="View tab">
          <button type="button" className="db-ghost" disabled={!tabs.canDuplicate} onClick={tabs.onDuplicate}><Copy size={13} aria-hidden="true" /> Duplicate view</button>
          <span style={{ display: "inline-flex", gap: 2 }}>
            <button type="button" className="db-icon-btn" aria-label="Move view left" disabled={tabs.index <= 0} onClick={() => tabs.onMove(tabs.index - 1)}><ArrowLeft size={14} aria-hidden="true" /></button>
            <button type="button" className="db-icon-btn" aria-label="Move view right" disabled={tabs.index >= tabs.count - 1} onClick={() => tabs.onMove(tabs.index + 1)}><ArrowRight size={14} aria-hidden="true" /></button>
          </span>
        </div>
      )}
      {canDelete && (
        <button type="button" className="db-ghost" style={{ color: "var(--color-danger)" }} onClick={onDelete}><Trash2 size={13} aria-hidden="true" /> Delete view</button>
      )}
    </div>
  );
}
