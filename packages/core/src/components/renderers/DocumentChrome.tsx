import React, { Suspense, useEffect, useRef, useState } from "react";
import "./DocumentChrome.css";
import { ChevronRight, Smile, ImagePlus } from "lucide-react";
import { PageBreadcrumbs, useHeaderBreadcrumbPath } from "../pages/Breadcrumbs";
export { PageCover } from "./PageCover";
import type { EmojiClickData, EmojiStyle, Theme } from "emoji-picker-react";

// Full emoji picker, lazy-loaded so it never weighs down the editor chunk —
// the ~megabyte of emoji data only loads when a user opens the picker.
const LazyEmojiPicker = React.lazy(() => import("emoji-picker-react"));

const titleStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--document-title-size, clamp(32px, 3.2vw, 42px))",
  fontWeight: 700,
  margin: 0,
  overflowWrap: "anywhere",
  letterSpacing: "-0.035em",
  lineHeight: 1.15,
  color: "var(--text-primary)",
};

/** Inline-editable page title: click to rename, Enter/blur commits, Esc cancels.
 *  Looks identical to the static <h1>. Commits the new (display) name only. */
function EditableTitle({ name, onRename }: { name: string; onRename: (newName: string) => void | Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Why the last rename was refused; shown under the (reverted) title until the next edit or page.
  const [refused, setRefused] = useState("");
  useEffect(() => { setRefused(""); }, [name]);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // NP-PG-03: Enter commits the title and moves into the body (first block),
  // like pressing Enter at the end of a heading. Blur and Esc leave focus alone.
  const wrapRef = useRef<HTMLDivElement>(null);
  const toBody = () => {
    for (let node: HTMLElement | null = wrapRef.current; node; node = node.parentElement) {
      const body = node.querySelector<HTMLElement>('.tiptap[contenteditable="true"]');
      if (body) { body.focus(); return; }
    }
  };
  // The title whose rename last failed and was kept: a BLUR with it sends nothing again (Enter is the retry) —
  // one request per attempted title, so nobody is held in the field hammering the server.
  const lastFailed = useRef<string | null>(null);
  const commit = async (thenBody = false) => {
    if (savingRef.current) return;
    const v = draft.trim();
    if (!v || v === name) { if (thenBody) toBody(); lastFailed.current = null; setDraft(name); setEditing(false); setError(""); return; }
    if (!thenBody && lastFailed.current === v) return;
    // After Enter the person is in the body: once they do anything there, a failure must not pull them back.
    let movedOn = false;
    const moved = () => { movedOn = true; };
    const watch = ["keydown", "pointerdown", "input"] as const;
    if (thenBody) for (const type of watch) document.addEventListener(type, moved, true);
    savingRef.current = true;
    setSaving(true);
    setError("");
    setRefused("");
    // Move first: the rename may take a moment, and typing should not wait for it.
    if (thenBody) toBody();
    try {
      await onRename(v);
      lastFailed.current = null;
      setEditing(false);
    } catch (e) {
      if (thenBody) for (const type of watch) document.removeEventListener(type, moved, true);
      // Name taken / page changed / no permission / page gone / offline: say why and put the title back.
      if (e instanceof Error && (e as { revertTitle?: unknown }).revertTitle === true) {
        lastFailed.current = null;
        setDraft(name);
        setEditing(false);
        setRefused(e.message);
        return;
      }
      // The server's own reason (no permission here, unsent changes…) when it gave one.
      const why = e instanceof Error && e.name === "PagesRequestError" && e.message ? ` ${e.message.replace(/[.\s]+$/, "")}.` : "";
      setError(`Could not rename this page.${why} Your title is still here; press Enter to retry.`);
      lastFailed.current = v;
      // Focus comes back to the title only for an Enter the person has not moved on from. A blur means
      // they went somewhere else on purpose: the typed title and the reason stay, focus is theirs.
      if (thenBody && !movedOn) inputRef.current?.focus();
    } finally {
      if (thenBody) for (const type of watch) document.removeEventListener(type, moved, true);
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="document-title-edit" ref={wrapRef}><input
        ref={inputRef}
        aria-label="Document title"
        value={draft}
        // readOnly, not disabled: disabling a focused input drops its focus, and
        // re-focusing after the failure raced React's re-enable under load.
        readOnly={saving}
        aria-busy={saving || undefined}
        aria-invalid={!!error}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { void commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void commit(true); }
          if (e.key === "Escape") { setDraft(name); setEditing(false); setError(""); }
        }}
        spellCheck={false}
        style={{ ...titleStyle, width: "100%", background: "transparent", border: "none", outline: "none", padding: 0 }}
      />
      {saving && <p role="status" className="document-title-notice">Renaming…</p>}
      {error && <p role="alert" className="document-title-notice">{error}</p>}
      </div>
    );
  }
  return (
    <>
      <h1 style={titleStyle}>
        <button type="button" onClick={() => { setRefused(""); setEditing(true); }} aria-label={`Rename ${name}`}
          title="Rename document" style={{ font: "inherit", textAlign: "left", cursor: "text", overflowWrap: "anywhere" }}>
          {name}
        </button>
      </h1>
      {refused && <p role="alert" className="document-title-notice" data-title-refused>{refused}</p>}
    </>
  );
}

/**
 * Shared document chrome — used by BOTH the plain DocumentRenderer and the live
 * CollabDoc host so the editing surface looks identical whether or not a note is
 * collaborative. Exposes the Notion-style page header (breadcrumb + title) and
 * the per-document Sans/Serif/Mono switch.
 */

/** Floating full-emoji picker, anchored under the icon tile. Closes on pick,
 *  outside-click, or Escape. Matches the app theme (html.light/.dark). */
function EmojiPickerPopover({
  anchor,
  onPick,
  onRemove,
  onClose,
}: {
  anchor: HTMLElement | null;
  onPick: (emoji: string) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const rect = anchor?.getBoundingClientRect();
  const top = rect ? Math.min(rect.bottom + 6, window.innerHeight - 420) : 80;
  const left = rect ? Math.min(rect.left, window.innerWidth - 352) : 80;
  const isLight = typeof document !== "undefined" && document.documentElement.classList.contains("light");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 70 }} />
      <div
        style={{
          position: "fixed",
          top,
          left,
          zIndex: 71,
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
          boxShadow: "var(--glass-shadow-elevated)",
        }}
      >
        {onRemove && (
          <button
            onClick={() => { onRemove(); onClose(); }}
            className="interactive"
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 12px",
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
              background: "var(--bg-surface)",
              borderBottom: "1px solid var(--glass-border)",
            }}
          >
            Remove icon
          </button>
        )}
        <Suspense
          fallback={
            <div style={{ width: 336, height: 300, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-surface)", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
              Loading emoji…
            </div>
          }
        >
          <LazyEmojiPicker
            onEmojiClick={(d: EmojiClickData) => { onPick(d.emoji); onClose(); }}
            emojiStyle={"native" as EmojiStyle}
            theme={(isLight ? "light" : "dark") as Theme}
            lazyLoadEmojis
            width={336}
            height={400}
            previewConfig={{ showPreview: false }}
            searchPlaceHolder="Search emoji"
          />
        </Suspense>
      </div>
    </>
  );
}

/** Anytype-style object icon above the title: shows the chosen emoji (large) or,
 *  when editable and unset, a quiet "add icon" affordance. Click → emoji picker. */
function IconTile({
  icon,
  typeIcon,
  onIconChange,
}: {
  icon?: string | null;
  typeIcon?: React.ReactNode;
  onIconChange?: (emoji: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const editable = !!onIconChange;

  if (!icon && !editable) {
    return typeIcon ? (
      <div style={{ marginBottom: 8, color: "var(--text-muted)" }}>{typeIcon}</div>
    ) : null;
  }

  return (
    <div style={{ position: "relative", marginBottom: icon ? 6 : 4, marginLeft: -4 }}>
      <button
        ref={ref}
        onClick={() => editable && setOpen((o) => !o)}
        title={editable ? "Change icon" : undefined}
        className={`interactive focus-ring document-icon-control ${icon ? "has-icon" : ""}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          justifyContent: "center",
          width: icon ? 56 : undefined,
          height: icon ? 56 : 28,
          padding: icon ? 0 : "0 8px",
          fontSize: icon ? 44 : "var(--text-xs)",
          lineHeight: 1,
          color: "var(--text-muted)",
          cursor: editable ? "pointer" : "default",
          borderRadius: "var(--radius-md)",
        }}
      >
        {icon ? (
          <span style={{ fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif' }}>{icon}</span>
        ) : (
          <>
            {typeIcon ?? <Smile size={15} />}
            <span>Add icon</span>
          </>
        )}
      </button>
      {open && editable && (
        <EmojiPickerPopover
          anchor={ref.current}
          onPick={(e) => onIconChange?.(e)}
          onRemove={icon ? () => onIconChange?.(null) : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

export type ContentFont = "sans" | "serif" | "mono";

export { renamePath } from "../../lib/pages/model";
import { withoutExtension } from "../../lib/pages/model";

import { formatDate as fmtDate, formatDateTime as fmtDateTime } from "../../lib/datetime/format";
/** Notion-style page header: breadcrumb of the folder path + a large sans title
 *  derived from the filename. `right` is an optional slot for status/actions
 *  (e.g. collab presence + comments toggle). Display-only. */
export function PageHeader({
  path,
  fallbackName,
  right,
  onRename,
  icon,
  typeIcon,
  onIconChange,
  details,
  onAddCover,
  presence,
}: {
  path?: string | null;
  /** Used when the path has no usable filename (e.g. a content-derived title). */
  fallbackName?: string;
  right?: React.ReactNode;
  /** Quiet metadata/properties row, supplied by hosts with those capabilities. */
  details?: React.ReactNode;
  /** When provided, the title becomes click-to-edit and commits the new display
   *  name here (the host turns it into a path rename). */
  onRename?: (newName: string) => void | Promise<void>;
  /** The object's emoji icon (from metadata), if set. */
  icon?: string | null;
  /** Fallback icon (e.g. a type glyph) shown when no emoji is set. */
  typeIcon?: React.ReactNode;
  /** When provided, the icon is clickable and opens the emoji picker; pass the
   *  chosen emoji (or null to clear) here for the host to persist. */
  onIconChange?: (emoji: string | null) => void;
  /** When provided (and the page has no cover yet), an "Add cover" control is shown; the host adds a default cover. */
  onAddCover?: () => void;
  /**
   * Named slot for live presence (who else is on this page). Rendered at the top
   * right of the header, beside the breadcrumb. Group 2D fills it; hosts pass
   * nothing today. Keep it small (avatars) — it wraps under the title on phones.
   */
  presence?: React.ReactNode;
}) {
  const stripped = (path || "").replace(/^vault\//, "");
  const parts = stripped.split("/").filter(Boolean);
  const baseName = parts.length ? withoutExtension(parts[parts.length - 1]) : "";
  const name = baseName || fallbackName || "Untitled";
  // NP-PG-06: the header bar shows this page's breadcrumb when it hosts it — then not here too.
  const inBar = useHeaderBreadcrumbPath();
  const crumbs = inBar && inBar === path ? [] : parts.slice(0, -1);
  return (
    <header className="document-page-header">
      {(crumbs.length > 0 || presence) && (
        <div className="document-page-topline">
          {crumbs.length > 0 ? <PageBreadcrumbs path={path} /> : <span />}
          {presence && <div className="document-page-presence" data-slot="presence">{presence}</div>}
        </div>
      )}
      <div className="document-page-heading">
        {(icon || onIconChange || onAddCover) && (
          <div className="document-page-adders">
            {(icon || onIconChange) && <IconTile icon={icon} typeIcon={typeIcon} onIconChange={onIconChange} />}
            {onAddCover && (
              <button type="button" className="interactive focus-ring document-add-cover" onClick={onAddCover}>
                <ImagePlus size={15} aria-hidden="true" />
                <span>Add cover</span>
              </button>
            )}
          </div>
        )}
        {onRename ? (
          <EditableTitle name={name} onRename={onRename} />
        ) : (
          <h1 style={titleStyle}>{name}</h1>
        )}
      </div>
      {(details || path || right) && <div className="document-page-details">
        {(details || path) && <div className="document-page-metadata">{details ?? <PageProperties path={path} />}</div>}
        {right && <div className="document-page-status">{right}</div>}
      </div>}
    </header>
  );
}

/** Notion-style per-document font switch; each option renders in its own face. */
export function FontSwitch({ value, onChange }: { value: ContentFont; onChange: (f: ContentFont) => void }) {
  const opts: { key: ContentFont; label: string; family: string }[] = [
    { key: "sans", label: "Sans", family: "var(--font-sans)" },
    { key: "serif", label: "Serif", family: "var(--font-serif)" },
    { key: "mono", label: "Mono", family: "var(--font-mono)" },
  ];
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Document font">
      {opts.map((o) => {
        const selected = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className="interactive focus-ring"
            data-selected={selected || undefined}
            title={`${o.label} font`}
            style={{
              padding: "2px 8px",
              fontFamily: o.family,
              fontSize: "var(--text-xs)",
              color: selected ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}


/** A compact, read-only properties disclosure shared by normal and live pages.
 * Hosts may supply their existing full-properties action; this never mutates a
 * document or invents save/permission state. */
export function PageProperties({path, tags, updatedAt, onOpenAll}: {
  path?: string | null; tags?: string[]; updatedAt?: string | null; onOpenAll?: () => void;
}) {
  const date = updatedAt && !Number.isNaN(new Date(updatedAt).getTime()) ? new Date(updatedAt) : null;
  return <>
    {date && <time dateTime={updatedAt!} title={fmtDateTime(date)}>Updated {fmtDate(date, {month:"short",day:"numeric"})}</time>}
    <details className="document-properties-disclosure">
      <summary className="focus-ring">Properties <ChevronRight size={14} aria-hidden="true" /></summary>
      <div className="document-properties-content">
        <dl>
          {path && <><dt>Location</dt><dd>{path}</dd></>}
          {tags && <><dt>Tags</dt><dd>{tags.length ? tags.map(tag => <span className="document-property-tag" key={tag}>{tag}</span>) : "No tags"}</dd></>}
          {date && <><dt>Updated</dt><dd>{fmtDateTime(date)}</dd></>}
        </dl>
        {onOpenAll && <button type="button" className="document-properties-control focus-ring" onClick={onOpenAll}>Open all properties <ChevronRight size={14} aria-hidden="true" /></button>}
      </div>
    </details>
  </>;
}
