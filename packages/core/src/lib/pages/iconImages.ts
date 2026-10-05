/**
 * Page icon images, fetched ONCE per attachment (NP-PG-01).
 *
 * An icon shows on many surfaces at once (sidebar row, tab, breadcrumb, favorites,
 * ⌘K, mention chips) and those mount and unmount all the time. A plain
 * `<img src="/api/attachments/<id>">` would ask the server again on every mount (the
 * route answers `no-cache`, and each request is a permission check), and in the native
 * shell / for a share-link viewer it cannot carry the credential at all. So the bytes
 * are fetched once through the shell's transport (`serverFetch`: cookie, device bearer
 * or capability header — never a credential in a URL) and every surface draws the
 * same `blob:` URL.
 *
 * Bounded: ≤ MAX images (least recently used first out), ≤ MAX_BYTES each, 4 fetches at
 * a time; a failure is remembered briefly so a list of rows does not hammer the server.
 */
import { serverFetch } from "../transport/serverFetch";
import { parsePageIcon } from "./iconValue";

const RASTER = /^image\/(png|jpeg|gif|webp|avif)$/;
const MAX = 200;
const MAX_BYTES = 10 * 1024 * 1024;
const FAIL_TTL_MS = 60_000;
const BUSY_TTL_MS = 5_000;
const CONCURRENCY = 4;

interface Entry { url: string | null; at: number; ttl: number }
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<string | null>>();
let running = 0;
const waiting: Array<() => void> = [];

function slot(): Promise<void> {
  if (running < CONCURRENCY) { running++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(() => { running++; resolve(); }));
}
function release(): void {
  running--;
  waiting.shift()?.();
}
function store(src: string, entry: Entry): void {
  entries.delete(src);
  entries.set(src, entry);
  while (entries.size > MAX) {
    const [oldest, gone] = entries.entries().next().value as [string, Entry];
    entries.delete(oldest);
    if (gone.url) try { URL.revokeObjectURL(gone.url); } catch { /* already gone */ }
  }
}

/** What is known right now: a blob URL, `null` (could not be loaded, for now), `undefined` (not asked yet). */
export function peekIconImage(src: string): string | null | undefined {
  const e = entries.get(src);
  if (!e) return undefined;
  if (e.url === null && Date.now() - e.at > e.ttl) { entries.delete(src); return undefined; }
  return e.url;
}

/** The image as a blob URL, or null. Only ever asks for a page-icon attachment path. */
export function loadIconImage(src: string): Promise<string | null> {
  if (parsePageIcon(src)?.kind !== "image") return Promise.resolve(null);
  const known = peekIconImage(src);
  if (known !== undefined) {
    if (known) store(src, entries.get(src)!); // touch
    return Promise.resolve(known);
  }
  const inFlight = pending.get(src);
  if (inFlight) return inFlight;
  const run = slot().then(async () => {
    let ttl = FAIL_TTL_MS;
    try {
      const res = await serverFetch(src);
      if (res.status === 503 || res.status === 429) ttl = BUSY_TTL_MS;
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!res.ok || !RASTER.test(type)) throw new Error("not an image");
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new Error("size");
      // Typed by us: never a type the list above does not allow.
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      store(src, { url, at: Date.now(), ttl: 0 });
      return url;
    } catch {
      if (typeof navigator !== "undefined" && navigator.onLine === false) ttl = BUSY_TTL_MS;
      store(src, { url: null, at: Date.now(), ttl });
      return null;
    } finally {
      release();
      pending.delete(src);
    }
  });
  pending.set(src, run);
  return run;
}

/** Tests / sign-out: forget every image (the next account must not be shown the previous one's). */
export function clearIconImages(): void {
  for (const e of entries.values()) if (e.url) try { URL.revokeObjectURL(e.url); } catch { /* gone */ }
  entries.clear();
}
if (typeof window !== "undefined") window.addEventListener("prism:signed-out", clearIconImages);
