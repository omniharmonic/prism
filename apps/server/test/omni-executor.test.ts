/**
 * Omni approvals → the REAL live-action route, in process (createApp): the decider's own
 * credential reaches /api/actions/* so its gates (owner, family flag, human origin,
 * idempotency, action audit) apply unchanged. The Matrix client is faked; nothing leaves
 * the process.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
process.env.OMNI_ENABLED = "true";
process.env.OMNI_HERMES_KEY = "hermes-test-key-0123456789";
process.env.OMNI_SERVICE_TOKEN = "omni-service-token-0123456789";

import { config } from "../src/config";
import { createApp } from "../src/app";
import { db } from "../src/db";
import { putSecret } from "../src/secrets";
import { setMatrixActionClientForTests } from "../src/actions/matrix";
import { setOmniPusherForTests } from "../src/omni/bus";
import { resetOmniStoreForTests } from "../src/omni/store";
import { issueDeviceToken } from "../src/auth/device";
import { resetDb, makeSession, sessionCookie, installFakeVault, type FakeVault } from "./helpers";

const J = { "content-type": "application/json" };
const ROOM = "!room1:hs.example.test";
let sent: Array<{ roomId: string; txnId: string; content: Record<string, unknown> }>;
let fv: FakeVault;
const app = createApp();

beforeEach(() => {
  resetDb();
  resetOmniStoreForTests();
  fv = installFakeVault();
  sent = [];
  setOmniPusherForTests(async () => {});
  setMatrixActionClientForTests(() => ({
    async sendEvent(roomId: string, _type: string, txnId: string, content: Record<string, unknown>) {
      sent.push({ roomId, txnId, content });
      return `$ev${sent.length}`;
    },
    async joinedRooms() {
      return [ROOM];
    },
  }));
  putSecret("primary", config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://hs.example.test", accessToken: "stub-matrix-token" }));
  Object.assign(config, { actionsMatrixEnabled: false });
});
after(() => {
  fv?.restore();
  setMatrixActionClientForTests(null);
  setOmniPusherForTests(null);
});

async function propose(): Promise<{ id: string; digest: string }> {
  const r = await app.request("/api/omni/hooks/propose", {
    method: "POST",
    headers: { ...J, authorization: `Bearer ${process.env.OMNI_SERVICE_TOKEN}` },
    body: JSON.stringify({ kind: "message", payload: { roomId: ROOM, body: "On my way" } }),
  });
  assert.equal(r.status, 201);
  return (await r.json()) as { id: string; digest: string };
}
const decide = (id: string, digest: string, headers: Record<string, string>, k: string) =>
  app.request(`/api/omni/approvals/${id}/decision`, { method: "POST", headers: { ...J, ...headers, "idempotency-key": k }, body: JSON.stringify({ decision: "send", digest }) });

test("flag off: executor_disabled, the live action is never called, the approval stays pending", async () => {
  const p = await propose();
  const r = await decide(p.id, p.digest, { cookie: sessionCookie(makeSession(config.ownerEmail)) }, "omni-exec-key-0001");
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, "executor_disabled");
  assert.equal(sent.length, 0);
  assert.equal((db.prepare("SELECT count(*) n FROM action_audit").get() as { n: number }).n, 0);
});

test("flag on: a device-token decision sends once through /api/actions/matrix/send as a HUMAN, keyed by the approval id", async () => {
  Object.assign(config, { actionsMatrixEnabled: true });
  const p = await propose();
  const dev = issueDeviceToken(config.ownerEmail, "Omni (iPhone)", "omni-native").token;
  const r = await decide(p.id, p.digest, { authorization: `Bearer ${dev}` }, "omni-exec-key-0002");
  assert.equal(r.status, 200, await r.clone().text());
  const j = (await r.json()) as { approval: { status: string; result: Record<string, unknown> } };
  assert.equal(j.approval.status, "sent");
  assert.equal(j.approval.result.eventId, "$ev1");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.content, { msgtype: "m.text", body: "On my way" });
  const audit = db.prepare("SELECT action, via, origin, status, idempotency_key FROM action_audit").all() as Array<Record<string, unknown>>;
  assert.deepEqual(audit, [{ action: "matrix.send", via: "device", origin: "human", status: "ok", idempotency_key: `omni-${p.id}` }]);
  // A second tap with a new key cannot send again.
  const again = await decide(p.id, p.digest, { authorization: `Bearer ${dev}` }, "omni-exec-key-0003");
  assert.equal(again.status, 409);
  assert.equal(sent.length, 1);
});
