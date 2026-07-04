/**
 * The /bioregion map — a thin adapter over the shared MapLibre CommonsMap
 * (@prism/core). Maps BioEntity → MapFeature and renders the real vector map
 * (OpenFreeMap basemap by default; falls back to a blank style offline).
 */
import { CommonsMap, type MapFeature } from "@prism/core";
import type { BioEntity } from "./api";

const toFeature = (e: BioEntity): MapFeature => ({
  id: e.id,
  kind: e.tag,
  name: e.name,
  sensing: e.sensing,
  status: e.status,
  geometry: e.geometry,
  geo: e.geo,
});

export function BioregionMap({
  entities,
  onPick,
  selectedId,
  basemap,
}: {
  entities: BioEntity[];
  onPick?: (id: string) => void;
  selectedId?: string | null;
  basemap?: string | null;
}) {
  return (
    <CommonsMap
      features={entities.map(toFeature)}
      onPick={onPick}
      selectedId={selectedId}
      basemap={basemap}
      testId="bioregion-map"
      height={480}
    />
  );
}
