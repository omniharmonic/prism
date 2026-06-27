import { useCallback, useMemo, useRef, useState, type MouseEvent } from "react";
import { sanitizeHtml } from "@prism/core";
import type { PublicationTemplateProps } from "./types";
import {
  buildLinkIndex,
  renderWikiBody,
  extractToc,
  computeBacklinks,
  buildTree,
  ancestorFolders,
  type TreeItem,
} from "./wiki-utils";

/**
 * Quartz-parity Wiki reader. Slots: header (title + in-publication search),
 * left path-tree nav (home pinned, active highlighted), center article (sanitized
 * HTML with scoped wikilinks), right rail (table of contents + backlinks), and a
 * "Published via Prism" footer. All note HTML is run through `sanitizeHtml` — it
 * is public/untrusted. Styled with the app's CSS variables so it feels native.
 */
export default function WikiTemplate({
  manifest,
  slug,
  activeId,
  note,
  noteLoading,
  onNavigate,
  graph,
}: PublicationTemplateProps) {
  const [query, setQuery] = useState("");
  const articleRef = useRef<HTMLDivElement>(null);

  const linkIndex = useMemo(() => buildLinkIndex(manifest.notes), [manifest.notes]);

  // Render → sanitize → extract TOC (which also injects heading ids).
  const { html, toc } = useMemo(() => {
    if (!note) return { html: "", toc: [] as ReturnType<typeof extractToc>["toc"] };
    const dirty = renderWikiBody(note.content, linkIndex, slug);
    return extractToc(sanitizeHtml(dirty));
  }, [note, linkIndex, slug]);

  const backlinks = useMemo(
    () => computeBacklinks(graph, activeId, manifest.notes),
    [graph, activeId, manifest.notes],
  );

  const tree = useMemo(() => buildTree(manifest.notes), [manifest.notes]);
  const homeNote = useMemo(
    () =>
      manifest.homeNoteId
        ? manifest.notes.find((n) => n.id === manifest.homeNoteId) || null
        : null,
    [manifest.homeNoteId, manifest.notes],
  );

  // Client-side, in-publication search: filter the note list by title (and path).
  const q = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!q) return null;
    return manifest.notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) || (n.path || "").toLowerCase().includes(q),
    );
  }, [q, manifest.notes]);

  // Intercept clicks on resolved wikilinks: navigate in-app (preserve modifier
  // clicks / middle-click so the real href still opens a new tab).
  const onArticleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const a = (e.target as HTMLElement).closest("a.pub-wikilink") as HTMLAnchorElement | null;
      if (!a) return;
      const id = a.getAttribute("data-target");
      if (!id) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      onNavigate(id);
    },
    [onNavigate],
  );

  const onTocClick = useCallback((e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const el = articleRef.current?.querySelector(`#${CSS.escape(id)}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      {/* Header: title + search */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "12px 20px",
          borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 15, color: "var(--text-primary, #fff)" }}>
          {manifest.title}
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this site…"
          style={{
            marginLeft: "auto",
            width: 220,
            maxWidth: "40vw",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
            background: "var(--glass-bg, rgba(255,255,255,0.04))",
            color: "var(--text-primary, #fff)",
            fontSize: 13,
            outline: "none",
          }}
        />
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Left nav: path tree (or search results) */}
        <nav
          style={{
            width: 260,
            flexShrink: 0,
            borderRight: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
            overflowY: "auto",
            padding: "12px 8px",
          }}
        >
          {searchResults ? (
            searchResults.length > 0 ? (
              searchResults.map((n) => (
                <NavLink
                  key={n.id}
                  label={n.title}
                  active={n.id === activeId}
                  depth={0}
                  onClick={() => onNavigate(n.id)}
                />
              ))
            ) : (
              <p style={emptyStyle}>No matches.</p>
            )
          ) : (
            <>
              {homeNote && (
                <NavLink
                  label={`🏠 ${homeNote.title}`}
                  active={homeNote.id === activeId}
                  depth={0}
                  onClick={() => onNavigate(homeNote.id)}
                />
              )}
              <TreeNav
                items={tree}
                activeId={activeId}
                homeId={manifest.homeNoteId}
                onNavigate={onNavigate}
                defaultOpen={ancestorFolders(manifest.notes, activeId)}
              />
              {manifest.notes.length === 0 && <p style={emptyStyle}>No published notes.</p>}
            </>
          )}
        </nav>

        {/* Center: article */}
        <main style={{ flex: 1, overflowY: "auto", padding: "0 24px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 0 96px" }}>
            {note && (
              <h1 style={{ marginTop: 0, fontSize: 28, color: "var(--text-primary, #fff)" }}>
                {note.title}
              </h1>
            )}
            {noteLoading && <p style={{ color: "var(--text-muted, #888)" }}>Loading…</p>}
            {!noteLoading && note && (
              <article
                ref={articleRef}
                className="prose-editor"
                onClick={onArticleClick}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
            {!noteLoading && !note && activeId && (
              <p style={{ color: "var(--text-secondary, #aaa)" }}>This note isn’t available.</p>
            )}
            <footer
              style={{
                marginTop: 64,
                paddingTop: 16,
                borderTop: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                fontSize: 12,
                color: "var(--text-muted, #777)",
              }}
            >
              Published via Prism
            </footer>
          </div>
        </main>

        {/* Right rail: TOC + backlinks */}
        <aside
          style={{
            width: 240,
            flexShrink: 0,
            borderLeft: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
            overflowY: "auto",
            padding: "40px 16px",
            fontSize: 12,
          }}
        >
          {toc.length > 0 && (
            <section style={{ marginBottom: 28 }}>
              <RailHeading>On this page</RailHeading>
              {toc.map((t) => (
                <a
                  key={t.id}
                  href={`#${t.id}`}
                  onClick={(e) => onTocClick(e, t.id)}
                  style={{
                    display: "block",
                    padding: "3px 0",
                    paddingLeft: (t.level - 1) * 12,
                    color: "var(--text-secondary, #bbb)",
                    textDecoration: "none",
                    lineHeight: 1.4,
                  }}
                >
                  {t.text}
                </a>
              ))}
            </section>
          )}

          <section>
            <RailHeading>Linked references</RailHeading>
            {backlinks.length > 0 ? (
              backlinks.map((b) => (
                <button
                  key={b.id}
                  onClick={() => onNavigate(b.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "3px 0",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-secondary, #bbb)",
                    cursor: "pointer",
                    fontSize: 12,
                    lineHeight: 1.4,
                  }}
                >
                  {b.title}
                </button>
              ))
            ) : (
              <p style={{ color: "var(--text-muted, #777)", margin: 0 }}>No backlinks.</p>
            )}
            {/* TODO (nice-to-have): an optional in-rail graph view rendered from
                /api/p/:slug/graph. Skipped to avoid heavy graph deps; backlinks
                already surface the same edges as a list. */}
          </section>
        </aside>
      </div>
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  color: "var(--text-muted, #777)",
  fontSize: 12,
  padding: "6px 10px",
};

function RailHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        textTransform: "uppercase",
        letterSpacing: 0.6,
        fontSize: 10,
        fontWeight: 700,
        color: "var(--text-muted, #888)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function NavLink({
  label,
  active,
  depth,
  onClick,
}: {
  label: string;
  active: boolean;
  depth: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "5px 10px",
        paddingLeft: 10 + depth * 14,
        borderRadius: 6,
        border: "none",
        background: active ? "var(--glass-hover, rgba(255,255,255,0.08))" : "transparent",
        color: active ? "var(--text-primary, #fff)" : "var(--text-secondary, #bbb)",
        cursor: "pointer",
        fontSize: 13,
        lineHeight: 1.3,
      }}
    >
      {label}
    </button>
  );
}

function TreeNav({
  items,
  activeId,
  homeId,
  onNavigate,
  defaultOpen,
  depth = 0,
}: {
  items: TreeItem[];
  activeId: string | null;
  homeId: string | null;
  onNavigate: (id: string) => void;
  defaultOpen: Set<string>;
  depth?: number;
}) {
  return (
    <>
      {items.map((item) =>
        item.type === "folder" ? (
          <Folder
            key={`f:${item.path}`}
            name={item.name}
            path={item.path}
            depth={depth}
            defaultOpen={defaultOpen.has(item.path)}
          >
            <TreeNav
              items={item.children}
              activeId={activeId}
              homeId={homeId}
              onNavigate={onNavigate}
              defaultOpen={defaultOpen}
              depth={depth + 1}
            />
          </Folder>
        ) : item.id === homeId ? null : ( // home is pinned separately at top
          <NavLink
            key={`l:${item.id}`}
            label={item.name}
            active={item.id === activeId}
            depth={depth}
            onClick={() => onNavigate(item.id)}
          />
        ),
      )}
    </>
  );
}

function Folder({
  name,
  depth,
  defaultOpen,
  children,
}: {
  name: string;
  path: string;
  depth: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "5px 10px",
          paddingLeft: 10 + depth * 14,
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: "var(--text-secondary, #bbb)",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {open ? "▾" : "▸"} {name}
      </button>
      {open && children}
    </div>
  );
}
