/**
 * One typed property value: display + inline editor. Shared by the page
 * property bar, the side panel and database cells/cards so every surface edits
 * a property the same way, with the same conflict handling.
 *
 * `onCommit` performs the write (with per-field CAS). It may throw
 * PropertyConflictError — the editor then shows what is stored now and lets the
 * person keep theirs or take the other value; any other failure keeps the draft
 * and offers Retry. Nothing is ever silently dropped.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarClock, Check, ExternalLink, Mail, Paperclip, Phone, Plus, Search, Upload, X } from "lucide-react";
import { buildDateValue, dateRange, hasTime, parseDateParts } from "../../lib/database/dates";
import { useVaultClient } from "../../data/VaultClientContext";
import { serverFetch } from "../../lib/transport/serverFetch";
import { downloadOwnAttachment, fileRef, isImageFileName, parseFileRefs, MAX_FILE_BYTES } from "../../lib/media/attachments";
import { PropertyConflictError } from "../../data/VaultClient";
import { useLinkCandidates } from "../../lib/database/hooks";
import {
  asWikilink,
  coerceValue,
  formatDateTime,
  formatValue,
  isBlank,
  looksLikeEmail,
  looksLikePhone,
  linkLabel,
  optionColor,
  optionLabel,
  STATUS_GROUP_LABELS,
  STATUS_GROUPS,
  type OptionColor,
  type PropertyDef,
} from "../../lib/database/schema";
import { Popover } from "./Popover";

export type ValueVariant = "bar" | "cell" | "panel" | "card";

export function OptionChip({ value, label, color, onRemove, removeLabel }: { value: string; /** Display name (an option rename); defaults to the stored value. */ label?: string; color: OptionColor; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className="db-opt" data-color={color} data-value={value}>
      <span className="db-opt-text">{label ?? value}</span>
      {onRemove && (
        <button type="button" className="db-opt-remove" aria-label={removeLabel ?? `Remove ${value}`} onClick={(e) => { e.stopPropagation(); onRemove(); }}>
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

const colorOf = (def: PropertyDef, v: string): OptionColor => def.options.find((o) => o.value === v)?.color ?? optionColor(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : isBlank(v) ? [] : [String(v)]);

/** Read-only rendering (cards, read-only pages, cells of rows you cannot edit). */
export function PropertyDisplay({ def, value }: { def: PropertyDef; value: unknown }) {
  if (isBlank(value)) return <span className="db-empty">Empty</span>;
  if (def.system === "created_time" || def.system === "edited_time") {
    const v = String(value);
    return <time className="db-text db-system" dateTime={v} title={new Date(v).toLocaleString()}>{formatDateTime(v)}</time>;
  }
  if (def.system === "created_by" || def.system === "edited_by") {
    const who = String(value) === "link" ? "Guest (link)" : String(value);
    return <span className="db-chips"><span className="db-link-chip" data-kind="person"><span className="db-avatar" aria-hidden="true">{who.slice(0, 1).toUpperCase()}</span>{who}</span></span>;
  }
  switch (def.kind) {
    case "select":
    case "status":
    case "multi_select":
      return <span className="db-chips">{list(value).map((v) => <OptionChip key={v} value={v} label={optionLabel(def, v)} color={colorOf(def, v)} />)}</span>;
    case "person":
    case "relation":
      return <span className="db-chips">{list(value).map((v) => <span key={v} className="db-link-chip" data-kind={def.kind}>{def.kind === "person" && <span className="db-avatar" aria-hidden="true">{linkLabel(v).slice(0, 1).toUpperCase()}</span>}{linkLabel(v)}</span>)}</span>;
    case "checkbox":
      return <span className="db-check" data-checked={value === true || undefined} role="img" aria-label={value === true ? "Checked" : "Unchecked"}>{value === true && <Check size={12} aria-hidden="true" />}</span>;
    case "files": {
      // Files & media (NP-DB-09): image thumbnails, other files as named chips; both download on click.
      const files = parseFileRefs(value);
      if (!files.length) return <span className="db-empty">Empty</span>;
      return (
        <span className="db-chips db-files">
          {files.map((f) => (
            <span key={f.url} role="link" tabIndex={0} className="db-file" title={`Download ${f.name}`}
              onClick={(e) => { e.stopPropagation(); void downloadOwnAttachment(serverFetch, f.url, f.name).catch(() => {}); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void downloadOwnAttachment(serverFetch, f.url, f.name).catch(() => {}); } }}>
              {isImageFileName(f.name) ? <img className="db-file-thumb" src={f.url} alt="" loading="lazy" /> : <Paperclip size={11} aria-hidden="true" />}
              <span className="db-file-name">{f.name}</span>
            </span>
          ))}
        </span>
      );
    }
    case "email": {
      const v = String(value);
      return looksLikeEmail(v) ? <a className="db-url" href={`mailto:${v.trim()}`} onClick={(e) => e.stopPropagation()}>{v}</a> : <span className="db-text">{v}</span>;
    }
    case "phone": {
      const v = String(value);
      return looksLikePhone(v) ? <a className="db-url" href={`tel:${v.replace(/[^\d+]/g, "")}`} onClick={(e) => e.stopPropagation()}>{v}</a> : <span className="db-text">{v}</span>;
    }
    case "url": {
      const href = String(value);
      const safe = /^https?:\/\//i.test(href);
      return safe ? <a className="db-url" href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{href.replace(/^https?:\/\//, "")}</a> : <span>{href}</span>;
    }
    default:
      return <span className="db-text">{formatValue(def, value)}</span>;
  }
}

type Conflict = { theirs: unknown };

export function PropertyValue({
  def,
  value,
  readOnly,
  variant = "bar",
  onCommit,
  onCreateOption,
  autoOpen,
  onDone,
  noteId,
}: {
  /** The page this value belongs to: files & media uploads attach to it. Omitted → files are read-only. */
  noteId?: string;
  def: PropertyDef;
  value: unknown;
  readOnly?: boolean;
  variant?: ValueVariant;
  /** Persist `next` (null = clear). `base` is the value the person was looking at. */
  onCommit: (next: unknown, base: unknown) => Promise<void>;
  /** Owner-only: add a new option to the schema before selecting it. */
  onCreateOption?: (option: string) => Promise<void>;
  /** Open the editor immediately (a just-added property). */
  autoOpen?: boolean;
  onDone?: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const attempted = useRef<unknown>(undefined);
  const base = useRef<unknown>(value);
  const id = useId();
  // Keyboard edits (Enter / Esc) hand focus back to the cell so arrow keys keep working (NP-DB-03).
  const refocus = useRef(false);
  useEffect(() => {
    if (!editingText && refocus.current) {
      refocus.current = false;
      anchor.current?.focus();
    }
  }, [editingText]);

  useEffect(() => {
    if (!busy && !conflict) base.current = value;
  }, [value, busy, conflict]);

  const textual = def.kind === "text" || def.kind === "number" || def.kind === "url" || def.kind === "date" || def.kind === "email" || def.kind === "phone";
  // System properties (created/edited time/by) are never editable.
  if (def.system) readOnly = true;

  const begin = () => {
    if (readOnly || busy) return;
    if (def.kind === "checkbox") {
      void commit(!(value === true));
      return;
    }
    // A date with a time or an end opens the full date editor (a plain day edits in place).
    if (def.kind === "date" && typeof value === "string" && (hasTime(value) || dateRange(value))) {
      setOpen(true);
      return;
    }
    if (textual) {
      setDraft(isBlank(value) ? "" : def.kind === "date" ? String(value).slice(0, 10) : String(value));
      setEditingText(true);
      return;
    }
    setOpen(true);
  };

  useEffect(() => {
    if (autoOpen) begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen]);
  useEffect(() => {
    if (editingText) inputRef.current?.focus();
  }, [editingText]);

  async function commit(raw: unknown, overrideBase?: unknown) {
    const next = coerceValue(def, raw);
    // Email/phone keep any text the person typed, but say when it does not look right.
    if (typeof next === "string" && ((def.kind === "email" && !looksLikeEmail(next)) || (def.kind === "phone" && !looksLikePhone(next)))) {
      attempted.current = raw;
      setError(def.kind === "email" ? "That doesn’t look like an email address." : "That doesn’t look like a phone number.");
      return;
    }
    if (JSON.stringify(next ?? null) === JSON.stringify(value ?? null) && overrideBase === undefined) {
      setEditingText(false);
      onDone?.();
      return;
    }
    attempted.current = raw;
    setBusy(true);
    setError("");
    setConflict(null);
    try {
      await onCommit(next, overrideBase === undefined ? base.current : overrideBase);
      setEditingText(false);
      onDone?.();
    } catch (e) {
      if (e instanceof PropertyConflictError) setConflict({ theirs: e.current[def.key] ?? null });
      else setError(e instanceof Error && e.message && !/failed: \d{3}/.test(e.message) ? e.message : "Not saved. Your value is kept; try again.");
    } finally {
      setBusy(false);
    }
  }

  const onTextKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      refocus.current = true;
      void commit(draft);
    }
    if (e.key === "Tab") refocus.current = false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      refocus.current = true;
      setEditingText(false);
      setError("");
      onDone?.();
    }
  };

  const feedback = (
    <>
      {error && (
        <span role="alert" className="db-error">
          {error}
          <button type="button" onClick={() => void commit(attempted.current)}>Retry</button>
        </span>
      )}
      {conflict && (
        <span role="alert" className="db-error" data-conflict>
          Changed elsewhere to “{formatValue(def, conflict.theirs) || "empty"}”.
          <button type="button" onClick={() => { base.current = conflict.theirs; setConflict(null); setEditingText(false); onDone?.(); }}>Use theirs</button>
          <button type="button" onClick={() => void commit(attempted.current, conflict.theirs)}>Keep mine</button>
        </span>
      )}
    </>
  );

  if (editingText) {
    return (
      <span className={`db-value db-value-${variant}`} data-editing data-date={def.kind === "date" || undefined}>
        <input
          ref={inputRef}
          className="db-input"
          aria-label={def.label}
          type={def.kind === "date" ? "date" : def.kind === "number" ? "text" : def.kind === "url" ? "url" : def.kind === "email" ? "email" : def.kind === "phone" ? "tel" : "text"}
          inputMode={def.kind === "number" ? "decimal" : def.kind === "email" ? "email" : def.kind === "phone" ? "tel" : undefined}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onTextKey}
          onBlur={() => { if (!busy && !error && !conflict) void commit(draft); }}
        />
        {def.kind === "date" && (
          // Time and end date live in the full editor; mousedown is swallowed so the input does not commit first.
          <button type="button" className="db-icon-btn db-date-more" aria-label={`Time and end date for ${def.label}`} disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setEditingText(false); setOpen(true); }}>
            <CalendarClock size={14} aria-hidden="true" />
          </button>
        )}
        {feedback}
      </span>
    );
  }

  return (
    <span className={`db-value db-value-${variant}`}>
      <button
        ref={anchor}
        type="button"
        className="db-value-button focus-ring"
        aria-label={def.kind === "checkbox" ? def.label : `${def.label}: ${formatValue(def, value) || "Empty"}`}
        role={def.kind === "checkbox" ? "checkbox" : undefined}
        aria-checked={def.kind === "checkbox" ? value === true : undefined}
        aria-haspopup={!textual && def.kind !== "checkbox" ? "dialog" : undefined}
        aria-expanded={open || undefined}
        aria-describedby={error || conflict ? id : undefined}
        disabled={busy}
        data-readonly={readOnly || undefined}
        onClick={(e) => { e.stopPropagation(); begin(); }}
      >
        {def.kind === "checkbox" ? (
          <span className="db-check" data-checked={value === true || undefined} aria-hidden="true">{value === true && <Check size={12} />}</span>
        ) : (
          <PropertyDisplay def={def} value={value} />
        )}
        {def.kind === "url" && !isBlank(value) && /^https?:\/\//i.test(String(value)) && <ExternalLink size={11} aria-hidden="true" className="db-muted-icon" />}
        {def.kind === "email" && !isBlank(value) && <Mail size={11} aria-hidden="true" className="db-muted-icon" />}
        {def.kind === "phone" && !isBlank(value) && <Phone size={11} aria-hidden="true" className="db-muted-icon" />}
      </button>
      <span id={id}>{feedback}</span>
      {(def.kind === "select" || def.kind === "status" || def.kind === "multi_select") && (
        <OptionPicker anchor={anchor} open={open} def={def} value={value} onClose={() => { setOpen(false); onDone?.(); }}
          onCreateOption={onCreateOption}
          onPick={(next) => { void commit(next); }} />
      )}
      {def.kind === "date" && open && (
        <DatePicker anchor={anchor} def={def} value={value} onClose={() => { setOpen(false); onDone?.(); }}
          onPick={(next) => { void commit(next); }} />
      )}
      {def.kind === "files" && (
        <FilesPicker anchor={anchor} open={open} def={def} value={value} noteId={noteId} onClose={() => { setOpen(false); onDone?.(); }}
          onPick={(next) => commit(next)} />
      )}
      {(def.kind === "person" || def.kind === "relation") && (
        <LinkPicker anchor={anchor} open={open} def={def} value={value} onClose={() => { setOpen(false); onDone?.(); }}
          onPick={(next) => { void commit(next); }} />
      )}
    </span>
  );
}

/**
 * The full date editor (NP-DB-08): a day, optionally with a time, optionally with
 * an end. Stored as `YYYY-MM-DD`, a zoned instant, or `start/end` (lib/database/dates.ts).
 * Nothing is written until Done; Escape leaves the value alone.
 */
function DatePicker({ anchor, def, value, onClose, onPick }: {
  anchor: React.RefObject<HTMLElement | null>; def: PropertyDef; value: unknown; onClose: () => void; onPick: (next: unknown) => void;
}) {
  const initial = parseDateParts(value);
  const [date, setDate] = useState(initial?.date ?? "");
  const [time, setTime] = useState(initial?.time ?? "09:00");
  const [timeOn, setTimeOn] = useState(!!initial?.time);
  const [endOn, setEndOn] = useState(!!initial?.endDate);
  const [endDate, setEndDate] = useState(initial?.endDate ?? initial?.date ?? "");
  const [endTime, setEndTime] = useState(initial?.endTime ?? initial?.time ?? "10:00");
  // The vault's own `date` type holds one date; a range needs a text-typed field.
  const rangeOk = def.type !== "date";
  const next = date ? buildDateValue({ date, time: timeOn ? time : null, endDate: endOn && rangeOk ? endDate || date : null, endTime: timeOn ? endTime : null }) : null;
  const backwards = !!next && endOn && rangeOk && (() => { const r = dateRange(next); return !!r && Date.parse(r[1].length === 10 ? `${r[1]}T00:00:00` : r[1]) < Date.parse(r[0].length === 10 ? `${r[0]}T00:00:00` : r[0]); })();
  const done = () => { if (!date) { onPick(null); onClose(); return; } if (!next || backwards) return; onPick(next); onClose(); };
  return (
    <Popover anchor={anchor} open onClose={onClose} label={`Edit ${def.label}`} width={300}>
      <form className="db-settings db-date-editor" onSubmit={(e) => { e.preventDefault(); done(); }}>
        <div className="db-date-row">
          <label className="db-field"><span>{endOn ? "Start date" : "Date"}</span><input autoFocus type="date" aria-label={endOn ? "Start date" : "Date"} value={date} onChange={(e) => { setDate(e.target.value); if (!endOn) setEndDate(e.target.value); }} /></label>
          {timeOn && <label className="db-field"><span>{endOn ? "Start time" : "Time"}</span><input type="time" aria-label={endOn ? "Start time" : "Time"} value={time} onChange={(e) => setTime(e.target.value)} /></label>}
        </div>
        {endOn && rangeOk && (
          <div className="db-date-row">
            <label className="db-field"><span>End date</span><input type="date" aria-label="End date" value={endDate} min={date || undefined} onChange={(e) => setEndDate(e.target.value)} /></label>
            {timeOn && <label className="db-field"><span>End time</span><input type="time" aria-label="End time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>}
          </div>
        )}
        <label className="db-radio"><input type="checkbox" checked={endOn && rangeOk} disabled={!rangeOk} onChange={(e) => { setEndOn(e.target.checked); if (e.target.checked && (!endDate || endDate < date)) setEndDate(date); }} /> Add an end date{!rangeOk ? " (this property holds a single date)" : ""}</label>
        <label className="db-radio"><input type="checkbox" checked={timeOn} onChange={(e) => setTimeOn(e.target.checked)} /> Include time</label>
        {backwards && <p role="alert" className="db-error">The end is before the start.</p>}
        <div className="db-settings-row">
          {!isBlank(value) ? <button type="button" className="db-ghost" onClick={() => { onPick(null); onClose(); }}>Clear</button> : <span />}
          <button type="submit" className="db-primary" disabled={!!date && (!next || backwards)}>Done</button>
        </div>
      </form>
    </Popover>
  );
}

/** Files & media editor: list with remove, and upload (stored as attachments of the page). */
function FilesPicker({ anchor, open, def, value, noteId, onClose, onPick }: {
  anchor: React.RefObject<HTMLElement | null>; open: boolean; def: PropertyDef; value: unknown; noteId?: string;
  onClose: () => void; onPick: (next: unknown) => Promise<void>;
}) {
  const client = useVaultClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const files = parseFileRefs(value);
  const canUpload = !!noteId && !!client.uploadAttachment;
  const add = async (picked: FileList | null) => {
    const list = Array.from(picked ?? []);
    if (!list.length || !noteId || !client.uploadAttachment) return;
    setErr("");
    setBusy(true);
    try {
      const next = files.map((f) => fileRef(f.name, f.url));
      for (const file of list) {
        if (file.size > MAX_FILE_BYTES) { setErr(`${file.name} is larger than ${Math.round(MAX_FILE_BYTES / 1_048_576)} MB.`); continue; }
        try {
          const a = await client.uploadAttachment(noteId, file, { kind: "file" });
          next.push(fileRef(a.name || file.name, a.url));
        } catch (e) {
          const why = (e as { userMessage?: string })?.userMessage;
          setErr(why ? `Couldn’t upload ${file.name}: ${why}.` : `Couldn’t upload ${file.name}. Nothing was added.`);
        }
      }
      if (next.length !== files.length) await onPick(next);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label={`${def.label} files`} width={300}>
      <div className="db-files-picker">
        {files.length === 0 && <p className="db-empty">No files yet.</p>}
        <ul>
          {files.map((f) => (
            <li key={f.url}>
              {isImageFileName(f.name) ? <img className="db-file-thumb" src={f.url} alt="" /> : <Paperclip size={13} aria-hidden="true" />}
              <button type="button" className="db-file-name focus-ring" onClick={() => void downloadOwnAttachment(serverFetch, f.url, f.name).catch(() => setErr("Couldn’t download this file."))}>{f.name}</button>
              <button type="button" className="db-opt-remove" aria-label={`Remove ${f.name}`} disabled={busy}
                onClick={() => { const rest = files.filter((x) => x.url !== f.url).map((x) => fileRef(x.name, x.url)); void onPick(rest.length ? rest : null); }}>
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {canUpload ? (
          <>
            <input ref={input} type="file" multiple hidden aria-label={`Upload to ${def.label}`} onChange={(e) => void add(e.target.files)} />
            <button type="button" className="db-files-upload focus-ring" disabled={busy} onClick={() => input.current?.click()}>
              <Upload size={13} aria-hidden="true" /> {busy ? "Uploading…" : "Upload a file"}
            </button>
          </>
        ) : <p className="db-empty">Uploading isn’t available here.</p>}
        {err && <p role="alert" className="db-error">{err}</p>}
      </div>
    </Popover>
  );
}

function OptionPicker({ anchor, open, def, value, onClose, onPick, onCreateOption }: {
  anchor: React.RefObject<HTMLElement | null>; open: boolean; def: PropertyDef; value: unknown;
  onClose: () => void; onPick: (next: unknown) => void; onCreateOption?: (o: string) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  const multi = def.kind === "multi_select";
  const selected = new Set(list(value));
  const options = useMemo(() => {
    const vals = [...def.options.map((o) => o.value)];
    for (const v of selected) if (!vals.includes(v)) vals.push(v);
    const needle = q.trim().toLowerCase();
    return vals.filter((v) => v.toLowerCase().includes(needle) || optionLabel(def, v).toLowerCase().includes(needle));
  }, [def.options, q, value]); // eslint-disable-line react-hooks/exhaustive-deps
  const exact = options.some((o) => o.toLowerCase() === q.trim().toLowerCase() || optionLabel(def, o).toLowerCase() === q.trim().toLowerCase());
  // Status options are listed under their group (To-do / In progress / Complete).
  const groupOf = (v: string) => def.options.find((o) => o.value === v)?.group;
  const grouped = def.kind === "status" && options.some((o) => groupOf(o));
  const ordered = grouped ? STATUS_GROUPS.flatMap((g) => options.filter((o) => (groupOf(o) ?? "in_progress") === g)) : options;
  // A free select (no schema enum) accepts any value; an enum select needs the
  // option in the schema first (the owner can add it), or the vault rejects the write.
  const canFree = multi || !def.options.length || def.type === undefined;
  const choose = (v: string) => {
    if (multi) {
      const next = selected.has(v) ? [...selected].filter((x) => x !== v) : [...selected, v];
      onPick(next.length ? next : null);
    } else {
      onPick(selected.has(v) ? null : v);
      onClose();
    }
  };
  const create = async () => {
    const v = q.trim();
    if (!v) return;
    setErr("");
    if (!canFree) {
      if (!onCreateOption) return;
      setCreating(true);
      try {
        await onCreateOption(v);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not add the option.");
        setCreating(false);
        return;
      }
      setCreating(false);
    }
    setQ("");
    choose(v);
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label={`Choose ${def.label}`}>
      <div className="db-pop-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus aria-label={`Search ${def.label} options`} placeholder={canFree || onCreateOption ? "Search or create…" : "Search…"} value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); if (options.length === 1) choose(options[0]!); else if (!exact) void create(); } }} />
      </div>
      <ul className="db-pop-list" role="listbox" aria-label={def.label} aria-multiselectable={multi || undefined}>
        {ordered.map((o, i) => {
          const g = groupOf(o) ?? "in_progress";
          const head = grouped && (i === 0 || (groupOf(ordered[i - 1]!) ?? "in_progress") !== g);
          return [
            head ? <li key={`g:${g}`} role="presentation" className="db-pop-heading db-status-group" data-status-group={g}>{STATUS_GROUP_LABELS[g]}</li> : null,
            <li key={o} role="option" aria-selected={selected.has(o)} data-group={grouped ? g : undefined}>
              <button type="button" onClick={() => choose(o)}>
                {multi && <span className="db-check" data-checked={selected.has(o) || undefined} aria-hidden="true">{selected.has(o) && <Check size={12} />}</span>}
                <OptionChip value={o} label={optionLabel(def, o)} color={colorOf(def, o)} />
                {!multi && selected.has(o) && <Check size={14} className="db-pop-tick" aria-hidden="true" />}
              </button>
            </li>,
          ];
        })}
        {!options.length && !q && <li className="db-pop-empty">No options yet</li>}
      </ul>
      {q.trim() && !exact && (canFree || onCreateOption) && (
        <button type="button" className="db-pop-create" disabled={creating} onClick={() => void create()}>
          <Plus size={14} aria-hidden="true" /> {creating ? "Adding…" : <>Create <OptionChip value={q.trim()} color={optionColor(q.trim())} /></>}
        </button>
      )}
      {err && <p role="alert" className="db-error">{err}</p>}
      {!isBlank(value) && (
        <button type="button" className="db-pop-clear" onClick={() => { onPick(null); onClose(); }}>Clear</button>
      )}
    </Popover>
  );
}

function LinkPicker({ anchor, open, def, value, onClose, onPick }: {
  anchor: React.RefObject<HTMLElement | null>; open: boolean; def: PropertyDef; value: unknown;
  onClose: () => void; onPick: (next: unknown) => void;
}) {
  const [q, setQ] = useState("");
  // The relation's target database (schema hint `relationTag`), else the old heuristics.
  const tag = def.target ?? (def.kind === "person" ? "person" : /^projects?$/i.test(def.key) ? "project" : null);
  const candidates = useLinkCandidates(tag, q, open);
  const current = list(value);
  const toggle = (path: string) => {
    const link = asWikilink(path);
    if (def.multiple) {
      const has = current.some((v) => linkLabel(v) === linkLabel(link) || v === link);
      const next = has ? current.filter((v) => v !== link && linkLabel(v) !== linkLabel(link)) : [...current, link];
      onPick(next.length ? next : null);
    } else {
      onPick(link);
      onClose();
    }
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label={`Link ${def.label}`} width={300}>
      {current.length > 0 && (
        <div className="db-pop-current">
          {current.map((v) => (
            <span key={v} className="db-link-chip" data-kind={def.kind}>
              {linkLabel(v)}
              <button type="button" aria-label={`Remove ${linkLabel(v)}`} onClick={() => { const next = current.filter((x) => x !== v); onPick(next.length ? (def.multiple ? next : next[0]) : null); }}><X size={11} aria-hidden="true" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="db-pop-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus aria-label={`Search ${def.kind === "person" ? "people" : "pages"}`} placeholder={def.kind === "person" ? "Search people…" : "Search pages…"} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="db-pop-list" role="listbox" aria-label={`${def.label} candidates`}>
        {(candidates.data ?? []).filter((c) => c.path).map((c) => (
          <li key={c.id} role="option" aria-selected={current.some((v) => linkLabel(v) === linkLabel(asWikilink(c.path!)))}>
            <button type="button" onClick={() => toggle(c.path!)}>
              {def.kind === "person" && <span className="db-avatar" aria-hidden="true">{c.title.slice(0, 1).toUpperCase()}</span>}
              <span className="db-pop-title">{c.title}</span>
              <span className="db-pop-path">{c.path}</span>
            </button>
          </li>
        ))}
        {candidates.isLoading && <li className="db-pop-empty">Searching…</li>}
        {!candidates.isLoading && !(candidates.data ?? []).length && <li className="db-pop-empty">{q ? "No matches" : "Type to search"}</li>}
      </ul>
    </Popover>
  );
}
