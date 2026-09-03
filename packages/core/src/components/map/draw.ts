/**
 * A small, dependency-free geometry draw controller for MapLibre — the heart of
 * the "draw a polygon → attach GeoJSON to the note" UX. Click to place vertices
 * with a live preview; double-click (or Finish) closes; the built geometry is
 * emitted via `onChange`. The pure geometry construction lives in
 * lib/geo/geojson (`buildGeometry`, tested); this file is only the map glue.
 */
import maplibregl, { type Map as MLMap, type MapMouseEvent } from "maplibre-gl";
import { buildGeometry, type Geometry, type Position } from "../../lib/geo/geojson";

export type DrawKind = "Point" | "LineString" | "Polygon";
export type DrawMode = "none" | DrawKind;

const SRC = "commons-draw";
const ACCENT = "#f59e0b";

type FC = GeoJSON.FeatureCollection;

export class DrawController {
  private map: MLMap;
  private mode: DrawMode = "none";
  private vertices: Position[] = [];
  private readonly onChange: (g: Geometry | null) => void;

  constructor(map: MLMap, onChange: (g: Geometry | null) => void) {
    this.map = map;
    this.onChange = onChange;
    this.ensureLayers();
    map.on("click", this.onClick);
    map.on("dblclick", this.onDblClick);
  }

  private ensureLayers() {
    const map = this.map;
    if (map.getSource(SRC)) return;
    map.addSource(SRC, { type: "geojson", data: empty() });
    map.addLayer({ id: "draw-fill", type: "fill", source: SRC, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": ACCENT, "fill-opacity": 0.15 } });
    map.addLayer({ id: "draw-line", type: "line", source: SRC, filter: ["in", ["geometry-type"], ["literal", ["LineString", "Polygon"]]], paint: { "line-color": ACCENT, "line-width": 2, "line-dasharray": [2, 1] } });
    map.addLayer({ id: "draw-vertex", type: "circle", source: SRC, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": ACCENT, "circle-stroke-width": 2.5 } });
  }

  /** Start (or restart) a drawing mode. Re-adds layers if the style reloaded. */
  setMode(mode: DrawMode) {
    this.ensureLayers();
    this.mode = mode;
    this.vertices = [];
    this.map.getCanvas().style.cursor = mode === "none" ? "" : "crosshair";
    this.render();
  }

  getMode(): DrawMode {
    return this.mode;
  }

  /** Re-add the draw layers after a style reload (basemap switch), keep vertices. */
  refresh() {
    this.ensureLayers();
    this.render();
  }

  /** Seed vertices from an existing geometry so the user can extend/redraw it. */
  loadForEdit(geometry: Geometry | null | undefined) {
    if (!geometry) return;
    if (geometry.type === "Point") this.startWith("Point", [geometry.coordinates as Position]);
    else if (geometry.type === "LineString") this.startWith("LineString", geometry.coordinates as Position[]);
    else if (geometry.type === "Polygon") {
      const ring = ((geometry.coordinates as Position[][])[0] ?? []).slice(0, -1); // drop closing point
      this.startWith("Polygon", ring);
    }
  }
  private startWith(mode: DrawKind, verts: Position[]) {
    this.ensureLayers();
    this.mode = mode;
    this.vertices = [...verts];
    this.map.getCanvas().style.cursor = "crosshair";
    this.render();
  }

  private onClick = (e: MapMouseEvent) => {
    if (this.mode === "none") return;
    const v: Position = [round(e.lngLat.lng), round(e.lngLat.lat)];
    this.vertices.push(v);
    if (this.mode === "Point") {
      this.finish();
      return;
    }
    this.render();
  };

  private onDblClick = (e: MapMouseEvent) => {
    if (this.mode === "none" || this.mode === "Point") return;
    e.preventDefault(); // suppress the default zoom
    // the dblclick also fired a single click first; drop the duplicate last vertex
    if (this.vertices.length > 1) this.vertices.pop();
    this.finish();
  };

  /** Commit the current vertices to a geometry and emit it. */
  finish() {
    if (this.mode === "none") return;
    const g = buildGeometry(this.mode, this.vertices);
    this.mode = "none";
    this.vertices = [];
    this.map.getCanvas().style.cursor = "";
    this.render();
    this.onChange(g);
  }

  /** Discard drawing and clear the geometry. */
  clear() {
    this.mode = "none";
    this.vertices = [];
    this.map.getCanvas().style.cursor = "";
    this.render();
    this.onChange(null);
  }

  cancel() {
    this.mode = "none";
    this.vertices = [];
    this.map.getCanvas().style.cursor = "";
    this.render();
  }

  private render() {
    const src = this.map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(this.preview());
  }

  private preview(): FC {
    const feats: GeoJSON.Feature[] = this.vertices.map((v) => ({ type: "Feature", geometry: { type: "Point", coordinates: v }, properties: {} }));
    if (this.mode === "LineString" && this.vertices.length >= 2) {
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: this.vertices }, properties: {} });
    }
    if (this.mode === "Polygon" && this.vertices.length >= 2) {
      feats.push(
        this.vertices.length >= 3
          ? { type: "Feature", geometry: { type: "Polygon", coordinates: [[...this.vertices, this.vertices[0]!]] }, properties: {} }
          : { type: "Feature", geometry: { type: "LineString", coordinates: this.vertices }, properties: {} },
      );
    }
    return { type: "FeatureCollection", features: feats };
  }

  destroy() {
    this.map.off("click", this.onClick);
    this.map.off("dblclick", this.onDblClick);
    for (const id of ["draw-fill", "draw-line", "draw-vertex"]) if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(SRC)) this.map.removeSource(SRC);
  }
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const empty = (): FC => ({ type: "FeatureCollection", features: [] });
