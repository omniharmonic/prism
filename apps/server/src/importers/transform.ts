/**
 * Bioregional data importers — pure transforms from authoritative open data
 * (GBIF/Darwin Core, GeoJSON, USGS Watershed Boundary Dataset) into typed
 * commons notes (Plan 2 §3, "identifier-first + one geometry convention").
 *
 * Dependency-free and I/O-free: each transform takes an upstream record and
 * returns a { content, tags, metadata } note-draft. Field names are the literal
 * upstream terms (dwc:*, HUC, GeoJSON) so notes round-trip. Geometry is stamped
 * with a derived bbox for indexed spatial pre-filtering. The CLI
 * (scripts/import-bioregion.mjs) fetches the data and POSTs these drafts.
 */

export interface NoteDraft {
  content: string;
  path?: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

// ── geometry (local, tiny — mirrors packages/core geo/geojson) ────────────────
export type BBox = [number, number, number, number];

function eachPos(coords: unknown, cb: (lon: number, lat: number) => void): void {
  if (Array.isArray(coords) && typeof coords[0] === "number" && typeof coords[1] === "number") {
    cb(coords[0], coords[1]);
    return;
  }
  if (Array.isArray(coords)) for (const c of coords) eachPos(c, cb);
}

export function computeBbox(geometry: { type?: string; coordinates?: unknown; geometries?: unknown[] } | null | undefined): BBox | null {
  if (!geometry) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let seen = 0;
  const visit = (lon: number, lat: number) => {
    seen++;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  };
  if (geometry.type === "GeometryCollection") {
    for (const g of geometry.geometries ?? []) {
      const bb = computeBbox(g as { type?: string; coordinates?: unknown });
      if (bb) {
        visit(bb[0], bb[1]);
        visit(bb[2], bb[3]);
      }
    }
  } else {
    eachPos(geometry.coordinates, visit);
  }
  return seen > 0 ? [minLon, minLat, maxLon, maxLat] : null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

// ── GBIF / Darwin Core species ─────────────────────────────────────────────────

export interface GbifSpecies {
  usageKey?: number;
  key?: number;
  scientificName?: string;
  canonicalName?: string;
  rank?: string;
  kingdom?: string;
  phylum?: string;
  family?: string;
  genus?: string;
  vernacularName?: string;
}

/** A GBIF species record → a `species` note (dwc terms + stable gbifTaxonKey). */
export function speciesFromGbif(rec: GbifSpecies): NoteDraft {
  const key = rec.usageKey ?? rec.key;
  const name = rec.scientificName || rec.canonicalName || "Unknown species";
  const metadata: Record<string, unknown> = {
    scientificName: name,
    sensing_or_responding: "sense",
    source: "gbif",
  };
  if (rec.rank) metadata.taxonRank = rec.rank.toLowerCase();
  if (rec.kingdom) metadata.kingdom = rec.kingdom;
  if (rec.phylum) metadata.phylum = rec.phylum;
  if (rec.family) metadata.family = rec.family;
  if (rec.genus) metadata.genus = rec.genus;
  if (rec.vernacularName) metadata.vernacularName = rec.vernacularName;
  if (key != null) {
    metadata.gbifTaxonKey = key;
    metadata.same_as = [`https://www.gbif.org/species/${key}`];
  }
  return {
    content: `# ${rec.vernacularName ? `${rec.vernacularName} (${name})` : name}`,
    tags: ["species"],
    metadata,
  };
}

// ── GeoJSON FeatureCollection → ecological-entity notes ────────────────────────

interface GeoFeature {
  type?: string;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/** Options for mapping generic GeoJSON features into typed notes. */
export interface GeoImportOpts {
  tag?: string; // default "ecological-entity"
  ecologicalKind?: string; // e.g. "creek", "river"
  sensing?: "sense" | "respond" | "both"; // default "sense"
  nameProp?: string; // property to use as the name (else common guesses)
  geometryField?: string; // metadata field to store geometry under (default "geometry")
}

function featureName(props: Record<string, unknown> | null | undefined, nameProp?: string): string {
  if (nameProp && props?.[nameProp] != null) return str(props[nameProp]);
  for (const k of ["name", "NAME", "gnis_name", "GNIS_NAME", "title", "label"]) {
    if (props?.[k] != null && str(props[k])) return str(props[k]);
  }
  return "Unnamed feature";
}

/** One GeoJSON Feature → a note draft (geometry + derived bbox). */
export function noteFromFeature(f: GeoFeature, opts: GeoImportOpts = {}): NoteDraft | null {
  const geom = f.geometry;
  if (!geom || geom.coordinates === undefined) return null;
  const tag = opts.tag ?? "ecological-entity";
  const geomField = opts.geometryField ?? "geometry";
  const name = featureName(f.properties, opts.nameProp);
  const metadata: Record<string, unknown> = {
    name,
    sensing_or_responding: opts.sensing ?? "sense",
    source: "geojson-import",
    [geomField]: geom,
  };
  if (opts.ecologicalKind) metadata.ecological_kind = opts.ecologicalKind;
  const bbox = computeBbox(geom);
  if (bbox) metadata.bbox = bbox;
  return { content: `# ${name}`, tags: [tag], metadata };
}

/** A GeoJSON FeatureCollection → note drafts (skips featureless entries). */
export function notesFromGeoJson(fc: { features?: GeoFeature[] } | GeoFeature[], opts: GeoImportOpts = {}): NoteDraft[] {
  const features = Array.isArray(fc) ? fc : (fc.features ?? []);
  return features.map((f) => noteFromFeature(f, opts)).filter((d): d is NoteDraft => d !== null);
}

// ── USGS Watershed Boundary Dataset (HUC) → watershed notes ────────────────────

/** A WBD feature (properties carry huc12 + name) → a `watershed` note. The HUC
 *  code encodes its own nesting, so parentHuc is derived by truncation. */
export function watershedFromWbd(f: GeoFeature): NoteDraft | null {
  const p = f.properties ?? {};
  const huc12 = str(p.huc12 ?? p.HUC12 ?? p.huc ?? p.HUC);
  if (!huc12) return null;
  const name = str(p.name ?? p.NAME ?? p.hu_12_name ?? p.HU_12_NAME) || `HUC ${huc12}`;
  const metadata: Record<string, unknown> = {
    huc12,
    hucName: name,
    hucLevel: huc12.length,
    sensing_or_responding: "sense",
    source: "usgs-wbd",
  };
  if (huc12.length > 2) metadata.parentHuc = huc12.slice(0, huc12.length - 2);
  if (f.geometry && f.geometry.coordinates !== undefined) {
    metadata.boundaryGeometry = f.geometry;
    const bbox = computeBbox(f.geometry);
    if (bbox) metadata.bbox = bbox;
  }
  const areaSqKm = num(p.areasqkm ?? p.AREASQKM);
  if (areaSqKm != null) metadata.areaSqKm = areaSqKm;
  return { content: `# ${name}`, tags: ["watershed"], metadata };
}

/** Registry of named importers → the CLI dispatches on --source. */
export const IMPORTERS = {
  "gbif-species": (data: unknown): NoteDraft[] => {
    // GBIF /species/search returns { results: [...] }; a bare array or single record also OK.
    const arr = Array.isArray(data)
      ? data
      : ((data as { results?: unknown[] }).results ?? [data]);
    return (arr as GbifSpecies[]).filter((r) => r && (r.scientificName || r.canonicalName)).map(speciesFromGbif);
  },
  "geojson-entities": (data: unknown, opts?: GeoImportOpts): NoteDraft[] => notesFromGeoJson(data as never, opts),
  "wbd-watersheds": (data: unknown): NoteDraft[] => {
    const features = Array.isArray(data) ? data : ((data as { features?: GeoFeature[] }).features ?? []);
    return features.map(watershedFromWbd).filter((d): d is NoteDraft => d !== null);
  },
} as const;

export type ImporterName = keyof typeof IMPORTERS;
