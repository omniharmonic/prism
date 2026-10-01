import React from "react";
import ReactDOM from "react-dom/client";
import { App, PushProvider, VaultClientProvider, CollabSharingProvider, CollabDocumentProvider, AccountProvider, PlatformProvider, AgentClientProvider, LiveActionsProvider, HostServicesProvider, InvalidationSourceProvider, initializeSettings, GovernancePanel, useAgentChatStore, useUIStore, AGENT_CHAT_TAB, openAgentChat, type InitialTab } from "@prism/core";
import { webAccount } from "./account";
import { httpVaultClient } from "./parachute/HttpVaultClient";
import { httpAgentClient } from "./agent/HttpAgentClient";
import { httpLiveActionsClient } from "./actions/HttpLiveActionsClient";
import { httpHostServices } from "./host/HttpHostServices";
import { httpInvalidationSource } from "./events/httpInvalidationSource";
import { webCollabSharing } from "./collab/grant";
import { CollabDocument, useLiveCollab } from "./collab/CollabDocument";
import { fetchMe, initCapability, isOwner, postLoginTarget } from "./config";
import { ReconnectScreen } from "./auth/ReconnectScreen";
import { LoginScreen as WebLoginScreen } from "./auth/LoginScreen";
import { NativeSignInScreen, NativeStartupScreen } from "./auth/NativeSignInScreen";
import { isNative, serverFetch, gatewayOrigin, initializeTransport, getDeviceToken } from "./transport";
import { RegisterScreen } from "./auth/RegisterScreen";
import { SetPasswordScreen } from "./auth/SetPasswordScreen";
import { ShareView } from "./share/ShareView";
import { PublicationView } from "./publish/PublicationView";
import { CollabPage } from "./collab/CollabPage";
import { CommonsLanding } from "./commons/CommonsLanding";
import { CommonsNav } from "./commons/CommonsNav";
import { clearLegacyApiCache } from "./offline/readCache";
import { startOutboxSync } from "./offline/outbox";
import { OfflineIndicator } from "./offline/OfflineIndicator";
import { UpdatePrompt } from "./offline/UpdatePrompt";
import { webPush } from "./push/webPush";
import { initAgentDeepLink } from "./push/deeplink";
import { initNativeExtras } from "./native/extras";
import { installExternalImageProxy } from "./native/externalImages";

// Native shell: no password/magic-link form — the host runs the device-token flow.
const SignInScreen = isNative ? NativeSignInScreen : WebLoginScreen;

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

export async function start() {
  initializeTransport();
  await clearLegacyApiCache();
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

  // The first Keychain read can wait for an OS prompt after a local rebuild.
  // Keep that wait distinct from the following network request; do not start
  // another sign-in or discard the existing credential while approval is pending.
  if (isNative && !capability) {
    root.render(<NativeStartupScreen phase="credentials" />);
    await getDeviceToken();
    root.render(<NativeStartupScreen phase="connecting" />);
  }

  // Commons governance surface: /governance. A signed-in member drives the
  // constitution + proposal lifecycle here (the API is /api/governance). Requires
  // a session; capability-link viewers are redirected to sign in.
  if (window.location.pathname === "/governance") {
    const me = await fetchMe();
    if (me.unavailable) { root.render(<ReconnectScreen />); return; }
    if (!me.authenticated) {
      root.render(
        <React.StrictMode>
          <SignInScreen notice="Sign in to access commons governance." />
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
    if (me.unavailable) { root.render(<ReconnectScreen />); return; }
    if (!me.authenticated) {
      root.render(
        <React.StrictMode>
          <SignInScreen notice="Sign in to enter the commons." />
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

  // Geospatial surface deep-links: /map (and the legacy /bioregion alias) boot the
  // real Prism app straight into the Map tab — a vault-wide MapLibre view where
  // every located note appears and clicking one opens it for editing. This is the
  // integrated replacement for the old standalone /bioregion panel: the map is a
  // lens over the vault, sharing the same tabs/search/renderers as everything else.
  const path = window.location.pathname;
  // /agent[/<sessionId>] opens the Agent chat (WP3.2; the push deep link of WP3.3).
  // A client route: the SW denylist stays /api/* + /auth/*.
  const agentLink = path.match(/^\/agent(?:\/([0-9a-f-]{36}))?\/?$/i);
  const initialTab: InitialTab | undefined =
    path === "/map" || path === "/bioregion"
      ? { id: "map", title: "Map", type: "map" }
      : agentLink
        ? { id: AGENT_CHAT_TAB, title: "Agent chat", type: AGENT_CHAT_TAB }
        : undefined;

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
    if (me.unavailable) { root.render(<ReconnectScreen />); return; }
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
          <SignInScreen notice={notice} />
        </React.StrictMode>,
      );
      return;
    }
    // Already signed in but bounced here by a native sign-in (?next=…): resume it.
    const resume = postLoginTarget();
    if (resume) {
      window.location.replace(resume);
      return;
    }
    // Only a genuine owner, and only when explicitly opted in, sees onboarding.
    isViewer = !(allowOwnerOnboarding && me.isOwner);
  }

  if (!capability && agentLink?.[1]) useAgentChatStore.getState().setActiveSession(agentLink[1]);
  window.addEventListener("prism:vault-changed", () => { void fetchMe(); });
  window.addEventListener("prism:offline-note-resolved", (event) => {
    const { temporaryId, noteId } = (event as CustomEvent<{ temporaryId: string; noteId: string }>).detail;
    // Keep tab IDs/history stable; only its resource identity changes.
    useUIStore.setState((state) => ({
      openTabs: state.openTabs.map((tab) => tab.noteId === temporaryId ? { ...tab, noteId } : tab),
    }));
  });
  startOutboxSync();
  if (!capability && isNative) initNativeExtras(); // WP4.2: export + drag-drop (page half)
  // Client parity C: external note images via the server's SSRF-guarded proxy
  // (blob: URLs; the client CSP only allows its own server). PWA loads directly.
  if (!capability && isNative) installExternalImageProxy({ fetch: serverFetch, apiOrigin: gatewayOrigin });
  if (!capability) {
    initAgentDeepLink(); // push notification → /agent/:id (WP3.3); cold start is handled by agentLink above
    // Warm start: the app is already open when a notification is tapped — the SW
    // posts the id, deeplink.ts re-dispatches it; switch the chat to it and open the tab.
    window.addEventListener("prism:open-agent-session", (e) => {
      const id = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!id) return;
      openAgentChat({ sessionId: id });
    });
  }
  // Web Push (WP3.3) is a PWA + server-owner feature; native (APNs) comes with WP5.3.
  const pushClient = !capability && !isNative && isOwner() ? webPush : null;
  root.render(
    <React.StrictMode>
      <PlatformProvider value="web">
        <VaultClientProvider client={httpVaultClient}>
          <CollabSharingProvider value={capability ? null : webCollabSharing}>
            <AccountProvider value={capability ? null : webAccount}>
              <CollabDocumentProvider value={{ useLiveCollab, CollabDocument }}>
                <PushProvider value={pushClient}>
                {/* Server agent sessions (WP3.2). Owner-only server-side; the UI
                    probes and hides itself on 403. None for capability viewers. */}
                <InvalidationSourceProvider source={httpInvalidationSource}>
                <AgentClientProvider client={capability ? null : httpAgentClient}>
                  {/* Live actions (WP1.5): server-owner only; components probe
                      GET /api/actions and keep their old path on 403/off. */}
                  <LiveActionsProvider client={capability ? null : httpLiveActionsClient}>
                  {/* Host services (WP4.3): the server-side replacements for the
                      legacy desktop's host commands. Server owner only. */}
                  <HostServicesProvider client={!capability && isOwner() ? httpHostServices : null}>
                  <App skipOnboarding={isViewer} initialTab={initialTab} />
                  </HostServicesProvider>
                  </LiveActionsProvider>
                </AgentClientProvider>
                </InvalidationSourceProvider>
                <OfflineIndicator />
                {!isNative && <UpdatePrompt />}
                </PushProvider>
              </CollabDocumentProvider>
            </AccountProvider>
          </CollabSharingProvider>
        </VaultClientProvider>
      </PlatformProvider>
    </React.StrictMode>,
  );
}
