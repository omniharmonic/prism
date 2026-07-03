/**
 * A dependency-free, CSP-safe map: it projects GeoJSON (WGS84, [lon,lat]) to an
 * inline SVG viewport — no external tiles, no map library, nothing to load over
 * the network (a published commons blocks external hosts anyway). Deterministic,
 * so it e2e-tests cleanly. Points → dots, LineStrings → polylines, Polygons →
 * filled paths; a simple centroid `geo` renders as a dot too.
 */
import { useMemo } from "react";
import type { BioEntity, BioTag } from "./api";

const W = 820;
const H = 460;
const PAD = 28;

const TAG_COLOR: Record<BioTag, string> = {
  "ecological-entity": "#2e7d32",
  species: "#00897b",
  watershed: "#1565c0",
  place: "#6a1b9a",
  signal: "#c62828",
  resource: "#ef6c00",
  event: "#455a64",
};

type Pt = [number, number]; // [lon, lat]

function eachPos(coords: unknown, cb: (p: Pt) => void): void {
  if (Array.isArray(coords) && typeof coords[0] === "number" && typeof coords[1] === "number") {
    cb([coords[0], coords[1]]);
    return;
  }
  if (Array.isArray(coords)) for (const c of coords) eachPos(c, cb);
}

interface Feature {
  entity: BioEntity;
  geometry: { type?: string; coordinates?: unknown } | null;
  point: Pt | null;
}

export function BioregionMap({ entities, onPick }: { entities: BioEntity[]; onPick?: (id: string) => void }) {
  const features: Feature[] = useMemo(
    () =>
      entities.map((e) => ({
        entity: e,
        geometry: (e.geometry ?? null) as Feature["geometry"],
        point: e.geo ? [e.geo.lon, e.geo.lat] : null,
      })),
    [entities],
  );

  // Combined bbox over every position we intend to draw.
  const bbox = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let seen = 0;
    const visit = (p: Pt) => {
      seen++;
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    };
    for (const f of features) {
      if (f.geometry?.coordinates !== undefined) eachPos(f.geometry.coordinates, visit);
      if (f.point) visit(f.point);
    }
    return seen > 0 ? { minX, minY, maxX, maxY } : null;
  }, [features]);

  const project = useMemo(() => {
    if (!bbox) return (p: Pt): Pt => p;
    const spanX = bbox.maxX - bbox.minX || 1e-6;
    const spanY = bbox.maxY - bbox.minY || 1e-6;
    const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
    const offX = (W - scale * spanX) / 2;
    const offY = (H - scale * spanY) / 2;
    return (p: Pt): Pt => [
      offX + (p[0] - bbox.minX) * scale,
      // flip Y so north is up
      H - (offY + (p[1] - bbox.minY) * scale),
    ];
  }, [bbox]);

  if (!bbox) {
    return (
      <div data-testid="bioregion-map-empty" style={{ padding: 40, textAlign: "center", opacity: 0.6, border: "1px dashed rgba(128,128,128,0.4)", borderRadius: 12 }}>
        No geometry to map yet. Ecological entities, watersheds, and species with GeoJSON appear here.
      </div>
    );
  }

  const drawGeom = (f: Feature) => {
    const g = f.geometry;
    const color = TAG_COLOR[f.entity.tag] ?? "#607d8b";
    if (!g?.type || g.coordinates === undefined) return null;
    const key = f.entity.id;

    if (g.type === "LineString" || g.type === "MultiLineString") {
      const lines = g.type === "LineString" ? [g.coordinates as Pt[]] : (g.coordinates as Pt[][]);
      return lines.map((line, i) => (
        <polyline
          key={`${key}-l${i}`}
          points={line.map((p) => project(p as Pt).join(",")).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth={2}
          data-entity={key}
        />
      ));
    }
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
      const polys = g.type === "Polygon" ? [g.coordinates as Pt[][]] : (g.coordinates as Pt[][][]);
      return polys.map((rings, i) => {
        const outer = (rings[0] ?? []) as Pt[];
        return (
          <path
            key={`${key}-p${i}`}
            d={outer.map((p, j) => `${j === 0 ? "M" : "L"}${project(p as Pt).join(" ")}`).join(" ") + " Z"}
            fill={color}
            fillOpacity={0.18}
            stroke={color}
            strokeWidth={1.5}
            data-entity={key}
            style={{ cursor: onPick ? "pointer" : "default" }}
            onClick={() => onPick?.(key)}
          />
        );
      });
    }
    // Point / MultiPoint
    const pts: Pt[] = [];
    eachPos(g.coordinates, (p) => pts.push(p));
    return pts.map((p, i) => {
      const [x, y] = project(p);
      return <circle key={`${key}-pt${i}`} cx={x} cy={y} r={5} fill={color} data-entity={key} style={{ cursor: onPick ? "pointer" : "default" }} onClick={() => onPick?.(key)} />;
    });
  };

  return (
    <svg
      data-testid="bioregion-map"
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", border: "1px solid rgba(128,128,128,0.3)", borderRadius: 12, background: "rgba(128,128,128,0.04)" }}
      role="img"
      aria-label="Bioregion map"
    >
      {features.map((f) => (
        <g key={f.entity.id}>{drawGeom(f)}</g>
      ))}
      {/* centroid dots for entities that only have a geo point (no full geometry) */}
      {features
        .filter((f) => f.point && (!f.geometry || f.geometry.coordinates === undefined))
        .map((f) => {
          const [x, y] = project(f.point as Pt);
          return (
            <circle
              key={`${f.entity.id}-c`}
              cx={x}
              cy={y}
              r={5}
              fill={TAG_COLOR[f.entity.tag] ?? "#607d8b"}
              data-entity={f.entity.id}
              style={{ cursor: onPick ? "pointer" : "default" }}
              onClick={() => onPick?.(f.entity.id)}
            />
          );
        })}
    </svg>
  );
}
