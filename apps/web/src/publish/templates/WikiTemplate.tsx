import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, Suspense, lazy } from "react";
import { sanitizeHtml } from "@prism/core";
import type { PubNote, PublicationTemplateProps } from "./types";
import { resolveTheme } from "../theme";
import { WikiGraph } from "./WikiGraph";
import { WikiMap } from "./WikiMap";
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
// The article's own map, mirroring the in-app geo-note editor: a note carrying
// real GeoJSON (or a geo centroid) shows it drawn above the prose. Lazy, like
// WikiMap, so text-only readers never pay for MapLibre.
const ArticleCommonsMap = lazy(() => import("@prism/core").then((m) => ({ default: m.CommonsMap })));

const GEO_KINDS = ["ecological-entity", "species", "watershed", "place", "signal", "organization", "event", "resource"];

function articleFeature(note: PubNote): { id: string; kind: string; name: string; geometry?: unknown; geo?: { lat: number; lon: number } | null } | null {
  const m = note.metadata ?? {};
  let geometry: unknown = null;
  for (const k of ["geometry", "boundaryGeometry", "rangeGeometry"]) {
    const g = m[k] as { type?: unknown; coordinates?: unknown } | null | undefined;
    if (g && typeof g === "object" && typeof g.type === "string" && g.coordinates != null) { geometry = g; break; }
  }
  const rawGeo = m.geo as { lat?: unknown; lon?: unknown } | null | undefined;
  const geo = rawGeo && typeof rawGeo === "object" && typeof rawGeo.lat === "number" && typeof rawGeo.lon === "number"
    ? { lat: rawGeo.lat, lon: rawGeo.lon } : null;
  if (!geometry && !geo) return null;
  const kind = (note.tags ?? []).find((t: string) => GEO_KINDS.includes(t)) ?? "place";
  return { id: note.id, kind, name: (typeof m.name === "string" && m.name) || note.title, geometry, geo };
}

/** Below this width the wiki renders its single-column phone layout. */
const MOBILE_BP = 880;

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BP}px)`);
    const on = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

/** Phone chrome styles: the drawer slide, trailhead chips, readable prose. One
 *  block, scoped under .pubwiki-m, honoring prefers-reduced-motion. */
const MOBILE_CSS = `
.pubwiki-m article.prose-editor { font-size: 16px; line-height: 1.7; }
.pubwiki-m article.prose-editor h1, .pubwiki-m article.prose-editor h2 { text-wrap: balance; }
.pubwiki-scrim {
  position: fixed; inset: 0; z-index: 40;
  background: rgba(0,0,0,0.5);
  animation: pubwiki-fade 200ms ease-out;
}
.pubwiki-drawer {
  position: fixed; top: 0; bottom: 0; left: 0; z-index: 41;
  width: min(85vw, 340px);
  display: flex; flex-direction: column;
  background: var(--bg, #16181d);
  border-right: 1px solid var(--glass-border, rgba(255,255,255,0.1));
  box-shadow: 12px 0 40px rgba(0,0,0,0.35);
  padding-top: env(safe-area-inset-top);
  padding-left: env(safe-area-inset-left);
  animation: pubwiki-slide 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes pubwiki-slide { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@keyframes pubwiki-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .pubwiki-drawer, .pubwiki-scrim { animation: none; }
}
.pubwiki-drawer button { min-height: 44px; }
.pubwiki-chip {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 14px; border-radius: 999px;
  border: 1px solid var(--glass-border, rgba(255,255,255,0.14));
  background: var(--glass-bg, rgba(255,255,255,0.05));
  color: var(--text-primary, #eee);
  font-size: 14px; line-height: 1.2; cursor: pointer;
  max-width: 100%;
}
.pubwiki-chip > span.mark { color: var(--text-muted, #888); font-size: 12px; }
.pubwiki-chip > span.txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pubwiki-chip:active { background: var(--glass-hover, rgba(255,255,255,0.1)); }
.pubwiki-m button:focus-visible, .pubwiki-drawer button:focus-visible, .pubwiki-m a:focus-visible {
  outline: 2px solid var(--color-accent, #4a7dd7); outline-offset: 2px; border-radius: 6px;
}
.pubwiki-toc summary {
  list-style: none; cursor: pointer;
  text-transform: uppercase; letter-spacing: 0.6px;
  font-size: 11px; font-weight: 700; color: var(--text-muted, #888);
  padding: 6px 0; min-height: 32px; display: flex; align-items: center; gap: 6px;
}
.pubwiki-toc summary::before { content: "▸"; font-size: 9px; transition: transform 150ms; }
.pubwiki-toc[open] summary::before { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .pubwiki-toc summary::before { transition: none; } }
`;

export default function WikiTemplate({
  manifest,
  slug,
  activeId,
  note,
  noteLoading,
  onNavigate,
  graph,
  mapFeatures,
  onRequestMap,
}: PublicationTemplateProps) {
  const [query, setQuery] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);
  // Map view: offered only when the publication actually has geo-bearing notes
  // (manifest.mapFeatureCount). Opening it triggers the lazy feature fetch.
  const [mapOpen, setMapOpen] = useState(false);
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Hub notes (the bioregion, indexes) can have hundreds of backlinks — show a
  // page, offer the rest. Reset per note.
  const [allBacklinks, setAllBacklinks] = useState(false);
  useEffect(() => { setAllBacklinks(false); }, [activeId]);
  // Drawer hygiene: close when navigation happens, lock body scroll while open,
  // close on Escape.
  useEffect(() => { setDrawerOpen(false); }, [activeId]);
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);
  const hasMap = (manifest.mapFeatureCount ?? 0) > 0;
  const openMap = useCallback(() => {
    setMapOpen(true);
    onRequestMap();
  }, [onRequestMap]);
  const articleRef = useRef<HTMLDivElement>(null);

  // Owner-set theme, re-validated here before it touches the page (untrusted on a
  // public site). Applied as CSS custom properties + a body font on the wiki root.
  const safeTheme = useMemo(() => resolveTheme(manifest.theme), [manifest.theme]);

  const linkIndex = useMemo(() => buildLinkIndex(manifest.notes), [manifest.notes]);

  // Render → sanitize → extract TOC (which also injects heading ids).
  const { html, toc } = useMemo(() => {
    if (!note) return { html: "", toc: [] as ReturnType<typeof extractToc>["toc"] };
    const dirty = renderWikiBody(note.content, linkIndex, slug);
    const out = extractToc(sanitizeHtml(dirty));
    // Notes conventionally open with "# <Title>", and the chrome already shows
    // the title — drop the body's leading h1 when it just repeats it.
    const m = out.html.match(/^\s*<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (m) {
      const text = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text === note.title.replace(/\s+/g, " ").trim().toLowerCase()) {
        out.html = out.html.replace(m[0], "");
      }
    }
    return out;
  }, [note, linkIndex, slug]);

  // The /notes/<x> slot accepts a vault PATH as well as a note id (the twin's
  // deep-link contract). Identity-keyed UI (backlinks, active nav row, map
  // focus) must use the loaded note's REAL id, not the raw slot value.
  const effectiveId = note?.id ?? activeId;

  const backlinks = useMemo(
    () => computeBacklinks(graph, effectiveId, manifest.notes),
    [graph, effectiveId, manifest.notes],
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

  // Theme: CSS custom properties + (optional) font on the wiki root. Falls back
  // to the app defaults when no theme is set.
  const rootStyle: CSSProperties = {
    minHeight: "100dvh",
    display: "flex",
    flexDirection: "column",
    ...safeTheme.vars,
    ...(safeTheme.fontFamily ? { fontFamily: safeTheme.fontFamily } : null),
    ...(safeTheme.vars["--bg"] ? { background: safeTheme.vars["--bg"] } : null),
  };

  // Search + home + tree: one nav body, rendered in the desktop column AND the
  // phone drawer (16px input font on mobile — iOS zooms any smaller input).
  const navBody = (
    <>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search this site…"
        style={{
          width: "100%",
          boxSizing: "border-box",
          marginBottom: 10,
          padding: isMobile ? "11px 12px" : "7px 10px",
          borderRadius: 8,
          border: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
          background: "var(--glass-bg, rgba(255,255,255,0.04))",
          color: "var(--text-primary, #fff)",
          fontSize: isMobile ? 16 : 13,
          outline: "none",
        }}
      />
      {searchResults ? (
        searchResults.length > 0 ? (
          searchResults.map((n) => (
            <NavLink key={n.id} label={n.title} active={n.id === effectiveId} depth={0} onClick={() => onNavigate(n.id)} />
          ))
        ) : (
          <p style={emptyStyle}>No matches.</p>
        )
      ) : (
        <>
          {homeNote && (
            <NavLink
              label={`🏠 ${homeNote.title}`}
              active={homeNote.id === effectiveId}
              depth={0}
              onClick={() => onNavigate(homeNote.id)}
            />
          )}
          <TreeNav
            items={tree}
            activeId={effectiveId}
            homeId={manifest.homeNoteId}
            onNavigate={onNavigate}
            defaultOpen={ancestorFolders(manifest.notes, effectiveId)}
          />
          {manifest.notes.length === 0 && <p style={emptyStyle}>No published notes.</p>}
        </>
      )}
    </>
  );

  // ── Phone layout: one column, drawer nav, trailhead chips ──────────────────
  if (isMobile) {
    const f = !noteLoading && note ? articleFeature(note) : null;
    return (
      <div style={rootStyle} className="pubwiki-m">
        <style>{MOBILE_CSS}</style>
        <header
          style={{
            position: "sticky", top: 0, zIndex: 30,
            display: "flex", alignItems: "center", gap: 10,
            padding: "calc(env(safe-area-inset-top) + 8px) 12px 8px",
            background: safeTheme.vars["--bg"] ?? "var(--bg, #16181d)",
            borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
            minHeight: 52, boxSizing: "border-box",
          }}
        >
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Contents"
            data-testid="wiki-drawer-open"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 40, height: 40, flexShrink: 0,
              borderRadius: 10, border: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
              background: "transparent", color: "var(--text-primary, #fff)",
              fontSize: 17, cursor: "pointer",
            }}
          >
            ☰
          </button>
          <span
            style={{
              fontWeight: 600, fontSize: 15, color: "var(--text-primary, #fff)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1,
            }}
          >
            {manifest.title}
          </span>
          {hasMap && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <HeaderTab label="Article" active={!mapOpen} onClick={() => setMapOpen(false)} />
              <HeaderTab label="Map" active={mapOpen} onClick={openMap} testId="wiki-map-tab" />
            </div>
          )}
        </header>

        {mapOpen ? (
          <main style={{ flex: 1, minWidth: 0, padding: 10 }}>
            <WikiMap
              features={mapFeatures}
              activeId={effectiveId}
              onNavigate={(id) => { setMapOpen(false); onNavigate(id); }}
            />
          </main>
        ) : (
          <main style={{ flex: 1, padding: "0 16px" }}>
            <div style={{ maxWidth: 680, margin: "0 auto", padding: "20px 0 calc(env(safe-area-inset-bottom) + 56px)" }}>
              {note && (
                <h1 style={{ margin: "0 0 12px", fontSize: "clamp(24px, 6.4vw, 30px)", lineHeight: 1.25, color: "var(--text-primary, #fff)" }}>
                  {note.title}
                </h1>
              )}
              {noteLoading && <p style={{ color: "var(--text-muted, #888)" }}>Loading…</p>}
              {!noteLoading && note && toc.length >= 3 && (
                <details className="pubwiki-toc" style={{ marginBottom: 14 }}>
                  <summary>On this page</summary>
                  <div style={{ padding: "2px 0 6px" }}>
                    {toc.map((t) => (
                      <a
                        key={t.id}
                        href={`#${t.id}`}
                        onClick={(e) => onTocClick(e, t.id)}
                        style={{
                          display: "block", padding: "8px 0", paddingLeft: (t.level - 1) * 14,
                          color: "var(--text-secondary, #bbb)", textDecoration: "none",
                          fontSize: 14, lineHeight: 1.35,
                        }}
                      >
                        {t.text}
                      </a>
                    ))}
                  </div>
                </details>
              )}
              {f && (
                <div style={{ margin: "0 0 18px" }}>
                  <Suspense fallback={<div style={{ height: 240, borderRadius: 12, background: "var(--glass, rgba(128,128,128,0.08))" }} />}>
                    <ArticleCommonsMap features={[f as never]} height={240} showControls={false} testId="article-map" />
                  </Suspense>
                </div>
              )}
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

              {backlinks.length > 0 && (
                <section style={{ marginTop: 40 }}>
                  <RailHeading>Linked references</RailHeading>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }} data-testid="wiki-backlink-chips">
                    {(allBacklinks ? backlinks : backlinks.slice(0, 12)).map((b) => (
                      <button key={b.id} className="pubwiki-chip" onClick={() => onNavigate(b.id)}>
                        <span className="mark">↩</span>
                        <span className="txt">{b.title}</span>
                      </button>
                    ))}
                    {!allBacklinks && backlinks.length > 12 && (
                      <button className="pubwiki-chip" onClick={() => setAllBacklinks(true)} style={{ color: "var(--text-secondary, #bbb)" }}>
                        <span className="txt">Show all {backlinks.length}</span>
                      </button>
                    )}
                  </div>
                </section>
              )}

              {graph && graph.nodes.length > 0 && (
                <section style={{ marginTop: 28 }}>
                  <details className="pubwiki-toc">
                    <summary>Graph</summary>
                    <div
                      style={{
                        marginTop: 6,
                        border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                        borderRadius: 10, overflow: "hidden",
                        background: "var(--glass-bg, rgba(255,255,255,0.02))",
                      }}
                    >
                      <WikiGraph graph={graph} activeId={effectiveId} onNavigate={onNavigate} />
                    </div>
                  </details>
                </section>
              )}

              <footer
                style={{
                  marginTop: 48, paddingTop: 16,
                  borderTop: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                  fontSize: 12, color: "var(--text-muted, #777)",
                }}
              >
                Published via Prism
              </footer>
            </div>
          </main>
        )}

        {drawerOpen && (
          <>
            <div className="pubwiki-scrim" onClick={() => setDrawerOpen(false)} data-testid="wiki-drawer-scrim" />
            <div className="pubwiki-drawer" role="dialog" aria-modal="true" aria-label="Contents" data-testid="wiki-drawer">
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 4px" }}>
                <span style={{ flex: 1, fontWeight: 600, fontSize: 14, color: "var(--text-primary, #fff)" }}>Contents</span>
                <button
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close contents"
                  style={{
                    width: 40, height: 40, borderRadius: 10, border: "none",
                    background: "transparent", color: "var(--text-secondary, #bbb)",
                    fontSize: 17, cursor: "pointer",
                  }}
                >
                  ✕
                </button>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "4px 10px calc(env(safe-area-inset-bottom) + 12px)" }}>
                {navBody}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Desktop layout (unchanged) ─────────────────────────────────────────────
  return (
    <div style={rootStyle}>
      {/* Header: optional logo + title */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 20px",
          borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
        }}
      >
        {safeTheme.logoUrl && (
          <img
            src={safeTheme.logoUrl}
            alt=""
            style={{ height: 24, width: "auto", maxWidth: 160, objectFit: "contain", display: "block" }}
          />
        )}
        <span style={{ fontWeight: 600, fontSize: 15, color: "var(--text-primary, #fff)" }}>
          {manifest.title}
        </span>
        {hasMap && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <HeaderTab label="Article" active={!mapOpen} onClick={() => setMapOpen(false)} />
            <HeaderTab label="Map" active={mapOpen} onClick={openMap} testId="wiki-map-tab" />
          </div>
        )}
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Left column: search (above) + path tree nav */}
        <nav
          style={{
            width: 260,
            flexShrink: 0,
            borderRight: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
            overflowY: "auto",
            padding: "12px 8px",
          }}
        >
          {navBody}
        </nav>

        {/* Center: article, or the publication-scoped map view */}
        {mapOpen ? (
          <main style={{ flex: 1, minWidth: 0, padding: 16 }}>
            <WikiMap
              features={mapFeatures}
              activeId={effectiveId}
              onNavigate={(id) => {
                setMapOpen(false);
                onNavigate(id);
              }}
            />
          </main>
        ) : (
        <main style={{ flex: 1, overflowY: "auto", padding: "0 24px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 0 96px" }}>
            {note && (
              <h1 style={{ marginTop: 0, fontSize: 28, color: "var(--text-primary, #fff)" }}>
                {note.title}
              </h1>
            )}
            {noteLoading && <p style={{ color: "var(--text-muted, #888)" }}>Loading…</p>}
            {!noteLoading && note && (() => { const f = articleFeature(note); return f ? (
              <div style={{ margin: "0 0 20px" }}>
                <Suspense fallback={<div style={{ height: 360, borderRadius: 12, background: "var(--glass, rgba(128,128,128,0.08))" }} />}>
                  <ArticleCommonsMap features={[f as never]} height={360} showControls={false} testId="article-map" />
                </Suspense>
              </div>
            ) : null; })()}
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
        )}

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
          </section>

          {/* Graph: a collapsible, in-rail force graph built ONLY from the
              publication-scoped (leak-proof) /api/p/:slug/graph endpoint. Click a
              node to navigate (same routing as the nav tree). */}
          {graph && graph.nodes.length > 0 && (
            <section style={{ marginTop: 28 }}>
              <button
                onClick={() => setGraphOpen((o) => !o)}
                aria-expanded={graphOpen}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--text-muted, #888)",
                  marginBottom: 8,
                }}
              >
                <span style={{ fontSize: 9 }}>{graphOpen ? "▾" : "▸"}</span> Graph
              </button>
              {graphOpen && (
                <div
                  style={{
                    border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                    borderRadius: 10,
                    overflow: "hidden",
                    background: "var(--glass-bg, rgba(255,255,255,0.02))",
                  }}
                >
                  <WikiGraph graph={graph} activeId={effectiveId} onNavigate={onNavigate} />
                </div>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function HeaderTab({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      style={{
        padding: "5px 12px",
        borderRadius: 8,
        border: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
        background: active ? "var(--glass-hover, rgba(255,255,255,0.08))" : "transparent",
        color: active ? "var(--text-primary, #fff)" : "var(--text-secondary, #bbb)",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
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
