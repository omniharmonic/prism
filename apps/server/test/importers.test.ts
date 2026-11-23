/**
 * Bioregional importers — pure transforms from authoritative open data into
 * typed commons notes. Tested against committed fixtures (no network), so the
 * mapping to Darwin Core / HUC / GeoJSON terms is pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  speciesFromGbif,
  noteFromFeature,
  notesFromGeoJson,
  watershedFromWbd,
  computeBbox,
  IMPORTERS,
} from "../src/importers/transform";

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(dir, "fixtures", name), "utf8"));

test("computeBbox spans a LineString", () => {
  assert.deepEqual(
    computeBbox({ type: "LineString", coordinates: [[-105.3, 40.0], [-105.1, 40.2]] }),
    [-105.3, 40.0, -105.1, 40.2],
  );
});

test("speciesFromGbif adopts dwc terms + the stable gbifTaxonKey", () => {
  const d = speciesFromGbif({ usageKey: 3120060, scientificName: "Achillea millefolium L.", rank: "SPECIES", family: "Asteraceae", genus: "Achillea", vernacularName: "Common Yarrow" });
  assert.deepEqual(d.tags, ["species"]);
  assert.equal(d.metadata.scientificName, "Achillea millefolium L.");
  assert.equal(d.metadata.taxonRank, "species");
  assert.equal(d.metadata.family, "Asteraceae");
  assert.equal(d.metadata.gbifTaxonKey, 3120060);
  assert.deepEqual(d.metadata.same_as, ["https://www.gbif.org/species/3120060"]);
  assert.equal(d.metadata.sensing_or_responding, "sense");
  assert.match(d.content, /Common Yarrow/);
});

test("gbif-species importer maps a search payload and skips empty records", () => {
  const drafts = IMPORTERS["gbif-species"](fixture("gbif-species.json"));
  assert.equal(drafts.length, 2); // the empty-name third record is dropped
  assert.equal(drafts[0]!.metadata.gbifTaxonKey, 3120060);
  assert.equal(drafts[1]!.metadata.family, "Passeridae");
});

test("noteFromFeature derives a name, stamps geometry + bbox, skips featureless", () => {
  const d = noteFromFeature(
    { geometry: { type: "LineString", coordinates: [[-105.3, 40.0], [-105.1, 40.2]] }, properties: { gnis_name: "Boulder Creek" } },
    { ecologicalKind: "creek", sensing: "respond" },
  );
  assert.ok(d);
  assert.deepEqual(d!.tags, ["ecological-entity"]);
  assert.equal(d!.metadata.name, "Boulder Creek");
  assert.equal(d!.metadata.ecological_kind, "creek");
  assert.equal(d!.metadata.sensing_or_responding, "respond");
  assert.deepEqual(d!.metadata.bbox, [-105.3, 40.0, -105.1, 40.2]);
  assert.equal(noteFromFeature({ geometry: null, properties: {} }), null);
});

test("geojson importer maps a FeatureCollection, dropping featureless entries", () => {
  const drafts = notesFromGeoJson(fixture("creeks.geojson") as never, { ecologicalKind: "creek", sensing: "respond" });
  assert.equal(drafts.length, 2); // 3 features, 1 has null geometry
  assert.deepEqual(drafts.map((d) => d.metadata.name).sort(), ["Boulder Creek", "Dry Creek"]);
});

test("watershedFromWbd keys by huc12 and derives parentHuc + bbox", () => {
  const drafts = IMPORTERS["wbd-watersheds"](fixture("wbd.geojson"));
  assert.equal(drafts.length, 1); // the no-huc feature is dropped
  const w = drafts[0]!;
  assert.deepEqual(w.tags, ["watershed"]);
  assert.equal(w.metadata.huc12, "101900050101");
  assert.equal(w.metadata.hucName, "Upper Saint Vrain");
  assert.equal(w.metadata.hucLevel, 12);
  assert.equal(w.metadata.parentHuc, "1019000501");
  assert.equal(w.metadata.areaSqKm, 142.3);
  assert.ok(Array.isArray(w.metadata.bbox));
});
