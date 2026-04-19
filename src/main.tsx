import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import "./styles/glass.css";
import "./styles/typography.css";

// Show errors visibly on screen ONLY before React mounts.
// Once React is mounted, ErrorBoundary handles rendering errors.
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

// Initialize settings (theme, fonts) before rendering
import("./app/stores/settings").then(({ initializeSettings }) => {
  initializeSettings();
});

// Lazy import App so if it crashes we catch it
import("./App").then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  reactMounted = true;
}).catch((err) => {
  document.getElementById("root")!.innerHTML = `
    <div style="padding:40px;color:white;font-family:monospace;background:#0a0a0b;height:100vh;">
      <h2 style="color:#EB5757;">Module Load Error</h2>
      <pre style="color:#aaa;white-space:pre-wrap;">${err.message}</pre>
      <pre style="color:#666;white-space:pre-wrap;">${err.stack}</pre>
    </div>`;
});
