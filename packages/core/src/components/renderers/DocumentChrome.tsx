import React from "react";

/**
 * Shared document chrome — used by BOTH the plain DocumentRenderer and the live
 * CollabDoc host so the editing surface looks identical whether or not a note is
 * collaborative. Exposes the Notion-style page header (breadcrumb + title) and
 * the per-document Sans/Serif/Mono switch.
 */

export type ContentFont = "sans" | "serif" | "mono";

/** Notion-style page header: breadcrumb of the folder path + a large sans title
 *  derived from the filename. `right` is an optional slot for status/actions
 *  (e.g. collab presence + comments toggle). Display-only. */
export function PageHeader({
  path,
  fallbackName,
  right,
}: {
  path?: string | null;
  /** Used when the path has no usable filename (e.g. a content-derived title). */
  fallbackName?: string;
  right?: React.ReactNode;
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
        <h1
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-3xl)",
            fontWeight: 700,
            letterSpacing: "-0.022em",
            lineHeight: 1.15,
            color: "var(--text-primary)",
          }}
        >
          {name}
        </h1>
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
