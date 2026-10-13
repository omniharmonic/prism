// The first-run checklist on its own: a server whose steps a test finishes one at a time
// (`window.setupFixture.done(id)`), as an agent working through them would.
import "../../../packages/core/src/shell";
import { createRoot } from "react-dom/client";
import type { SetupStatus, SetupStep } from "../../../packages/core/src/data/CollabSharing";
import { SetupChecklist } from "../../../packages/core/src/components/renderers/network/SetupChecklist";

const params = new URLSearchParams(location.search);
if (params.has("dark")) { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); }
const steps: SetupStep[] = [
  { id: "server", group: "core", done: true },
  { id: "vault", group: "core", done: true },
  { id: "owner", group: "core", done: true },
  { id: "secrets", group: "core", done: false, detail: "SECRETS_KEY is not set, so no integration can be connected yet." },
  { id: "agent-token", group: "agent", done: false, detail: "No agent access token has been created." },
  { id: "agent-connected", group: "agent", done: false, detail: "Create an agent access token first." },
  { id: "reachable", group: "devices", done: false, detail: "This server answers on this computer only. A phone needs an https address (Tailscale or a Cloudflare tunnel)." },
  { id: "device", group: "devices", done: false, detail: "No app has signed in to this server yet." },
  { id: "email", group: "optional", done: false, detail: "Sign-in links and invitations are printed in the server log instead of being emailed." },
  { id: "integration:matrix", group: "optional", done: false },
  { id: "integration:fireflies", group: "optional", done: false },
];
const controls = {
  reads: 0,
  fail: false,
  copied: [] as string[],
  done(id: string) { const step = steps.find((s) => s.id === id); if (step) { step.done = true; delete step.detail; } },
};
Object.assign(window, { setupFixture: controls });
// The clipboard of a test page: keep what was written where the spec can read it.
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { controls.copied.push(text); } } });
const load = async (): Promise<SetupStatus> => {
  controls.reads++;
  if (controls.fail) throw new Error("fixture: unreachable");
  const now = steps.map((s) => ({ ...s }));
  return { ready: now.filter((s) => s.group === "core").every((s) => s.done), steps: now };
};
createRoot(document.getElementById("root")!).render(
  <main style={{ maxWidth: 640, margin: "0 auto", padding: 24, background: "var(--bg-base)", minHeight: "100vh" }}>
    <SetupChecklist load={load} origin="http://localhost:8787" intervalMs={300} />
  </main>,
);
