/**
 * Basemap through the Prism Server (Client parity C).
 *
 * The Prism Client's CSP only lets the page reach its one Prism Server, so the
 * OpenFreeMap basemap can't load directly there. When a shell installs a server
 * fetch here (`setMapProxyFetch`, done by apps/web in NATIVE mode only),
 * CommonsMap swaps an OpenFreeMap style URL for `prismmap://style/<id>` and
 * registers a MapLibre custom protocol whose handler fetches
 *
 *   prismmap://style/<id>   → GET /api/map/style/<id>   (rewritten style)
 *   prismmap://ofm/<path>   → GET /api/map/ofm/<path>   (tiles, glyphs, sprites)
 *
 * through that fetch — so the device bearer rides in a header (never a URL) and
 * goes only to the configured server. The server's style has every asset URL
 * rewritten to `/api/map/ofm/…`; `localizeStyle` turns those into `prismmap://`
 * URLs so MapLibre routes them back through the same handler.
 *
 * The PWA installs nothing here and keeps loading OpenFreeMap directly (its CSP
 * allows it; proxying would only add load to the home server).
 *
 * No maplibre import: CommonsMap passes `maplibregl.addProtocol` in, so this
 * module (and its tests) stay free of the map bundle.
 */
import type { StyleSpecification } from "maplibre-gl";
import type { ServerFetch } from "../../lib/transport/serverFetch";

export const MAP_PROTOCOL = "prismmap";
const OFM_STYLE = /^https:\/\/tiles\.openfreemap\.org\/styles\/(liberty|positron|bright)$/;
const LOCAL_PREFIX = "/api/map/";

let proxyFetch: ServerFetch | null = null;

/** Shell hook: route the basemap through the server (null = load directly). */
export function setMapProxyFetch(f: ServerFetch | null): void {
  proxyFetch = f;
}
export const mapProxyActive = (): boolean => proxyFetch !== null;

/** The style to hand MapLibre: an OpenFreeMap style becomes `prismmap://style/<id>`
 *  while the proxy is active; anything else (blank, custom URLs) is untouched — a
 *  custom host stays CSP-blocked in the client and degrades to blank. */
export function proxiedStyle(style: string | StyleSpecification): string | StyleSpecification {
  if (!proxyFetch || typeof style !== "string") return style;
  const m = OFM_STYLE.exec(style);
  return m ? `${MAP_PROTOCOL}://style/${m[1]}` : style;
}

/** `prismmap://ofm/x` → `/api/map/ofm/x`; null for anything outside the two known roots. */
export function protocolUrlToPath(url: string): string | null {
  const pre = `${MAP_PROTOCOL}://`;
  if (!url.startsWith(pre)) return null;
  const rest = url.slice(pre.length);
  if (!/^(style|ofm)\/[A-Za-z0-9_@.,%\- /]{1,400}$/.test(rest) || rest.includes("..") || rest.includes("//")) return null;
  return LOCAL_PREFIX + rest;
}

/** Rewrite the server's `/api/map/…` URLs inside a style to `prismmap://…`. */
export function localizeStyle<T>(v: T): T {
  if (typeof v === "string") return (v.startsWith(LOCAL_PREFIX) ? `${MAP_PROTOCOL}://${v.slice(LOCAL_PREFIX.length)}` : v) as T;
  if (Array.isArray(v)) return v.map(localizeStyle) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, localizeStyle(x)])) as T;
  return v;
}

interface ProtocolParams {
  url: string;
  type?: "string" | "json" | "arrayBuffer" | "image";
}

/** The MapLibre `addProtocol` handler for `prismmap://`. */
export function createMapProtocolHandler(fetchImpl: ServerFetch) {
  return async (params: ProtocolParams, abort: AbortController): Promise<{ data: unknown }> => {
    const path = protocolUrlToPath(params.url);
    if (!path) throw new Error("map proxy: refused URL");
    const res = await fetchImpl(path, { signal: abort.signal });
    if (!res.ok) throw new Error(`map proxy: ${res.status}`);
    if (params.type === "json") {
      const json: unknown = await res.json();
      return { data: path.startsWith(`${LOCAL_PREFIX}style/`) ? localizeStyle(json) : json };
    }
    if (params.type === "string") return { data: await res.text() };
    return { data: await res.arrayBuffer() };
  };
}

let registered = false;
/** Register the protocol once (CommonsMap calls this on mount with maplibre's addProtocol). */
export function ensureMapProtocol(addProtocol: (name: string, fn: ReturnType<typeof createMapProtocolHandler>) => void): void {
  if (registered || !proxyFetch) return;
  const f = proxyFetch;
  addProtocol(MAP_PROTOCOL, createMapProtocolHandler((input, init) => f(input, init)));
  registered = true;
}
