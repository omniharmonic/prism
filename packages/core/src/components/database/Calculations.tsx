/**
 * View calculations (NP-DB-26): the footer figures of a database view.
 *
 * A figure is never computed from the rows on screen: `useDatabaseAggregates`
 * asks the query route (or, in a shell without it, the same pure engine over the
 * shell's listing) for the calculation over EVERY row the viewer can see that
 * matches the view's filter and search. What a view calculates is saved in
 * `view.calculations` ({propertyKey: fn}); people who cannot save the view change
 * it for their session, like every other view setting.
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { AGGREGATE_FNS, computeAggregates, MAX_AGGREGATES, type AggregateFn, type AggregateGroup, type AggregateRequest, type AggregateValue, type AggregateValues } from "../../lib/database/query";
import { formatDate, formatNumber, type PropertyDef } from "../../lib/database/schema";
import { Popover } from "./Popover";
import type { DatabaseView } from "./config";

export const CALC_LABELS: Record<AggregateFn, string> = {
  count_all: "Count all", count_values: "Count values", count_unique: "Count unique values", count_empty: "Count empty", count_not_empty: "Count not empty",
  percent_empty: "Percent empty", percent_not_empty: "Percent not empty",
  sum: "Sum", average: "Average", median: "Median", min: "Min", max: "Max", range: "Range",
  earliest: "Earliest date", latest: "Latest date", date_range: "Date range",
  checked: "Checked", unchecked: "Unchecked", percent_checked: "Percent checked",
};
/** The small label beside a figure. */
const CALC_SHORT: Record<AggregateFn, string> = {
  count_all: "Count", count_values: "Values", count_unique: "Unique", count_empty: "Empty", count_not_empty: "Not empty",
  percent_empty: "Empty", percent_not_empty: "Not empty",
  sum: "Sum", average: "Average", median: "Median", min: "Min", max: "Max", range: "Range",
  earliest: "Earliest", latest: "Latest", date_range: "Range",
  checked: "Checked", unchecked: "Unchecked", percent_checked: "Checked",
};
/** How a sentence names a figure: "Sum of Amount". */
const CALC_PHRASE: Record<AggregateFn, string> = {
  count_all: "Count of", count_values: "Values in", count_unique: "Unique values in", count_empty: "Empty in", count_not_empty: "Not empty in",
  percent_empty: "Percent empty in", percent_not_empty: "Percent not empty in",
  sum: "Sum of", average: "Average of", median: "Median of", min: "Minimum of", max: "Maximum of", range: "Range of",
  earliest: "Earliest", latest: "Latest", date_range: "Date range of",
  checked: "Checked in", unchecked: "Unchecked in", percent_checked: "Percent checked in",
};

const COUNT: AggregateFn[] = ["count_all", "count_values", "count_unique", "count_empty", "count_not_empty"];
const PERCENT: AggregateFn[] = ["percent_empty", "percent_not_empty"];
const NUMBER: AggregateFn[] = ["sum", "average", "median", "min", "max", "range"];
const DATE: AggregateFn[] = ["earliest", "latest", "date_range"];
const CHECK: AggregateFn[] = ["checked", "unchecked", "percent_checked"];

/** The calculations a property offers, by family (the menu's sections). */
export function calcFamilies(def: Pick<PropertyDef, "kind">): Array<{ label: string; fns: AggregateFn[] }> {
  const out = [{ label: "Count", fns: COUNT }, { label: "Percent", fns: PERCENT }];
  if (def.kind === "number") out.push({ label: "Number", fns: NUMBER });
  if (def.kind === "date") out.push({ label: "Date", fns: DATE });
  if (def.kind === "checkbox") out.unshift({ label: "Checkbox", fns: CHECK });
  return out;
}
export const calcOffered = (def: Pick<PropertyDef, "kind">, fn: AggregateFn): boolean => calcFamilies(def).some((f) => f.fns.includes(fn));

const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;
/** Whole days as people say them: days up to two months, then months, then years. */
export function formatDaySpan(days: number): string {
  if (days < 60) return plural(days, "day");
  if (days < 730) return plural(Math.round(days / 30.44), "month");
  const years = Math.round((days / 365.25) * 10) / 10;
  return `${years.toLocaleString()} ${years === 1 ? "year" : "years"}`;
}

/** A figure as text. `—` when the rows hold nothing to calculate from. */
export function formatCalc(fn: AggregateFn, value: AggregateValue | undefined, def?: Pick<PropertyDef, "format">): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return formatDate(value);
  switch (fn) {
    case "percent_empty":
    case "percent_not_empty":
    case "percent_checked": return value.toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 });
    case "date_range": return formatDaySpan(value);
    case "sum":
    case "min":
    case "max":
    case "range": return formatNumber(Math.round(value * 1e6) / 1e6, def?.format === "number" ? "comma" : def?.format);
    case "average":
    case "median": return formatNumber(Math.round(value * 100) / 100, def?.format === "number" ? "comma" : def?.format);
    default: return value.toLocaleString();
  }
}
/** Figures that can only grow when more rows are counted: a partial scan is a lower bound. */
const LOWER_BOUND = new Set<AggregateFn>(["count_all", "count_values", "count_unique", "count_empty", "count_not_empty", "checked", "unchecked", "max", "range", "date_range"]);
const partialText = (fn: AggregateFn, text: string, partial: boolean) => (!partial || text === "—" ? text : LOWER_BOUND.has(fn) ? `≥ ${text}` : `${text} (partial)`);
/** "Sum of Amount: 1,240" — what a screen reader hears and a tooltip shows. */
export const calcSentence = (fn: AggregateFn, label: string, text: string): string => `${CALC_PHRASE[fn]} ${label}: ${text}`;

/** What a view layout needs to draw and change its calculations. */
export interface CalcState {
  /** The view's setting: property key → function. */
  chosen: Record<string, AggregateFn>;
  /** Figures over the whole view; null until the first answer. */
  total: AggregateValues | null;
  /** Per group value (`groupBy` views); null until answered / when not grouped. */
  groups: Map<string | null, AggregateGroup> | null;
  /** Matching rows the viewer can see; null until the first answer. */
  count: number | null;
  /** The figures cover only part of the view (the server's scan cap or its work budget). */
  partial: boolean;
  /** Some groups are missing from the answer: a missing group was not counted (it is not empty). */
  groupsCapped?: boolean;
  /** The answer is for exactly what is asked now (not the previous answer kept while loading). */
  settled?: boolean;
  /** Change (or clear, with null) a property's calculation. */
  set: (key: string, fn: AggregateFn | null) => void;
}

/** The `{key, fn}` list a view asks the query for (only properties that still exist). */
export function calcRequests(view: Pick<DatabaseView, "calculations">, props: PropertyDef[]): AggregateRequest[] {
  const out: AggregateRequest[] = [];
  for (const [key, fn] of Object.entries(view.calculations ?? {})) {
    if (out.length >= MAX_AGGREGATES) break;
    if (props.some((p) => p.key === key) && (AGGREGATE_FNS as readonly string[]).includes(fn)) out.push({ key, fn });
  }
  return out;
}
/** `view.calculations` with one entry changed; undefined when none are left. */
export function withCalculation(current: Record<string, AggregateFn> | undefined, key: string, fn: AggregateFn | null): Record<string, AggregateFn> | undefined {
  const next = { ...(current ?? {}) };
  if (fn === null) delete next[key];
  else if (key in next || Object.keys(next).length < MAX_AGGREGATES) next[key] = fn;
  return Object.keys(next).length ? next : undefined;
}

/** A group the answer left out although it may hold rows (groups were cut, or the scan was partial). */
const notCounted = (calc: CalcState, group?: { value: string | null }): boolean =>
  !!group && !!calc.groups && !calc.groups.has(group.value) && (calc.groupsCapped === true || calc.partial);
/**
 * The figures for the view or for one group; null until answered. A group a
 * COMPLETE answer does not list has no rows: its figures are those of an empty set.
 */
function valuesFor(calc: CalcState, group?: { value: string | null }): AggregateValues | null {
  if (!group) return calc.total;
  if (!calc.groups) return null;
  return calc.groups.get(group.value)?.aggregates ?? computeAggregates([], Object.entries(calc.chosen).map(([key, fn]) => ({ key, fn }))).aggregates;
}
/**
 * A figure that has not arrived yet: no answer, or the previous answer is still
 * shown while the next loads. An answer that arrived WITHOUT the figure (an older
 * or stricter server) is not pending — it reads "—", never "…" forever.
 */
const pendingValue = (calc: CalcState, values: AggregateValues | null, v: AggregateValue | undefined): boolean => v === undefined && (values === null || calc.settled === false);
const NOT_COUNTED = "partial";
const NOT_COUNTED_SPOKEN = "not counted";
const NOT_COUNTED_WHY = "This view has more groups or values than are calculated at once: this group was not counted";
const PARTIAL_WHY = "This database is very large: the figure covers the first pages scanned";

/** One figure: small label + value, with the full sentence for assistive tech. */
function Figure({ fn, def, value, partial, pending, missing }: { fn: AggregateFn; def: PropertyDef; value: AggregateValue | undefined; partial: boolean; pending: boolean; missing: boolean }) {
  const text = missing ? NOT_COUNTED : pending ? "…" : partialText(fn, formatCalc(fn, value, def), partial);
  return (
    <>
      <span className="db-calc-label" aria-hidden="true">{CALC_SHORT[fn]}</span>
      <span className="db-calc-value" aria-hidden="true" data-calc-value={pending ? undefined : text}>{text}</span>
    </>
  );
}

/** The menu of a footer cell: None + the property's families. */
function CalcMenu({ def, current, onPick }: { def: PropertyDef; current: AggregateFn | undefined; onPick: (fn: AggregateFn | null) => void }) {
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    e.preventDefault();
    items[next]?.focus();
  };
  return (
    <div className="db-menu db-calc-menu" role="menu" aria-label={`Calculate ${def.label}`} onKeyDown={onKey}>
      <button type="button" role="menuitemradio" aria-checked={!current} onClick={() => onPick(null)}><span className="db-calc-check" aria-hidden="true">{!current && <Check size={13} />}</span> None</button>
      {calcFamilies(def).map((family) => (
        <div key={family.label} role="group" aria-label={family.label} className="db-calc-family">
          <p className="db-pop-heading" aria-hidden="true">{family.label}</p>
          {family.fns.map((fn) => (
            <button key={fn} type="button" role="menuitemradio" aria-checked={current === fn} onClick={() => onPick(fn)}>
              <span className="db-calc-check" aria-hidden="true">{current === fn && <Check size={13} />}</span> {CALC_LABELS[fn]}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A table footer cell: the chosen figure, or "Calculate" on hover / focus; opens the menu. */
export function CalcCell({ def, calc, group }: { def: PropertyDef; calc: CalcState; group?: { value: string | null; label: string } }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const fn = calc.chosen[def.key];
  const values = valuesFor(calc, group);
  const value = fn ? values?.[def.key]?.[fn] : undefined;
  const missing = !!fn && notCounted(calc, group);
  const pending = !!fn && !missing && pendingValue(calc, values, value);
  const text = fn ? (missing ? NOT_COUNTED_SPOKEN : pending ? "…" : partialText(fn, formatCalc(fn, value, def), calc.partial)) : "";
  const where = group ? ` in ${group.label}` : "";
  return (
    <td className="db-calc-cell">
      <button ref={anchor} type="button" className="db-calc-btn focus-ring" data-empty={fn ? undefined : ""} aria-haspopup="menu" aria-expanded={open}
        aria-label={fn ? `${calcSentence(fn, def.label, text)}${where}${calc.partial ? " (only part of this very large database was counted)" : ""}` : `Calculate ${def.label}${where}`}
        title={fn && missing ? NOT_COUNTED_WHY : fn && calc.partial ? PARTIAL_WHY : undefined}
        onClick={() => setOpen((o) => !o)}>
        {fn ? <Figure fn={fn} def={def} value={value} partial={calc.partial} pending={pending} missing={missing} /> : <span className="db-calc-prompt" data-print="hide"><span className="db-calc-label">Calculate</span><ChevronDown size={12} aria-hidden="true" /></span>}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={`Calculate ${def.label}`} width={230}>
        <CalcMenu def={def} current={fn} onPick={(next) => { setOpen(false); calc.set(def.key, next); anchor.current?.focus(); }} />
      </Popover>
    </td>
  );
}

/** The frozen first footer cell: how many rows (of the view, or of the group). */
export function CalcCountCell({ calc, group, loaded }: { calc: CalcState; group?: { value: string | null; label: string }; loaded: number }) {
  const n = group ? calc.groups?.get(group.value)?.count ?? loaded : calc.count ?? loaded;
  // A group the answer left out: the rows loaded so far are all that is known of it.
  const text = partialText("count_all", n.toLocaleString(), calc.partial || notCounted(calc, group));
  return (
    <th scope="row" className="db-sticky db-calc-cell db-calc-count" aria-label={`Count${group ? ` in ${group.label}` : ""}: ${text}`}>
      <span className="db-calc-static"><span className="db-calc-label">Count</span><span className="db-calc-value" data-calc-value={text}>{text}</span></span>
    </th>
  );
}

/**
 * Read-only figures in a row (group headers, board columns, list / gallery
 * footers, the grand total under a grouped table when laid out as text).
 */
export function CalcSummary({ calc, props, group, className = "" }: { calc: CalcState; props: PropertyDef[]; group?: { value: string | null }; className?: string }) {
  const values = valuesFor(calc, group);
  const items = Object.entries(calc.chosen).map(([key, fn]) => ({ fn, def: props.find((p) => p.key === key) })).filter((x): x is { fn: AggregateFn; def: PropertyDef } => !!x.def);
  if (!items.length) return null;
  return (
    <span className={`db-calc-summary ${className}`}>
      {items.map(({ fn, def }) => {
        const value = values?.[def.key]?.[fn];
        const missing = notCounted(calc, group);
        const pending = !missing && pendingValue(calc, values, value);
        const text = missing ? NOT_COUNTED : pending ? "…" : partialText(fn, formatCalc(fn, value, def), calc.partial);
        return (
          <span key={def.key} className="db-calc-chip" data-calc={def.key} title={missing ? NOT_COUNTED_WHY : CALC_LABELS[fn]}>
            <span className="db-sr-only">{calcSentence(fn, def.label, missing ? NOT_COUNTED_SPOKEN : text)}</span>
            <span aria-hidden="true" className="db-calc-label">{CALC_SHORT[fn]} · {def.label}</span>
            <span aria-hidden="true" className="db-calc-value" data-calc-value={pending ? undefined : text}>{text}</span>
          </span>
        );
      })}
    </span>
  );
}

/** The footer under a list or gallery: the row count and the view's figures. */
export function CalcFooter({ calc, props, loaded, label }: { calc: CalcState; props: PropertyDef[]; loaded: number; label: string }) {
  const n = calc.count ?? loaded;
  const text = partialText("count_all", n.toLocaleString(), calc.partial);
  return (
    <p className="db-calc-footer" role="group" aria-label={label}>
      <span className="db-calc-chip" data-calc="$count"><span className="db-calc-label">Count</span><span className="db-calc-value" data-calc-value={text}>{text}</span></span>
      <CalcSummary calc={calc} props={props} />
    </p>
  );
}

/**
 * Arrow keys between a table's body and its footer (the grid keyboard model):
 * ↓ on the last row moves to that column's footer cell, ↑ from the footer back,
 * ← / → along the footer. Enter on a footer cell opens its menu (it is a button).
 * Returns true when the key was taken.
 */
export function calcGridKey(e: ReactKeyboardEvent<HTMLTableElement>): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return false;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select, [contenteditable='true']")) return false;
  const cellEl = t.closest("td, th");
  const rowEl = cellEl?.parentElement;
  const table = e.currentTarget;
  if (!cellEl || !rowEl || !table.contains(cellEl)) return false;
  const col = Array.from(rowEl.children).indexOf(cellEl);
  const foot = table.querySelector<HTMLElement>("tfoot > tr");
  const focusIn = (el: Element | null | undefined, selector: string) => {
    const target = el?.querySelector<HTMLElement>(selector);
    if (!target) return false;
    e.preventDefault();
    target.focus();
    return true;
  };
  if (rowEl.parentElement?.tagName === "TFOOT") {
    if (e.key === "ArrowDown") return false;
    if (e.key === "ArrowUp") {
      const rows = table.querySelectorAll<HTMLElement>("tbody > tr[data-row-id]");
      return focusIn(rows[rows.length - 1]?.children[col], ".db-value-button:not(:disabled), .db-row-open");
    }
    const step = e.key === "ArrowRight" ? 1 : -1;
    for (let c = col + step; c >= 0 && c < rowEl.children.length; c += step) if (focusIn(rowEl.children[c], ".db-calc-btn")) return true;
    e.preventDefault();
    return true;
  }
  if (e.key !== "ArrowDown" || !foot || !rowEl.hasAttribute("data-row-id")) return false;
  const rows = table.querySelectorAll<HTMLElement>("tbody > tr[data-row-id]");
  if (rows[rows.length - 1] !== rowEl) return false;
  // The title column has no calculation of its own: its ↓ lands on the first one.
  for (let c = Math.max(col, 1); c < foot.children.length; c++) if (focusIn(foot.children[c], ".db-calc-btn")) return true;
  return false;
}

/** View settings → Calculations: for layouts without a footer cell per column (board, list, gallery). */
export function CalcSettings({ view, props, onChange }: { view: DatabaseView; props: PropertyDef[]; onChange: (patch: Partial<DatabaseView>) => void }) {
  const chosen = view.calculations ?? {};
  const entries = Object.entries(chosen).filter(([k]) => props.some((p) => p.key === k));
  const free = props.filter((p) => !(p.key in chosen));
  const set = (key: string, fn: AggregateFn | null) => onChange({ calculations: withCalculation(view.calculations, key, fn) });
  const options = (def: PropertyDef): ReactNode => calcFamilies(def).map((f) => <optgroup key={f.label} label={f.label}>{f.fns.map((fn) => <option key={fn} value={fn}>{CALC_LABELS[fn]}</option>)}</optgroup>);
  return (
    <div>
      <p className="db-pop-heading">Calculations</p>
      <ul className="db-visible-list" aria-label="Calculations">
        {entries.map(([key, fn]) => {
          const def = props.find((p) => p.key === key)!;
          return (
            <li key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{def.label}</span>
              <select aria-label={`Calculation for ${def.label}`} value={fn} onChange={(e) => set(key, e.target.value as AggregateFn)}>
                {!calcOffered(def, fn) && <option value={fn}>{CALC_LABELS[fn]}</option>}
                {options(def)}
              </select>
              <button type="button" className="db-icon-btn" aria-label={`Remove calculation for ${def.label}`} onClick={() => set(key, null)}><X size={14} /></button>
            </li>
          );
        })}
        {!entries.length && <li className="db-pop-empty">None. Add one to see a total for this view{view.groupBy ? " and each group" : ""}.</li>}
      </ul>
      {free.length > 0 && entries.length < MAX_AGGREGATES && (
        <select aria-label="Add a calculation" className="db-control" value="" onChange={(e) => {
          const def = props.find((p) => p.key === e.target.value);
          if (def) set(def.key, def.kind === "number" ? "sum" : def.kind === "checkbox" ? "checked" : def.kind === "date" ? "date_range" : "count_not_empty");
        }}>
          <option value="">Add a calculation…</option>
          {free.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      )}
    </div>
  );
}
