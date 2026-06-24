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
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["apple-touch-icon.png", "vite.svg"],
      manifest: {
        name: "Prism",
        short_name: "Prism",
        description: "Your Parachute vault — notes, graph, and dashboards, anywhere.",
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
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Activate a new build immediately instead of waiting for every tab to
        // close — so users stop getting a stale app shell after a deploy.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallback: "index.html",
        // Let server-handled routes reach the network instead of being shadowed
        // by the SPA shell: /auth/* (magic-link callback sets the session cookie
        // + redirects — must hit the server) and /api/* (the gateway).
        navigateFallbackDenylist: [/^\/auth\//, /^\/api\//],
        runtimeCaching: [
          {
            // Recently-viewed vault content stays available offline (read-only).
            urlPattern: ({ url }) =>
              url.pathname.includes("/api/notes") ||
              url.pathname.includes("/api/vault") ||
              url.pathname.includes("/api/tags"),
            handler: "NetworkFirst",
            options: {
              cacheName: "vault-api",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Lazily-loaded JS chunks (diagrams, code editor) cache on first use.
            urlPattern: ({ request }) => request.destination === "script",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "app-chunks" },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
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
  },
});
