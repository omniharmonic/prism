import React from "react";
import ReactDOM from "react-dom/client";
import { App, VaultClientProvider, CollabSharingProvider, CollabDocumentProvider, initializeSettings } from "@prism/core";
import { httpVaultClient } from "./parachute/HttpVaultClient";
import { webCollabSharing } from "./collab/grant";
import { CollabDocument, useLiveCollab } from "./collab/CollabDocument";
import { fetchMe, initCapability } from "./config";
import { LoginScreen } from "./auth/LoginScreen";
import { RegisterScreen } from "./auth/RegisterScreen";
import { SetPasswordScreen } from "./auth/SetPasswordScreen";
import { ShareView } from "./share/ShareView";
import { CollabPage } from "./collab/CollabPage";
import { startOutboxSync } from "./offline/outbox";
import { OfflineIndicator } from "./offline/OfflineIndicator";

// Importing `@prism/core` pulls in the global design system (tokens/glass/
// typography) as a side effect, so the login screen is styled too.

// Self-heal after a deploy: when a lazily-imported chunk fails to load (its
// hashed filename changed in a new build, so the old one 404s / the SPA fallback
// hands back index.html), drop the stale service worker + caches and reload once
// to fetch the fresh build. Guarded so it can never loop.
window.addEventListener("vite:preloadError", () => {
  const KEY = "prism:chunk-reload-at";
  const last = Number(sessionStorage.getItem(KEY) || "0");
  if (Date.now() - last < 15000) return; // already recovered very recently — don't loop
  sessionStorage.setItem(KEY, String(Date.now()));
  void (async () => {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = (await caches?.keys?.()) ?? [];
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* best-effort cache bust */
    }
    window.location.reload();
  })();
});

async function start() {
  initializeSettings();
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

  // Capture a ?t= capability token early so every route (incl. /collab) can use
  // it — a share/collab link is the recipient's only credential.
  const capability = initCapability();

  // Accept-invite route: create an account from an owner-issued invite link.
  if (window.location.pathname === "/accept-invite") {
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    root.render(
      <React.StrictMode>
        <RegisterScreen token={token} />
      </React.StrictMode>,
    );
    return;
  }

  // Set/replace your password (owner bootstrap, or anyone wanting password login).
  if (window.location.pathname === "/set-password") {
    root.render(
      <React.StrictMode>
        <SetPasswordScreen />
      </React.StrictMode>,
    );
    return;
  }

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
    // CollabCanvas (and the note-card drawer) use the VaultClient seam, so the
    // share route must provide it too — without this the canvas editor throws on
    // mount and the page goes blank (document/code/sheet don't hit the seam).
    root.render(
      <React.StrictMode>
        <VaultClientProvider client={httpVaultClient}>
          <CollabPage noteId={decodeURIComponent(collab[1])} />
        </VaultClientProvider>
      </React.StrictMode>,
    );
    return;
  }

  // Capability link (?t=): a recipient with no session. The token authorizes
  // gateway calls; they see only the shared notes. Share UI is hidden for them.
  if (!capability) {
    // Otherwise a session is required. Ask the gateway who we are.
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
  }

  startOutboxSync();
  root.render(
    <React.StrictMode>
      <VaultClientProvider client={httpVaultClient}>
        <CollabSharingProvider value={capability ? null : webCollabSharing}>
          <CollabDocumentProvider value={{ useLiveCollab, CollabDocument }}>
            <App />
            <OfflineIndicator />
          </CollabDocumentProvider>
        </CollabSharingProvider>
      </VaultClientProvider>
    </React.StrictMode>,
  );
}

void start();
