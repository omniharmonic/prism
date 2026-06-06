import React from "react";
import ReactDOM from "react-dom/client";
import { App, VaultClientProvider, initializeSettings } from "@prism/core";
import { httpVaultClient } from "./parachute/HttpVaultClient";
import { loadConnection, setActiveConnection } from "./config";
import { ConnectScreen } from "./auth/ConnectScreen";

// Importing `@prism/core` pulls in the global design system (tokens/glass/
// typography) as a side effect, so the connect screen is styled too.

function start() {
  initializeSettings();
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  const conn = loadConnection();

  if (!conn) {
    root.render(
      <React.StrictMode>
        <ConnectScreen onConnected={() => window.location.reload()} />
      </React.StrictMode>,
    );
    return;
  }

  setActiveConnection(conn);
  root.render(
    <React.StrictMode>
      <VaultClientProvider client={httpVaultClient}>
        <App />
      </VaultClientProvider>
    </React.StrictMode>,
  );
}

start();
