import React from "react";
import ReactDOM from "react-dom/client";
import { App, VaultClientProvider, CollabSharingProvider, initializeSettings } from "@prism/core";
import { httpVaultClient } from "./parachute/HttpVaultClient";
import { webCollabSharing } from "./collab/grant";
import { loadConnection, setActiveConnection } from "./config";
import { ConnectScreen } from "./auth/ConnectScreen";
import { ShareView } from "./share/ShareView";
import { CollabPage } from "./collab/CollabPage";
import { startOutboxSync } from "./offline/outbox";
import { OfflineIndicator } from "./offline/OfflineIndicator";

// Importing `@prism/core` pulls in the global design system (tokens/glass/
// typography) as a side effect, so the connect screen is styled too.

function start() {
  initializeSettings();
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

  // Public, read-only share route: /share/:id (or /view/:id). No login.
  const share = window.location.pathname.match(/^\/(?:share|view)\/(.+)$/);
  if (share) {
    root.render(
      <React.StrictMode>
        <ShareView noteId={decodeURIComponent(share[1])} />
      </React.StrictMode>,
    );
    return;
  }

  // Real-time collaborative editing route: /collab/:id (CRDT, peer-to-peer).
  const collab = window.location.pathname.match(/^\/collab\/(.+)$/);
  if (collab) {
    root.render(
      <React.StrictMode>
        <CollabPage noteId={decodeURIComponent(collab[1])} />
      </React.StrictMode>,
    );
    return;
  }

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
  startOutboxSync();
  root.render(
    <React.StrictMode>
      <VaultClientProvider client={httpVaultClient}>
        <CollabSharingProvider value={webCollabSharing}>
          <App />
          <OfflineIndicator />
        </CollabSharingProvider>
      </VaultClientProvider>
    </React.StrictMode>,
  );
}

start();
