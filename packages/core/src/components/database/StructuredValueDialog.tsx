/**
 * The editor for a STRUCTURED property value — a list of items such as
 * `members: [{name, role}]`, or one object. Rows are the items, columns the fields
 * they have; a cell is text, a number or a yes/no; rows can be added, removed and
 * reordered. A field that holds a page link offers the page picker.
 *
 * It writes the WHOLE value back in its own shape through `useStructuredWriter`
 * (`POST /api/properties/:id/structured`, compare-and-set on the value loaded here).
 * 🔒 Everything the dialog does not show is kept: nested objects and lists inside an
 * item, fields beyond the columns shown, items beyond the rows shown, items that are
 * not objects, a field present on only some rows, the order of every item's fields
 * (`lib/database/structuredEdit.ts` — the model, tested without a browser).
 *
 * A MODAL, built the way the app builds its modals: a native `<dialog>` opened with
 * `showModal()` (the browser keeps focus inside, makes the rest inert, and puts it in
 * the top layer — so it also works when opened from the phone's "Document panel",
 * itself a modal) with the database dialog look (`.db-dialog-wrap` / `.db-dialog`, full
 * screen on a phone). Escape and the backdrop close it; closing with unsaved changes
 * asks first, in the dialog (never a browser prompt); focus returns to "Edit…". The
 * page picker is part of the dialog (a body-level popover would sit under a modal).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Link2, Plus, Search, Trash2, X } from "lucide-react";
import type { RelationCandidate } from "../../lib/database/relations";
import { PropertyConflictError, VaultRequestError } from "../../data/VaultClient";
import { StructuredEditError, useLinkCandidates, useStructuredWriter } from "../../lib/database/hooks";
import { asWikilink, linkLabel, type RelationTarget } from "../../lib/database/schema";
import { isStructuredValue, valueText } from "../../lib/database/structured";
import {
  blankItem, buildValue, cellOf, clearItemKey, columnsOf, columnType, isBlankItem, isLinkColumn, itemsOf, parseCell,
  sameStructured, sameTopShape, setItemKey, validateStructuredValue, MAX_EDIT_COLUMNS, MAX_EDIT_ROWS, type CellType,
} from "../../lib/database/structuredEdit";
import "./database.css";

interface Row {
  /** Stable for the life of the dialog (React key, focus target). */
  id: number;
  item: unknown;
  /** The item as loaded; undefined for a row added here. */
  original: unknown;
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const PERSON_COLUMN = /^(person|people|member|owner|assignee|sponsor|attendee|contact)s?$/i;
const humanize = (key: string): string => { const s = key.replace(/[_-]+/g, " ").trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : key; };
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])';

/** Why a save did not land, in words for the person. Their edits are always still in the dialog. */
function failureText(e: unknown): string {
  if (e instanceof StructuredEditError) return e.message;
  if ((e as { offline?: boolean })?.offline === true && e instanceof Error) return e.message;
  if (e instanceof VaultRequestError) {
    if (e.status === 403) return "You can’t edit this page. Nothing was saved.";
    if (e.status === 404) return "This page is no longer available. Nothing was saved.";
    if (e.status === 423) return "This page is locked. Nothing was saved.";
    if (e.status === 429) return "Too many changes at once. Wait a moment and save again.";
    if (e.status === 400 || e.status === 413) {
      const at = e.message.indexOf("{");
      try {
        const body = JSON.parse(at >= 0 ? e.message.slice(at) : "") as { detail?: unknown };
        if (typeof body.detail === "string" && body.detail) return `This can’t be saved: ${body.detail}.`;
      } catch { /* the generic text below */ }
      return "This can’t be saved as it is. Nothing was changed.";
    }
  }
  return "Not saved. Your changes are still here; try again.";
}

export function StructuredValueDialog({ noteId, propertyKey, label, value, personTarget, opener, onClose, onSaved }: {
  noteId: string;
  propertyKey: string;
  /** The property's name as people see it ("Members"). */
  label: string;
  /** The stored value as the opener shows it — what the write is compared against. */
  value: unknown;
  /** Where people-named columns look pages up (default: pages tagged #person). */
  personTarget?: RelationTarget | null;
  /** The control that opened the dialog: focus goes back to it (Safari does not focus a button on click, so it is passed, not guessed). */
  opener?: HTMLElement | null;
  onClose: () => void;
  onSaved?: (next: unknown) => void;
}) {
  const write = useStructuredWriter();
  const titleId = useId();
  const noteTextId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const nextId = useRef(1);
  const rowsFrom = (v: unknown): Row[] => itemsOf(v).slice(0, MAX_EDIT_ROWS).map((item) => ({ id: nextId.current++, item, original: item }));

  /** The value this edit is based on (and compared against when saving). */
  const [base, setBase] = useState<unknown>(value);
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{ theirs: unknown } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  /** Cells whose typed text is not a value yet (a number field holding "abc"): `rowId:key`. */
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [focusRow, setFocusRow] = useState<number | null>(null);
  /** The cell whose page picker is open (one at a time), shown under the items. */
  const [picking, setPicking] = useState<{ rowId: number; key: string } | null>(null);
  const [announce, setAnnounce] = useState("");

  const isList = Array.isArray(base);
  /** Items past the rows shown: never touched, written back after the shown ones. */
  const hiddenItems = useMemo(() => itemsOf(base).slice(MAX_EDIT_ROWS), [base]);
  const items = useMemo(() => rows.map((r) => r.item), [rows]);
  // Columns come from the value as loaded plus anything added since, so a column does not vanish while its last value is being retyped.
  const allColumns = useMemo(() => columnsOf([...itemsOf(base), ...items]), [base, items]);
  const columns = allColumns.slice(0, MAX_EDIT_COLUMNS);
  const hiddenColumns = allColumns.length - columns.length;
  const types = useMemo(() => new Map(columns.map((k) => [k, columnType([...items, ...itemsOf(base)], k)] as const)), [columns, items, base]);
  const linkColumns = useMemo(() => new Set(columns.filter((k) => isLinkColumn([...items, ...itemsOf(base)], k))), [columns, items, base]);

  /** What Save would write: rows added here and left empty are not items. */
  const draft = useMemo(
    () => buildValue(base, [...rows.filter((r) => !(r.original === undefined && isBlankItem(r.item))).map((r) => r.item), ...hiddenItems]),
    [base, rows, hiddenItems],
  );
  const dirty = !sameStructured(draft, base);
  const problem = invalid.size > 0 ? "Fix the highlighted number before saving." : validateStructuredValue(draft);

  // Open as a modal; focus into the first field; back to the opener on close.
  const closing = useRef(false);
  useEffect(() => {
    const el = dialog.current;
    const back = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closing.current = false;
    if (el && !el.open) el.showModal();
    (el?.querySelector<HTMLElement>("tbody input, tbody button") ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el)?.focus({ preventScroll: true });
    return () => {
      closing.current = true;
      if (el?.open) el.close();
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A row just added or moved: its first field takes focus.
  useEffect(() => {
    if (focusRow === null) return;
    const row = dialog.current?.querySelector<HTMLElement>(`[data-sv-row="${focusRow}"]`);
    (row?.querySelector<HTMLElement>("input, button") ?? row)?.focus();
    row?.scrollIntoView?.({ block: "nearest" });
    setFocusRow(null);
  }, [focusRow]);

  const requestClose = () => {
    if (busy) return;
    if (dirty && !confirmClose) { setConfirmClose(true); return; }
    onClose();
  };
  const closePicker = () => {
    const at = picking;
    setPicking(null);
    if (at) dialog.current?.querySelector<HTMLElement>(`[data-sv-pick="${at.rowId}:${CSS.escape(at.key)}"]`)?.focus();
  };
  /** Escape: the innermost thing first — the page picker, the "Discard?" question, then the dialog. */
  const onEscape = () => {
    if (picking) { closePicker(); return; }
    if (confirmClose) { setConfirmClose(false); return; }
    requestClose();
  };

  // A control that held focus can go away (the "Discard?" bar dismissed, a button disabled while
  // saving): focus goes back to where the person was, inside the dialog.
  const lastFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (confirmClose || busy) return;
    const el = dialog.current;
    if (!el || (el.contains(document.activeElement) && document.activeElement !== el)) return;
    const back = lastFocus.current;
    (back && el.contains(back) && !(back as HTMLButtonElement).disabled ? back : el).focus({ preventScroll: true });
  }, [confirmClose, busy]);

  const update = (id: number, fn: (r: Row) => Row) => { setError(""); setRows((cur) => cur.map((r) => (r.id === id ? fn(r) : r))); };
  const flag = (cell: string, bad: boolean) => setInvalid((cur) => {
    if (cur.has(cell) === bad) return cur;
    const next = new Set(cur);
    if (bad) next.add(cell); else next.delete(cell);
    return next;
  });
  const setCell = (row: Row, key: string, type: CellType, next: string | number | boolean | null) => {
    // Unticking a box the row never had a value for is "nothing" again, like clearing a text field.
    const before = row.original === undefined ? null : cellOf(row.original, key).kind;
    const emptied = next === "" || next === null || (next === false && (before === "absent" || before === "null"));
    update(row.id, (r) => ({ ...r, item: emptied ? clearItemKey(r.item, r.original, key, type) : setItemKey(r.item, key, next) }));
  };
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= rows.length) return;
    setError("");
    setRows((cur) => { const next = [...cur]; const [r] = next.splice(index, 1); next.splice(to, 0, r!); return next; });
    setAnnounce(`Item ${index + 1} moved to position ${to + 1} of ${rows.length}.`);
    setFocusRow(rows[index]!.id);
  };
  const remove = (index: number) => {
    const row = rows[index]!;
    setError("");
    setRows((cur) => cur.filter((r) => r.id !== row.id));
    setInvalid((cur) => new Set([...cur].filter((c) => !c.startsWith(`${row.id}:`))));
    if (picking?.rowId === row.id) setPicking(null);
    setAnnounce(`Item ${index + 1} removed. ${rows.length - 1} left.`);
    const neighbour = rows[index + 1] ?? rows[index - 1];
    if (neighbour) setFocusRow(neighbour.id); else dialog.current?.querySelector<HTMLElement>("[data-sv-add]")?.focus();
  };
  const model = useMemo(() => blankItem([...itemsOf(base), ...items]), [base, items]);
  const canAdd = isList && Object.keys(model).length > 0 && rows.length < MAX_EDIT_ROWS;
  const add = () => {
    if (!canAdd) return;
    const row: Row = { id: nextId.current++, item: blankItem(items.length ? items : itemsOf(base)), original: undefined };
    setError("");
    setRows((cur) => [...cur, row]);
    setAnnounce(`Item ${rows.length + 1} added.`);
    setFocusRow(row.id);
  };

  async function save(over?: unknown) {
    if (busy || problem) return;
    const expect = over === undefined ? base : over;
    const next = over === undefined ? draft : buildValue(over, itemsOf(draft));
    if (sameStructured(next, expect)) { onClose(); return; }
    setBusy(true);
    setError("");
    setConflict(null);
    try {
      await write(noteId, propertyKey, next, expect);
      onSaved?.(next);
      onClose();
    } catch (e) {
      if (e instanceof PropertyConflictError) setConflict({ theirs: Object.prototype.hasOwnProperty.call(e.current, propertyKey) ? e.current[propertyKey] : null });
      else setError(failureText(e));
    } finally {
      setBusy(false);
    }
  }
  const takeTheirs = () => {
    if (!conflict) return;
    setBase(conflict.theirs);
    setRows(rowsFrom(conflict.theirs));
    setInvalid(new Set());
    setPicking(null);
    setConflict(null);
    setError("");
    setAnnounce("The latest saved value is shown.");
  };
  /** After a conflict: is what is stored now still something this dialog can write over? */
  const theirsEditable = !!conflict && isStructuredValue(conflict.theirs) && sameTopShape(conflict.theirs, base);

  const rowName = (i: number) => (isList ? `item ${i + 1}` : "this value");
  const cell = (row: Row, i: number, key: string): ReactNode => {
    const c = cellOf(row.item, key);
    const type = types.get(key) ?? "text";
    const name = `${humanize(key)} of ${rowName(i)}`;
    if (c.kind === "nested") {
      const text = valueText(c.value) || (Array.isArray(c.value) ? "Empty list" : "Empty");
      return <span className="db-sv-nested" title="This field holds a list or a group of fields. It is kept exactly as it is." data-sv-kept>{text}<span className="db-sv-kept"> · kept as it is</span></span>;
    }
    // A cell follows its own value's type; an empty one follows its column.
    const kind: CellType = c.kind === "text" || c.kind === "number" || c.kind === "boolean" ? c.kind : type;
    if (kind === "boolean") {
      return <input type="checkbox" className="db-sv-check" aria-label={name} disabled={busy} checked={c.kind === "boolean" && c.value}
        onChange={(e) => setCell(row, key, "boolean", e.target.checked)} />;
    }
    if (kind === "number") {
      return <NumberCell label={name} disabled={busy} value={c.kind === "number" ? c.value : null}
        onValid={(n) => { flag(`${row.id}:${key}`, false); setCell(row, key, "number", n); }} onInvalid={() => flag(`${row.id}:${key}`, true)} />;
    }
    const text = c.kind === "text" ? c.value : "";
    return (
      <span className="db-sv-text">
        <input className="db-input" aria-label={name} disabled={busy} value={text} maxLength={10_000} spellCheck={false}
          onChange={(e) => setCell(row, key, "text", e.target.value)} />
        {linkColumns.has(key) && (() => {
          const open = picking?.rowId === row.id && picking.key === key;
          const linked = text.trim().startsWith("[[") && text.trim().endsWith("]]");
          return (
            <button type="button" className="db-icon-btn focus-ring db-sv-link" disabled={busy} aria-expanded={open} data-linked={linked || undefined} data-sv-pick={`${row.id}:${key}`}
              aria-label={`Link a page for ${name}`} title={linked ? `Linked to ${linkLabel(text)} — choose another page` : "Link a page"}
              onClick={() => (open ? closePicker() : setPicking({ rowId: row.id, key }))}>
              <Link2 size={13} aria-hidden="true" />
            </button>
          );
        })()}
      </span>
    );
  };

  const pickRow = picking ? rows.findIndex((r) => r.id === picking.rowId) : -1;
  return createPortal(
    <dialog ref={dialog} className="db-dialog-wrap db-sv-wrap" aria-modal="true" aria-labelledby={titleId} aria-describedby={noteTextId} data-structured-dialog
      onCancel={(e) => { e.preventDefault(); onEscape(); }}
      // Chrome closes a modal on a second Escape even when the first was refused: open it again, as it was.
      onClose={() => { const el = dialog.current; if (!closing.current && el && !el.open) el.showModal(); }}
      // The dialog is portaled, but React still bubbles its events to the cell / row that opened it:
      // nothing clicked or typed here may reach the table behind.
      onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) requestClose(); }}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()} onKeyDown={(e: KeyboardEvent<HTMLDialogElement>) => e.stopPropagation()}
      onFocus={(e) => { if (e.target instanceof HTMLElement && e.target !== e.currentTarget && !e.target.closest("[data-sv-confirm]")) lastFocus.current = e.target; }}>
      <div className="db-dialog db-dialog-wide db-sv">
        <header className="db-dialog-head">
          <h2 id={titleId}>Edit {label}</h2>
          <button type="button" className="db-icon-btn focus-ring" aria-label="Close" disabled={busy} onClick={requestClose}><X size={14} aria-hidden="true" /></button>
        </header>
        <p id={noteTextId} className="db-sv-note">
          {isList ? `${rows.length + hiddenItems.length} ${rows.length + hiddenItems.length === 1 ? "item" : "items"}. Each row is one item; each column is a field.` : "One group of fields."}
          {" "}Anything not shown here is kept exactly as it is.
        </p>

        {rows.length === 0 ? (
          <p className="db-pop-empty" data-sv-empty>{isList ? "No items. Saving leaves an empty list." : "Nothing to edit."}</p>
        ) : (
          <div className="db-sv-scroll">
            <table className="db-sv-table" aria-label={`${label} items`}>
              <thead>
                <tr>
                  {isList && <th scope="col" className="db-sv-n"><span className="db-sr-only">Item</span>#</th>}
                  {columns.length === 0 ? <th scope="col">Value</th> : columns.map((k) => <th key={k} scope="col" title={k}>{humanize(k)}</th>)}
                  {isList && <th scope="col" className="db-sv-actions"><span className="db-sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.id} data-sv-row={row.id} data-new={row.original === undefined || undefined} tabIndex={-1}>
                    {isList && <th scope="row" className="db-sv-n">{i + 1}</th>}
                    {isObject(row.item) ? (
                      columns.length === 0
                        ? <td><span className="db-sv-nested" data-sv-kept>{valueText(row.item) || "Empty"}<span className="db-sv-kept"> · kept as it is</span></span></td>
                        : columns.map((k) => <td key={k} data-label={humanize(k)}><span className="db-sv-cell-label" aria-hidden="true">{humanize(k)}</span>{cell(row, i, k)}</td>)
                    ) : (
                      <td colSpan={Math.max(1, columns.length)} data-label="Value">
                        <span className="db-sv-cell-label" aria-hidden="true">Value</span>
                        <PlainItem row={row} name={`Value of ${rowName(i)}`} busy={busy} flag={flag}
                          onChange={(next) => update(row.id, (r) => ({ ...r, item: next }))} />
                      </td>
                    )}
                    {isList && (
                      <td className="db-sv-actions">
                        <button type="button" className="db-icon-btn focus-ring" aria-label={`Move item ${i + 1} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} aria-hidden="true" /></button>
                        <button type="button" className="db-icon-btn focus-ring" aria-label={`Move item ${i + 1} down`} disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} aria-hidden="true" /></button>
                        <button type="button" className="db-icon-btn focus-ring" data-sv-remove aria-label={`Remove item ${i + 1}`} disabled={busy} onClick={() => remove(i)}><Trash2 size={13} aria-hidden="true" /></button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {picking && pickRow >= 0 && (
          <PagePicker key={`${picking.rowId}:${picking.key}`} label={`${humanize(picking.key)} of ${rowName(pickRow)}`}
            target={PERSON_COLUMN.test(picking.key) ? personTarget ?? { tag: "person" } : null}
            onPick={(path) => { setCell(rows[pickRow]!, picking.key, "text", asWikilink(path)); closePicker(); }} onClose={closePicker} />
        )}
        {(hiddenItems.length > 0 || hiddenColumns > 0) && (
          <p className="db-sv-note" data-sv-hidden>
            {hiddenItems.length > 0 && `${hiddenItems.length} more ${hiddenItems.length === 1 ? "item is" : "items are"} not shown. `}
            {hiddenColumns > 0 && `${hiddenColumns} more ${hiddenColumns === 1 ? "field is" : "fields are"} not shown. `}
            They are kept exactly as they are.
          </p>
        )}
        {isList && (
          <div>
            <button type="button" className="db-ghost focus-ring" data-sv-add disabled={busy || !canAdd} onClick={add}
              title={!canAdd ? (rows.length >= MAX_EDIT_ROWS ? "This list is at the size that can be edited here." : "There is no item to shape a new one by.") : undefined}>
              <Plus size={13} aria-hidden="true" /> Add item
            </button>
          </div>
        )}

        <span className="db-sr-only" role="status" aria-live="polite">{announce}</span>
        {invalid.size === 0 && problem && <p className="db-error" role="alert">This can’t be saved: {problem}.</p>}
        {error && <p className="db-error" role="alert">{error}</p>}
        {conflict && (
          <div className="db-error db-sv-conflict" role="alert" data-conflict>
            <span>
              {theirsEditable
                ? `${label} was changed somewhere else while you were editing. It now reads: ${valueText(conflict.theirs) || "empty"}.`
                : `${label} was changed somewhere else and is no longer a list of items${valueText(conflict.theirs) ? ` (it now reads: ${valueText(conflict.theirs)})` : ""}. Close this and edit it as an ordinary property.`}
            </span>
            {theirsEditable && (
              <span className="db-sv-conflict-actions">
                <button type="button" onClick={takeTheirs}>Show the latest (discard mine)</button>
                <button type="button" onClick={() => void save(conflict.theirs)}>Save mine anyway</button>
              </span>
            )}
          </div>
        )}
        {confirmClose ? (
          <div className="db-settings-row db-sv-confirm" role="alertdialog" aria-label="Discard changes?" data-sv-confirm>
            <span>Discard your changes to {label}?</span>
            <span className="db-sv-conflict-actions">
              <button type="button" className="db-ghost focus-ring" autoFocus onClick={() => setConfirmClose(false)}>Keep editing</button>
              <button type="button" className="db-primary db-danger focus-ring" onClick={onClose}>Discard</button>
            </span>
          </div>
        ) : (
          <div className="db-settings-row">
            <button type="button" className="db-ghost focus-ring" disabled={busy} onClick={requestClose}>Cancel</button>
            <button type="button" className="db-primary focus-ring" disabled={busy || !!problem || !dirty || (!!conflict && !theirsEditable)} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </dialog>,
    document.body,
  );
}

/** A number field: the text typed is kept while it is not a number yet (and said so); only a real number, or nothing, reaches the value. */
function NumberCell({ label, value, disabled, required, onValid, onInvalid }: { label: string; value: number | null; disabled: boolean; /** Emptying it is not a value (a number ITEM of the list). */ required?: boolean; onValid: (n: number | null) => void; onInvalid: () => void }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [bad, setBad] = useState("");
  const id = useId();
  return (
    <span className="db-sv-text">
      <input className="db-input" aria-label={label} inputMode="decimal" disabled={disabled} value={text} aria-invalid={bad ? true : undefined} aria-describedby={bad ? id : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseCell("number", e.target.value);
          if ("error" in parsed) { setBad(parsed.error); onInvalid(); return; }
          if (required && parsed.value === null) { setBad("Enter a number, or remove this item."); onInvalid(); return; }
          setBad("");
          onValid(parsed.value as number | null);
        }} />
      {bad && <span id={id} className="db-error" role="alert">{bad}</span>}
    </span>
  );
}

/** An item of the list that is not an object: plain text, a number or a yes/no is edited in place; a nested list is kept. */
function PlainItem({ row, name, busy, flag, onChange }: { row: Row; name: string; busy: boolean; flag: (cell: string, bad: boolean) => void; onChange: (next: unknown) => void }) {
  const v = row.item;
  if (typeof v === "boolean") return <input type="checkbox" className="db-sv-check" aria-label={name} disabled={busy} checked={v} onChange={(e) => onChange(e.target.checked)} />;
  if (typeof v === "number") {
    // A number item stays a number: it cannot be emptied (remove the row to drop it).
    return <NumberCell label={name} disabled={busy} value={v} required
      onValid={(n) => { flag(`${row.id}:$item`, false); if (n !== null) onChange(n); }}
      onInvalid={() => flag(`${row.id}:$item`, true)} />;
  }
  if (typeof v === "string") return <input className="db-input" aria-label={name} disabled={busy} value={v} maxLength={10_000} spellCheck={false} onChange={(e) => onChange(e.target.value)} />;
  return <span className="db-sv-nested" data-sv-kept title="This item is a list inside the list. It is kept exactly as it is.">{valueText(v) || "Empty"}<span className="db-sv-kept"> · kept as it is</span></span>;
}

/** "Link a page" for one field: search pages (people for a people-named field) and choose one — the field then holds `[[its path]]`. Part of the dialog, under the items. */
function PagePicker({ label, target, onPick, onClose }: { label: string; target: RelationTarget | null; onPick: (path: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const candidates = useLinkCandidates(target, q, true);
  const rows: RelationCandidate[] = (candidates.data ?? []).filter((c) => c.path);
  return (
    <section className="db-sv-picker" role="group" aria-label={`Link a page for ${label}`}>
      <div className="db-sv-picker-head">
        <span>Link a page for {label}</span>
        <button type="button" className="db-icon-btn focus-ring" aria-label="Close the page list" onClick={onClose}><X size={13} aria-hidden="true" /></button>
      </div>
      <div className="db-pop-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus aria-label={target ? "Search people" : "Search pages"} placeholder={target ? "Search people…" : "Search pages…"} value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && rows.length === 1) { e.preventDefault(); onPick(rows[0]!.path!); } }} />
      </div>
      <ul className="db-pop-list" role="listbox" aria-label="Pages">
        {rows.map((c) => (
          <li key={c.id} role="presentation">
            <button type="button" role="option" aria-selected={false} onClick={() => onPick(c.path!)}>
              <span className="db-pop-title">{c.title}</span>
              <span className="db-pop-path">{c.path}</span>
            </button>
          </li>
        ))}
        {candidates.isLoading && <li className="db-pop-empty">Searching…</li>}
        {!candidates.isLoading && !rows.length && <li className="db-pop-empty">{q ? "No matches" : target ? "No people yet" : "Type to search"}</li>}
      </ul>
    </section>
  );
}
