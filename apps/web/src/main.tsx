import React from "react";
import ReactDOM from "react-dom/client";
import { App, VaultClientProvider, CollabSharingProvider, initializeSettings } from "@prism/core";
import { httpVaultClient } from "./parachute/HttpVaultClient";
import { webCollabSharing } from "./collab/grant";
import { fetchMe } from "./config";
import { LoginScreen } from "./auth/LoginScreen";
import { ShareView } from "./share/ShareView";
import { CollabPage } from "./collab/CollabPage";
import { startOutboxSync } from "./offline/outbox";
import { OfflineIndicator } from "./offline/OfflineIndicator";

// Importing `@prism/core` pulls in the global design system (tokens/glass/
// typography) as a side effect, so the login screen is styled too.

async function start() {
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

  // Real-time collaborative editing route: /collab/:id (CRDT). Capability link
  // in ?t= carries access — no session required.
  const collab = window.location.pathname.match(/^\/collab\/(.+)$/);
  if (collab) {
    root.render(
      <React.StrictMode>
        <CollabPage noteId={decodeURIComponent(collab[1])} />
      </React.StrictMode>,
    );
    return;
  }

  // Everything else requires a session. Ask the gateway who we are.
  const me = await fetchMe();
  if (!me.authenticated) {
    const reason = new URLSearchParams(window.location.search).get("login");
    const notice =
      reason === "expired"
        ? "That sign-in link expired or was already used. Request a new one."
        : reason === "error"
          ? "Something went wrong with that link. Try again."
          : undefined;
    root.render(
      <React.StrictMode>
        <LoginScreen notice={notice} />
      </React.StrictMode>,
    );
    return;
  }

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

void start();
