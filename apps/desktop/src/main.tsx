import React from "react";
import ReactDOM from "react-dom/client";

// Global styles (tokens/glass/typography) ship as a side-effect of importing
// `@prism/core`, so there are no CSS imports here.

// Show errors visibly on screen ONLY before React mounts.
// Once React is mounted, ErrorBoundary (inside @prism/core's App) handles them.
let reactMounted = false;

window.addEventListener("error", (e) => {
  if (reactMounted) {
    console.error("[Prism] Uncaught error:", e.message, e.filename, e.lineno);
    return; // Let React ErrorBoundary handle it
  }
  document.getElementById("root")!.innerHTML = `
    <div style="padding:40px;color:white;font-family:monospace;background:#0a0a0b;height:100vh;">
      <h2 style="color:#EB5757;">Startup Error</h2>
      <pre style="color:#aaa;white-space:pre-wrap;">${e.message}</pre>
      <pre style="color:#666;white-space:pre-wrap;">${e.filename}:${e.lineno}</pre>
    </div>`;
});

window.addEventListener("unhandledrejection", (e) => {
  if (reactMounted) {
    console.error("[Prism] Unhandled rejection:", e.reason);
    return;
  }
  document.getElementById("root")!.innerHTML = `
    <div style="padding:40px;color:white;font-family:monospace;background:#0a0a0b;height:100vh;">
      <h2 style="color:#EB5757;">Unhandled Promise Error</h2>
      <pre style="color:#aaa;white-space:pre-wrap;">${e.reason}</pre>
    </div>`;
});

// Lazy-import the shared core + the desktop's Tauri data adapter so a crash in
// either surfaces in the catch handler below rather than a blank screen.
Promise.all([import("@prism/core"), import("./data/TauriVaultClient")])
  .then(([{ App, VaultClientProvider, initializeSettings }, { tauriVaultClient }]) => {
    // Initialize settings (theme, fonts) before first paint.
    initializeSettings();

    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <VaultClientProvider client={tauriVaultClient}>
          <App />
        </VaultClientProvider>
      </React.StrictMode>,
    );
    reactMounted = true;
  })
  .catch((err) => {
    document.getElementById("root")!.innerHTML = `
      <div style="padding:40px;color:white;font-family:monospace;background:#0a0a0b;height:100vh;">
        <h2 style="color:#EB5757;">Module Load Error</h2>
        <pre style="color:#aaa;white-space:pre-wrap;">${err.message}</pre>
        <pre style="color:#666;white-space:pre-wrap;">${err.stack}</pre>
      </div>`;
  });
