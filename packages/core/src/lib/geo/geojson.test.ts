/**
 * GeoJSON geometry utilities. Pure, so tested in isolation (run:
 * `node --import tsx --test packages/core/src/lib/geo/geojson.test.ts`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPosition, computeBbox, validateGeometry, withBbox, buildGeometry, roundPos, type Geometry } from "./geojson";

const point = (lon: number, lat: number): Geometry => ({ type: "Point", coordinates: [lon, lat] });

test("isPosition enforces [lon, lat] and WGS84 range", () => {
  assert.equal(isPosition([-105.27, 40.02]), true); // Boulder-ish
  assert.equal(isPosition([-105.27, 40.02, 1655]), true); // with elevation
  assert.equal(isPosition([200, 0]), false); // lon out of range
  assert.equal(isPosition([0, 91]), false); // lat out of range
  assert.equal(isPosition([0]), false);
  assert.equal(isPosition(["0", "0"]), false);
});

test("computeBbox on a Point is a degenerate box", () => {
  assert.deepEqual(computeBbox(point(-105, 40)), [-105, 40, -105, 40]);
});

test("computeBbox spans a LineString (a creek)", () => {
  const creek: Geometry = { type: "LineString", coordinates: [[-105.3, 40.0], [-105.1, 40.2], [-105.2, 39.9]] };
  assert.deepEqual(computeBbox(creek), [-105.3, 39.9, -105.1, 40.2]);
});

test("computeBbox spans a Polygon (a watershed)", () => {
  const shed: Geometry = {
    type: "Polygon",
    coordinates: [[[-105.5, 39.8], [-105.0, 39.8], [-105.0, 40.3], [-105.5, 40.3], [-105.5, 39.8]]],
  };
  assert.deepEqual(computeBbox(shed), [-105.5, 39.8, -105.0, 40.3]);
});

test("computeBbox spans a MultiPolygon (a species range)", () => {
  const range: Geometry = {
    type: "MultiPolygon",
    coordinates: [
      [[[-106, 39], [-105, 39], [-105, 40], [-106, 39]]],
      [[[-104, 41], [-103, 41], [-103, 42], [-104, 41]]],
    ],
  };
  assert.deepEqual(computeBbox(range), [-106, 39, -103, 42]);
});

test("computeBbox handles a GeometryCollection", () => {
  const gc: Geometry = {
    type: "GeometryCollection",
    geometries: [point(-105, 40), { type: "LineString", coordinates: [[-106, 39], [-104, 41]] }],
  };
  assert.deepEqual(computeBbox(gc), [-106, 39, -104, 41]);
});

test("computeBbox returns null for empty/invalid geometry", () => {
  assert.equal(computeBbox(null), null);
  assert.equal(computeBbox({ type: "Point", coordinates: [] } as unknown as Geometry), null);
});

test("validateGeometry accepts good geometry and rejects unknown types", () => {
  assert.deepEqual(validateGeometry(point(-105, 40)), { ok: true });
  assert.equal(validateGeometry({ type: "Blob", coordinates: [0, 0] }).ok, false);
  assert.equal(validateGeometry(null).ok, false);
  assert.equal(validateGeometry({ type: "Point" }).ok, false); // missing coordinates
});

test("validateGeometry flags a [lat, lon] swap explicitly", () => {
  // Boulder as [lat, lon] = [40.02, -105.27] — latitude 40 is fine but a clearer
  // swap: [lat, lon] = [95, 10] has an impossible latitude in position 1.
  const swapped = { type: "Point", coordinates: [10, 95] }; // lat 95 → out of range
  const r = validateGeometry(swapped);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /lat, lon|lon, lat/);
});

test("validateGeometry validates every geometry in a collection", () => {
  const bad: Geometry = {
    type: "GeometryCollection",
    geometries: [point(-105, 40), { type: "Point", coordinates: [10, 200] }],
  };
  assert.equal(validateGeometry(bad).ok, false);
});

test("buildGeometry: point/line/polygon with ring auto-close + rounding", () => {
  assert.deepEqual(buildGeometry("Point", [[-105.123456789, 40.1]]), { type: "Point", coordinates: [-105.123457, 40.1] });
  assert.deepEqual(buildGeometry("LineString", [[-105, 40], [-104, 41]]), { type: "LineString", coordinates: [[-105, 40], [-104, 41]] });
  const poly = buildGeometry("Polygon", [[-105, 40], [-104, 40], [-104, 41]]);
  assert.equal(poly?.type, "Polygon");
  // ring auto-closed: first === last, 4 positions from 3 vertices
  const ring = (poly!.coordinates as number[][][])[0]!;
  assert.equal(ring.length, 4);
  assert.deepEqual(ring[0], ring[3]);
});

test("buildGeometry: too-few vertices → null (nothing to save)", () => {
  assert.equal(buildGeometry("Point", []), null);
  assert.equal(buildGeometry("LineString", [[-105, 40]]), null);
  assert.equal(buildGeometry("Polygon", [[-105, 40], [-104, 40]]), null);
});

test("buildGeometry: an already-closed polygon ring isn't double-closed", () => {
  const poly = buildGeometry("Polygon", [[-105, 40], [-104, 40], [-104, 41], [-105, 40]]);
  const ring = (poly!.coordinates as number[][][])[0]!;
  assert.equal(ring.length, 4);
});

test("roundPos preserves elevation", () => {
  assert.deepEqual(roundPos([-105.1234567, 40.7654321, 1655]), [-105.123457, 40.765432, 1655]);
});

test("withBbox stamps a derived bbox, idempotently", () => {
  const md = { geometry: point(-105, 40), name: "gauge" };
  const out = withBbox(md);
  assert.deepEqual(out.bbox, [-105, 40, -105, 40]);
  assert.equal(out.name, "gauge");
  // no geometry → unchanged
  assert.deepEqual(withBbox({ name: "x" }), { name: "x" });
});
