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
import { setMembership } from "../src/db";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

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
  assert.ok(body.steps.every((s) => ["core", "agent", "devices", "optional"].includes(s.group)));
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

test("GET /api/version answers anyone with the release and the wire version, and nothing else", async () => {
  const r = await createApp().request("/api/version");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { version: SERVER_VERSION, api: API_VERSION });
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
