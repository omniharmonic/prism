import React, { Suspense, useEffect, useRef, useState } from "react";
import "./DocumentChrome.css";
import { ChevronRight, Folder, Smile } from "lucide-react";
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

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    if (savingRef.current) return;
    const v = draft.trim();
    if (!v || v === name) { setDraft(name); setEditing(false); setError(""); return; }
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await onRename(v);
      setEditing(false);
    } catch {
      setError("Could not rename this page. Your title is still here; press Enter to retry.");
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="document-title-edit"><input
        ref={inputRef}
        aria-label="Document title"
        value={draft}
        disabled={saving}
        aria-invalid={!!error}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { void commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void commit(); }
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
    <h1 style={titleStyle}>
      <button type="button" onClick={() => setEditing(true)} aria-label={`Rename ${name}`}
        title="Rename document" style={{ font: "inherit", textAlign: "left", cursor: "text", overflowWrap: "anywhere" }}>
        {name}
      </button>
    </h1>
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

/** Build the new note path when a title is renamed: swap the filename's base
 *  name (preserving folder + extension), sanitizing path separators. Returns
 *  null if the name is empty or unchanged. */
export function renamePath(oldPath: string | null | undefined, newName: string): string | null {
  if (!oldPath) return null;
  const slash = oldPath.lastIndexOf("/");
  const dir = slash >= 0 ? oldPath.slice(0, slash) : "";
  const file = slash >= 0 ? oldPath.slice(slash + 1) : oldPath;
  const ext = file.match(/\.[^.]+$/)?.[0] ?? "";
  const safe = newName.trim().replace(/[\\/]/g, "-");
  if (!safe) return null;
  const next = (dir ? `${dir}/` : "") + safe + ext;
  return next === oldPath ? null : next;
}

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
}) {
  const stripped = (path || "").replace(/^vault\//, "");
  const parts = stripped.split("/").filter(Boolean);
  const baseName = parts.length ? parts[parts.length - 1].replace(/\.[^.]+$/, "") : "";
  const name = baseName || fallbackName || "Untitled";
  const crumbs = parts.slice(0, -1);
  return (
    <header className="document-page-header">
      {crumbs.length > 0 && (
        <nav className="document-breadcrumb" aria-label="Document location">
          <Folder size={14} aria-hidden="true" className="shrink-0" />
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight size={12} aria-hidden="true" className="shrink-0" />}
              <span title={c} className="document-breadcrumb-part">{c}</span>
            </React.Fragment>
          ))}
        </nav>
      )}
      <div className="document-page-heading">
        {(icon || onIconChange) && (
          <IconTile icon={icon} typeIcon={typeIcon} onIconChange={onIconChange} />
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
    {date && <time dateTime={updatedAt!} title={date.toLocaleString()}>Updated {date.toLocaleDateString(undefined,{month:"short",day:"numeric"})}</time>}
    <details className="document-properties-disclosure">
      <summary className="focus-ring">Properties <ChevronRight size={14} aria-hidden="true" /></summary>
      <div className="document-properties-content">
        <dl>
          {path && <><dt>Location</dt><dd>{path}</dd></>}
          {tags && <><dt>Tags</dt><dd>{tags.length ? tags.map(tag => <span className="document-property-tag" key={tag}>{tag}</span>) : "No tags"}</dd></>}
          {date && <><dt>Updated</dt><dd>{date.toLocaleString()}</dd></>}
        </dl>
        {onOpenAll && <button type="button" className="document-properties-control focus-ring" onClick={onOpenAll}>Open all properties <ChevronRight size={14} aria-hidden="true" /></button>}
      </div>
    </details>
  </>;
}
