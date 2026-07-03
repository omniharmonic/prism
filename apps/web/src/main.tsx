import React from "react";
import ReactDOM from "react-dom/client";
import { App, VaultClientProvider, CollabSharingProvider, CollabDocumentProvider, PlatformProvider, initializeSettings, GovernancePanel } from "@prism/core";
import { httpVaultClient } from "./parachute/HttpVaultClient";
import { webCollabSharing } from "./collab/grant";
import { CollabDocument, useLiveCollab } from "./collab/CollabDocument";
import { fetchMe, initCapability } from "./config";
import { LoginScreen } from "./auth/LoginScreen";
import { RegisterScreen } from "./auth/RegisterScreen";
import { SetPasswordScreen } from "./auth/SetPasswordScreen";
import { ShareView } from "./share/ShareView";
import { PublicationView } from "./publish/PublicationView";
import { CollabPage } from "./collab/CollabPage";
import { BioregionPanel } from "./bioregion/BioregionPanel";
import { CommonsLanding } from "./commons/CommonsLanding";
import { CommonsNav } from "./commons/CommonsNav";
import { startOutboxSync } from "./offline/outbox";
import { OfflineIndicator } from "./offline/OfflineIndicator";
import { UpdatePrompt } from "./offline/UpdatePrompt";

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

  // Public published-site route: /p/:slug[/notes/:id]. Anonymous, read-only; no
  // session and no capability token — the gateway authorizes each /api/p read
  // server-side. Must be checked before the session/capability logic below.
  const pub = window.location.pathname.match(/^\/p\/([^/]+)(?:\/notes\/(.+))?$/);
  if (pub) {
    root.render(
      <React.StrictMode>
        <PublicationView slug={decodeURIComponent(pub[1])} noteId={pub[2] ? decodeURIComponent(pub[2]) : null} />
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

  // Commons governance surface: /governance. A signed-in member drives the
  // constitution + proposal lifecycle here (the API is /api/governance). Requires
  // a session; capability-link viewers are redirected to sign in.
  if (window.location.pathname === "/governance") {
    const me = await fetchMe();
    if (!me.authenticated) {
      root.render(
        <React.StrictMode>
          <LoginScreen notice="Sign in to access commons governance." />
        </React.StrictMode>,
      );
      return;
    }
    root.render(
      <React.StrictMode>
        <CommonsNav active="governance" />
        <GovernancePanel />
      </React.StrictMode>,
    );
    return;
  }

  // Commons landing: /commons — orientation + the two doors (requires a session).
  if (window.location.pathname === "/commons") {
    const me = await fetchMe();
    if (!me.authenticated) {
      root.render(
        <React.StrictMode>
          <LoginScreen notice="Sign in to enter the commons." />
        </React.StrictMode>,
      );
      return;
    }
    root.render(
      <React.StrictMode>
        <CommonsLanding />
      </React.StrictMode>,
    );
    return;
  }

  // Bioregional commons browse + map surface: /bioregion. Reads the graph through
  // the gateway (owner passthrough, or a member's granted slice); requires a session.
  if (window.location.pathname === "/bioregion") {
    const me = await fetchMe();
    if (!me.authenticated) {
      root.render(
        <React.StrictMode>
          <LoginScreen notice="Sign in to explore the bioregional commons." />
        </React.StrictMode>,
      );
      return;
    }
    root.render(
      <React.StrictMode>
        <BioregionPanel />
      </React.StrictMode>,
    );
    return;
  }

  // The owner setup wizard is Tauri-only (its steps call `invoke()`), so the web
  // shell skips it by DEFAULT for everyone — a capability viewer, an invited
  // non-owner, and even the owner (web setup is the desktop/CLI's job). The only
  // exception is an explicit opt-in for a future web-native owner flow.
  const allowOwnerOnboarding = import.meta.env.VITE_WEB_OWNER_ONBOARDING === "true";
  let isViewer = true;

  // Capability link (?t=): a recipient with no session. The token authorizes
  // gateway calls; they see only the shared notes. Share UI is hidden for them.
  // Capability viewers skip fetchMe entirely, so isViewer must stay true here.
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
    // Only a genuine owner, and only when explicitly opted in, sees onboarding.
    isViewer = !(allowOwnerOnboarding && me.isOwner);
  }

  startOutboxSync();
  root.render(
    <React.StrictMode>
      <PlatformProvider value="web">
        <VaultClientProvider client={httpVaultClient}>
          <CollabSharingProvider value={capability ? null : webCollabSharing}>
            <CollabDocumentProvider value={{ useLiveCollab, CollabDocument }}>
              <App skipOnboarding={isViewer} />
              <OfflineIndicator />
              <UpdatePrompt />
            </CollabDocumentProvider>
          </CollabSharingProvider>
        </VaultClientProvider>
      </PlatformProvider>
    </React.StrictMode>,
  );
}

void start();
