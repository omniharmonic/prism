import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import "./styles/glass.css";
import "./styles/typography.css";

// Show errors visibly on screen instead of white screen
window.addEventListener("error", (e) => {
  document.getElementById("root")!.innerHTML = `
    <div style="padding:40px;color:white;font-family:monospace;background:#0a0a0b;height:100vh;">
      <h2 style="color:#EB5757;">Startup Error</h2>
      <pre style="color:#aaa;white-space:pre-wrap;">${e.message}</pre>
      <pre style="color:#666;white-space:pre-wrap;">${e.filename}:${e.lineno}</pre>
    </div>`;
});

window.addEventListener("unhandledrejection", (e) => {
  document.getElementById("root")!.innerHTML = `
    <div style="padding:40px;color:white;font-family:monospace;background:#0a0a0b;height:100vh;">
      <h2 style="color:#EB5757;">Unhandled Promise Error</h2>
      <pre style="color:#aaa;white-space:pre-wrap;">${e.reason}</pre>
    </div>`;
});

// Lazy import App so if it crashes we catch it
import("./App").then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}).catch((err) => {
  document.getElementById("root")!.innerHTML = `
    <div style="padding:40px;color:white;font-family:monospace;background:#0a0a0b;height:100vh;">
      <h2 style="color:#EB5757;">Module Load Error</h2>
      <pre style="color:#aaa;white-space:pre-wrap;">${err.message}</pre>
      <pre style="color:#666;white-space:pre-wrap;">${err.stack}</pre>
    </div>`;
});
