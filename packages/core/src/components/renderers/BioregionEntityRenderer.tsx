/**
 * Bioregional entity renderer — a geo-aware view for the commons's mapped types
 * (ecological-entity, species, watershed, place, signal). Renders the note's
 * GeoJSON on the shared MapLibre CommonsMap (OpenFreeMap basemap, blank
 * fallback), the sensing/responding cleavage, the key identifier/standard
 * fields, and — for signals — the affects/response links that close the
 * sense→respond loop.
 */
import type { RendererProps } from "./RendererProps";
import { CommonsMap, type MapFeature } from "../map/CommonsMap";

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

      {(geometry?.coordinates !== undefined || Boolean(m?.geo)) && (
        <div style={{ margin: "12px 0" }}>
          <CommonsMap
            features={[{ id: note.id, kind: tag, name: (m?.name as string) ?? note.id, sensing, geometry: geometry ?? null, geo: (m?.geo as { lat: number; lon: number } | undefined) ?? null } as MapFeature]}
            height={340}
            showControls={false}
            testId="entity-map"
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

      {note.content && (
        <pre style={{ marginTop: 12, whiteSpace: "pre-wrap", fontFamily: "inherit", opacity: 0.9, borderTop: "1px solid rgba(128,128,128,0.2)", paddingTop: 12 }}>
          {note.content.replace(/<[^>]+>/g, "")}
        </pre>
      )}
    </div>
  );
}
