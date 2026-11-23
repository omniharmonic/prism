/**
 * Get onto the newest build and reload. PWA: ask the service worker for an
 * update and activate a waiting one (prompt mode never swaps by itself), then
 * reload regardless. Native shell: no service worker — a plain reload (an old
 * installed app bundle needs an app update; the message says so).
 */
export async function reloadForUpdate(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.update().catch(() => {});
      reg.waiting?.postMessage({ type: "SKIP_WAITING" });
    }
  } catch {
    /* reload anyway */
  }
  setTimeout(() => window.location.reload(), 700);
}
