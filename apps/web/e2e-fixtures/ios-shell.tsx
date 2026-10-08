/**
 * The page half of the iOS app (WP5), over the shell's REAL host hook with a scripted IPC
 * (the spec injects apps/client/src-tauri/src/host.js with platform = "ios" before this runs):
 *
 *   ?view=setup     the first-run "Enter your server" screen (ServerSetupScreen)
 *   ?view=session   the sign-in gate as main.tsx decides it (fetchMe → the native sign-in
 *                   screen, "can't reach", or a stand-in for the signed-in workspace), with
 *                   the real transport exposed so a spec can make requests the way the app
 *                   does. The 401 / signed-out rules need the NATIVE transport: those cases
 *                   run when the fixture server was started with VITE_PRISM_NATIVE=1
 *                   (native-session.spec.ts); the rule itself is `npm run verify:session`.
 *   ?view=settings  Settings → Account's iOS section (IosAppSettings) + the notification
 *                   toggle (PushSettings over apnsPush), after the same boot wiring main.tsx
 *                   does for a signed-in person (fetchMe → initIosPush)
 *
 * Fictional data; the spec answers /auth/me and /api/push/* itself. This runs in the fixture
 * (PWA) transport, so requests carry no device bearer here — that the native transport adds
 * it is `npm run verify:native -w @prism/web`'s subject, and the routes' own tests.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { PushProvider, useUIStore } from "@prism/core/shell";
import { PushSettings } from "../../../packages/core/src/components/layout/PushSettings";
import { fetchMe, logout } from "../src/config";
import { isNative, serverFetch } from "../src/transport";
import { NativeSignInScreen } from "../src/auth/NativeSignInScreen";
import { ReconnectScreen } from "../src/auth/ReconnectScreen";
import { ServerSetupScreen } from "../src/native/ServerSetupScreen";
import { IosAppSettings } from "../src/native/IosAppSettings";
import { apnsPush, initIosPush } from "../src/native/apnsPush";

const view = new URLSearchParams(location.search).get("view");
const root = createRoot(document.getElementById("root")!);

Object.assign(window, {
  iosFixture: {
    /** What is open, in order: note ids / virtual tab ids. */
    tabs: () => useUIStore.getState().openTabs.map((t) => t.noteId),
    ready: false,
  },
});
const ready = () => { (window as unknown as { iosFixture: { ready: boolean } }).iosFixture.ready = true; };

if (view === "setup") {
  root.render(<React.StrictMode><ServerSetupScreen /></React.StrictMode>);
  ready();
} else if (view === "session") {
  void (async () => {
    const me = await fetchMe();
    Object.assign((window as unknown as { iosFixture: object }).iosFixture, {
      native: isNative,
      /** Status of a request made the way the app makes every request. */
      get: (path: string) => serverFetch(path).then((r) => r.status),
      me: () => fetchMe().then((m) => (m.unavailable ? "unavailable" : m.authenticated ? "in" : "out")),
      logout: () => logout(),
    });
    root.render(
      <React.StrictMode>
        {me.unavailable ? <ReconnectScreen /> : me.authenticated ? <main data-testid="workspace">Signed in as {me.email}</main> : <NativeSignInScreen />}
      </React.StrictMode>,
    );
    ready();
  })();
} else {
  void (async () => {
    await fetchMe(); // who is signed in decides whose notification choice is read
    initIosPush();
    root.render(
      <React.StrictMode>
        <main style={{ background: "var(--bg-base)", color: "var(--text-primary)", minHeight: "100dvh", padding: 16, maxWidth: 560 }}>
          <IosAppSettings />
          <PushProvider value={apnsPush}>
            <PushSettings />
          </PushProvider>
        </main>
      </React.StrictMode>,
    );
    ready();
  })();
}
