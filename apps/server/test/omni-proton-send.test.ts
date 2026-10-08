/**
 * Option B (Benjamin, 2026-10-08): approved emails run the agent repo's
 * scripts/proton_send.py --approved. Fake spawner — nothing is executed or sent.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { protonSendArgs, runProtonSend, setProtonSpawnerForTests, type Spawner } from "../src/omni/proton-send";
import { executorFor } from "../src/omni/approvals";

const SELF = "synergy@benjaminlife.one";
type Call = Parameters<Spawner>;
let calls: Call[];
let reply: Awaited<ReturnType<Spawner>>;

beforeEach(() => {
  calls = [];
  reply = { code: 0, signal: null, stdout: 'Sent to x\n{\n  "messageId": "<m1@x>"\n}\n', stderr: "", timedOut: false };
  setProtonSpawnerForTests(async (...a) => {
    calls.push(a);
    return reply;
  });
  process.env.OMNI_PROTON_SEND = process.execPath;
  process.env.SUPER_SECRET_TOKEN = "never-in-the-child";
});
afterEach(() => {
  setProtonSpawnerForTests(null);
  delete process.env.OMNI_PROTON_SEND;
  delete process.env.OMNI_EMAIL_EXECUTOR;
  delete process.env.SUPER_SECRET_TOKEN;
});

test("executor choice: proton-send by default, enabled only when OMNI_PROTON_SEND is an existing absolute path", () => {
  assert.deepEqual(executorFor("email"), { name: "proton-send", available: true, enabled: true });
  process.env.OMNI_PROTON_SEND = "relative/proton_send.py";
  assert.equal(executorFor("email-reply").enabled, false);
  process.env.OMNI_PROTON_SEND = "/nonexistent/proton_send.py";
  assert.equal(executorFor("email").enabled, false);
  process.env.OMNI_EMAIL_EXECUTOR = "live-actions";
  assert.equal(executorFor("email").name, "prism-live-actions:email");
  assert.equal(executorFor("email").enabled, config.actionsEmailEnabled);
});

test("argv: fixed flags, one element per value, --allow-external only for third parties", () => {
  const self = protonSendArgs("email", { to: [SELF], subject: "Note to self", body: "b" }, SELF)!;
  assert.deepEqual(self, ["send", "--approved", "--json", "--body-file", "-", "--subject", "Note to self", "--to", SELF]);
  const ext = protonSendArgs("email", { to: ["kevin@example.org"], cc: [SELF], subject: "Hi; rm -rf /", body: "b" }, SELF)!;
  assert.ok(ext.includes("--allow-external"));
  assert.equal(ext[ext.indexOf("--subject") + 1], "Hi; rm -rf /", "a value is one argv element, never a shell");
  const rep = protonSendArgs("email-reply", { noteId: "n1", expectTo: ["kevin@example.org"], body: "b" }, SELF)!;
  assert.deepEqual(rep.slice(5, 9), ["--reply-to-note", "n1", "--to", "kevin@example.org"], "the recipients on the card are sent explicitly");
  assert.equal(protonSendArgs("email", { to: [], subject: "s" }, SELF), null);
  assert.equal(protonSendArgs("tweet", { text: "x" }, SELF), null);
});

test("run: body on stdin, allowlisted env, cwd = agent repo root, messageId parsed", async () => {
  const out = await runProtonSend("email", { to: ["kevin@example.org"], subject: "S", body: "Plain body" });
  assert.equal(out.status, "sent");
  assert.equal(out.detail.messageId, "<m1@x>");
  const [, args, o] = calls[0]!;
  assert.equal(args[0], process.execPath);
  assert.equal(o.input, "Plain body");
  assert.ok(!("SUPER_SECRET_TOKEN" in o.env) && !("PROTON_SEND_ALLOW_EXTERNAL" in o.env), "no Prism env, no recipient policy from Prism");
  assert.ok(Object.keys(o.env).every((k) => ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TMPDIR", "TZ"].includes(k) || k.startsWith("LC_")));
});

test("outcomes: pre-socket refusals are failed; SMTP trouble, timeouts and signals are unknown", async () => {
  const p = { to: ["kevin@example.org"], subject: "S", body: "b" };
  for (const stderr of [
    "ERROR: Refusing to send: the body contains markdown, which Gmail renders literally.",
    "ERROR: --allow-external was passed but third-party outbound mail is switched OFF.",
    "ERROR: cannot reach Proton Bridge SMTP at 127.0.0.1:1025 (refused).",
    "ERROR: Bridge SMTP TLS fingerprint does not match the pin.",
  ]) {
    reply = { code: 1, signal: null, stdout: "", stderr, timedOut: false };
    assert.equal((await runProtonSend("email", p)).status, "failed", stderr);
  }
  reply = { code: 1, signal: null, stdout: "", stderr: "ERROR: Bridge refused the message: (451, b'later')", timedOut: false };
  assert.equal((await runProtonSend("email", p)).status, "unknown");
  reply = { code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true };
  const t = await runProtonSend("email", p);
  assert.equal(t.status, "unknown");
  assert.equal(t.detail.error, "timeout");
  delete process.env.OMNI_PROTON_SEND;
  assert.equal((await runProtonSend("email", p)).status, "disabled");
});
