import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED = "true"; process.env.OMNI_SERVICE_TOKEN = "test-service-secret-0123456789";
process.env.OMNI_HERMES_URL = "http://127.0.0.1:8642"; process.env.OMNI_HERMES_KEY = "test-hermes-key-0123456789";
import { config } from "../src/config";
import { resetDb } from "./helpers";
import { proposeApproval } from "../src/omni/propose";
import { ensureSourceSession } from "../src/omni/source-session";
import { resetOmniStoreForTests, eventsAfter, ensureThread, sha256 } from "../src/omni/store";
import { setOmniPusherForTests, subscribeNotices } from "../src/omni/bus";
import { approvalDigest } from "../src/omni/approvals";
import { createHermesStub } from "../scripts/lib/hermes-stub";
import { setHermesFetchForTests } from "../src/omni/hermes-client";

beforeEach(() => { resetDb(); resetOmniStoreForTests(); });

test("proposeApproval stores the draft, shows it in the thread and pushes only when asked", () => {
  const pushes: string[] = [];
  setOmniPusherForTests(async (_owner, kind, id) => { pushes.push(`${kind}:${id}`); });
  const notices: string[] = [];
  const off = subscribeNotices((n) => notices.push(`${n.type}:${n.op}`));
  try {
    ensureThread({ id: "omni_t1" });
    const payload = { roomId: "!hardware:example.org", body: "The review moved to Friday at 11." };
    const a = proposeApproval({ owner: config.ownerEmail, threadId: "omni_t1", kind: "message", payload, summary: "Tell the room", ttlMs: 60_000, actor: "hermes", via: "service-token", push: false });
    assert.equal(a.status, "pending");
    assert.equal(a.digest, approvalDigest("message", payload));
    assert.equal(eventsAfter("omni_t1", 0).filter((e) => e.payload.t === "approval").length, 1);
    assert.deepEqual(notices, ["approval:pending"]);
    assert.deepEqual(pushes, []);
    const b = proposeApproval({ owner: config.ownerEmail, threadId: null, kind: "message", payload, summary: null, ttlMs: 60_000, actor: "hermes", via: "service-token", push: true });
    assert.deepEqual(pushes, [`OMNI_APPROVAL:${b.id}`]);
  } finally { off(); setOmniPusherForTests(null); }
});

test("ensureSourceSession: one stable session per owner and source, recovered rather than duplicated", async () => {
  const stub = createHermesStub({ key: process.env.OMNI_HERMES_KEY! });
  setHermesFetchForTests(stub.fetch);
  try {
    const first = await ensureSourceSession(config.ownerEmail, "mail1", "Sam asks about the budget");
    const again = await ensureSourceSession(config.ownerEmail, "mail1", "Sam asks about the budget");
    assert.equal(first, `omni-proactive-${sha256(`${config.ownerEmail}:mail1`).slice(0, 32)}`);
    assert.equal(again, first);
    assert.equal(stub.sessions.size, 1);
    assert.equal(await ensureSourceSession(config.ownerEmail, "mail1", "Bound elsewhere", "omni_0123456789abcdef01234567"), "omni_0123456789abcdef01234567");
    assert.equal(stub.sessions.size, 2);
  } finally { setHermesFetchForTests(null); }
});
