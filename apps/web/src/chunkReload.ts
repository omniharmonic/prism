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
  window.addEventListener("vite:preloadError", () => {
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
  });
}
