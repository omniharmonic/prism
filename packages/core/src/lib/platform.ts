/**
 * Shell detection for the shared UI core.
 *
 * The same React core runs in two shells: the Tauri desktop app (which injects
 * `window.__TAURI_INTERNALS__`) and the web PWA (whose `@tauri-apps/api/core`
 * shim has no such global). Features that depend on desktop-only Tauri commands
 * — e.g. Google Calendar / Gmail / Matrix I/O — should gate their write paths on
 * `isDesktop`. Read paths that go through the VaultClient seam work in both.
 */
export const isDesktop: boolean =
  typeof window !== "undefined" &&
  // Tauri v2 exposes internals here; the web shim defines neither.
  (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));

export const isWeb = !isDesktop;
