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
    // Dev-only: when PRISM_DEV_SESSION is set, proxy the gateway routes to a
    // locally-running Prism Server (:8787) and inject an owner session cookie
    // server-side, so `localhost:5180` renders the real app with real vault data
    // and hot-reloads the redesign — no login dance. Inert in prod (env unset)
    // and never affects the static build (server.proxy is dev-server only).
    proxy: devGatewayProxy(),
  },
});

function devGatewayProxy() {
  const session = process.env.PRISM_DEV_SESSION;
  if (!session) return undefined;
  const cookie = `prism_session=${session}`;
  // Inject the owner session on the outgoing request — both plain HTTP and the
  // WebSocket upgrade (/collab), so the collab editor authenticates and notes
  // actually open.
  const setReqCookie = (req: { getHeader: (n: string) => unknown; setHeader: (n: string, v: string) => void }) => {
    const existing = req.getHeader("cookie");
    req.setHeader("cookie", existing ? `${existing}; ${cookie}` : cookie);
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const configure = (proxy: { on: (e: string, cb: (a: any) => void) => void }) => {
    proxy.on("proxyReq", (proxyReq: any) => setReqCookie(proxyReq));
    proxy.on("proxyReqWs", (proxyReq: any) => setReqCookie(proxyReq));
    // Also hand the browser the cookie so it carries the session natively on
    // every subsequent request (including the WS handshake from the client).
    proxy.on("proxyRes", (proxyRes: any) => {
      const sc = proxyRes.headers["set-cookie"];
      const list = Array.isArray(sc) ? sc : sc ? [sc] : [];
      proxyRes.headers["set-cookie"] = [...list, `${cookie}; Path=/; SameSite=Lax`];
    });
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const base = { target: "http://localhost:8787", changeOrigin: true, configure };
  return {
    "/api": base,
    "/auth": base,
    "/collab": { ...base, ws: true },
  } as Record<string, unknown>;
}
