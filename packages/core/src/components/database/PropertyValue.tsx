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
import { CalendarClock, Check, ExternalLink, Lock, Mail, Paperclip, Phone, Plus, Search, Upload, X } from "lucide-react";
import { buildDateValue, dateRange, hasTime, parseDateParts } from "../../lib/database/dates";
import { useVaultClient } from "../../data/VaultClientContext";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { Note } from "../../lib/types";
import { serverFetch } from "../../lib/transport/serverFetch";
import { downloadOwnAttachment, fileRef, isImageFileName, parseFileRefs, MAX_FILE_BYTES } from "../../lib/media/attachments";
import { PropertyConflictError, VaultRequestError } from "../../data/VaultClient";
import { loadRelationIndex, relationIndexKey, useLinkCandidates, useRelationIndex, useScope } from "../../lib/database/hooks";
import { conventionalPath, relationValues, resolveRelationValue, resolvedPath, type RelationResolution } from "../../lib/database/relations";
import { isStructuredValue, scalarText, STRUCTURED_HINT, structuredItems } from "../../lib/database/structured";
import { useQueryClient } from "@tanstack/react-query";
import {
  asWikilink,
  coerceValue,
  formatDateTime,
  formatValue,
  INGEST_TAGS,
  isBlank,
  isPeopleKeyName,
  looksLikeEmail,
  looksLikePhone,
  linkLabel,
  linkTarget,
  optionColor,
  optionLabel,
  STATUS_GROUP_LABELS,
  STATUS_GROUPS,
  type OptionColor,
  type PropertyDef,
  type RelationTarget,
} from "../../lib/database/schema";
import { Popover } from "./Popover";

export type ValueVariant = "bar" | "cell" | "panel" | "card";

/** The pages a relation / person property points at: its stated or inferred target, else the old fallbacks. */
export function relationTargetFor(def: Pick<PropertyDef, "kind" | "key" | "target" | "targetPath">): RelationTarget | null {
  if (def.targetPath) return { pathPrefix: def.targetPath };
  if (def.target) return { tag: def.target };
  if (def.kind === "person") return { tag: "person" };
  // "project", "projects" and names that end in them ("linked_projects", "related-project") point at #project pages,
  // so a slug or folder link reads as the project's title instead of its folder name.
  return /(^|[_\-\s])projects?$/i.test(def.key) ? { tag: "project" } : null;
}

/** A stored value the target's index reads better than its text: anything non-blank (a full-path link resolves to its page's title). */
const needsIndex = (v: string): boolean => v.trim() !== "";

/**
 * Open the page a relation/person value points at (NP-DB-12). The page is read
 * through the reader's own client, so someone who cannot view it opens nothing
 * and learns nothing beyond the link text they already see. A value in an older
 * encoding (a folder link, a bare slug, a name) is resolved against the relation's
 * TARGET when the path itself names no page.
 */
export function useOpenLinked(target?: RelationTarget | null) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const scope = useScope();
  return async (value: string): Promise<boolean> => {
    const path = linkTarget(value);
    if (!path) return false;
    try {
      let note: Note | null = null;
      try {
        note = await client.getNote(path);
      } catch {
        // A server that only takes ids: find the id in the (permission-filtered) tree.
        const entry = (await client.listTree()).find((n) => n.path === path || n.path?.replace(/\.[^./]+$/, "") === path);
        if (entry) note = await client.getNote(entry.id);
      }
      if (!note && target) {
        const idx = await qc.fetchQuery({ queryKey: relationIndexKey(scope, target), staleTime: 60_000, queryFn: () => loadRelationIndex(client, target) });
        const r = resolveRelationValue(value, idx);
        if (r.kind === "note") note = await client.getNote(r.note.id);
      }
      if (!note) return false;
      useUIStore.getState().openTab(note.id, (typeof note.metadata?.title === "string" && note.metadata.title) || linkLabel(value), inferContentType(note));
      return true;
    } catch {
      return false;
    }
  };
}

/** A related page / person as a chip. `open`: a plain click opens it (else only ⌘/Ctrl-click does — the cell's own click edits). */
function LinkChip({ value, kind, open, target, resolution, text, detail }: { value: string; kind: "person" | "relation"; open: boolean; target: RelationTarget | null; resolution: RelationResolution | null; /** The name to show when the page does not answer with its own title (a structured item's label). */ text?: string; /** Shown after the name: "— delegate" (a structured item's role). */ detail?: string }) {
  const openLinked = useOpenLinked(target);
  const [missing, setMissing] = useState(false);
  const go = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.stopPropagation();
    e.preventDefault();
    if (resolution?.kind === "note") {
      useUIStore.getState().openTab(resolution.note.id, resolution.note.title, "document");
      return;
    }
    void openLinked(value).then((ok) => setMissing(!ok));
  };
  const resolved = resolution?.kind === "note" ? resolution.note : null;
  const label = resolved?.title || text || linkLabel(value);
  // A plain name / slug no target page answers: shown as the text it is, never guessed.
  const unlinked = !resolved && !!resolution && !value.trim().startsWith("[[");
  const where = target ? ("tag" in target ? `#${target.tag} page` : `page in ${target.pathPrefix}`) : "page";
  const title = missing ? "This page is unavailable. It may have moved, or you may not have access."
    : unlinked ? (resolution?.kind === "ambiguous" ? `“${value}” matches ${resolution.count} ${where}s — not linked` : `“${value}” is not linked to a ${where}`)
    : open ? `Open ${label}` : `${label} — ${navigator.platform?.startsWith("Mac") ? "⌘" : "Ctrl"}-click to open`;
  return (
    <span className={`db-link-chip${open ? " db-link-open" : ""}`} data-kind={kind} data-missing={missing || undefined} data-unlinked={unlinked || undefined}
      data-resolved-via={resolved ? resolution!.kind === "note" && resolution!.via : undefined}
      role={open ? "link" : undefined} tabIndex={open ? 0 : undefined}
      title={title}
      onClick={(e) => { if (open || e.metaKey || e.ctrlKey) go(e); }}
      onKeyDown={(e) => { if (open && e.key === "Enter") go(e); }}>
      {kind === "person" && <span className="db-avatar" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>}{label}{detail ? <span className="db-chip-detail"> — {detail}</span> : null}
    </span>
  );
}

/** Where a structured value's names may be looked up: the relation's own target, else people for a people-named property ("members", "attendees"). */
function structuredTargetFor(def: Pick<PropertyDef, "kind" | "key" | "target" | "targetPath">): RelationTarget | null {
  if (def.kind === "person" || def.kind === "relation") return relationTargetFor(def);
  return isPeopleKeyName(def.key) || /^members?$/i.test(def.key) ? { tag: "person" } : null;
}

/**
 * A value that holds OBJECTS (`members: [{name, role}]`): one chip per item, named by
 * the shared formatter (`structuredItems`) — never `[object Object]`. An item whose
 * name is a page link, or the name of exactly one page of the target, opens that page
 * like a relation chip; every other item is plain text. Read-only by construction.
 */
function StructuredChips({ def, value, open }: { def: PropertyDef; value: unknown; open: boolean }) {
  const items = structuredItems(value);
  const target = structuredTargetFor(def);
  const idx = useRelationIndex(target, items.some((it) => !!it.link));
  const kind: "person" | "relation" = def.kind === "person" || (!!target && "tag" in target && target.tag === "person") ? "person" : "relation";
  if (!items.length) return <span className="db-empty">Empty</span>;
  return (
    <span className="db-chips db-structured" data-structured>
      {items.map((it, i) => {
        const resolution = it.link && idx.data ? resolveRelationValue(it.link, idx.data) : null;
        const linked = !!it.link && (it.link.startsWith("[[") || resolution?.kind === "note");
        return linked
          ? <LinkChip key={i} value={it.link!} kind={kind} open={open} target={target} resolution={resolution} text={it.label} detail={it.detail} />
          : <span key={i} className="db-link-chip db-structured-chip" data-kind="structured" title={it.text}>{it.text}</span>;
      })}
    </span>
  );
}

/** Relation / person chips: every stored encoding read against the target (one shared index per target). */
function RelationChips({ def, value, open }: { def: PropertyDef; value: unknown; open: boolean }) {
  const values = relationValues(value);
  const target = relationTargetFor(def);
  const idx = useRelationIndex(target, values.some(needsIndex));
  return (
    <span className="db-chips">
      {values.map((v) => (
        <LinkChip key={v} value={v} kind={def.kind as "person" | "relation"} open={open} target={target}
          resolution={idx.data && needsIndex(v) ? resolveRelationValue(v, idx.data) : null} />
      ))}
    </span>
  );
}

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
// `""` (an older writer's "empty list") and blank items are empty, never a chip.
// `scalarText`, not `String`: an object item reads as its name, never `[object Object]` (and such a value is never editable).
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(scalarText).filter((x) => x.trim() !== "") : isBlank(v) ? [] : [scalarText(v)]);

/** Read-only rendering (cards, read-only pages, cells of rows you cannot edit). */
export function PropertyDisplay({ def, value, openLinks = true, links = true }: { def: PropertyDef; value: unknown; /** Relation/person chips open their page on a plain click (off inside an editable cell, where the click edits). */ openLinks?: boolean; /** URL / email / phone render as real links. Off inside the cell's own button (a link inside a button is invalid and unreachable by keyboard); the cell renders the link beside the button instead. */ links?: boolean }) {
  if (isBlank(value)) return <span className="db-empty">Empty</span>;
  if (def.system === "created_time" || def.system === "edited_time") {
    const v = String(value);
    return <time className="db-text db-system" dateTime={v} title={new Date(v).toLocaleString()}>{formatDateTime(v)}</time>;
  }
  if (def.system === "created_by" || def.system === "edited_by") {
    const who = String(value) === "link" ? "Guest (link)" : String(value);
    return <span className="db-chips"><span className="db-link-chip" data-kind="person"><span className="db-avatar" aria-hidden="true">{who.slice(0, 1).toUpperCase()}</span>{who}</span></span>;
  }
  if (isStructuredValue(value)) return <StructuredChips def={def} value={value} open={openLinks} />;
  switch (def.kind) {
    case "select":
    case "status":
    case "multi_select":
      return <span className="db-chips">{list(value).map((v) => <OptionChip key={v} value={v} label={optionLabel(def, v)} color={colorOf(def, v)} />)}</span>;
    case "person":
    case "relation":
      return <RelationChips def={def} value={value} open={openLinks} />;
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
      return links && looksLikeEmail(v) ? <a className="db-url" href={`mailto:${v.trim()}`} onClick={(e) => e.stopPropagation()}>{v}</a> : <span className="db-text">{v}</span>;
    }
    case "phone": {
      const v = String(value);
      return links && looksLikePhone(v) ? <a className="db-url" href={`tel:${v.replace(/[^\d+]/g, "")}`} onClick={(e) => e.stopPropagation()}>{v}</a> : <span className="db-text">{v}</span>;
    }
    case "url": {
      const href = String(value);
      const safe = /^https?:\/\//i.test(href);
      if (safe && !links) return <span className="db-text">{href.replace(/^https?:\/\//, "")}</span>;
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
  // A value holding objects is never editable inline: every editor here works on text,
  // so any edit (a chip remove, a retype) would write the text back and lose the fields.
  const structured = isStructuredValue(value);
  const couldEdit = !readOnly;
  if (structured) readOnly = true;
  const [hintOpen, setHintOpen] = useState(false);

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
      setDraft(isBlank(value) ? "" : def.kind === "date" ? scalarText(value).slice(0, 10) : scalarText(value));
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
    if (structured) return; // belt and braces: no editor opens for a structured value
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

  const raw = isBlank(value) || structured ? "" : scalarText(value);
  const valueLink = def.kind === "url" && /^https?:\/\//i.test(raw) ? { href: raw, name: raw.replace(/^https?:\/\//, "") }
    : def.kind === "email" && looksLikeEmail(raw) ? { href: `mailto:${raw.trim()}`, name: raw }
    : def.kind === "phone" && looksLikePhone(raw) ? { href: `tel:${raw.replace(/[^\d+]/g, "")}`, name: raw }
    : null;
  const readOnlyLinks = !!readOnly && (structured || def.kind === "relation" || def.kind === "person") && !isBlank(value);
  return (
    <span className={`db-value db-value-${variant}`} data-linked={valueLink ? "" : undefined} data-structured={structured || undefined}>
      {readOnlyLinks ? (
        /* A reader's relation / person chips are links to those pages. Links may not sit inside a
           button, and a read-only cell has nothing else to do — so here it is a labelled group. */
        <span className="db-value-button" role="group" data-readonly aria-label={`${def.label}: ${formatValue(def, value) || "Empty"}`} title={structured ? STRUCTURED_HINT : undefined}>
          <PropertyDisplay def={def} value={value} openLinks links={false} />
          {/* Someone who could otherwise edit is told why this one cannot be (a tap shows it: phones have no hover). */}
          {structured && couldEdit && (
            <button type="button" className="db-structured-lock focus-ring" aria-label={`${def.label} is read-only: ${STRUCTURED_HINT}`} aria-expanded={hintOpen} title={STRUCTURED_HINT}
              onClick={(e) => { e.stopPropagation(); setHintOpen((v) => !v); }}>
              <Lock size={11} aria-hidden="true" />
            </button>
          )}
        </span>
      ) : (
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
          <PropertyDisplay def={def} value={value} openLinks={false} links={false} />
        )}
      </button>
      )}
      {/* The link sits BESIDE the cell's button (never inside it): a real, keyboard-reachable link named by its value. */}
      {valueLink && (
        <a className="db-value-link focus-ring" href={valueLink.href} aria-label={valueLink.name} title={`Open ${valueLink.name}`}
          {...(def.kind === "url" ? { target: "_blank", rel: "noreferrer noopener" } : {})} onClick={(e) => e.stopPropagation()}>
          {def.kind === "url" ? <ExternalLink size={12} aria-hidden="true" /> : def.kind === "email" ? <Mail size={12} aria-hidden="true" /> : <Phone size={12} aria-hidden="true" />}
        </a>
      )}
      {structured && hintOpen && <span role="status" className="db-structured-note">{STRUCTURED_HINT}</span>}
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
  // The vault's own `date` type holds one date; a range needs a text-typed field. And a
  // field of a tag an integration owns (`task.due`, a meeting's date…) stays a single date:
  // ingesters, agents and other apps read it as one.
  const ingestField = !!def.tag && INGEST_TAGS.has(def.tag);
  const rangeOk = def.type !== "date" && !ingestField;
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
        <label className="db-radio"><input type="checkbox" checked={endOn && rangeOk} disabled={!rangeOk} onChange={(e) => { setEndOn(e.target.checked); if (e.target.checked && (!endDate || endDate < date)) setEndDate(date); }} /> Add an end date{ingestField ? " (not here: this property is kept in sync by an integration)" : !rangeOk ? " (this property holds a single date)" : ""}</label>
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
            <li key={o} role="presentation" data-group={grouped ? g : undefined}>
              <button type="button" role="option" aria-selected={selected.has(o)} onClick={() => choose(o)}>
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

/**
 * The relation / person picker (B). It searches ONLY the relation's target (pages
 * with its tag, or under its folder), lists them on open, and offers
 * "Create “<query>”" when no target page has that name: a new page with the target
 * tag, beside the target's existing pages, through the ordinary create route (the
 * gateway decides; a refusal is said, nothing is linked). A choice is always written
 * as a full-path `[[wikilink]]`; values stored in an older encoding (folder link,
 * bare slug, name) are recognised as the page they mean, so choosing it again does
 * not add a second copy.
 */
function LinkPicker({ anchor, open, def, value, onClose, onPick }: {
  anchor: React.RefObject<HTMLElement | null>; open: boolean; def: PropertyDef; value: unknown;
  onClose: () => void; onPick: (next: unknown) => void;
}) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const scopeKey = useScope();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  const target = relationTargetFor(def);
  const openLinked = useOpenLinked(target);
  const candidates = useLinkCandidates(target, q, open);
  const current = list(value);
  // Every stored encoding, read as the page it means (needed to show what is selected).
  const idx = useRelationIndex(target, open);
  const pathOf = (v: string): string => (resolvedPath(v, idx.data) ?? linkTarget(v)).toLowerCase();
  const holds = (path: string) => current.some((v) => pathOf(v) === path.toLowerCase());
  const toggle = (path: string) => {
    const link = asWikilink(path);
    if (def.multiple) {
      const next = holds(path) ? current.filter((v) => pathOf(v) !== path.toLowerCase()) : [...current, link];
      onPick(next.length ? next : null);
    } else {
      onPick(link);
      onClose();
    }
  };
  const label = (v: string) => {
    const r = idx.data ? resolveRelationValue(v, idx.data) : null;
    return r?.kind === "note" ? r.note.title : linkLabel(v);
  };
  const rows = (candidates.data ?? []).filter((c) => c.path);
  const query = q.trim();
  const exact = rows.some((c) => c.title.toLowerCase() === query.toLowerCase());
  const tag = target && "tag" in target ? target.tag : null;
  const where = target ? ("tag" in target ? `#${target.tag}` : target.pathPrefix) : "";
  const canCreate = !!target && !!query && !exact && typeof client.createNote === "function";
  const create = async () => {
    if (!canCreate || creating) return;
    setErr("");
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setErr("Creating a page needs a connection. Nothing was added."); return; }
    setCreating(true);
    try {
      const index = idx.data ?? await qc.fetchQuery({ queryKey: relationIndexKey(scopeKey, target!), staleTime: 60_000, queryFn: () => loadRelationIndex(client, target!) });
      if (!index) throw new Error("no index");
      const existing = [...index.byPath.values()].flat().map((c) => c.path);
      const path = conventionalPath(target, existing, query);
      const note = await client.createNote({ content: "", path, tags: tag ? [tag] : [], metadata: { title: query } });
      if (!note?.id || note.id.startsWith("offline-")) { setErr("Creating a page needs a connection. Nothing was linked."); return; }
      void qc.invalidateQueries({ queryKey: ["vault", "search"] });
      void qc.invalidateQueries({ queryKey: ["vault", "tree"] });
      setQ("");
      toggle(note.path ?? path);
    } catch (e) {
      const status = e instanceof VaultRequestError ? e.status : /\b(40[349])\b/.exec(String((e as Error)?.message ?? ""))?.[1];
      setErr(String(status) === "403" ? `You can’t add ${where} pages.` : String(status) === "409" ? "A page with that name already exists there. Search for it instead." : "The page could not be created. Nothing was linked.");
    } finally {
      setCreating(false);
    }
  };
  const kindWord = def.kind === "person" ? "people" : "pages";
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label={`Link ${def.label}`} width={300}>
      {current.length > 0 && (
        <div className="db-pop-current">
          {current.map((v) => (
            <span key={v} className="db-link-chip" data-kind={def.kind}>
              <button type="button" className="db-link-open" aria-label={`Open ${label(v)}`} onClick={() => void openLinked(v).then((ok) => { if (ok) onClose(); })}>{label(v)}</button>
              <button type="button" aria-label={`Remove ${label(v)}`} onClick={() => { const next = current.filter((x) => x !== v); onPick(next.length ? (def.multiple ? next : next[0]) : null); }}><X size={11} aria-hidden="true" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="db-pop-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus aria-label={`Search ${kindWord}`} placeholder={target ? `Search ${where} ${kindWord}…` : def.kind === "person" ? "Search people…" : "Search pages…"} value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); if (rows.length === 1) toggle(rows[0]!.path!); else if (canCreate) void create(); } }} />
      </div>
      {target && <p className="db-pop-path db-pop-target">Links to {"tag" in target ? <>pages tagged <code>#{target.tag}</code></> : <>pages in <code>{target.pathPrefix}</code></>}</p>}
      <ul className="db-pop-list" role="listbox" aria-label={`${def.label} candidates`}>
        {rows.map((c) => (
          <li key={c.id} role="presentation">
            <button type="button" role="option" aria-selected={holds(c.path!)} onClick={() => toggle(c.path!)}>
              {def.kind === "person" && <span className="db-avatar" aria-hidden="true">{c.title.slice(0, 1).toUpperCase()}</span>}
              <span className="db-pop-title">{c.title}</span>
              <span className="db-pop-path">{c.path}</span>
            </button>
          </li>
        ))}
        {candidates.isLoading && <li className="db-pop-empty">Searching…</li>}
        {!candidates.isLoading && !rows.length && <li className="db-pop-empty">{q ? "No matches" : target ? `No ${where} ${kindWord} yet` : "Type to search"}</li>}
      </ul>
      {canCreate && (
        <button type="button" className="db-pop-create" disabled={creating} onClick={() => void create()}>
          <Plus size={14} aria-hidden="true" /> {creating ? "Creating…" : <>Create “{query}”{tag ? <span className="db-pop-path"> in #{tag}</span> : null}</>}
        </button>
      )}
      {err && <p role="alert" className="db-error">{err}</p>}
    </Popover>
  );
}
