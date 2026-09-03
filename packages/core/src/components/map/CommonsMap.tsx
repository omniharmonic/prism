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
  onPick?: (id: string) => void;
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

function toPoint(f: MapFeature): GeoJSON.Feature | null {
  const g = f.geometry as GeoJSON.Geometry | undefined;
  if (g && (g.type === "Point" || g.type === "MultiPoint")) return { type: "Feature", geometry: g, properties: props(f) };
  if (!g && f.geo) return { type: "Feature", geometry: { type: "Point", coordinates: [f.geo.lon, f.geo.lat] }, properties: props(f) };
  return null;
}
function toShape(f: MapFeature): GeoJSON.Feature | null {
  const g = f.geometry as GeoJSON.Geometry | undefined;
  if (g && ["LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(g.type)) return { type: "Feature", geometry: g, properties: props(f) };
  return null;
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

export function CommonsMap({ features, basemap, height = 460, onPick, selectedId, showControls = true, autoFit = true, testId = "commons-map", editable = false, value, onGeometryChange }: CommonsMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const drawRef = useRef<DrawController | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>("none");
  const [current, setCurrent] = useState<Basemap>(() => resolveBasemap(basemap));
  const [webglFailed, setWebglFailed] = useState(false);
  const featRef = useRef(features);
  featRef.current = features;
  const geomChangeRef = useRef(onGeometryChange);
  geomChangeRef.current = onGeometryChange;

  // (Re)build sources + layers on the active style; idempotent.
  const paint = (map: MLMap, hasGlyphs: boolean) => {
    const { points, shapes, bounds } = collect(featRef.current);
    if (!map.getSource(SRC_PTS)) {
      map.addSource(SRC_PTS, { type: "geojson", data: points, cluster: true, clusterRadius: 46, clusterMaxZoom: 12 });
      map.addSource(SRC_SHP, { type: "geojson", data: shapes });

      // watershed / polygon fills + outlines
      map.addLayer({ id: "shp-fill", type: "fill", source: SRC_SHP, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": kindColorExpression() as never, "fill-opacity": 0.16 } });
      map.addLayer({ id: "shp-outline", type: "line", source: SRC_SHP, filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": kindColorExpression() as never, "line-width": 1.5 } });
      // rivers / lines
      map.addLayer({ id: "shp-line", type: "line", source: SRC_SHP, filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": kindColorExpression() as never, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.5, 14, 4] as never } });
      // clusters
      map.addLayer({ id: "clusters", type: "circle", source: SRC_PTS, filter: ["has", "point_count"], paint: { "circle-color": "#0ea5e9", "circle-opacity": 0.85, "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 30] as never, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      // unclustered points
      map.addLayer({ id: "points", type: "circle", source: SRC_PTS, filter: ["!", ["has", "point_count"]], paint: { "circle-color": kindColorExpression() as never, "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 5, 14, 8] as never, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      // selection ring
      map.addLayer({ id: "points-selected", type: "circle", source: SRC_PTS, filter: ["==", ["get", "id"], "__none__"], paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": 13, "circle-stroke-color": "#111", "circle-stroke-width": 3 } });

      if (hasGlyphs) {
        map.addLayer({ id: "cluster-count", type: "symbol", source: SRC_PTS, filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12 }, paint: { "text-color": "#fff" } });
        map.addLayer({ id: "labels", type: "symbol", source: SRC_PTS, filter: ["!", ["has", "point_count"]], layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-optional": true }, paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
      }

      // interactions (registered once; layers persist across setData)
      const pick = (id: string) => {
        map.setFilter("points-selected", ["==", ["get", "id"], id]);
        onPick?.(id);
      };
      for (const layer of ["points", "shp-fill", "shp-line"]) {
        map.on("click", layer, (e) => {
          const feat = e.features?.[0];
          if (!feat) return;
          pick(String(feat.properties?.id));
          new maplibregl.Popup({ closeButton: true, offset: 10 })
            .setLngLat(e.lngLat)
            .setHTML(`<div style="font:13px system-ui"><b>${escapeHtml(String(feat.properties?.name ?? ""))}</b><br><span style="opacity:.7">${escapeHtml(String(feat.properties?.kind ?? ""))}${feat.properties?.sensing ? " · " + escapeHtml(String(feat.properties.sensing)) : ""}</span></div>`)
            .addTo(map);
        });
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }
      map.on("click", "clusters", (e) => {
        const f = e.features?.[0];
        const cid = f?.properties?.cluster_id;
        if (cid == null) return;
        (map.getSource(SRC_PTS) as GeoJSONSource).getClusterExpansionZoom(cid as number).then((zoom) => {
          map.easeTo({ center: (f!.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
        });
      });
      map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));
    } else {
      (map.getSource(SRC_PTS) as GeoJSONSource).setData(points);
      (map.getSource(SRC_SHP) as GeoJSONSource).setData(shapes);
    }

    if (autoFit && bounds) {
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

    return () => {
      clearTimeout(styleTimer);
      clearTimeout(hardTimer);
      drawRef.current?.destroy();
      drawRef.current = null;
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

  // Fly to / ring the selected feature.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    if (map.getLayer("points-selected")) map.setFilter("points-selected", ["==", ["get", "id"], selectedId]);
    const f = featRef.current.find((x) => x.id === selectedId);
    const g = f?.geometry as GeoJSON.Geometry | undefined;
    const c = g?.type === "Point" ? (g.coordinates as [number, number]) : f?.geo ? [f.geo.lon, f.geo.lat] : null;
    if (c) map.flyTo({ center: c as [number, number], zoom: Math.max(map.getZoom(), 11), duration: 500 });
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
    <div style={{ position: "relative" }}>
      <div ref={containerRef} data-testid={testId} style={{ height, borderRadius: 12, overflow: "hidden", border: "1px solid rgba(128,128,128,0.3)" }} />

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
