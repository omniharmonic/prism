/**
 * CommonsMap — the shared MapLibre GL surface for the geospatial commons. Used
 * both by the /bioregion browse map (all in-scope entities) and by the per-note
 * bioregion renderer (a single focused feature).
 *
 * Design notes:
 *  - Two GeoJSON sources: a CLUSTERED point source (points + geo centroids) and
 *    an unclustered shape source (lines/polygons). Data-driven color by `kind`.
 *  - Basemap defaults to OpenFreeMap vector tiles but ALWAYS degrades to a
 *    network-free blank style when tiles can't load (offline, CSP-locked, tile
 *    host down) — the note geometry renders regardless.
 *  - No WebGL (rare headless case) → a graceful fallback panel; the surrounding
 *    list UI still works. Test hooks: the container carries data-map-ready /
 *    data-feature-count (or data-map-fallback) so e2e can assert state without a
 *    GPU.
 *  - Text/label layers are gated on the basemap's `hasGlyphs` (blank has none).
 */
import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MLMap, type StyleSpecification, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { resolveBasemap, kindColor, kindColorExpression, BLANK_STYLE, BASEMAPS, type Basemap } from "./basemaps";
import { DrawController, type DrawKind, type DrawMode } from "./draw";

export interface MapFeature {
  id: string;
  kind: string;
  name: string;
  sensing?: string;
  status?: string;
  geometry?: unknown | null;
  geo?: { lat: number; lon: number } | null;
}

export interface CommonsMapProps {
  features: MapFeature[];
  basemap?: string | null;
  height?: number | string;
  /** Explicit "open this note" request — fired by the popup's Open button, never
   *  by a bare map click. Wire this to openTab. */
  onPick?: (id: string) => void;
  /** Fired when a map click selects a feature (smallest polygon wins). */
  onSelect?: (id: string) => void;
  selectedId?: string | null;
  showControls?: boolean;
  /** Fit to data on load + when the feature set changes (default true). */
  autoFit?: boolean;
  testId?: string;
  /** Enable the draw toolbar (point/line/polygon) — the geometry-editing UX. */
  editable?: boolean;
  /** The note's current geometry, used to seed edits. */
  value?: unknown | null;
  /** Emitted when the user finishes drawing (or clears). Persist as GeoJSON. */
  onGeometryChange?: (geometry: unknown | null) => void;
}

type FC = GeoJSON.FeatureCollection;
type Pos = [number, number];

// ---- defensive geometry sanitization ---------------------------------------
// Vault geometry comes from many ingests; a corrupt ring (thinned below 4
// points, non-finite coords, unclosed) must degrade to "skip that ring", never
// "drop the whole feature" — and never crash the layer.
const finitePos = (p: unknown): p is Pos => Array.isArray(p) && Number.isFinite(p[0] as number) && Number.isFinite(p[1] as number);

/** Valid closed ring or null: ≥4 finite positions, closure repaired if missing. */
function cleanRing(r: unknown): Pos[] | null {
  if (!Array.isArray(r)) return null;
  const pts = (r as unknown[]).filter(finitePos);
  if (pts.length < 3) return null;
  const closed = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts : [...pts, [...pts[0]] as Pos];
  return closed.length >= 4 ? closed : null;
}
function cleanLine(l: unknown): Pos[] | null {
  if (!Array.isArray(l)) return null;
  const pts = (l as unknown[]).filter(finitePos);
  return pts.length >= 2 ? pts : null;
}
/** Sanitize a shape geometry, salvaging the valid parts. Null = nothing valid. */
function sanitizeShape(g: GeoJSON.Geometry): GeoJSON.Geometry | null {
  if (g.type === "LineString") {
    const l = cleanLine(g.coordinates);
    return l ? { type: "LineString", coordinates: l } : null;
  }
  if (g.type === "MultiLineString") {
    const ls = (g.coordinates as unknown[]).map(cleanLine).filter((x): x is Pos[] => x != null);
    return ls.length ? { type: "MultiLineString", coordinates: ls } : null;
  }
  const cleanPoly = (rings: unknown): Pos[][] | null => {
    if (!Array.isArray(rings) || rings.length === 0) return null;
    const outer = cleanRing(rings[0]);
    if (!outer) return null; // no valid outer ring → this polygon part is gone
    const holes = (rings as unknown[]).slice(1).map(cleanRing).filter((x): x is Pos[] => x != null);
    return [outer, ...holes];
  };
  if (g.type === "Polygon") {
    const p = cleanPoly(g.coordinates);
    return p ? { type: "Polygon", coordinates: p } : null;
  }
  if (g.type === "MultiPolygon") {
    const ps = (g.coordinates as unknown[]).map(cleanPoly).filter((x): x is Pos[][] => x != null);
    return ps.length ? { type: "MultiPolygon", coordinates: ps } : null;
  }
  return null;
}

/** Planar shoelace area (deg²) over the outer ring(s) — only used to RANK
 *  nested polygons (smallest wins a click; biggest paints first), so the
 *  unprojected approximation is fine. */
function ringArea(r: Pos[]): number {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(a / 2);
}
function shapeArea(g: GeoJSON.Geometry): number {
  if (g.type === "Polygon") return ringArea(g.coordinates[0] as Pos[]);
  if (g.type === "MultiPolygon") return (g.coordinates as Pos[][][]).reduce((a, p) => a + ringArea(p[0]), 0);
  return 0;
}

function toPoint(f: MapFeature): GeoJSON.Feature | null {
  const g = f.geometry as GeoJSON.Geometry | undefined;
  if (g && g.type === "Point") return finitePos(g.coordinates as unknown) ? { type: "Feature", geometry: g, properties: props(f) } : null;
  if (g && g.type === "MultiPoint") {
    const pts = (g.coordinates as unknown[]).filter(finitePos);
    return pts.length ? { type: "Feature", geometry: { type: "MultiPoint", coordinates: pts }, properties: props(f) } : null;
  }
  if (!g && f.geo && Number.isFinite(f.geo.lon) && Number.isFinite(f.geo.lat)) return { type: "Feature", geometry: { type: "Point", coordinates: [f.geo.lon, f.geo.lat] }, properties: props(f) };
  return null;
}
function toShape(f: MapFeature): GeoJSON.Feature | null {
  const g = f.geometry as GeoJSON.Geometry | undefined;
  if (!g || !["LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(g.type)) return null;
  const clean = sanitizeShape(g);
  if (!clean) return null;
  return { type: "Feature", geometry: clean, properties: { ...props(f), area: shapeArea(clean) } };
}
const props = (f: MapFeature) => ({ id: f.id, kind: f.kind, name: f.name, sensing: f.sensing ?? "", status: f.status ?? "" });

function collect(features: MapFeature[]): { points: FC; shapes: FC; bounds: maplibregl.LngLatBounds | null } {
  const points: GeoJSON.Feature[] = [];
  const shapes: GeoJSON.Feature[] = [];
  let bounds: maplibregl.LngLatBounds | null = null;
  const extend = (lon: number, lat: number) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    bounds = bounds ? bounds.extend([lon, lat]) : new maplibregl.LngLatBounds([lon, lat], [lon, lat]);
  };
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") extend(c[0] as number, c[1] as number);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  for (const f of features) {
    const p = toPoint(f);
    const s = toShape(f);
    if (p) {
      points.push(p);
      walk((p.geometry as GeoJSON.Point).coordinates);
    }
    if (s) {
      shapes.push(s);
      walk((s.geometry as { coordinates: unknown }).coordinates);
    }
  }
  // Big-under-small: sort descending by area so nested polygons paint smallest
  // on top — their fills stay visible AND hoverable/clickable under deep nesting.
  shapes.sort((a, b) => Number(b.properties?.area ?? 0) - Number(a.properties?.area ?? 0));
  return { points: { type: "FeatureCollection", features: points }, shapes: { type: "FeatureCollection", features: shapes }, bounds };
}

const SRC_PTS = "commons-points";
const SRC_SHP = "commons-shapes";

/** Cheap up-front WebGL probe — MapLibre needs it; a browser/headless runner
 *  without it gets the graceful fallback rather than a hung canvas. */
function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"));
  } catch {
    return false;
  }
}

export function CommonsMap({ features, basemap, height = 460, onPick, onSelect, selectedId, showControls = true, autoFit = true, testId = "commons-map", editable = false, value, onGeometryChange }: CommonsMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const drawRef = useRef<DrawController | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const fittedRef = useRef(false);
  const [drawMode, setDrawMode] = useState<DrawMode>("none");
  const [current, setCurrent] = useState<Basemap>(() => resolveBasemap(basemap));
  const [webglFailed, setWebglFailed] = useState(false);
  const featRef = useRef(features);
  featRef.current = features;
  const geomChangeRef = useRef(onGeometryChange);
  geomChangeRef.current = onGeometryChange;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // (Re)build sources + layers on the active style; idempotent.
  const paint = (map: MLMap, hasGlyphs: boolean) => {
    const { points, shapes, bounds } = collect(featRef.current);
    if (!map.getSource(SRC_PTS)) {
      map.addSource(SRC_PTS, { type: "geojson", data: points, cluster: true, clusterRadius: 46, clusterMaxZoom: 12 });
      map.addSource(SRC_SHP, { type: "geojson", data: shapes });

      // watershed / polygon fills + outlines. Fill opacity scales down with
      // area (deg²) so a huge container (the bioregion ring, a HUC-8) stays a
      // faint wash while deeply nested HUC-12s remain legible on top.
      map.addLayer({ id: "shp-fill", type: "fill", source: SRC_SHP, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": kindColorExpression() as never, "fill-opacity": ["interpolate", ["linear"], ["coalesce", ["get", "area"], 0], 0, 0.14, 0.02, 0.1, 0.2, 0.05, 2, 0.025] as never } });
      map.addLayer({ id: "shp-outline", type: "line", source: SRC_SHP, filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": kindColorExpression() as never, "line-width": 1.2 } });
      // rivers / lines
      map.addLayer({ id: "shp-line", type: "line", source: SRC_SHP, filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": kindColorExpression() as never, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.5, 14, 4] as never } });
      // clusters
      map.addLayer({ id: "clusters", type: "circle", source: SRC_PTS, filter: ["has", "point_count"], paint: { "circle-color": "#0ea5e9", "circle-opacity": 0.85, "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 30] as never, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      // unclustered points
      map.addLayer({ id: "points", type: "circle", source: SRC_PTS, filter: ["!", ["has", "point_count"]], paint: { "circle-color": kindColorExpression() as never, "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 5, 14, 8] as never, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      // selection highlight: ring for points, bold outline for shapes
      map.addLayer({ id: "points-selected", type: "circle", source: SRC_PTS, filter: ["==", ["get", "id"], "__none__"], paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": 13, "circle-stroke-color": "#111", "circle-stroke-width": 3 } });
      map.addLayer({ id: "shp-selected", type: "line", source: SRC_SHP, filter: ["==", ["get", "id"], "__none__"], paint: { "line-color": "#111", "line-width": 3 } });

      if (hasGlyphs) {
        map.addLayer({ id: "cluster-count", type: "symbol", source: SRC_PTS, filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12 }, paint: { "text-color": "#fff" } });
        map.addLayer({ id: "labels", type: "symbol", source: SRC_PTS, filter: ["!", ["has", "point_count"]], layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-optional": true }, paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
      }

      // interactions (registered once; layers persist across setData).
      // ONE map-wide click handler with smallest-feature-wins resolution:
      // points beat lines beat polygons, and among stacked polygons the
      // SMALLEST area wins — so a HUC-12 nested inside a HUC-10 inside a HUC-8
      // inside the bioregion ring is what you actually selected, and the big
      // ring can never swallow a click. A click SELECTS (highlight + popup);
      // opening the note is the popup's explicit "Open →" button (onPick) —
      // never a side effect of clicking the map.
      const select = (id: string) => {
        map.setFilter("points-selected", ["==", ["get", "id"], id]);
        map.setFilter("shp-selected", ["==", ["get", "id"], id]);
        onSelectRef.current?.(id);
      };
      const openPopup = (lngLat: maplibregl.LngLatLike, p: Record<string, unknown>) => {
        const id = String(p.id ?? "");
        const el = document.createElement("div");
        el.dataset.testid = "map-popup";
        el.style.font = "13px system-ui";
        el.style.minWidth = "140px";
        el.style.color = "#111"; // popup chrome is white; don't inherit the app's dark-theme text color
        const title = document.createElement("b");
        title.textContent = String(p.name ?? "");
        const sub = document.createElement("div");
        sub.style.opacity = "0.7";
        sub.style.margin = "1px 0 6px";
        sub.textContent = `${String(p.kind ?? "")}${p.sensing ? " · " + String(p.sensing) : ""}`;
        const open = document.createElement("button");
        open.dataset.testid = "map-popup-open";
        open.textContent = "Open →";
        Object.assign(open.style, { padding: "3px 10px", borderRadius: "7px", border: "1px solid rgba(0,0,0,0.2)", background: "#111", color: "#fff", cursor: "pointer", font: "12px system-ui", fontWeight: "600" });
        open.onclick = () => onPickRef.current?.(id);
        el.append(title, sub, open);
        popupRef.current?.remove();
        popupRef.current = new maplibregl.Popup({ closeButton: true, offset: 10 }).setLngLat(lngLat).setDOMContent(el).addTo(map);
      };
      map.on("click", (e) => {
        if (drawRef.current?.isDrawing) return; // drawing owns clicks
        const layers = ["clusters", "points", "shp-line", "shp-fill"].filter((l) => map.getLayer(l));
        const feats = map.queryRenderedFeatures(e.point, { layers });
        if (!feats.length) return;
        const cluster = feats.find((f) => f.layer.id === "clusters");
        if (cluster) {
          const cid = cluster.properties?.cluster_id;
          if (cid == null) return;
          (map.getSource(SRC_PTS) as GeoJSONSource).getClusterExpansionZoom(cid as number).then((zoom) => {
            map.easeTo({ center: (cluster.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
          });
          return;
        }
        let chosen = feats.find((f) => f.layer.id === "points") ?? feats.find((f) => f.layer.id === "shp-line");
        if (!chosen) {
          const polys = feats.filter((f) => f.layer.id === "shp-fill");
          chosen = polys.reduce((best, f) => (Number(f.properties?.area ?? Infinity) < Number(best.properties?.area ?? Infinity) ? f : best), polys[0]);
        }
        if (!chosen) return;
        select(String(chosen.properties?.id));
        openPopup(e.lngLat, chosen.properties ?? {});
      });
      for (const layer of ["points", "shp-fill", "shp-line", "clusters"]) {
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }
    } else {
      (map.getSource(SRC_PTS) as GeoJSONSource).setData(points);
      (map.getSource(SRC_SHP) as GeoJSONSource).setData(shapes);
    }

    // Fit ONCE per mount (when data first arrives) — never on later feature-set
    // identity changes (legend toggles, re-selects), which used to yank the
    // camera back out to the full extent.
    if (autoFit && bounds && !fittedRef.current) {
      fittedRef.current = true;
      const b = bounds as maplibregl.LngLatBounds;
      const single = b.getNorthEast().distanceTo(b.getSouthWest()) < 1;
      if (single) map.easeTo({ center: b.getCenter(), zoom: 12 });
      else map.fitBounds(b, { padding: 48, maxZoom: 14, duration: 400 });
    }

    const el = containerRef.current;
    if (el) {
      el.dataset.mapReady = "true";
      el.dataset.featureCount = String(featRef.current.length);
    }
  };

  // Mount the map once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!hasWebGL()) {
      setWebglFailed(true);
      el.dataset.mapFallback = "true";
      return;
    }
    let map: MLMap;
    try {
      map = new maplibregl.Map({
        container: el,
        style: current.style as string | StyleSpecification,
        center: [-105.27, 40.02],
        zoom: 8,
        attributionControl: { compact: true },
      });
    } catch {
      setWebglFailed(true);
      if (el) el.dataset.mapFallback = "true";
      return;
    }
    mapRef.current = map;
    if (showControls) {
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
      map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false }, trackUserLocation: false }), "top-right");
    }

    let painted = false;
    const onStyle = () => {
      if (!map.isStyleLoaded()) return;
      try {
        paint(map, current.hasGlyphs);
        painted = true;
        if (editable) {
          if (!drawRef.current) {
            drawRef.current = new DrawController(map, (g) => {
              setDrawMode("none");
              geomChangeRef.current?.(g);
            });
          } else {
            drawRef.current.refresh();
          }
        }
      } catch {
        if (containerRef.current) containerRef.current.dataset.mapFallback = "true";
      }
    };
    map.on("load", onStyle);
    map.on("styledata", onStyle);

    // If the hosted style fails to load, fall back to blank so data still shows.
    const fallback = () => {
      if (painted || current.id === "blank") return;
      map.setStyle(BLANK_STYLE);
      setCurrent(BASEMAPS.find((b) => b.id === "blank")!);
    };
    map.on("error", (e) => {
      // Style/tile fetch errors surface here; only fall back before first paint.
      if (!painted && e?.error) fallback();
    });
    const styleTimer = setTimeout(() => { if (!painted) fallback(); }, 6000);
    // Last resort: if nothing has painted (e.g. an async WebGL-context failure
    // the constructor didn't throw for), mark the container degraded so the UI —
    // and any test — can proceed. The list beside the map still works.
    const hardTimer = setTimeout(() => { if (!painted && containerRef.current) containerRef.current.dataset.mapFallback = "true"; }, 9000);

    // e2e hook: lets tests project lng/lat → pixels to click real features.
    (el as HTMLDivElement & { __map?: MLMap }).__map = map;

    return () => {
      clearTimeout(styleTimer);
      clearTimeout(hardTimer);
      popupRef.current?.remove();
      popupRef.current = null;
      drawRef.current?.destroy();
      drawRef.current = null;
      delete (el as HTMLDivElement & { __map?: MLMap }).__map;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch basemap on demand.
  useEffect(() => {
    const map = mapRef.current;
    const next = resolveBasemap(basemap);
    if (!map || next.id === current.id) return;
    setCurrent(next);
    map.setStyle(next.style as string | StyleSpecification);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  // Re-paint when the feature set changes.
  useEffect(() => {
    const map = mapRef.current;
    if (map && map.isStyleLoaded()) paint(map, current.hasGlyphs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features]);

  // Highlight the selected feature (ring for points, bold outline for shapes).
  // Deliberately NO camera movement here: selection — from a map click or a
  // list hover/click — must never zoom or pan the map out from under the user.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    if (map.getLayer("points-selected")) map.setFilter("points-selected", ["==", ["get", "id"], selectedId]);
    if (map.getLayer("shp-selected")) map.setFilter("shp-selected", ["==", ["get", "id"], selectedId]);
  }, [selectedId]);

  const switchBasemap = (id: string) => {
    const map = mapRef.current;
    const next = resolveBasemap(id);
    if (!map) return;
    setCurrent(next);
    map.setStyle(next.style as string | StyleSpecification);
  };

  const kindsPresent = [...new Set(features.map((f) => f.kind))];

  if (webglFailed) {
    return (
      <div data-testid={testId} data-map-fallback="true" style={{ height, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(128,128,128,0.3)", borderRadius: 12, background: "rgba(128,128,128,0.05)", textAlign: "center", padding: 24 }}>
        <div style={{ opacity: 0.7 }}>Map needs WebGL, which isn't available here. The list below still works.</div>
      </div>
    );
  }

  const startDraw = (kind: DrawKind) => {
    const d = drawRef.current;
    if (!d) return;
    const existing = value as { type?: string } | null | undefined;
    // Re-drawing the same geometry type seeds the existing vertices so you edit
    // rather than start from scratch; a different type starts fresh.
    if (existing && existing.type === kind) d.loadForEdit(existing as never);
    else d.setMode(kind);
    setDrawMode(kind);
  };
  const btn = (active: boolean): React.CSSProperties => ({ padding: "5px 9px", borderRadius: 7, border: "1px solid rgba(0,0,0,0.15)", background: active ? "#f59e0b" : "rgba(255,255,255,0.92)", color: active ? "#fff" : "#222", cursor: "pointer", font: "12px system-ui", fontWeight: 600 });

  return (
    <div style={{ position: "relative", height }}>
      <div ref={containerRef} data-testid={testId} style={{ height: "100%", minHeight: 280, borderRadius: 12, overflow: "hidden", border: "1px solid rgba(128,128,128,0.3)" }} />

      {editable && !webglFailed && (
        <div style={{ position: "absolute", top: 10, left: 10, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }} data-testid="map-draw-toolbar">
          <div style={{ display: "flex", gap: 5, background: "rgba(255,255,255,0.85)", backdropFilter: "blur(6px)", padding: 5, borderRadius: 9 }}>
            <button style={btn(drawMode === "Point")} onClick={() => startDraw("Point")} title="Draw a point">● Point</button>
            <button style={btn(drawMode === "LineString")} onClick={() => startDraw("LineString")} title="Draw a line">╱ Line</button>
            <button style={btn(drawMode === "Polygon")} onClick={() => startDraw("Polygon")} title="Draw a polygon">⬠ Polygon</button>
            {drawMode !== "none" && drawMode !== "Point" && (
              <button style={btn(false)} onClick={() => drawRef.current?.finish()} title="Finish (or double-click)">✓ Finish</button>
            )}
            <button style={btn(false)} onClick={() => { drawRef.current?.clear(); setDrawMode("none"); }} title="Clear geometry">✕ Clear</button>
          </div>
          {drawMode !== "none" && drawMode !== "Point" && (
            <span style={{ fontSize: 11, color: "#222", background: "rgba(255,255,255,0.85)", padding: "3px 8px", borderRadius: 7 }}>
              Click to add points · double-click or Finish to close
            </span>
          )}
        </div>
      )}
      {showControls && (
        <>
          <div style={{ position: "absolute", top: 10, left: 10, display: "flex", gap: 6, flexWrap: "wrap", background: "rgba(255,255,255,0.82)", backdropFilter: "blur(6px)", padding: "6px 8px", borderRadius: 10, maxWidth: "70%", fontFamily: "system-ui, sans-serif" }} data-testid="map-legend">
            {kindsPresent.map((k) => (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#222" }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: kindColor(k) }} />
                {k}
              </span>
            ))}
          </div>
          <select
            aria-label="Basemap"
            data-testid="basemap-switcher"
            value={current.id}
            onChange={(e) => switchBasemap(e.target.value)}
            style={{ position: "absolute", bottom: 10, right: 10, padding: "5px 8px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.15)", background: "rgba(255,255,255,0.9)", font: "12px system-ui", color: "#222" }}
          >
            {BASEMAPS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
