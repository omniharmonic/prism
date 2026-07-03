# Bioregional Knowledge Commons — Plan 2: The Bioregional Graph (Schema & Ontology)

> Status: research/design (v0). Branch `claude/bioregional-commons-research-imkw2y`.
> Companion: **Plan 1 — Governance & Commons Infrastructure** (read first). Plan 1
> answers *how the commons is governed*; Plan 2 answers *what is in it and why*.
>
> **Premise.** The vault already carries the seed of this commons: `opencivics`
> (197 notes) and `spirit-of-the-front-range` (123 notes) are top-level tags
> today. "Spirit of the Front Range" is the live bioregional vault. This plan is
> not greenfield invention — it is giving that material a **purpose-bound
> ontology** and the **geospatial + sensing** types it currently lacks, using the
> existing tag→type→renderer pipeline and the existing
> `extract-entities`/`reconcile`/`schema-bridge` skills as the ingestion engine.

---

## 0. Start with purpose (the cleavage is the whole problem)

There is a near-infinite amount of mappable information about a place. A commons
is a *subset*, and the design question is not "what could we map" but "what must
we map, and how do we know what to leave out." The transcript answers this: the
commons is a **cybernetic information layer for the bioregion — sensing and
responding for resilience.** That purpose is sharper than Wikipedia-style
"notability" (popularity-bound) because it is **function-bound**.

We make the cleavage *decidable* by borrowing the discipline of **ontology
competency questions** (Grüninger & Fox): the schema's scope is exactly the set
of questions the commons must be able to answer. Ours:

1. **What is the state of the bioregion's earth-systems and species?** (sense)
2. **What threatens its resilience right now** — ecological, policy, corporate? (sense)
3. **Who and what can respond, and how?** — people, orgs, resources, playbooks (respond)
4. **What regenerative production is underway or possible?** — food, medicine, materials (respond)

From which the single inclusion test:

> **Include a thing iff it materially helps the bioregion SENSE its state/threats
> OR RESPOND for resilience. If it serves neither, it stays out.**

This cleaves on **function, not category** — "not every salsa class in the
bioregion," as the transcript puts it, but the regenerative farm, the watershed,
the harmful zoning ordinance, and the governance playbook all qualify. To make
the test *enforced at write time*, every commons note carries a required header
field `sensing_or_responding: sense | respond | both`. A note that can't declare
one is, by definition, out of scope. This is the ontological membrane.

---

## 1. The supertype decision (the load-bearing ontological choice)

The transcript wrestles with the right framing: Cameron's **REA accounting
(Resources, Events, Agents)** is "elegant in its simplicity but a bit reductive,"
because mapping a watershed or a river as an "Agent" feels wrong. This intuition
is correct and the resolution is clean:

- **REA / Valueflows is the right economic substrate.** Valueflows (REA extended
  for distributed commons) already models *Economic Resource*, *Economic Event*,
  *Economic Agent*, *Process*, *Commitment*, *Recipe*, and even admits
  **ecological agents** and ecological accounting. Cameron's accounting drops in
  unchanged. We adopt its vocabulary verbatim (the `action` verb list:
  `produce, consume, use, cite, work, transfer, transferCustody, move, …`).
- **But "Agent" is the wrong top of the tree.** An REA Agent is defined by
  *participation in economic events*. A river, an aquifer, or a species matters to
  a *sensing* commons even when no economic event touches it. Forcing it into
  "Agent" subordinates ecology to economics — the opposite of the intent.
- **Resolution: a neutral `entity` supertype**, with `person`, `organization`,
  and `ecological-entity` as subtypes. REA's "Agent" becomes a *role/capability*
  ("any entity that can perform an Economic Event"), not the root. An
  `ecological-entity` river that you *also* want to account flows for simply
  *also* plays the Agent role — full REA/VF interop preserved, ecology liberated
  to exist for sensing reasons alone. This is exactly the user's instinct: "maybe
  entity is better, and ecological entity is a subtype that includes the GeoJSON
  coordinates."

**This maps directly onto a Parachute capability the codebase sweep nearly
missed.** Parachute's `query-notes` supports `expand: subtypes` over a tag's
declared `parent_names` — the *semantic is-a axis*; the tool's own example is
literally "`tag:entity` also matches `person/work`." So a true type hierarchy is
available at the vault layer **today**; `tag-schemas.json` simply doesn't declare
`parent_names` yet. We use it: `person`, `organization`, `ecological-entity`,
`species` declare `entity` as a parent, so a single `query-notes { tag: "entity",
expand: "subtypes" }` returns the whole actor/being layer, while
`tag: "ecological-entity"` narrows. (One caveat to verify against the running
Parachute: confirm `parent_names` is settable via `update-tag` and that the
Prism seed mechanism preserves it — see §6 risks.)

---

## 2. The proposed taxonomy (8 top-level types)

Two layers. Types 1–5 are the **map layer** (who/what/where/when — well-served by
existing standards). Types 6–8 are the **cybernetic layer** (sense → respond).
Every type inherits a **shared header** (below); each has a one-sentence
inclusion test.

| # | Type (tag) | Subtypes (via `parent_names`) | Inclusion test | Standard anchor |
|---|---|---|---|---|
| 1 | **`entity`** (super) | `person`, `organization`, `ecological-entity` | This actor/being can sense or respond in the bioregion. | REA Agent → neutral Entity; Murmurations; schema.org |
| 2 | **`species`** | (links to `ecological-entity`) | Its presence/abundance is a resilience signal or a regenerative resource. | Darwin Core + GBIF/iNat IDs |
| 3 | **`place`** | `watershed`, `site`, `bioregion` | A bounded area whose state we sense or within which we respond. | schema.org Place + GeoCoordinates + HUC |
| 4 | **`event`** | — | A dated occurrence registering a change of state or a coordinated response. | REA Economic Event; schema.org Event |
| 5 | **`resource`** | `food`, `medicine`, `material`, `knowledge` | A stock/flow regenerative response can produce, consume, or steward. | REA/Valueflows Economic Resource |
| 6 | **`signal`** / **`threat`** | `policy`, `corporate`, `ecological` | A sensed condition that demands a response for resilience. | **none — invent it (the cybernetic core)** |
| 7 | **`recipe`** / **`playbook`** | `governance`, `production`, `coordination` | A reusable how-to for responding that others can re-run. | OpenCivics Protocol + VF Recipe + schema.org/HowTo |
| 8 | **`flow`** / **`commitment`** | — | Links the above into a planned or observed action (who did/will do what to which resource). | REA duality; VF Commitment/Event |

**The shared header** (every commons note carries it — declared once on the
`entity` supertype schema and on the standalone types):

```jsonc
{
  "sensing_or_responding": "sense | respond | both",  // REQUIRED — the cleavage gate
  "wikidata_qid": "Q…",        // optional stable global id (survives renames)
  "same_as": ["…"],            // external authority URLs (GBIF, Murmurations, USGS…)
  "geo": { "lat": 0, "lon": 0 },        // simple centroid for cheap filtering
  "geometry": { /* GeoJSON */ },        // full geometry (WGS84, [lon,lat]) — see §3
  "bbox": [minLon, minLat, maxLon, maxLat],  // derived; indexed for spatial pre-filter
  "source": "provenance",
  "confidence": 0.0,           // extraction confidence (reuses existing entity model)
  "indigenous_governed": false // §5 sovereignty membrane — excludes from publish/federation
}
```

Notes on the cleave:
- **Type 6 (`signal`/`threat`) is the type with no prior art — and that is
  correct.** No general ontology models "a sensed condition demanding response,"
  because none is purpose-bound to resilience. It is the *raison d'être* of a
  cybernetic commons and the one piece we invent. Fields:
  `{ kind: policy|corporate|ecological, severity, status, observed_at, affects:
  [→place|species|watershed], source_url, response: [→recipe|→commitment] }`.
- **`species` and `ecological-entity`** are kept distinct: a `species` is the
  *taxon* (a knowledge-level type, reconciled to a GBIF key); an
  `ecological-entity` is a *located being/feature* (a river, a stand of forest,
  an observed population) carrying geometry. A species note links to many
  occurrence/ecological-entity notes — this is the Darwin Core taxon↔occurrence
  split (§3).

---

## 3. The ecological + geospatial layer (adopt standards verbatim)

The governing principle from the research: **identifier-first** (a note is a
*pointer* to an authoritative record, not a re-host) and **one geometry
convention** (all geometry is embedded GeoJSON). Reusing exact upstream field
names means notes round-trip to GBIF/USGS/NOAA instead of needing a translation
layer.

**Geometry convention (RFC 7946 — non-negotiable details):**
- One `geometry` field per note holding a single GeoJSON geometry, or `features`
  holding a `FeatureCollection`. Always **WGS84**, always **`[longitude,
  latitude]`** order (the #1 bug is reversing it), no `crs` member (RFC 7946
  removed it), coords rounded to ~6 decimals.
- Modeling: river/creek → `LineString`; watershed/parcel → `Polygon`; species
  range → `MultiPolygon`; station/POI/occurrence → `Point`; migration track →
  `LineString`.
- Store a derived `bbox` as an **indexed** field for cheap spatial pre-filtering
  (Parachute indexes per-field metadata, not geometry — bbox is the workaround).

**Species (`species` + occurrence notes):** adopt Darwin Core terms as the literal
metadata keys — `scientificName, taxonRank, kingdom/phylum/class/order/family/
genus, vernacularName, taxonID`; anchor to stable IDs `gbifTaxonKey`,
`inatTaxonId` (resolvable, cross-referenced, re-fetchable). Range →
`rangeGeometry` (MultiPolygon) + `iucnId`/`iucnCategory`. Occurrences carry
`occurrenceID, basisOfRecord, eventDate, decimalLatitude, decimalLongitude`.

**Hydrology (`watershed`/`waterway`):** key watersheds by **HUC12** (`huc12`
indexed) — the code *encodes its own nesting* (HUC2⊃HUC4⊃…⊃HUC12), so the
`place` hierarchy is derivable by prefix match with no join; `boundaryGeometry`
Polygon. Waterways key by NHD `comid` + `LineString`. Water quality via the EPA/
USGS **Water Quality Portal** (`MonitoringLocationIdentifier` — the only
cross-agency-unique id) and USGS NWIS gages (`site_no`, parameter codes
`00060`/`00065`).

**Earth systems (`place`-attached):** NOAA NCEI GHCN-Daily station id (`ghcndId`)
+ 30-yr Climate Normals; ISRIC SoilGrids properties at the centroid; USGS/MRLC
NLCD land-cover class. Every datum stores `sourceId` + coordinates so it can be
re-pulled.

**Herbal medicine (`resource/medicine` + `herbal-use`):** USDA **Dr. Duke's
Phytochemical & Ethnobotanical Databases** (CC0 — mirrorable). A `herbal-use`
note is the *join record* linking a `species` to `{ ethnobotanicalUse,
preparation, plantPart, biologicalActivity, chemical, pubchemCid, source,
license: CC0 }` — so one species carries many uses and each use cites its
authority. This is exactly the transcript's "where species and Earth-systems data
intersect" — and the resilience framing (closed-loop bioregional medicine if
global supply chains fail) is the inclusion justification.

**Social / map layer (`organization`/`project`/`place`/`event`):** adopt
**Murmurations** field names verbatim (`name, nickname, primary_url, mission,
description, tags[], geolocation:{lat,lon}, geographic_scope, relationships[],
status, linked_schemas[]`) so the commons can **publish to and consume from the
Murmurations Index** — instant federation with the existing 30k-node regenerative
movement. Layer in `wikidata_qid` + `same_as[]` so identity survives renames and
reconciles against authority files (GBIF for species, GeoNames for places, VIAF
for people).

**Recipes/playbooks (`recipe`):** model the OpenCivics **Protocol** shape on the
inside (`objective, roles[], steps[], governance`) and **schema.org/HowTo** on the
wire (`step[], tool[], supply[], totalTime`). Valueflows *Recipe* (material
production) and OpenCivics *Protocol* (social production) converge here — one
unified type. This is where OpenCivics' decade of recipe/playbook thinking lands
in the vault, reusing the 197 `opencivics` notes already present.

---

## 4. How it's built — extending the pipeline (concrete recipe)

The codebase sweep produced the exact, minimal extension recipe. Adding one
tag-driven type with a renderer + indexed fields touches a known, small set of
files:

1. **`packages/core/src/lib/schemas/tag-schemas.json`** — add the tag entry:
   `description`, `contentType`, `precedence`, `fields` (with `indexed: true` on
   anchor ids + `bbox`; `enum` where closed), and **`parent_names`** for subtypes
   (`ecological-entity` → `["entity"]`). This JSON is the **single source of
   truth**, shared with the Rust enrichment and the vault seed.
2. **`packages/core/src/lib/types.ts`** — add the string to the `ContentType`
   union (+ `CONTENT_DEFAULTS`, icons, labels auto-derive).
3. **`packages/core/src/lib/schemas/content-types.ts`** — add to `KNOWN_TYPES`.
4. **`packages/core/src/components/renderers/<Type>Renderer.tsx`** — the renderer
   (consumes `RendererProps = { note, onSave, onMetadataChange, readOnly }`).
5. **`packages/core/src/components/renderers/Registry.ts`** — lazy import + map
   entry.
6. **`apps/desktop/src-tauri/src/commands/vault.rs`** — add to `known_prism_types`
   so `enrich_note` recognizes it (the Rust side loads the same tag-schemas.json
   and stamps `prism_type` by precedence).
7. **Seed:** run the schema seed (`seedTagSchemas` / `prism-setup-schema` skill) —
   **additive-only, idempotent**, pushes description + fields (+ `parent_names`)
   to the vault via `PUT /vault/{name}/api/tags/{tag}`.

**The map renderer (the one genuinely new UI capability).** There is **no
geospatial support today** — no GeoJSON handling, no map library, no map widget.
We add:
- A `MapRenderer` (for `ecological-entity`/`place`/`watershed`) and/or a `map`
  **dashboard widget** (register in `widget-registry.ts`, add a `renderWidget`
  case). The widget filters notes by tag/path `source`, reads each note's
  `geometry`, and renders the `FeatureCollection`.
- Library: **MapLibre GL JS** for dense bioregional layers (WebGL, data-driven
  styling, declarative `addSource({type:'geojson'})`), with **Leaflet** as the
  lighter "drop a feature on a map" option. (Both consume the note's GeoJSON
  directly — the geometry convention in §3 makes this trivial.)
- A "Map" **virtual tab** (like the existing dashboards — `ContentType` +
  `Registry` + `VIRTUAL_TAB_IDS`) that renders the whole in-scope graph as layers
  (watersheds, waterways, species ranges, orgs, threats), each toggleable.

**Ingestion reuses the existing entity pipeline wholesale.** The
`classify → extract-entities → reconcile` skills already turn unstructured
content into typed, deduplicated vault notes with `aliases`/`source`/`confidence`,
and `schema-bridge` already translates the OpenCivics **OPAL** format
(`resource_types`, `dimensions`, `relationships`) ⇄ Parachute tag schemas. So:
- **OPAL → ontology:** the OpenCivics OPAL schema imports via `schema-bridge`
  (OPAL `resource_type` → tag; `dimensions` → namespaced tags or metadata;
  `relationships` → link types). The 197 `opencivics` notes get re-typed under the
  new taxonomy through `reconcile`, not re-authored.
- **External data → notes:** GBIF/iNat/USGS/NOAA/Murmurations pulls become
  scripted importers (Parachute is a plain HTTP API — mint an ephemeral
  `vault:default:write` token, POST notes) that stamp the Darwin Core / HUC /
  GHCN ids and GeoJSON per §3. These can run as Prism background services or
  Parachute Runner crons.

---

## 5. The indigenous-knowledge boundary (a membrane, not a category)

The transcript is explicit: **deliberately do not index indigenous knowledge;
partner with those doing that work, in right relationship.** The cleanest,
most-respected mechanism is **Local Contexts' TK/BC Labels + the CARE principles**
(Collective benefit, Authority to control, Responsibility, Ethics). Implement as a
hard membrane:

1. **Out of scope by construction.** The inclusion test ("serves sensing/
   responding") does **not** override Indigenous **Authority to control**;
   sovereignty is the prior constraint. The commons never crawls, mirrors, or
   infers indigenous knowledge.
2. **Partner via pointer, not copy.** Where collaboration is invited, store only a
   `partner` edge to a community-controlled node + TK/BC Label metadata
   (`tk_label, bc_label, community, access_protocol, permissions`) — never the
   underlying knowledge.
3. **Engineering hook (decidable + enforced).** The shared header's
   `indigenous_governed: boolean` (or a populated `tk_label`) **excludes the note
   from public publishing and federation** — it must never reach an
   `anyone/tag/view` grant or the Murmurations Index. This wires directly into
   Plan 1's publish/federation guards: the governance layer already gates what
   becomes public; this is one more exclusion predicate on that path. The commons
   can *know a partnership exists* without ever holding the knowledge.

---

## 6. Phased build plan (schema-first, each step verifiable)

- **S0 — Ontology spec + competency questions (this doc → a living schema doc).**
  Lock the 8 types, the shared header, the `parent_names` hierarchy, and the
  inclusion test. Write the competency questions as acceptance queries.
  *Verify: peer/owner review; the cleavage test applied to 20 sample real notes.*
- **S1 — Seed the schema (no UI yet).** Author the 8 tags + subtypes + fields
  (Darwin Core / Murmurations / HUC / VF names verbatim) in `tag-schemas.json`
  with `parent_names`; seed additively; confirm `query-notes { tag:"entity",
  expand:"subtypes" }` resolves the hierarchy. *Verify: `list-tags` shows schemas;
  subtype expansion works; idempotent re-seed reports zero changes.*
- **S2 — Types + renderers (non-geo first).** `entity`/`organization`/`person`/
  `event`/`resource`/`signal`/`recipe` through the §4 recipe with simple
  metadata-form renderers. *Verify: create one note of each type; renderer +
  indexed-field queries work end-to-end.*
- **S3 — Geospatial foundation (the headline new capability).** GeoJSON header
  convention + `bbox` indexing; `MapRenderer` + a `map` dashboard widget +
  MapLibre; a "Map" virtual tab. *Verify: a river `LineString`, a watershed
  `Polygon` (HUC12), and a species-range `MultiPolygon` render as toggleable
  layers; coordinate order correct.*
- **S4 — Ingestion: OPAL re-type + external importers.** Run `schema-bridge` on
  the OpenCivics OPAL schema; `reconcile` the 197 `opencivics` +
  `spirit-of-the-front-range` notes under the new taxonomy; build 2–3 importers
  (GBIF species, USGS watershed/HUC, Murmurations orgs). *Verify: a real Front
  Range watershed + a keystone species + a regenerative org land as correct typed,
  geometried, deduplicated notes.*
- **S5 — Sensing/responding loops.** `signal`/`threat` ingestion (policy/corporate
  monitors — reuse the existing web-monitor/intelligence-scan agents) linked to
  affected `place`/`species` and to response `recipe`/`commitment`. Close the
  cybernetic loop: a sensed threat surfaces the playbook to respond. *Verify: a
  seeded policy threat links to its watershed and a governance playbook; the Map
  tab shows it.*

**Sequencing.** S0–S2 establish the ontology and prove the pipeline; S3 adds the
one real new capability (maps/GeoJSON); S4 migrates the existing OpenCivics
corpus instead of starting empty; S5 lights up the cybernetic purpose. Each step
ships independently and every note created is governed by Plan 1.

---

## 7. How the two plans interlock

- **Governance governs the graph.** Every type here is a resource the Plan 1
  engine gates: a `species` or `recipe` edit is a *proposal* requiring tag-scoped
  gardener sign-off; high-stakes tags (`signal/threat`, `resource/medicine`) carry
  stricter thresholds; `indigenous_governed` notes are excluded from publish/
  federation by the same guard. The ontology defines *what*; the governance layer
  defines *who may change it and how it goes live*.
- **The graph gives governance its scopes.** Plan 1's tag-scoped roles
  ("gardener of `#watershed`") and per-tag thresholds presuppose a real type
  taxonomy — this plan provides it. The two were specified together for that
  reason.
- **Federation + Murmurations.** Plan 1's peer federation and this plan's
  Murmurations interop are the same outward reflex at two scales: peer-to-peer
  vault sync for trusted collaborators, open-index publishing for the movement.

---

## 8. Open questions for the user

1. **Type vs. subtype granularity.** Ship all 8 top-level types at once, or start
   with the spine (`entity`+subtypes, `place`/`watershed`, `species`, `signal`,
   `recipe`) and add `flow`/`commitment` once REA accounting is actually needed?
   *Recommendation: spine first (S2–S3), accounting (`flow`/`commitment`) in S5.*
2. **REA depth.** — **RESOLVED: light.** v1 ships the `entity`/`event`/`resource`
   core plus a light `flow`/`commitment` layer only; full Valueflows process/
   commitment accounting is deferred. The neutral `entity` supertype keeps the
   door open to full VF later without a migration. Governance thresholds attach
   per-type (Plan 1), so a small type set also keeps the initial policy surface
   small.
3. **`signal`/`threat` — manual vs. agent-sensed.** Curate threats by hand first,
   or wire the existing intelligence-scan/web-monitor agents to propose them as
   pending notes (governed by Plan 1)? *Recommendation: agent-proposed → human-
   approved, dogfooding the governance pipeline.*
4. **Map library.** MapLibre GL (heavier, scales to dense layers) vs. Leaflet
   (lighter, simpler) for v1? *Recommendation: Leaflet for S3 speed, MapLibre when
   layer density demands it.*
5. **Geometry storage at scale.** Inline `geometry` in note metadata is simplest
   but bloats large polygons; do we need a linked-attachment path for big
   watershed/range geometries from day one? *Recommendation: inline + `bbox` now;
   attachment path only if profiling shows metadata bloat.*
6. **Parachute `parent_names` confirmation.** — **RESOLVED for S1 via the
   fallback.** The current seed (`seedTagSchemas`) pushes only `description` +
   `fields` to the vault, so `parent_names` would be dead data today. S1 therefore
   ships the working-today dimension pattern: an **indexed `entity_kind`** field
   on `entity` (person/organization/ecological) as the is-a axis, with `species`,
   `place`, `event`, `resource`, `signal`, `recipe`, `flow`, `herbal-use` as
   sibling top-level tags. *Follow-up:* extend the seed to also PUT `parent_names`
   (and confirm `update-tag` accepts it against the live vault), then switch the
   hierarchy to true `expand: subtypes` — a small, isolated enhancement.
