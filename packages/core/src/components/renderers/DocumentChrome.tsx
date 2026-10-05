import React, { Suspense, useEffect, useId, useRef, useState } from "react";
import "./DocumentChrome.css";
import { ChevronRight, Smile, ImagePlus, Upload } from "lucide-react";
import { PageIconView, PAGE_ICON_GLYPHS } from "../../lib/pages/PageIconView";
import { glyphIconValue, pageIconOf, parsePageIcon, PAGE_ICON_COLORS, PAGE_ICON_COLOR_CSS, PAGE_ICON_NAMES, type PageIconColor } from "../../lib/pages/iconValue";
import { formatBytes, MAX_IMAGE_BYTES } from "../../lib/media/attachments";
import { PageBreadcrumbs } from "../pages/Breadcrumbs";
export { PageCover } from "./PageCover";
import type { EmojiClickData, EmojiStyle, Theme } from "emoji-picker-react";

// Full emoji picker, lazy-loaded so it never weighs down the editor chunk —
// the ~megabyte of emoji data only loads when a user opens the picker.
const LazyEmojiPicker = React.lazy(() => import("emoji-picker-react"));

/** What an uploaded page icon may be (the server sniffs the bytes and decides). */
const ICON_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

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

type IconTab = "emoji" | "icons" | "upload";

/** Floating icon picker, anchored under the icon tile: emoji, a built-in icon in a colour,
 *  or (where the host can upload) an image of the page's own. Closes on pick,
 *  outside-click, or Escape. Matches the app theme (html.light/.dark). */
function IconPickerPopover({
  anchor,
  current,
  onPick,
  onRemove,
  onUpload,
  onClose,
}: {
  anchor: HTMLElement | null;
  current?: string | null;
  onPick: (icon: string) => void;
  onRemove?: () => void;
  /** Stores the file as an attachment of THIS page and resolves to its `/api/attachments/<id>` path. */
  onUpload?: (file: File) => Promise<string>;
  onClose: () => void;
}) {
  const rect = anchor?.getBoundingClientRect();
  const width = Math.min(336, window.innerWidth - 16);
  const top = rect ? Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 460)) : 80;
  const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) : 80;
  const isLight = typeof document !== "undefined" && document.documentElement.classList.contains("light");
  const parsed = parsePageIcon(current);
  const [tab, setTab] = useState<IconTab>(parsed?.kind === "glyph" ? "icons" : parsed?.kind === "image" && onUpload ? "upload" : "emoji");
  const [color, setColor] = useState<PageIconColor>(parsed?.kind === "glyph" ? parsed.color : "gray");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const tabsId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const upload = async (picked: File | undefined) => {
    if (!picked || !onUpload || busy) return;
    setError("");
    if (!ICON_IMAGE_TYPES.includes(picked.type)) { setError("Choose a PNG, JPEG, GIF, WebP or AVIF image."); return; }
    if (picked.size > MAX_IMAGE_BYTES) { setError(`That image is too large (the limit is ${formatBytes(MAX_IMAGE_BYTES)}).`); return; }
    setBusy(true);
    try {
      const url = await onUpload(picked);
      // Only the page's own attachment path is ever an image icon — never whatever a host returned.
      if (parsePageIcon(url)?.kind !== "image") throw new Error("not an attachment");
      onPick(url);
      if (alive.current) onClose();
    } catch {
      if (alive.current) setError(typeof navigator !== "undefined" && navigator.onLine === false ? "You’re offline. Connect to upload an image." : "The image could not be uploaded. Try again.");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const tabs: Array<{ id: IconTab; label: string }> = [{ id: "emoji", label: "Emoji" }, { id: "icons", label: "Icons" }, ...(onUpload ? [{ id: "upload" as const, label: "Upload" }] : [])];
  const tabKeys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    setTab(next.id);
    document.getElementById(`${tabsId}-${next.id}`)?.focus();
  };
  const bar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 2, padding: "4px 6px", background: "var(--bg-surface)", borderBottom: "1px solid var(--glass-border)" };
  const tabStyle = (selected: boolean): React.CSSProperties => ({ padding: "5px 10px", minHeight: 30, fontSize: "var(--text-sm)", borderRadius: "var(--radius-sm)", color: selected ? "var(--text-primary)" : "var(--text-secondary)", background: selected ? "var(--surface-selected)" : "transparent", fontWeight: selected ? 600 : 400 });

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 70 }} />
      <div
        className="icon-picker"
        role="dialog"
        aria-label="Page icon"
        style={{
          position: "fixed",
          top,
          left,
          width,
          zIndex: 71,
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
          boxShadow: "var(--glass-shadow-elevated)",
          background: "var(--bg-surface)",
          color: "var(--text-primary)",
        }}
      >
        <div style={bar}>
          <div role="tablist" aria-label="Icon type" onKeyDown={tabKeys} style={{ display: "flex", gap: 2, flex: 1, minWidth: 0 }}>
            {tabs.map((t) => (
              <button key={t.id} id={`${tabsId}-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`${tabsId}-panel`} tabIndex={tab === t.id ? 0 : -1}
                className="interactive focus-ring" onClick={() => setTab(t.id)} style={tabStyle(tab === t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          {onRemove && (
            <button type="button" onClick={() => { onRemove(); onClose(); }} className="interactive focus-ring" style={{ ...tabStyle(false), flex: "0 0 auto" }}>
              Remove icon
            </button>
          )}
        </div>
        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
          {tab === "emoji" && (
            <Suspense
              fallback={
                <div style={{ width: "100%", height: 300, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-surface)", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
                  Loading emoji…
                </div>
              }
            >
              <LazyEmojiPicker
                onEmojiClick={(d: EmojiClickData) => { onPick(d.emoji); onClose(); }}
                emojiStyle={"native" as EmojiStyle}
                theme={(isLight ? "light" : "dark") as Theme}
                lazyLoadEmojis
                width={width}
                height={400}
                previewConfig={{ showPreview: false }}
                searchPlaceHolder="Search emoji"
              />
            </Suspense>
          )}
          {tab === "icons" && (
            <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              <div role="radiogroup" aria-label="Icon colour" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {PAGE_ICON_COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c[0]!.toUpperCase() + c.slice(1)} title={c[0]!.toUpperCase() + c.slice(1)}
                    className="interactive focus-ring" onClick={() => setColor(c)}
                    style={{ width: 28, height: 28, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", border: color === c ? "2px solid var(--text-primary)" : "2px solid transparent" }}>
                    <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: "50%", background: PAGE_ICON_COLOR_CSS[c] }} />
                  </button>
                ))}
              </div>
              <div role="group" aria-label="Icons" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(36px, 1fr))", gap: 2 }}>
                {PAGE_ICON_NAMES.map((name) => {
                  const Glyph = PAGE_ICON_GLYPHS[name];
                  const value = glyphIconValue(name, color);
                  return (
                    <button key={name} type="button" aria-label={`${name[0]!.toUpperCase()}${name.slice(1)} icon`} title={name[0]!.toUpperCase() + name.slice(1)} aria-pressed={current === value}
                      className="interactive focus-ring" onClick={() => { onPick(value); onClose(); }}
                      style={{ height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-sm)", color: PAGE_ICON_COLOR_CSS[color], background: current === value ? "var(--surface-selected)" : undefined }}>
                      <Glyph size={20} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {tab === "upload" && onUpload && (
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
              {parsed?.kind === "image" && <PageIconView value={current} size={56} />}
              <input ref={file} type="file" accept={ICON_IMAGE_TYPES.join(",")} aria-label="Icon image file" hidden
                onChange={(e) => { const picked = e.target.files?.[0]; e.target.value = ""; void upload(picked); }} />
              <button type="button" className="interactive focus-ring" disabled={busy} aria-busy={busy || undefined} onClick={() => file.current?.click()}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 34, padding: "6px 12px", fontSize: "var(--text-sm)", borderRadius: "var(--radius-md)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                <Upload size={15} aria-hidden="true" />
                {busy ? "Uploading…" : parsed?.kind === "image" ? "Replace image…" : "Choose an image…"}
              </button>
              <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                PNG, JPEG, GIF, WebP or AVIF, up to {formatBytes(MAX_IMAGE_BYTES)}. It is stored with this page and shown to everyone who can see the page.
              </p>
              {error && <p role="alert" style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-danger)" }}>{error}</p>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Anytype-style object icon above the title: shows the chosen icon (large) or,
 *  when editable and unset, a quiet "add icon" affordance. Click → icon picker. */
function IconTile({
  icon,
  typeIcon,
  onIconChange,
  onIconUpload,
}: {
  icon?: string | null;
  typeIcon?: React.ReactNode;
  onIconChange?: (icon: string | null) => void;
  onIconUpload?: (file: File) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const editable = !!onIconChange;
  // A stored value that is not an icon (a stray URL, a path of another route) is never drawn.
  const shown = pageIconOf(icon);

  if (!shown && !editable) {
    return typeIcon ? (
      <div style={{ marginBottom: 8, color: "var(--text-muted)" }}>{typeIcon}</div>
    ) : null;
  }

  return (
    <div style={{ position: "relative", marginBottom: shown ? 6 : 4, marginLeft: -4 }}>
      <button
        ref={ref}
        type="button"
        onClick={() => editable && setOpen((o) => !o)}
        title={editable ? "Change icon" : undefined}
        aria-label={shown ? (editable ? "Change icon" : "Page icon") : undefined}
        aria-haspopup={editable ? "dialog" : undefined}
        aria-expanded={editable ? open : undefined}
        className={`interactive focus-ring document-icon-control ${shown ? "has-icon" : ""}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          justifyContent: "center",
          width: shown ? 56 : undefined,
          height: shown ? 56 : 28,
          padding: shown ? 0 : "0 8px",
          fontSize: shown ? 44 : "var(--text-xs)",
          lineHeight: 1,
          color: "var(--text-muted)",
          cursor: editable ? "pointer" : "default",
          borderRadius: "var(--radius-md)",
        }}
      >
        {shown ? (
          <PageIconView value={shown} size={55} fallback={typeIcon ?? <Smile size={28} />} />
        ) : (
          <>
            {typeIcon ?? <Smile size={15} />}
            <span>Add icon</span>
          </>
        )}
      </button>
      {open && editable && (
        <IconPickerPopover
          anchor={ref.current}
          current={shown}
          onPick={(e) => onIconChange?.(e)}
          onRemove={shown ? () => onIconChange?.(null) : undefined}
          onUpload={onIconUpload}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

export type ContentFont = "sans" | "serif" | "mono";

export { renamePath } from "../../lib/pages/model";
import { withoutExtension } from "../../lib/pages/model";

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
  onIconUpload,
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
  /** When provided, the icon picker offers "Upload": store the image as an attachment of THIS
   *  page and resolve to its `/api/attachments/<id>` path (nothing else is accepted as an image icon). */
  onIconUpload?: (file: File) => Promise<string>;
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
  const crumbs = parts.slice(0, -1);
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
            {(icon || onIconChange) && <IconTile icon={icon} typeIcon={typeIcon} onIconChange={onIconChange} onIconUpload={onIconChange ? onIconUpload : undefined} />}
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
