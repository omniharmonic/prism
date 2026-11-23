/**
 * Retry a lazily loaded chunk a few times before giving up.
 *
 * A first open right after a deploy, a cold service-worker cache or a flaky
 * connection can make ONE chunk request fail (the large canvas engine most of
 * all: "creating a new canvas crashed, then it loaded"). That is not a reason to
 * show a crash screen — the same request a moment later usually succeeds.
 *
 * Browsers remember a failed module fetch for the rest of the page (Chromium AND
 * Safari answer the next `import()` of that URL with the same rejection, without
 * a request). So a retry re-imports the chunk's URL with a `?t=` query — a fresh
 * request, the same code (the chunk's own imports are unchanged). The URL is the
 * one the error names (Chromium, Firefox); Safari's error names none, so there it
 * is read from the loader itself (`importedUrl`: the one `import("…")` in the
 * function's source). Only when neither gives a URL is `load` simply called again
 * (pass the loader that contains the `import()`, not a wrapper around it). The
 * last failure is rethrown unchanged. Never retries offline (nothing can arrive).
 *
 * Import-free on purpose: it is used by the boot-path shell.
 */
export const RETRY_IMPORT_DELAYS = [400, 1200] as const;

/** Fired when a chunk loads on a retry, so a pending stale-build reload can stand down. */
export const CHUNK_RECOVERED_EVENT = "prism:chunk-recovered";

export async function retryImport<T>(load: () => Promise<T>, delays: readonly number[] = RETRY_IMPORT_DELAYS): Promise<T> {
  let next = load;
  for (let attempt = 0; ; attempt++) {
    try {
      const module = await next();
      if (attempt > 0 && typeof window !== "undefined") window.dispatchEvent(new Event(CHUNK_RECOVERED_EVENT));
      return module;
    } catch (error) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      if (attempt >= delays.length || offline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      const url = failedModuleUrl(error) ?? importedUrl(load);
      next = url ? () => import(/* @vite-ignore */ withRetryQuery(url, attempt + 1)) as Promise<T> : load;
    }
  }
}

/** The same-origin script URL a failed `import()` names (Chromium, Firefox), else null. */
export function failedModuleUrl(error: unknown): string | null {
  if (!(error instanceof Error) || typeof location === "undefined") return null;
  const match = /https?:\/\/[^\s'"<>]+/.exec(error.message.slice(0, 2000));
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[.,;)]+$/, ""));
    if (url.origin !== location.origin || !/\.(m?js|tsx?|jsx)$/.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The same-origin script a loader imports, read from its source: `() => import("./X-hash.js")`
 * (a build wraps it — `() => __vitePreload(() => import("./X-hash.js"), deps, import.meta.url)` —
 * and the dev server writes an absolute path). Null unless the source holds exactly ONE literal
 * `import("…")`. A relative specifier is resolved against this module's own URL: every chunk of a
 * build is emitted into the same directory. (A wrong guess costs nothing: the retry fails like the
 * request before it and the original failure is what the caller sees.)
 */
export function importedUrl(load: unknown, base: string | undefined = moduleBase()): string | null {
  if (typeof load !== "function" || typeof location === "undefined") return null;
  let source: string;
  try {
    source = Function.prototype.toString.call(load).slice(0, 4000);
  } catch {
    return null;
  }
  const found = [...source.matchAll(/\bimport\(\s*(?:\/\*[^*]*\*\/\s*)?(["'])([^"'\\]+)\1\s*\)/g)];
  if (found.length !== 1) return null;
  const specifier = found[0]![2]!;
  if (!/^(\.{0,2}\/|https?:)/.test(specifier)) return null; // a bare package name is not a URL
  try {
    const url = new URL(specifier, base ?? location.href);
    if (url.origin !== location.origin || !/\.(m?js|tsx?|jsx)$/.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function moduleBase(): string | undefined {
  try {
    return import.meta.url;
  } catch {
    return undefined;
  }
}

function withRetryQuery(href: string, attempt: number): string {
  const url = new URL(href);
  url.searchParams.set("t", `${Date.now()}-${attempt}`);
  return url.href;
}

/** Does this error look like a chunk that could not be downloaded (rather than a bug in the view)? */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [^ ]+ failed|Unable to preload CSS/i.test(error.message);
}
