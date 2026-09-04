/**
 * Bioregional entity renderer — a geo-aware view for the commons's mapped types
 * (ecological-entity, species, watershed, place, signal). Renders the note's
 * GeoJSON on the shared MapLibre CommonsMap (OpenFreeMap basemap, blank
 * fallback), the sensing/responding cleavage, the key identifier/standard
 * fields, and — for signals — the affects/response links that close the
 * sense→respond loop.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type { RendererProps } from "./RendererProps";
import { CommonsMap, type MapFeature } from "../map/CommonsMap";
import { withBbox } from "../../lib/geo/geojson";
import { convertApi } from "../../lib/parachute/client";
import { useWikilinkNavigate } from "../../app/hooks/useWikilinkNavigate";
import { reviewMode } from "../../lib/governance/review";

// The real document editor (TipTap + autosave + wikilink autocomplete + slash
// commands), lazy so the read-only geo view doesn't pay for the editor bundle.
const DocumentEditor = lazy(() => import("./DocumentRenderer"));

const str = (m: Record<string, unknown> | null, k: string): string => {
  const v = m?.[k];
  return typeof v === "string" ? v : v == null ? "" : String(v);
};
const arr = (m: Record<string, unknown> | null, k: string): string[] => {
  const v = m?.[k];
  return Array.isArray(v) ? v.map(String) : [];
};

// The fields worth surfacing per type — literal upstream terms.
const FIELDS = ["scientificName", "vernacularName", "family", "gbifTaxonKey", "huc12", "hucName", "ecological_kind", "signal_kind", "severity", "resource_kind", "status", "same_as"];

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** [[target]] / [[target|label]] → clickable anchors. Runs AFTER markdown
 *  conversion (wikilinks survive it as literal text — same order as the
 *  document editor's decoration), so it never depends on raw-HTML passthrough. */
function linkifyWikilinks(html: string): string {
  return html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => {
    const t = target.trim();
    const text = (label ?? t.split("/").pop() ?? t).trim();
    return `<a class="wikilink" data-wikilink-target="${escapeHtml(t)}" data-wikilink-display="${escapeHtml(text)}">${escapeHtml(text)}</a>`;
  });
}

const BODY_CSS = `
.bioregion-body { line-height: 1.65; font-size: 15px; }
.bioregion-body h1 { font-size: 1.5em; font-weight: 650; margin: 0.2em 0 0.5em; }
.bioregion-body h2 { font-size: 1.2em; font-weight: 650; margin: 1.1em 0 0.4em; }
.bioregion-body h3 { font-size: 1.05em; font-weight: 650; margin: 1em 0 0.3em; }
.bioregion-body p { margin: 0.55em 0; }
.bioregion-body ul, .bioregion-body ol { margin: 0.55em 0; padding-left: 1.4em; }
.bioregion-body li { margin: 0.2em 0; }
.bioregion-body blockquote { margin: 0.7em 0; padding-left: 1em; border-left: 3px solid rgba(128,128,128,0.35); opacity: 0.85; }
.bioregion-body hr { border: none; border-top: 1px solid rgba(128,128,128,0.25); margin: 1.2em 0; }
.bioregion-body a { color: var(--color-accent, #2563eb); text-decoration: none; cursor: pointer; }
.bioregion-body a:hover { text-decoration: underline; }
.bioregion-body strong { font-weight: 650; }
.bioregion-body table { border-collapse: collapse; margin: 0.7em 0; }
.bioregion-body th, .bioregion-body td { border: 1px solid rgba(128,128,128,0.3); padding: 4px 10px; font-size: 14px; }
`;

const smallBtn: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: 7,
  border: "1px solid rgba(128,128,128,0.4)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  font: "12px system-ui",
  fontWeight: 600,
};

export default function BioregionEntityRenderer({ note, onSave, onMetadataChange, readOnly }: RendererProps) {
  const m = (note.metadata ?? null) as Record<string, unknown> | null;
  const geometry = (m?.geometry ?? m?.boundaryGeometry ?? m?.rangeGeometry) as { type?: string; coordinates?: unknown } | undefined;
  const sensing = str(m, "sensing_or_responding");
  const tag = (note.tags ?? []).find((t) => ["ecological-entity", "species", "watershed", "place", "signal"].includes(t)) ?? "entity";
  const color = tag === "signal" ? "#c62828" : tag === "watershed" ? "#1565c0" : tag === "species" ? "#00897b" : "#2e7d32";
  const affects = arr(m, "affects");
  const response = arr(m, "response");
  const editable = !!onMetadataChange && !readOnly;

  // ── Edit mode: swap the geo view for the REAL document editor ─────────────
  // Gating mirrors DocumentRenderer's own: `readOnly` (published wiki /
  // anonymous surfaces) hides the affordance entirely; a governed "read-only"
  // actor (view/comment caps, no suggest) gets no button either — the editor
  // would only lock itself. A "propose" actor DOES get the button:
  // DocumentRenderer implements the propose-for-review flow (local edits +
  // submit banner, autosave suppressed). Desktop and web owners carry no
  // `_caps`, so `mode` is "none" and they get plain editing.
  const mode = reviewMode(note);
  const canEditBody = !readOnly && mode !== "read-only";
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [note.id]); // switching notes exits edit mode

  // Hand the editor IDENTITY-STABLE callbacks. Canvas re-creates its onSave /
  // onMetadataChange on every render (they close over a fresh useMutation
  // object), and DocumentRenderer keys effects off onMetadataChange identity
  // (via its font-persist callback). On the web-owner path that unstable
  // identity + a whole-store subscription re-render feed back into each other
  // and blow React's update-depth limit — a combination the app never hit
  // before because web documents route to the collab editor, not this one.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onMetadataChangeRef = useRef(onMetadataChange);
  onMetadataChangeRef.current = onMetadataChange;
  const stableOnSave = useCallback((content: string) => onSaveRef.current?.(content), []);
  const stableOnMetadataChange = useCallback((md: Record<string, unknown>) => onMetadataChangeRef.current?.(md), []);

  // The body is vault markdown — render it (with clickable [[wikilinks]])
  // instead of dumping the raw source. Conversion goes through convertApi so
  // each shell uses its own converter (Rust command / marked shim).
  const [bodyHtml, setBodyHtml] = useState<string>("");
  const navigate = useWikilinkNavigate();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const raw = note.content ?? "";
      if (!raw.trim()) { setBodyHtml(""); return; }
      let html: string;
      try {
        html = raw.trim().startsWith("<") ? raw : await convertApi.markdownToHtml(raw);
      } catch {
        html = `<p>${escapeHtml(raw)}</p>`;
      }
      if (!cancelled) setBodyHtml(DOMPurify.sanitize(linkifyWikilinks(html)));
    })();
    return () => { cancelled = true; };
  }, [note.id, note.content]);

  const onBodyClick = useCallback(
    (e: React.MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      const wl = a.getAttribute("data-wikilink-target");
      if (wl) { e.preventDefault(); navigate(wl); return; }
      const href = a.getAttribute("href");
      if (href && /^https?:/i.test(href)) { e.preventDefault(); window.open(href, "_blank", "noopener,noreferrer"); }
    },
    [navigate],
  );

  // Persist a drawn geometry (with a derived bbox) into note metadata; null clears it.
  const saveGeometry = (g: unknown | null) => {
    if (!onMetadataChange) return;
    const base = { ...(note.metadata ?? {}) } as Record<string, unknown>;
    if (g == null) {
      delete base.geometry;
      delete base.bbox;
      onMetadataChange(base);
    } else {
      onMetadataChange(withBbox({ ...base, geometry: g }));
    }
  };

  const hasGeo = geometry?.coordinates !== undefined || Boolean(m?.geo);

  if (editing) {
    // The editor autosaves through the vault mutation (which invalidates the
    // note query), so by the time "Done" flips back the refetched note.content
    // feeds the read view. A pending debounce is flushed by the editor's
    // unmount cleanup.
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }} data-testid="bioregion-entity">
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 20px 0" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.4 }}>{tag}</span>
          <button style={{ ...smallBtn, marginLeft: "auto" }} onClick={() => setEditing(false)} data-testid="bioregion-done" title="Back to the map view">
            Done
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <Suspense fallback={<div style={{ padding: 24, opacity: 0.6, font: "14px system-ui" }}>Loading editor…</div>}>
            <DocumentEditor note={note} onSave={stableOnSave} onMetadataChange={stableOnMetadataChange} readOnly={readOnly} />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: 20, fontFamily: "system-ui, sans-serif" }} data-testid="bioregion-entity">
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.4 }}>{tag}</span>
        {sensing && <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, opacity: 0.7 }}>{sensing}</span>}
        {canEditBody && (
          <button style={{ ...smallBtn, marginLeft: "auto" }} onClick={() => setEditing(true)} data-testid="bioregion-edit" title="Edit this note in the document editor">
            Edit
          </button>
        )}
      </div>

      {(hasGeo || editable) && (
        <div style={{ margin: "12px 0" }}>
          {editable && !hasGeo && (
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
              No location yet — use the draw tools (top-left of the map) to add a point, line, or polygon. It saves as GeoJSON on this note.
            </div>
          )}
          <CommonsMap
            features={hasGeo ? [{ id: note.id, kind: tag, name: (m?.name as string) ?? note.id, sensing, geometry: geometry ?? null, geo: (m?.geo as { lat: number; lon: number } | undefined) ?? null } as MapFeature] : []}
            height={360}
            showControls={false}
            testId="entity-map"
            editable={editable}
            value={geometry ?? null}
            onGeometryChange={saveGeometry}
          />
        </div>
      )}

      <table style={{ borderCollapse: "collapse", margin: "8px 0" }}>
        <tbody>
          {FIELDS.map((f) => {
            const v = m?.[f];
            if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) return null;
            return (
              <tr key={f}>
                <td style={{ padding: "3px 12px 3px 0", opacity: 0.6, verticalAlign: "top", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{f}</td>
                <td style={{ padding: "3px 0" }}>{Array.isArray(v) ? v.join(", ") : String(v)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {(affects.length > 0 || response.length > 0) && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "8px 0" }} data-testid="cybernetic-links">
          {affects.length > 0 && (
            <div>
              <div style={{ fontWeight: 650, color: "#c62828" }}>⚠ Affects</div>
              {affects.map((a) => <div key={a} style={{ padding: "2px 0" }}>{a.replace(/^\[\[|\]\]$/g, "")}</div>)}
            </div>
          )}
          {response.length > 0 && (
            <div>
              <div style={{ fontWeight: 650, color: "#2e7d32" }}>→ Response</div>
              {response.map((a) => <div key={a} style={{ padding: "2px 0" }}>{a.replace(/^\[\[|\]\]$/g, "")}</div>)}
            </div>
          )}
        </div>
      )}

      {bodyHtml && (
        <>
          <style>{BODY_CSS}</style>
          <div
            className="bioregion-body"
            data-testid="bioregion-body"
            onClick={onBodyClick}
            style={{ marginTop: 12, borderTop: "1px solid rgba(128,128,128,0.2)", paddingTop: 12 }}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        </>
      )}
    </div>
  );
}
