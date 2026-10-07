/**
 * The page half of the iOS app (WP5), over the shell's REAL host hook with a scripted IPC
 * (the spec injects apps/client/src-tauri/src/host.js with platform = "ios" before this runs):
 *
 *   ?view=setup     the first-run "Enter your server" screen (ServerSetupScreen)
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
import { fetchMe } from "../src/config";
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
