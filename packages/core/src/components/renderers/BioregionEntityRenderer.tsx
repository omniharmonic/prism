/**
 * Bioregional entity renderer — a geo-aware view for the commons's mapped types
 * (ecological-entity, species, watershed, place, signal). Shows the note's
 * GeoJSON geometry on a dependency-free inline-SVG map (WGS84, [lon,lat] — no
 * external tiles, CSP-safe), the sensing/responding cleavage, the key
 * identifier/standard fields, and — for signals — the affects/response links
 * that close the sense→respond loop. Falls back to the document body below.
 */
import { useMemo } from "react";
import type { RendererProps } from "./RendererProps";

type Pt = [number, number];

function eachPos(coords: unknown, cb: (p: Pt) => void): void {
  if (Array.isArray(coords) && typeof coords[0] === "number" && typeof coords[1] === "number") {
    cb([coords[0], coords[1]]);
    return;
  }
  if (Array.isArray(coords)) for (const c of coords) eachPos(c, cb);
}

const W = 640;
const H = 360;
const PAD = 22;

function MiniMap({ geometry, color }: { geometry: { type?: string; coordinates?: unknown }; color: string }) {
  const bbox = useMemo(() => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, n = 0;
    eachPos(geometry.coordinates, ([lon, lat]) => {
      n++;
      a = Math.min(a, lon); b = Math.min(b, lat); c = Math.max(c, lon); d = Math.max(d, lat);
    });
    return n > 0 ? { minX: a, minY: b, maxX: c, maxY: d } : null;
  }, [geometry]);

  if (!bbox) return null;
  const spanX = bbox.maxX - bbox.minX || 1e-6;
  const spanY = bbox.maxY - bbox.minY || 1e-6;
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const offX = (W - scale * spanX) / 2;
  const offY = (H - scale * spanY) / 2;
  const proj = ([lon, lat]: Pt): Pt => [offX + (lon - bbox.minX) * scale, H - (offY + (lat - bbox.minY) * scale)];

  const g = geometry;
  let shapes: React.ReactNode = null;
  if (g.type === "LineString" || g.type === "MultiLineString") {
    const lines = g.type === "LineString" ? [g.coordinates as Pt[]] : (g.coordinates as Pt[][]);
    shapes = lines.map((line, i) => <polyline key={i} points={line.map((p) => proj(p as Pt).join(",")).join(" ")} fill="none" stroke={color} strokeWidth={2} />);
  } else if (g.type === "Polygon" || g.type === "MultiPolygon") {
    const polys = g.type === "Polygon" ? [g.coordinates as Pt[][]] : (g.coordinates as Pt[][][]);
    shapes = polys.map((rings, i) => {
      const outer = (rings[0] ?? []) as Pt[];
      return <path key={i} d={outer.map((p, j) => `${j === 0 ? "M" : "L"}${proj(p as Pt).join(" ")}`).join(" ") + " Z"} fill={color} fillOpacity={0.18} stroke={color} strokeWidth={1.5} />;
    });
  } else {
    const pts: Pt[] = [];
    eachPos(g.coordinates, (p) => pts.push(p));
    shapes = pts.map((p, i) => {
      const [x, y] = proj(p);
      return <circle key={i} cx={x} cy={y} r={5} fill={color} />;
    });
  }
  return (
    <svg data-testid="entity-map" viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 640, height: "auto", border: "1px solid rgba(128,128,128,0.3)", borderRadius: 10, background: "rgba(128,128,128,0.04)" }}>
      {shapes}
    </svg>
  );
}

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

export default function BioregionEntityRenderer({ note }: RendererProps) {
  const m = (note.metadata ?? null) as Record<string, unknown> | null;
  const geometry = (m?.geometry ?? m?.boundaryGeometry ?? m?.rangeGeometry) as { type?: string; coordinates?: unknown } | undefined;
  const sensing = str(m, "sensing_or_responding");
  const tag = (note.tags ?? []).find((t) => ["ecological-entity", "species", "watershed", "place", "signal"].includes(t)) ?? "entity";
  const color = tag === "signal" ? "#c62828" : tag === "watershed" ? "#1565c0" : tag === "species" ? "#00897b" : "#2e7d32";
  const affects = arr(m, "affects");
  const response = arr(m, "response");

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: 20, fontFamily: "system-ui, sans-serif" }} data-testid="bioregion-entity">
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.4 }}>{tag}</span>
        {sensing && <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, opacity: 0.7 }}>{sensing}</span>}
      </div>

      {geometry?.coordinates !== undefined && <div style={{ margin: "12px 0" }}><MiniMap geometry={geometry} color={color} /></div>}

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

      {note.content && (
        <pre style={{ marginTop: 12, whiteSpace: "pre-wrap", fontFamily: "inherit", opacity: 0.9, borderTop: "1px solid rgba(128,128,128,0.2)", paddingTop: 12 }}>
          {note.content.replace(/<[^>]+>/g, "")}
        </pre>
      )}
    </div>
  );
}
