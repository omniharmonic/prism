// The first-run checklist on its own: a server whose steps a test finishes one at a time
// (`window.setupFixture.done(id)`), as an agent working through them would.
// `?pairing` adds a fake of /auth/pair/* (`window.pairingFixture`): the test plays the phone.
import "../../../packages/core/src/shell";
import { createRoot } from "react-dom/client";
import type { DevicePairingClient, DevicePairingView, SetupStatus, SetupStep } from "../../../packages/core/src/data/CollabSharing";
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
  { id: "email", group: "optional", done: false, detail: "Optional. Without it you sign in on this computer with `prism signin`, and invitations are links you copy and send yourself." },
  { id: "integration:matrix", group: "optional", done: false },
  { id: "integration:fireflies", group: "optional", done: false },
];
const controls = {
  reads: 0,
  fail: false,
  copied: [] as string[],
  done(id: string) { const step = steps.find((s) => s.id === id); if (step) { step.done = true; delete step.detail; } },
};
if (params.has("reachable")) controls.done("reachable");

// The real server's rules are pinned in apps/server/test/pairing.test.ts; this fake only
// answers like it so the dialog's states can be walked.
type Current = { id: string; status: DevicePairingView["status"]; label?: string; checkCode?: string };
const pairing = {
  starts: 0,
  denied: [] as string[],
  approved: [] as Array<{ id: string; checkCode?: string }>,
  failStart: "",
  current: null as Current | null,
  /** The phone scanned the code (it shows `checkCode`). */
  claim(label = "Sam's iPhone", checkCode = "4719") { if (pairing.current) Object.assign(pairing.current, { status: "claimed", label, checkCode }); },
  /** The server ended it (expired, contested, …). */
  end(status: DevicePairingView["status"]) { if (pairing.current) pairing.current.status = status; },
};
const fail = (code: string) => Object.assign(new Error(code), { code });
const pairingClient: DevicePairingClient = {
  async start() {
    pairing.starts++;
    if (pairing.failStart) throw fail(pairing.failStart);
    const id = `pair_${pairing.starts}`;
    pairing.current = { id, status: "pending" };
    return { pairingId: id, link: "prism://pair?v=1&s=https%3A%2F%2Fprism.tail1234.ts.net&c=AbCdEfGhIjKlMnOpQrStUv", origin: "https://prism.tail1234.ts.net", expiresAt: Date.now() + 300_000, approveNeedsDevice: params.has("devicefirst") };
  },
  async get(id) {
    const c = pairing.current;
    if (!c || c.id !== id) return { id, status: "replaced", expiresAt: 0, approveNeedsDevice: false };
    return { id, status: c.status, expiresAt: 0, approveNeedsDevice: params.has("devicefirst"), ...(c.label && c.status !== "pending" ? { label: c.label, platform: "ios" } : {}) };
  },
  async decide(id, decision, checkCode) {
    const c = pairing.current;
    if (decision === "deny") {
      pairing.denied.push(id);
      if (c && c.id === id && ["pending", "claimed", "approved"].includes(c.status)) c.status = "denied";
      return;
    }
    if (params.has("devicefirst")) throw fail("device_required");
    if (!c || c.status !== "claimed") throw fail("not_claimed");
    pairing.approved.push({ id, checkCode });
    if (checkCode !== c.checkCode) throw fail("wrong_check_code");
    // The phone redeems its device token on its next poll.
    c.status = "completed";
    controls.done("device");
  },
};

Object.assign(window, { setupFixture: controls, pairingFixture: pairing });
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
    <SetupChecklist load={load} origin="http://localhost:8787" intervalMs={300} pairing={params.has("pairing") ? pairingClient : undefined} />
  </main>,
);
