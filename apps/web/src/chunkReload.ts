import { CHUNK_RECOVERED_EVENT } from "../../../packages/core/src/lib/retryImport";

/**
 * Self-heal after a deploy: when a lazily-imported chunk fails to load (its hashed
 * filename changed in a new build, so the old one 404s / the SPA fallback hands back
 * index.html), drop the stale service worker + caches and reload once to fetch the
 * fresh build. Guarded so it can never loop.
 *
 * Never while offline: a chunk that fails to load without a connection (the background
 * editor preload, a page opened on a train) is not a stale build, a reload cannot fetch
 * anything, and dropping the service worker + caches would take the offline app with it.
 */
export function installChunkReloadRecovery(): void {
  // A failed chunk is first retried in the page (`retryImport`: a fresh request a moment
  // later). The reload waits for those retries and stands down when one succeeds — a single
  // flaky request (a cold cache, a bad moment on the network) is not a stale build, and
  // reloading for it was the "the canvas crashed, then it loaded" people saw.
  let timer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener(CHUNK_RECOVERED_EVENT, () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
  window.addEventListener("vite:preloadError", () => {
    if (navigator.onLine === false) return;
    if (timer) return; // one decision per burst of failures
    timer = setTimeout(reloadForStaleBuild, RELOAD_AFTER_RETRIES_MS);
  });
}

/** Longer than every `retryImport` attempt together (400 + 1200 ms, plus the requests themselves). */
const RELOAD_AFTER_RETRIES_MS = 4000;

function reloadForStaleBuild(): void {
  if (navigator.onLine === false) return;
  const KEY = "prism:chunk-reload-at";
  const last = Number(sessionStorage.getItem(KEY) || "0");
  if (Date.now() - last < 15000) return; // already recovered very recently — don't loop
  sessionStorage.setItem(KEY, String(Date.now()));
  void (async () => {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = (await caches?.keys?.()) ?? [];
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* best-effort cache bust */
    }
    window.location.reload();
  })();
}
