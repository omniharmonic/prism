import React, { useEffect, useRef, useState } from "react";

const titleStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-3xl)",
  fontWeight: 700,
  letterSpacing: "-0.022em",
  lineHeight: 1.15,
  color: "var(--text-primary)",
};

/** Inline-editable page title: click to rename, Enter/blur commits, Esc cancels.
 *  Looks identical to the static <h1>. Commits the new (display) name only. */
function EditableTitle({ name, onRename }: { name: string; onRename: (newName: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== name) onRename(v);
    else setDraft(name);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { setDraft(name); setEditing(false); }
        }}
        spellCheck={false}
        style={{ ...titleStyle, width: "100%", background: "transparent", border: "none", outline: "none", padding: 0 }}
      />
    );
  }
  return (
    <h1
      onClick={() => setEditing(true)}
      title="Click to rename"
      style={{ ...titleStyle, cursor: "text" }}
    >
      {name}
    </h1>
  );
}

/**
 * Shared document chrome — used by BOTH the plain DocumentRenderer and the live
 * CollabDoc host so the editing surface looks identical whether or not a note is
 * collaborative. Exposes the Notion-style page header (breadcrumb + title) and
 * the per-document Sans/Serif/Mono switch.
 */

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
}: {
  path?: string | null;
  /** Used when the path has no usable filename (e.g. a content-derived title). */
  fallbackName?: string;
  right?: React.ReactNode;
  /** When provided, the title becomes click-to-edit and commits the new display
   *  name here (the host turns it into a path rename). */
  onRename?: (newName: string) => void;
}) {
  const stripped = (path || "").replace(/^vault\//, "");
  const parts = stripped.split("/").filter(Boolean);
  const baseName = parts.length ? parts[parts.length - 1].replace(/\.[^.]+$/, "") : "";
  const name = baseName || fallbackName || "Untitled";
  const crumbs = parts.slice(0, -1);
  return (
    <header
      style={{
        marginBottom: "var(--space-6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <div style={{ minWidth: 0 }}>
        {crumbs.length > 0 && (
          <nav
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 4,
              marginBottom: "var(--space-3)",
              fontSize: "var(--text-xs)",
              color: "var(--text-muted)",
            }}
          >
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span className="truncate" style={{ maxWidth: 160 }}>{c}</span>
                {i < crumbs.length - 1 && <span style={{ opacity: 0.6 }}>/</span>}
              </span>
            ))}
          </nav>
        )}
        {onRename ? (
          <EditableTitle name={name} onRename={onRename} />
        ) : (
          <h1 style={titleStyle}>{name}</h1>
        )}
      </div>
      {right && <div style={{ flexShrink: 0 }}>{right}</div>}
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
