/**
 * "Open in the app" banner (decision D-H), mounted as `main.tsx` does for the PWA. The spec
 * serves this page AT `/page/<id>` (and other paths) so the module reads a real location.
 * `window.openInAppFixture` (set by the spec before load): `vault` stands in for the
 * signed-in vault (null = signed out), `capability` for a capability link in this tab.
 */
import "@prism/core/shell"; // design tokens, as in the app
import { mountOpenInAppBanner } from "../src/share/openInApp";

declare global {
  interface Window {
    openInAppFixture?: { vault?: string | null; capability?: boolean; mounted?: boolean };
  }
}

const f = (window.openInAppFixture ??= {});
const box = mountOpenInAppBanner({
  native: false,
  capability: !!f.capability,
  origin: location.origin,
  vault: () => window.openInAppFixture?.vault ?? null,
});
f.mounted = box !== null;
document.documentElement.dataset.fixtureReady = "1";
