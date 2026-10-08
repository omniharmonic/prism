/**
 * Retry a lazily loaded chunk a few times before giving up.
 *
 * A first open right after a deploy, a cold service-worker cache or a flaky
 * connection can make ONE chunk request fail (the large canvas engine most of
 * all: "creating a new canvas crashed, then it loaded"). That is not a reason to
 * show a crash screen — the same request a moment later usually succeeds.
 *
 * Browsers remember a failed module fetch for the rest of the page (Chromium
 * answers the next `import()` of that URL with the same rejection, without a
 * request). So a retry re-imports the URL the error names with a `?t=` query —
 * a fresh request, the same code (the chunk's own imports are unchanged). An
 * error that names no URL (Safari) is retried by calling `load` again. The last
 * failure is rethrown unchanged. Never retries offline (nothing can arrive).
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
      const url = failedModuleUrl(error);
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
