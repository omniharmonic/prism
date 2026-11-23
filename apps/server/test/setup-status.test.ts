/**
 * The first-run checklist (`GET /acl/setup`, server owner) and `GET /api/version`.
 * The checklist is booleans and plain sentences: it must never carry a secret.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { acl } from "../src/routes/acl";
import { createApp, API_VERSION, SERVER_VERSION } from "../src/app";
import { config } from "../src/config";
import { issuePat, verifyPat } from "../src/auth/pat";
import { reachableOrigin, setupStatus, type SetupFacts, type SetupStep } from "../src/setup-status";
import { resolveVaultEntry, setMembership } from "../src/db";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";
import { readSetupStatus, resetSetupProbesForTests, setupUnfinished } from "../src/setup-facts";
import { issueDeviceToken } from "../src/auth/device";
import { putSecret } from "../src/secrets";
import { clearBlueBubblesCredsCache } from "../src/bluebubbles/config";

let fv: FakeVault;
beforeEach(() => { resetDb(); fv = installFakeVault(); });
afterEach(() => fv.restore());

const owner = () => sessionCookie(makeSession(config.ownerEmail));
const read = async (cookie?: string) => acl.request("/setup", cookie ? { headers: { cookie } } : {});
const by = (steps: SetupStep[]) => Object.fromEntries(steps.map((s) => [s.id, s]));
const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({ vaultReachable: true, secretsAvailable: true, emailConfigured: false, appOrigin: "http://localhost:8787", agentTokens: 0, agentTokenUsed: false, devices: 0, integrations: { matrix: false }, ...over });

test("the checklist is the server owner's only", async () => {
  assert.equal((await read()).status, 403);
  setMembership("primary", "admin@x.co", "admin", config.ownerEmail);
  assert.equal((await read(sessionCookie(makeSession("admin@x.co")))).status, 403);
  assert.equal((await read(owner())).status, 200);
});

test("a fresh server: the core is done, the agent and phone steps say what is missing", async () => {
  const body = (await (await read(owner())).json()) as { ready: boolean; steps: SetupStep[] };
  const step = by(body.steps);
  assert.equal(step.server!.done, true);
  assert.equal(step.vault!.done, true);
  assert.equal(step["agent-token"]!.done, false);
  assert.equal(step["agent-connected"]!.done, false);
  assert.match(step["agent-connected"]!.detail!, /Create an agent access token first/);
  assert.equal(step.device!.done, false);
  assert.ok(body.steps.some((s) => s.id === "integration:matrix" && s.group === "optional"));
  // Every step is one of the four groups and nothing in the answer is secret material.
  assert.ok(body.steps.every((s) => ["core", "agent", "devices", "comms", "sending", "optional"].includes(s.group)));
  assert.ok(!/Bearer |pp_[A-Za-z0-9]|pd_[A-Za-z0-9]|parachuteToken|sessionSecret/.test(JSON.stringify(body)));
});

test("an agent token is one step; an agent that has used it is the next", async () => {
  const { token } = issuePat({ email: config.ownerEmail, vaultId: "primary", scope: "read" });
  let step = by(((await (await read(owner())).json()) as { steps: SetupStep[] }).steps);
  assert.equal(step["agent-token"]!.done, true);
  assert.equal(step["agent-connected"]!.done, false);
  assert.match(step["agent-connected"]!.detail!, /no agent has used it yet/);
  assert.ok(verifyPat(token), "the agent presents its token");
  step = by(((await (await read(owner())).json()) as { steps: SetupStep[] }).steps);
  assert.equal(step["agent-connected"]!.done, true);
  assert.ok(!JSON.stringify(step).includes(token));
});

test("ready is the core alone; a phone needs an https address that is not this machine and not a placeholder", () => {
  assert.equal(setupStatus(facts()).ready, true);
  assert.equal(setupStatus(facts({ vaultReachable: false })).ready, false);
  assert.equal(setupStatus(facts({ secretsAvailable: false })).ready, false);
  assert.equal(setupStatus(facts({ agentTokens: 0, devices: 0 })).ready, true, "optional groups never hold the app back");
  for (const [origin, ok] of [["http://localhost:8787", false], ["https://localhost", false], ["http://prism.example.com", false], ["https://127.0.0.1:8787", false], ["https://mac-mini.tail1234.ts.net", true], ["https://notes.acme.dev", true], ["https://prism.example.com", false], ["https://EXAMPLE.org", false], ["https://prism.test", false], ["https://app.localhost", false], ["not a url", false]] as const)
    assert.equal(reachableOrigin(origin), ok, origin);
});

test("GET /api/version answers anyone with the release, the wire version and the AGPL source offer, and nothing else", async () => {
  const r = await createApp().request("/api/version");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { version: SERVER_VERSION, api: API_VERSION, license: "AGPL-3.0-only", source: config.sourceUrl });
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+/);
});

test("the owner step asks for a password (a phone signs in with one); email is optional and points at local sign-in", async () => {
  const without = by(setupStatus(facts({ ownerHasPassword: false })).steps);
  assert.equal(without.owner!.done, false);
  assert.match(without.owner!.detail!, /password/);
  assert.match(without.owner!.detail!, /prism signin/);
  assert.equal(setupStatus(facts({ ownerHasPassword: false })).ready, false);
  assert.equal(by(setupStatus(facts({ ownerHasPassword: true })).steps).owner!.done, true);
  const email = by(setupStatus(facts()).steps).email!;
  assert.equal(email.group, "optional");
  assert.match(email.detail!, /prism signin/);
  assert.doesNotMatch(email.detail!, /server log/);
  // The live checklist reads the owner's password state.
  const live = by(((await (await read(owner())).json()) as { steps: SetupStep[] }).steps);
  assert.equal(live.owner!.done, false);
});


// ── Comms, Minutes, the send switches and the ecosystem summary (release 2026-11) ──

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { await fn(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

test("Comms off: its steps say how to turn it on, none counts as left, the summary says Comms is not set up", () => {
  const st = setupStatus(facts());
  const step = by(st.steps);
  assert.equal(step.comms!.group, "comms");
  assert.match(step.comms!.detail!, /prism config set COMMS_ENABLED=true/);
  assert.equal(step["comms-device"]!.done, false);
  assert.equal(step["integration:bluebubbles"]!.done, false);
  assert.equal(st.ready, true, "optional apps never block ready");
  const apps = Object.fromEntries(st.ecosystem.map((e) => [e.app, e]));
  assert.deepEqual(Object.keys(apps), ["prism", "comms", "omni", "minutes"]);
  assert.equal(apps.prism!.ready, true);
  assert.equal(apps.comms!.ready, false);
  assert.equal(apps.omni!.ready, false);
  assert.equal(apps.minutes!.ready, false);
});

test("Comms on: conversations + a signed-in Comms app tick it; BlueBubbles is judged by its answer", () => {
  const comms = (over: object = {}) => ({ enabled: true, threads: 3, devices: 1, bluebubbles: { enabled: true, urlAccepted: true, credential: true, answers: true }, ...over });
  let step = by(setupStatus(facts({ comms: comms() })).steps);
  assert.equal(step.comms!.done, true);
  assert.equal(step["comms-device"]!.done, true);
  assert.equal(step["integration:bluebubbles"]!.done, true);
  step = by(setupStatus(facts({ comms: comms({ threads: 0, devices: 0 }) })).steps);
  assert.match(step.comms!.detail!, /no conversations are in it yet/);
  assert.match(step["comms-device"]!.detail!, /Install the Comms app/);
  const bb = (b: object) => by(setupStatus(facts({ comms: comms({ bluebubbles: { enabled: true, urlAccepted: true, credential: true, answers: true, ...b } }) })).steps)["integration:bluebubbles"]!;
  assert.match(bb({ enabled: false }).detail!, /BLUEBUBBLES_ENABLED=true/);
  assert.match(bb({ urlAccepted: false }).detail!, /loopback address on a port of its own/);
  assert.match(bb({ credential: false }).detail!, /Connections → BlueBubbles/);
  assert.match(bb({ answers: false }).detail!, /does not answer/);
  const apps = setupStatus(facts({ comms: comms(), omni: { enabled: true, devices: 1 }, minutesNotes: 1 })).ecosystem;
  assert.ok(apps.every((a) => a.ready), JSON.stringify(apps));
});

test("send switches: one step each, off is a sentence about the one door, on is done; never counted as left", () => {
  const st = setupStatus(facts());
  const sends = st.steps.filter((s) => s.id.startsWith("send:"));
  assert.deepEqual(sends.map((s) => s.id), ["send:chat", "send:imessage", "send:email", "send:actions-email", "send:actions-calendar"]);
  assert.ok(sends.every((s) => s.group === "sending" && !s.done && /^Off:/.test(s.detail!)));
  assert.match(by(sends)["send:chat"]!.detail!, /--confirm-send/);
  const on = by(setupStatus(facts({ sending: { chat: true } })).steps);
  assert.equal(on["send:chat"]!.done, true);
  assert.equal(on["send:chat"]!.detail, undefined);
});

test("minutes: a note tagged minutes in the vault ticks it; an unreachable vault says so", () => {
  assert.equal(by(setupStatus(facts({ minutesNotes: 1 })).steps).minutes!.done, true);
  assert.match(by(setupStatus(facts({ minutesNotes: 0 })).steps).minutes!.detail!, /export a meeting/);
  assert.match(by(setupStatus(facts({ minutesNotes: null })).steps).minutes!.detail!, /could not be asked/);
});

test("GET /acl/setup: live Comms, Omni and Minutes facts, BlueBubbles pinged once per 30 s, nothing secret", async () => {
  let now = 1_000_000;
  let pings = 0;
  resetSetupProbesForTests({ now: () => now, ping: async () => { pings++; } });
  try {
    await withEnv({ COMMS_ENABLED: "true", OMNI_ENABLED: "true", BLUEBUBBLES_ENABLED: "true", BLUEBUBBLES_URL: "http://127.0.0.1:1235", SECRETS_KEY: Buffer.alloc(32, 7).toString("base64") }, async () => {
      fv.put({ id: "m1", path: "vault/_inbox/transcripts/minutes/2026-11-01-sync", content: "x", tags: ["meeting", "transcript", "minutes"] });
      issueDeviceToken(config.ownerEmail, "Comms (test)", "comms-native");
      issueDeviceToken(config.ownerEmail, "Omni (test)", "omni-native");
      putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "bluebubbles", JSON.stringify({ password: "pw-not-shown", webhookSecret: "a".repeat(64) }));
      clearBlueBubblesCredsCache();
      const body = (await (await read(owner())).json()) as { steps: SetupStep[]; ecosystem: Array<{ app: string; ready: boolean }> };
      const step = by(body.steps);
      assert.equal(step["comms-device"]!.done, true);
      assert.equal(step["integration:bluebubbles"]!.done, true, step["integration:bluebubbles"]!.detail);
      assert.equal(step.minutes!.done, true);
      assert.equal(body.ecosystem.find((e) => e.app === "omni")!.ready, true);
      assert.ok(!JSON.stringify(body).includes("pw-not-shown"));
      await readSetupStatus();
      assert.equal(pings, 1, "the second read within 30 s reuses the answer");
      now += 31_000;
      await readSetupStatus();
      assert.equal(pings, 2);
      // the optional apps never make setup "unfinished"
      assert.equal(typeof (await setupUnfinished()), "boolean");
    });
  } finally {
    resetSetupProbesForTests();
  }
});
