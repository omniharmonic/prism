// WikiMap — the published wiki's geospatial view.
//
// Uses the SAME MapLibre surface (`CommonsMap` from @prism/core) as the in-app
// bioregion map, so the public site's map looks and behaves like the owner's.
// It renders ONLY the features from the publication-scoped, leak-proof
// `/api/p/:slug/map` endpoint (passed in as `features`) — never the owner's
// full vault — so it can never surface an out-of-set note's geometry. The
// CommonsMap module (and the maplibre-gl bundle it pulls in) is lazy-loaded so
// it costs nothing until the reader opens the map view. Clicking a feature
// navigates to that note's wiki page (same routing as the nav tree).
import { Suspense, lazy, useMemo, useState } from "react";
import type { MapFeature } from "@prism/core";
import type { PubMapFeature } from "./types";

const CommonsMap = lazy(() => import("@prism/core").then((m) => ({ default: m.CommonsMap })));

export function WikiMap({
  features,
  activeId,
  onNavigate,
}: {
  /** null = still loading from /api/p/:slug/map. */
  features: PubMapFeature[] | null;
  activeId: string | null;
  onNavigate: (id: string) => void;
}) {
  const [kindsHidden, setKindsHidden] = useState<Set<string>>(new Set());

  const mapFeatures = useMemo<MapFeature[]>(
    () =>
      (features ?? []).map((f) => ({
        id: f.id,
        kind: f.kind,
        name: f.name,
        sensing: f.sensing,
        status: f.status,
        geometry: f.geometry ?? null,
        geo: f.geo ?? null,
      })),
    [features],
  );

  const kinds = useMemo(() => [...new Set(mapFeatures.map((f) => f.kind))].sort(), [mapFeatures]);
  const shown = useMemo(
    () => mapFeatures.filter((f) => !kindsHidden.has(f.kind)),
    [mapFeatures, kindsHidden],
  );

  if (features === null) return <MapMessage>Loading map…</MapMessage>;
  if (mapFeatures.length === 0) return <MapMessage>No mapped notes in this publication.</MapMessage>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {kinds.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, flexShrink: 0 }}>
          {kinds.map((k) => {
            const hidden = kindsHidden.has(k);
            return (
              <button
                key={k}
                onClick={() =>
                  setKindsHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  borderRadius: 999,
                  border: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
                  background: hidden ? "transparent" : "var(--glass-bg, rgba(255,255,255,0.06))",
                  color: hidden ? "var(--text-muted, #777)" : "var(--text-secondary, #bbb)",
                  cursor: "pointer",
                  fontSize: 12,
                  textDecoration: hidden ? "line-through" : "none",
                }}
              >
                {k}
              </button>
            );
          })}
        </div>
      )}
      {/* Viewport-bounded height, NOT a flex/percentage chain: the wiki page can
          be much taller than the viewport (a long nav), and a %-height map
          would stretch to the full page height with only its top slice visible
          — MapLibre would then center the fitted bounds in the off-screen
          middle of a 3000px canvas (seen as "the map opens on the wrong
          place"). calc(100dvh - chrome) keeps the whole canvas on screen. */}
      <div style={{ height: "calc(100dvh - 160px)", minHeight: 320, borderRadius: 10, overflow: "hidden" }}>
        <Suspense fallback={<MapMessage>Loading map…</MapMessage>}>
          <CommonsMap
            features={shown}
            height="100%"
            selectedId={activeId}
            onPick={onNavigate}
            testId="wiki-map"
          />
        </Suspense>
      </div>
    </div>
  );
}

function MapMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        minHeight: 320,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        color: "var(--text-secondary, #888)",
      }}
    >
      {children}
    </div>
  );
}
