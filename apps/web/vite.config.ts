import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// The shared UI in `@prism/core` imports `invoke`/`listen` from `@tauri-apps/api`
// directly (editor markdown conversion, project tree, links panel, etc.). In the
// browser there is no Tauri runtime, so we alias those module specifiers to local
// shims: `invoke` routes vault commands to the Parachute REST API and gracefully
// degrades desktop-only commands; `listen` is a no-op. This lets the entire
// existing UI run on the web with zero changes to `@prism/core`.
//
// NATIVE BUILD (`vite build --mode native`, i.e. `npm run build:native`): the same
// UI for a Tauri shell served from tauri://localhost. No PWA plugin / service worker
// / manifest, output to dist-native/ (never clobbers the PWA `dist/` the server
// serves), and `import.meta.env.VITE_PRISM_NATIVE` is baked to "1" so the transport
// (src/transport.ts) uses the configured origin + device bearer token. The PWA build
// is byte-for-byte the same config as before.
export default defineConfig(({ mode }) => {
  const native = mode === "native" || process.env.VITE_PRISM_NATIVE === "1";
  return {
  plugins: [
    react(),
    tailwindcss(),
    ...(native ? [] : [VitePWA({
      // PROMPT, not autoUpdate: a loaded session keeps a consistent asset set —
      // the new build is applied only on a user-confirmed reload (see the
      // UpdatePrompt in main.tsx). autoUpdate + skipWaiting used to swap the SW
      // mid-session and evict in-use CSS/JS, so styling vanished until a manual
      // refresh and stale chunks rendered old code.
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["apple-touch-icon.png", "prism-icon.svg", "prism-mark.svg"],
      manifest: {
        name: "Prism",
        short_name: "Prism",
        description: "Documents, people, and ideas in one collaborative workspace.",
        theme_color: "#0a0a0b",
        background_color: "#0a0a0b",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the app shell, but skip the large lazy diagram/math chunks —
        // they runtime-cache on demand instead of bloating the install.
        globPatterns: ["**/*.{js,css,html}", "icon-*.png", "apple-touch-icon.png"],
        globIgnores: [
          "**/mindmap-*",
          "**/flowchart-*",
          "**/*Diagram*",
          "**/katex-*",
          "**/percentages-*",
          "**/subset-shared*",
          "**/createText-*",
          "**/push-sw.js", // loaded via importScripts, not precached
          "**/quick-capture.*", // native shell capture window only
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Do NOT skipWaiting/clientsClaim: the new SW waits until the user
        // accepts the update (UpdatePrompt → updateServiceWorker), then it
        // activates + reloads cleanly. This keeps the running session's assets
        // consistent (no mid-session eviction → no "styling disappeared").
        cleanupOutdatedCaches: true,
        // Web Push (WP3.3): the `push` + `notificationclick` handlers live in
        // public/push-sw.js and are importScripts'd into the GENERATED worker, so
        // generateSW (precache, denylist, runtime caching) stays exactly as it was.
        importScripts: ["push-sw.js"],
        navigateFallback: "index.html",
        // Let server-handled routes reach the network instead of being shadowed
        // by the SPA shell: /auth/* (magic-link callback sets the session cookie
        // + redirects — must hit the server) and /api/* (the gateway, which
        // includes the public publication JSON at /api/p/*). The human-facing
        // published Wiki URL /p/:slug is a CLIENT route — it intentionally FALLS
        // BACK to index.html (the SPA), which then fetches /api/p/:slug.
        // /mcp (the Prism MCP endpoint) and /.well-known/ (its RFC 9728
        // protected-resource metadata) are server-owned too (WP6.1).
        navigateFallbackDenylist: [/^\/auth\//, /^\/api\//, /^\/health(\?|$)/, /^\/mcp(\/|$)/, /^\/\.well-known\//],
        runtimeCaching: [
          // Authenticated vault responses use the account/vault-scoped IndexedDB
          // cache. A URL-only service-worker cache can mix accounts and vaults.
          {
            // Lazily-loaded JS chunks (diagrams, code editor) cache on first use.
            urlPattern: ({ request }) => request.destination === "script",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "app-chunks" },
          },
        ],
      },
      devOptions: { enabled: false },
    })]),
  ],
  build: {
    ...(native ? { outDir: "dist-native" } : {}),
    rollupOptions: {
      output: {
        // Rollup can name the shared app chunk after a lazy math module. Keep
        // the boot dependency out of the intentionally uncached diagram names.
        chunkFileNames: (chunk) => chunk.moduleIds.some((id) => id.endsWith("/apps/web/src/main.tsx"))
          ? "assets/workspace-[hash].js" : "assets/[name]-[hash].js",
      },
    },
  },
  ...(native
    ? {
        define: { "import.meta.env.VITE_PRISM_NATIVE": JSON.stringify("1") },
      }
    : {}),
  resolve: {
    alias: {
      ...(native
        ? {
            // No service worker in a native shell: keep UpdatePrompt's import inert.
            "virtual:pwa-register/react": fileURLToPath(
              new URL("./src/native/pwa-register-stub.ts", import.meta.url),
            ),
          }
        : {}),
      "@tauri-apps/api/core": fileURLToPath(
        new URL("./src/tauri-shim/core.ts", import.meta.url),
      ),
      "@tauri-apps/api/event": fileURLToPath(
        new URL("./src/tauri-shim/event.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5180,
    // A test run serves ONE snapshot of the code. With the watcher on, any file written under
    // apps/web or packages/core while tests run (an editor save, a checkout, a report) reaches
    // every open page as a full reload — Tailwind scans all of it, specs included — and the tests
    // that are mid-step fail in ways that look like product races ("execution context was
    // destroyed", a theme class that flips back, a selection that vanishes). Playwright sets this.
    ...(process.env.PRISM_FIXTURE_FROZEN === "1" ? { watch: null } : {}),
    // Dev-only: proxy the server-owned routes to a locally running Prism Server
    // so `npm run dev -w @prism/web` is fully functional (sign-in, the gateway,
    // /api/governance, and the collab websocket) without building + serving via
    // the server. Set PRISM_SERVER to point at a non-default origin. Production
    // is same-origin (the server serves the built PWA), so this never applies there.
    proxy: {
      "/api": { target: process.env.PRISM_SERVER ?? "http://localhost:8787", changeOrigin: true },
      "/auth": { target: process.env.PRISM_SERVER ?? "http://localhost:8787", changeOrigin: true },
      "/collab": { target: process.env.PRISM_SERVER ?? "http://localhost:8787", changeOrigin: true, ws: true },
    },
  },
  };
});
