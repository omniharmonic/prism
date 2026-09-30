/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  /** "1" in the native (Tauri shell) build: bearer-token transport, no service worker. */
  readonly VITE_PRISM_NATIVE?: string;
  /** Native build-time fallback for the Prism Server origin (host `apiOrigin` wins). */
  readonly VITE_PRISM_API_ORIGIN?: string;
}
