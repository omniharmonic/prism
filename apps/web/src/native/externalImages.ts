// External images in the native client (Client parity C, docs/client-app.md).
//
// The Prism Client's CSP only allows images from its own server (page script can
// read the device token, so an arbitrary image URL would be an exfiltration
// channel). Notes still embed external images (web clips, Substack, email), so in
// NATIVE mode every <img> whose src is an external http(s) URL is re-pointed at a
// blob: URL built from the server's SSRF-guarded proxy:
//
//   serverFetch("/api/media/proxy?u=<url>")  — bearer in the Authorization header
//     → bytes (raster, sniffed server-side)  → Blob → URL.createObjectURL
//
// Why blob URLs and not a signed media token in the <img src>: the device token
// never appears in a URL, no new credential type exists, nothing is minted, and
// the CSP is unchanged (`img-src` already allows `blob:`). The cost is that the
// browser's HTTP cache doesn't apply — this module keeps its own bounded LRU of
// blob URLs and the server keeps an on-disk cache.
//
// One document-wide MutationObserver covers every rendering site (TipTap, the
// sanitized HTML previews, version diffs, bioregion bodies, dashboard widgets)
// without touching each renderer. It only ever changes the DOM attribute: TipTap/
// ProseMirror ignore attribute mutations on leaf nodes, so the note's stored HTML
// keeps the ORIGINAL URL; a re-render that restores it is simply re-mapped
// (cache hit). The original is kept in `data-prism-src`.
//
// The PWA does not install this: its CSP allows https images and it loads them
// directly (proxying would only add load to the home server).

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Raster types the proxy may return; anything else is discarded client-side too. */
const RASTER = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/;

/** Is `src` an absolute http(s) URL on a host other than our server? */
export function isExternalImageSrc(src: string | null | undefined, apiOrigin: string): src is string {
  if (!src || !/^https?:\/\//i.test(src.trim())) return false;
  try {
    const u = new URL(src.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return !apiOrigin || u.origin !== new URL(apiOrigin).origin;
  } catch {
    return false;
  }
}

export const proxyPath = (src: string): string => `/api/media/proxy?u=${encodeURIComponent(src.trim())}`;

/**
 * Note attachments (wave 2B, `/api/attachments/<id>`) are relative to the SERVER,
 * not to tauri://localhost, and need the device bearer — so in native mode they
 * are fetched with serverFetch (bearer in a header) and shown as blob: URLs too.
 * Images, audio and video only (img-src / media-src allow blob:); PDFs and
 * other files are downloaded by the block's own button.
 */
const ATTACHMENT_PATH = /^\/api\/attachments\/[A-Za-z0-9_-]{1,64}$/;
export function ownAttachmentPath(src: string | null | undefined, apiOrigin: string): string | null {
  const s = (src ?? "").trim();
  if (ATTACHMENT_PATH.test(s)) return s;
  if (!apiOrigin) return null;
  try {
    const u = new URL(s);
    return u.origin === new URL(apiOrigin).origin && ATTACHMENT_PATH.test(u.pathname) && !u.search ? u.pathname : null;
  } catch {
    return null;
  }
}
/** A server-relative media-proxy path (bookmark preview images the server already proxied). */
const PROXY_PATH = /^\/api\/media\/proxy\?u=[A-Za-z0-9%._~!*'()-]{1,3000}$/;
export const serverProxyPath = (src: string | null | undefined): string | null => (PROXY_PATH.test((src ?? "").trim()) ? (src as string).trim() : null);
const MEDIA = /^(image\/(png|jpeg|gif|webp|avif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/;

interface Entry {
  url: string | null; // blob URL, or null = failed
  bytes: number;
  failedAt?: number;
  /** Transient (server busy / rate-limited): retry much sooner. */
  transient?: boolean;
}

export interface ImageCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  concurrency?: number;
  /** How long a failure is remembered before a retry (ms). */
  failureTtlMs?: number;
  createObjectURL?: (b: Blob) => string;
  revokeObjectURL?: (u: string) => void;
  now?: () => number;
}

/** URL → blob-URL LRU with in-flight dedupe and a fetch concurrency cap. */
export class ImageBlobCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<string | null>>();
  private bytes = 0;
  private running = 0;
  private queue: Array<() => void> = [];
  private readonly o: Required<ImageCacheOptions>;

  constructor(
    private readonly fetchImpl: FetchLike,
    opts: ImageCacheOptions = {},
  ) {
    this.o = {
      maxEntries: opts.maxEntries ?? 400,
      maxBytes: opts.maxBytes ?? 96 * 1024 * 1024,
      concurrency: opts.concurrency ?? 6,
      failureTtlMs: opts.failureTtlMs ?? 60_000,
      createObjectURL: opts.createObjectURL ?? ((b) => URL.createObjectURL(b)),
      revokeObjectURL: opts.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u)),
      now: opts.now ?? (() => Date.now()),
    };
  }

  /** Resolve `src` to a blob URL (null = could not be proxied). `direct` = fetch this server path as-is (attachments). */
  get(src: string, direct = false): Promise<string | null> {
    const e = this.entries.get(src);
    if (e) {
      if (e.url === null && this.o.now() - (e.failedAt ?? 0) > (e.transient ? Math.min(5_000, this.o.failureTtlMs) : this.o.failureTtlMs)) {
        this.entries.delete(src);
      } else {
        this.entries.delete(src); // touch
        this.entries.set(src, e);
        return Promise.resolve(e.url);
      }
    }
    const p = this.pending.get(src);
    if (p) return p;
    const run = this.slot().then(async (release) => {
      let transient = false;
      try {
        const res = await this.fetchImpl(direct ? src : proxyPath(src));
        const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (res.status === 503 || res.status === 429) transient = true;
        if (!res.ok || !(direct ? MEDIA : RASTER).test(type)) throw new Error(`proxy ${res.status}`);
        const buf = await res.arrayBuffer();
        // Re-type the blob ourselves: never trust a type we didn't allow.
        const url = this.o.createObjectURL(new Blob([buf], { type }));
        this.store(src, { url, bytes: buf.byteLength });
        return url;
      } catch {
        this.store(src, { url: null, bytes: 0, failedAt: this.o.now(), transient });
        return null;
      } finally {
        release();
        this.pending.delete(src);
      }
    });
    this.pending.set(src, run);
    return run;
  }

  private slot(): Promise<() => void> {
    const release = () => {
      this.running--;
      this.queue.shift()?.();
    };
    if (this.running < this.o.concurrency) {
      this.running++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) =>
      this.queue.push(() => {
        this.running++;
        resolve(release);
      }),
    );
  }

  private store(src: string, e: Entry): void {
    const prev = this.entries.get(src);
    if (prev) this.drop(src, prev);
    this.entries.set(src, e);
    this.bytes += e.bytes;
    for (const [k, v] of this.entries) {
      if (this.entries.size <= this.o.maxEntries && this.bytes <= this.o.maxBytes) break;
      if (k === src) continue;
      this.drop(k, v);
    }
  }

  private drop(k: string, v: Entry): void {
    this.entries.delete(k);
    this.bytes -= v.bytes;
    if (v.url) this.o.revokeObjectURL(v.url);
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }

  clear(): void {
    for (const [k, v] of [...this.entries]) this.drop(k, v);
  }
}

export interface InstallOptions {
  fetch: FetchLike;
  apiOrigin: () => string;
  root?: Document;
  cache?: ImageBlobCache;
  /** Only re-point note attachments (a capability-link viewer in the PWA: <img> can't send
   *  the Capability header, and external images load directly there). */
  attachmentsOnly?: boolean;
}

const ORIGINAL = "data-prism-src";
const FAILED = "data-prism-src-failed";

/** Re-point one <img>/<audio>/<video>/<source> holding a note attachment. Exported for tests. */
export function proxyAttachmentElement(el: Element, cache: ImageBlobCache, apiOrigin: string, proxied = false): boolean {
  const src = el.getAttribute("src");
  // `proxied` (native only): a relative /api/media/proxy path is relative to the SERVER too.
  const path = ownAttachmentPath(src, apiOrigin) ?? (proxied && el.tagName === "IMG" ? serverProxyPath(src) : null);
  if (!path || !src) return false;
  el.setAttribute(ORIGINAL, src);
  el.removeAttribute(FAILED);
  el.removeAttribute("src");
  void cache.get(path, true).then((blobUrl) => {
    if (el.getAttribute(ORIGINAL) !== src || el.hasAttribute("src")) return;
    if (blobUrl) el.setAttribute("src", blobUrl);
    else el.setAttribute(FAILED, "");
  });
  return true;
}

/** Re-point one <img> if it needs it. Exported for tests. */
export function proxyImageElement(img: HTMLImageElement, cache: ImageBlobCache, apiOrigin: string): void {
  if (proxyAttachmentElement(img, cache, apiOrigin, true)) return;
  const src = img.getAttribute("src");
  if (!isExternalImageSrc(src, apiOrigin)) return;
  // srcset candidates are external too, and would win over our blob src.
  if (img.hasAttribute("srcset")) img.removeAttribute("srcset");
  img.setAttribute(ORIGINAL, src);
  img.removeAttribute(FAILED);
  img.removeAttribute("src"); // the original was already CSP-blocked; don't retry it
  void cache.get(src).then((blobUrl) => {
    if (img.getAttribute(ORIGINAL) !== src || img.hasAttribute("src")) return; // re-rendered meanwhile
    if (blobUrl) img.setAttribute("src", blobUrl);
    else img.setAttribute(FAILED, "");
  });
}

/** Watch the document and proxy external images. Returns an uninstaller. */
export function installExternalImageProxy(opts: InstallOptions): () => void {
  const doc = opts.root ?? document;
  const cache = opts.cache ?? new ImageBlobCache(opts.fetch);
  const handle = (el: Element) => {
    if (el.tagName === "IMG" && !opts.attachmentsOnly) proxyImageElement(el as HTMLImageElement, cache, opts.apiOrigin());
    else proxyAttachmentElement(el, cache, opts.apiOrigin()); // AUDIO / VIDEO / SOURCE (and every attachment)
  };
  const MEDIA_TAGS = new Set(["IMG", "AUDIO", "VIDEO", "SOURCE"]);
  const scan = (n: Node) => {
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (MEDIA_TAGS.has(el.tagName)) handle(el);
    el.querySelectorAll?.("img[src], audio[src], video[src], source[src]").forEach((i) => handle(i));
  };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "attributes") {
        if (MEDIA_TAGS.has((m.target as Element).tagName)) handle(m.target as Element);
      } else {
        m.addedNodes.forEach(scan);
      }
    }
  });
  obs.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  scan(doc.documentElement);
  return () => {
    obs.disconnect();
    cache.clear();
  };
}
