/**
 * MapRenderer — the vault's geospatial surface. A top-level virtual tab (like
 * Network), NOT a per-note dialog: it is "the map view of the vault" the user
 * asked for. Every note that carries geometry (a drawn Point/Line/Polygon in
 * `metadata.geometry`, or a `metadata.geo` centroid) shows up here on one shared
 * MapLibre map; clicking a feature (or its list row) opens that note as a tab,
 * where the per-note renderer's draw tools let you edit its geometry.
 *
 * This is the integration the standalone `/bioregion` route got wrong: geospatial
 * is a *lens over the vault*, reachable from the sidebar, sharing the same tabs,
 * search, and renderers as everything else — not a separate app at a URL.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Layers } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useUIStore } from "../../app/stores/ui";
import { CommonsMap, type MapFeature } from "../map/CommonsMap";
import { kindColor } from "../map/basemaps";
import type { Note, ContentType } from "../../lib/types";
import type { RendererProps } from "./RendererProps";

/** The tags whose notes are geospatially meaningful (Plan 2 §2). A note need not
 *  carry one of these to appear — geometry is what qualifies it — but querying
 *  these keeps the fetch bounded instead of scanning the whole vault. */
const GEO_TAGS = ["ecological-entity", "species", "watershed", "place", "signal", "resource", "event"] as const;

const str = (m: Record<string, unknown> | null | undefined, k: string): string => {
  const v = m?.[k];
  return typeof v === "string" ? v : "";
};

function geometryOf(m: Record<string, unknown> | null | undefined): unknown | null {
  return (m?.geometry ?? m?.boundaryGeometry ?? m?.rangeGeometry) ?? null;
}
function geoOf(m: Record<string, unknown> | null | undefined): { lat: number; lon: number } | null {
  const g = m?.geo;
  if (g && typeof g === "object") {
    const o = g as { lat?: number; lon?: number };
    if (typeof o.lat === "number" && typeof o.lon === "number") return { lat: o.lat, lon: o.lon };
  }
  return null;
}
function hasLocation(n: Note): boolean {
  return geometryOf(n.metadata) != null || geoOf(n.metadata) != null;
}

/** The most specific geo tag on the note drives its color/legend bucket. */
function kindOf(n: Note): string {
  const tags = n.tags ?? [];
  for (const t of GEO_TAGS) if (tags.includes(t)) return t;
  return "place";
}
function nameOf(n: Note): string {
  const m = n.metadata;
  return (
    str(m, "name") ||
    str(m, "title") ||
    str(m, "scientificName") ||
    str(m, "hucName") ||
    n.content?.split("\n")[0]?.replace(/^#\s*/, "").slice(0, 80) ||
    n.path?.split("/").pop() ||
    n.id
  );
}

function toFeature(n: Note): MapFeature {
  const m = n.metadata as Record<string, unknown> | null;
  return {
    id: n.id,
    kind: kindOf(n),
    name: nameOf(n),
    sensing: str(m, "sensing_or_responding"),
    status: str(m, "status") || str(m, "severity"),
    geometry: geometryOf(m),
    geo: geoOf(m),
  };
}

export default function MapRenderer(_props: RendererProps) {
  const client = useVaultClient();
  const openTab = useUIStore((s) => s.openTab);
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Load geo-bearing notes across the mapped tags (deduped — a note can carry
  // several). Handled through the VaultClient seam, so it works on desktop
  // (Tauri) and web (gateway) alike.
  const { data: features = [], isLoading } = useQuery({
    queryKey: ["vault", "geo-features"] as const,
    queryFn: async () => {
      const lists = await Promise.all(
        GEO_TAGS.map((t) => client.listNotes({ tag: t }).catch(() => [] as Note[])),
      );
      const seen = new Set<string>();
      const out: MapFeature[] = [];
      for (const n of lists.flat()) {
        if (seen.has(n.id) || !hasLocation(n)) continue;
        seen.add(n.id);
        out.push(toFeature(n));
      }
      return out;
    },
  });

  const kinds = useMemo(() => [...new Set(features.map((f) => f.kind))].sort(), [features]);
  const shown = useMemo(() => features.filter((f) => !hidden.has(f.kind)), [features, hidden]);

  const toggleKind = (k: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const open = (id: string) => {
    const f = features.find((x) => x.id === id);
    openTab(id, f?.name ?? id, "bioregion-entity" as ContentType);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <header style={{ padding: "20px 28px 12px", borderBottom: "1px solid var(--glass-border)", flexShrink: 0 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 8 }}>
          <MapPin size={20} /> Map
        </h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "4px 0 0" }}>
          Every note with a location, on one map. Click a feature to open it — draw or edit its geometry from there.
        </p>
        {kinds.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Layers size={13} style={{ opacity: 0.6 }} />
            {kinds.map((k) => {
              const off = hidden.has(k);
              return (
                <button
                  key={k}
                  onClick={() => toggleKind(k)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999,
                    border: "1px solid var(--glass-border)", cursor: "pointer", fontSize: 12,
                    background: off ? "transparent" : "var(--surface-hover)",
                    color: off ? "var(--text-muted)" : "var(--text-primary)", opacity: off ? 0.55 : 1,
                  }}
                  title={off ? `Show ${k}` : `Hide ${k}`}
                >
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: kindColor(k) }} />
                  {k}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* The map */}
        <div style={{ flex: 1, minWidth: 0, padding: 16 }}>
          {isLoading ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
              Loading locations…
            </div>
          ) : features.length === 0 ? (
            <EmptyState />
          ) : (
            <CommonsMap
              features={shown}
              height="100%"
              onPick={setSelected}
              selectedId={selected}
              testId="vault-map"
            />
          )}
        </div>

        {/* The list — a linked index of what's on the map */}
        {features.length > 0 && (
          <aside style={{ width: 280, flexShrink: 0, borderLeft: "1px solid var(--glass-border)", overflow: "auto", padding: "12px 0" }} data-testid="map-list">
            <div style={{ padding: "0 16px 8px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-muted)" }}>
              {shown.length} located {shown.length === 1 ? "note" : "notes"}
            </div>
            {shown.map((f) => (
              <button
                key={f.id}
                onClick={() => { setSelected(f.id); open(f.id); }}
                onMouseEnter={() => setSelected(f.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left",
                  padding: "8px 16px", border: "none", cursor: "pointer", fontSize: 13,
                  background: selected === f.id ? "var(--surface-hover)" : "transparent", color: "var(--text-primary)",
                }}
              >
                <span style={{ width: 9, height: 9, borderRadius: 3, background: kindColor(f.kind), flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              </button>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
      <MapPin size={30} strokeWidth={1.5} />
      <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Nothing on the map yet</p>
      <p style={{ fontSize: 13, margin: 0, maxWidth: 380 }}>
        Open any note (a place, watershed, species, signal…) and use its draw tools to add a
        point, line, or polygon. It saves as GeoJSON and appears here.
      </p>
    </div>
  );
}
