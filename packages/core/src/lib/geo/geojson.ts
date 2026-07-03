/**
 * GeoJSON geometry utilities — the "one geometry convention" the bioregional
 * ontology mandates (Plan 2 §3): every geometry is GeoJSON (RFC 7946), always
 * WGS84, always [longitude, latitude], with a derived `bbox` for cheap indexed
 * spatial pre-filtering. Pure + dependency-free so it is shared by the map
 * renderer (S3) and any importer that stamps geometry onto a note (S4).
 *
 * The #1 GeoJSON bug is reversing coordinate order; `validateGeometry` catches
 * the tell-tale out-of-range latitude that a [lat, lon] swap produces.
 */

export const GEOMETRY_TYPES = [
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
] as const;
export type GeometryType = (typeof GEOMETRY_TYPES)[number];

/** A GeoJSON position: [lon, lat] with an optional elevation. */
export type Position = [number, number] | [number, number, number];

export interface Geometry {
  type: GeometryType;
  coordinates?: unknown;
  geometries?: Geometry[]; // GeometryCollection only
}

/** BBox in GeoJSON order: [minLon, minLat, maxLon, maxLat]. */
export type BBox = [number, number, number, number];

const isGeometryType = (t: unknown): t is GeometryType =>
  typeof t === "string" && (GEOMETRY_TYPES as readonly string[]).includes(t);

/** A structurally valid WGS84 position: numeric [lon, lat] within range. */
export function isPosition(v: unknown): v is Position {
  if (!Array.isArray(v) || v.length < 2) return false;
  const [lon, lat, elev] = v as unknown[];
  if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (v.length >= 3 && elev !== undefined && typeof elev !== "number") return false;
  return lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

/** True when the value is an array of coordinates (nested), not a bare position. */
const isNestedCoords = (v: unknown): v is unknown[] =>
  Array.isArray(v) && (v.length === 0 || Array.isArray((v as unknown[])[0]));

/**
 * Visit every position in a coordinates tree, regardless of geometry depth
 * (Point → LineString → Polygon → Multi*). Returns false if a leaf isn't a
 * valid position.
 */
function eachPosition(coords: unknown, cb: (p: Position) => void): boolean {
  if (isPosition(coords)) {
    cb(coords);
    return true;
  }
  if (isNestedCoords(coords)) {
    for (const c of coords) if (!eachPosition(c, cb)) return false;
    return true;
  }
  return false;
}

/** Compute the bounding box of a geometry, or null if it has no valid positions. */
export function computeBbox(geometry: Geometry | null | undefined): BBox | null {
  if (!geometry) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let seen = 0;

  const visit = (p: Position) => {
    seen += 1;
    if (p[0] < minLon) minLon = p[0];
    if (p[0] > maxLon) maxLon = p[0];
    if (p[1] < minLat) minLat = p[1];
    if (p[1] > maxLat) maxLat = p[1];
  };

  if (geometry.type === "GeometryCollection") {
    for (const g of geometry.geometries ?? []) {
      const bb = computeBbox(g);
      if (bb) {
        visit([bb[0], bb[1]]);
        visit([bb[2], bb[3]]);
      }
    }
  } else if (!eachPosition(geometry.coordinates, visit)) {
    return null;
  }

  return seen > 0 ? [minLon, minLat, maxLon, maxLat] : null;
}

export interface GeometryValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate a value as a WGS84 GeoJSON geometry: a known type, structurally
 * correct coordinates, and every position within range. An out-of-range latitude
 * (>90) is the signature of a [lat, lon] swap, reported explicitly.
 */
export function validateGeometry(value: unknown): GeometryValidation {
  if (!value || typeof value !== "object") return { ok: false, error: "not an object" };
  const g = value as Geometry;
  if (!isGeometryType(g.type)) return { ok: false, error: `unknown geometry type: ${String(g.type)}` };

  if (g.type === "GeometryCollection") {
    if (!Array.isArray(g.geometries)) return { ok: false, error: "GeometryCollection missing geometries[]" };
    for (const sub of g.geometries) {
      const r = validateGeometry(sub);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  if (g.coordinates === undefined) return { ok: false, error: "missing coordinates" };

  // Detect a likely lon/lat swap before the generic range check, for a clearer error.
  let swapped = false;
  const rangeOk = eachPosition(g.coordinates, () => {});
  if (!rangeOk) {
    // Re-walk permissively to see whether the failure is an out-of-range latitude
    // (the swap signature) vs. structurally malformed coordinates.
    const anyNumericPair = looksLikeSwappedLatLon(g.coordinates);
    swapped = anyNumericPair;
    return { ok: false, error: swapped ? "coordinates look like [lat, lon] — GeoJSON is [lon, lat]" : "malformed coordinates" };
  }
  return { ok: true };
}

/** Heuristic: a leaf pair whose first element is out of lon range but a plausible
 *  latitude, and second out of lat range — i.e. the pair is reversed. */
function looksLikeSwappedLatLon(coords: unknown): boolean {
  let swap = false;
  const walk = (v: unknown) => {
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number" && !Array.isArray(v[0])) {
      const [a, b] = v as [number, number];
      if (Math.abs(b) > 90 && Math.abs(a) <= 90) swap = true;
      return;
    }
    if (Array.isArray(v)) for (const c of v) walk(c);
  };
  walk(coords);
  return swap;
}

/** Attach/refresh a note's derived bbox from its geometry (idempotent). Returns a
 *  shallow-updated metadata object; caller persists it. */
export function withBbox(metadata: Record<string, unknown>): Record<string, unknown> {
  const geometry = metadata.geometry as Geometry | undefined;
  const bbox = computeBbox(geometry);
  if (!bbox) return metadata;
  return { ...metadata, bbox };
}
