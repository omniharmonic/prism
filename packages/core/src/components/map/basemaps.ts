import type { StyleSpecification } from "maplibre-gl";

/**
 * Basemap registry for the commons map. Default is OpenFreeMap (keyless, free
 * vector tiles) — works within the app CSP (connect-src https:, img-src https:;
 * MapLibre's worker is a same-origin file, `worker-src 'self'`). Every basemap
 * degrades to BLANK when its tiles can't load (offline, CSP-locked, or the tile
 * host is down), so the note geometry — the actual wiki content — always renders.
 */

/** A network-free style — always loads. No glyphs/sprite, so consumers must gate
 *  text/symbol layers on `hasGlyphs`. Doubles as the CSP-pure "no external hosts"
 *  option and the deterministic e2e/offline fallback.
 *  NEVER give it a `glyphs: undefined` key: MapLibre 6's style validation rejects
 *  it ("glyphs: string expected, undefined found") and the style silently never
 *  loads — the fallback itself would blank the map. */
export const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#0a0f0d" } }],
};

export interface Basemap {
  id: string;
  label: string;
  style: string | StyleSpecification;
  /** True when the style ships a glyphs endpoint (safe to add text/label layers). */
  hasGlyphs: boolean;
  attribution?: string;
}

const OFM_ATTR = "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors";

export const BASEMAPS: Basemap[] = [
  { id: "liberty", label: "Liberty", style: "https://tiles.openfreemap.org/styles/liberty", hasGlyphs: true, attribution: OFM_ATTR },
  { id: "positron", label: "Light", style: "https://tiles.openfreemap.org/styles/positron", hasGlyphs: true, attribution: OFM_ATTR },
  { id: "bright", label: "Bright", style: "https://tiles.openfreemap.org/styles/bright", hasGlyphs: true, attribution: OFM_ATTR },
  { id: "blank", label: "None", style: BLANK_STYLE, hasGlyphs: false },
];

export const DEFAULT_BASEMAP = "liberty";

/** Resolve a basemap id, a custom style URL, or fall back to the default. */
export function resolveBasemap(idOrUrl?: string | null): Basemap {
  if (!idOrUrl) return BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP)!;
  const byId = BASEMAPS.find((b) => b.id === idOrUrl);
  if (byId) return byId;
  if (/^https?:\/\//.test(idOrUrl)) return { id: "custom", label: "Custom", style: idOrUrl, hasGlyphs: true, attribution: "Custom style" };
  return BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP)!;
}

let addressChoice: "blank" | null | undefined;
/**
 * `?basemap=blank` in the page's address (e.g. `/bioregion?basemap=blank`) starts every map of
 * this page load on the network-free style: no style, tile, glyph or sprite request leaves the
 * page (deterministic e2e runs, an offline demo). ONLY `blank` is honoured — never another id or
 * a style URL, so a link can make a map load LESS, never fetch from a host of its choosing.
 * Read once, at the first map of the page load (a later in-app navigation that drops the query
 * keeps it). An explicit `basemap` prop wins, and the switcher still changes it.
 */
export function basemapFromAddress(): "blank" | null {
  if (addressChoice === undefined) {
    try {
      addressChoice = typeof location !== "undefined" && new URLSearchParams(location.search).get("basemap") === "blank" ? "blank" : null;
    } catch {
      addressChoice = null;
    }
  }
  return addressChoice;
}

/** Type → brand color, shared by the map layers and the legend/list. */
export const KIND_COLORS: Record<string, string> = {
  "ecological-entity": "#16a34a",
  species: "#0d9488",
  watershed: "#2563eb",
  place: "#7c3aed",
  signal: "#e11d48",
  resource: "#ea580c",
  event: "#475569",
  entity: "#16a34a",
};
export const kindColor = (kind: string): string => KIND_COLORS[kind] ?? "#16a34a";

/** A MapLibre `match` expression coloring a feature by its `kind` property. */
export function kindColorExpression(): unknown {
  const pairs = Object.entries(KIND_COLORS).flatMap(([k, v]) => [k, v]);
  return ["match", ["get", "kind"], ...pairs, "#16a34a"];
}
