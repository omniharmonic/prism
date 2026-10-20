import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import {
  resetDb,
  installFakeVault,
  grantUser,
  makeSession,
  sessionCookie,
  type FakeVault,
} from "./helpers";
import { config } from "../src/config";
import { addVaultEntry, addGrant, db } from "../src/db";
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());
const person = (id: string, extra = {}) => ({
  id,
  path: `People/${id}`,
  content: "PRIVATE_BODY",
  tags: ["person", "team"],
  metadata: { name: "Same Name", channels: { email: [id + "@example.test"] } },
  ...extra,
});
const req = (path: string, email = config.ownerEmail, vault = "primary") =>
  createApp().request(path, {
    headers: {
      cookie: sessionCookie(makeSession(email)),
      "X-Prism-Vault": vault,
    },
  });
test("people preserve separate canonical identities and project no bodies", async () => {
  fv.put(person("a"));
  fv.put(person("b"));
  const response = await req("/api/people");
  assert.equal(response.status, 200);
  const data = (await response.json()) as any;
  assert.deepEqual(
    data.people.map((p: any) => p.id),
    ["a", "b"],
  );
  assert.equal(data.people[0].name, data.people[1].name);
  assert.ok(!JSON.stringify(data).includes("PRIVATE_BODY"));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(
    (
      (await (await req("/api/people?q=b%40example.test")).json()) as any
    ).people.map((p: any) => p.id),
    ["b"],
  );
  assert.ok(!fv.calls.some((c) => c.search.includes("include_content=true")));
});
test("people and related records check both endpoints and live revocation", async () => {
  fv.put(
    person("a", {
      links: [
        { sourceId: "mail", targetId: "a", relationship: "email_from" },
        { sourceId: "hidden", targetId: "a", relationship: "knows" },
      ],
    }),
  );
  fv.put(person("secret", { tags: ["person", "secret"] }));
  fv.put({
    id: "mail",
    path: "Mail/Conversation",
    content: "MESSAGE_BODY",
    tags: ["team", "email"],
    metadata: { title: "Visible conversation" },
  });
  fv.put({
    id: "hidden",
    path: "Private/Hidden title",
    content: "HIDDEN_BODY",
    tags: ["secret"],
  });
  grantUser("reader@test.local", "tag", "team", "view");
  const data = (await (
    await req("/api/people/a", "reader@test.local")
  ).json()) as any;
  assert.deepEqual(
    data.related.map((n: any) => [n.id, n.category, n.relationships]),
    [["mail", "conversations", ["email_from"]]],
  );
  assert.equal(data.next, null);
  assert.ok(
    !/HIDDEN|hidden|MESSAGE_BODY|PRIVATE_BODY|total/.test(JSON.stringify(data)),
  );
  assert.deepEqual(
    (
      (await (await req("/api/people", "reader@test.local")).json()) as any
    ).people.map((p: any) => p.id),
    ["a"],
  );
  db.prepare("DELETE FROM grants").run();
  assert.equal((await req("/api/people/a", "reader@test.local")).status, 404);
  assert.equal(
    (await req("/api/people/missing", "reader@test.local")).status,
    404,
  );
});
test("directory pages use visible stable IDs and respect selected vaults", async () => {
  for (let i = 0; i < 56; i++) fv.put(person(String(i).padStart(3, "0")));
  const first = (await (await req("/api/people")).json()) as any;
  assert.equal(first.people.length, 50);
  assert.equal(first.next, "049");
  const second = (await (
    await req("/api/people?after=" + first.next)
  ).json()) as any;
  assert.equal(second.people.length, 6);
  assert.equal(second.next, null);
  addVaultEntry({
    id: "team-b",
    label: "B",
    url: "http://vault.test",
    vault: "team-b",
    token: "t",
  });
  fv.putIn("team-b", person("other"));
  addGrant({
    vault_id: "team-b",
    subject_type: "user",
    subject: "other@test.local",
    resource_type: "tag",
    resource: "team",
    level: "view",
    created_by: config.ownerEmail,
  });
  const isolated = (await (
    await req("/api/people", "other@test.local", "team-b")
  ).json()) as any;
  assert.deepEqual(
    isolated.people.map((p: any) => p.id),
    ["other"],
  );
  assert.equal(
    (await req("/api/people/000", "other@test.local", "team-b")).status,
    404,
  );
});
test("related pagination filters hidden neighbors before selecting a cursor", async () => {
  const links = Array.from({ length: 58 }, (_, i) => ({
    sourceId: String(i).padStart(3, "0"),
    targetId: "a",
    relationship: "involves",
  }));
  fv.put(person("a", { links }));
  for (let i = 0; i < 58; i++)
    fv.put({
      id: String(i).padStart(3, "0"),
      path: `Notes/${i}`,
      tags: [i === 50 ? "secret" : "team"],
      metadata: { type: i % 2 ? "task" : "meeting" },
    });
  grantUser("reader@test.local", "tag", "team", "view");
  const first = (await (
    await req("/api/people/a", "reader@test.local")
  ).json()) as any;
  assert.equal(first.related.length, 50);
  assert.equal(first.next, "049");
  const second = (await (
    await req("/api/people/a?after=" + first.next, "reader@test.local")
  ).json()) as any;
  assert.equal(second.related.length, 7);
  assert.equal(second.next, null);
  assert.ok(!second.related.some((r: any) => r.id === "050"));
});

function decision(
  id: string,
  change: Record<string, unknown>,
  email = config.ownerEmail,
  vault = "primary",
) {
  return createApp().request(`/api/people/${id}/identities`, {
    method: "POST",
    headers: {
      cookie: sessionCookie(makeSession(email)),
      "X-Prism-Vault": vault,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(change),
  });
}
test("manual accounts merge only intended fields and record decisions guarded by the shown revision", async () => {
  const n = fv.put(
    person("a", {
      metadata: {
        email: "old@example.test",
        emails: ["old@example.test", "keep@example.test"],
        channels: { email: ["old@example.test"], matrix: "@keep:example.test" },
        other: "preserve",
      },
    }),
  );
  const result = await decision("a", {
    kind: "email",
    value: "New@Example.test",
    action: "add",
    ifUpdatedAt: n.updatedAt,
  });
  assert.equal(result.status, 200);
  let stored = fv.notes.get("a")!;
  assert.equal(stored.content, "PRIVATE_BODY");
  assert.equal(stored.metadata!.other, "preserve");
  assert.equal((stored.metadata!.channels as any).matrix, "@keep:example.test");
  assert.deepEqual((stored.metadata!.channels as any).email, [
    "old@example.test",
    "new@example.test",
  ]);
  assert.equal(
    (stored.metadata!.prism_identity_history as any[])[0].actor,
    config.ownerEmail,
  );
  const remove = await decision("a", {
    kind: "email",
    value: "old@example.test",
    action: "remove",
    ifUpdatedAt: stored.updatedAt,
  });
  assert.equal(remove.status, 200);
  stored = fv.notes.get("a")!;
  assert.equal(stored.metadata!.email, undefined);
  assert.deepEqual(stored.metadata!.emails, ["keep@example.test"]);
  assert.deepEqual((stored.metadata!.channels as any).email, [
    "new@example.test",
  ]);
  assert.equal((stored.metadata!.prism_identity_history as any[]).length, 2);
  const stale = await decision("a", {
    kind: "matrix",
    value: "@new:example.test",
    action: "add",
    ifUpdatedAt: "stale",
  });
  assert.equal(stale.status, 409);
});
test("identity conflicts reveal no hidden person and concurrent assignments cannot silently merge", async () => {
  const a = fv.put(person("a")),
    b = fv.put(person("b"));
  const payload = {
    kind: "email",
    value: "shared@example.test",
    action: "add",
  };
  const results = await Promise.all([
    decision("a", { ...payload, ifUpdatedAt: a.updatedAt }),
    decision("b", { ...payload, ifUpdatedAt: b.updatedAt }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.ok(
    !(await results.find((r) => r.status === 409)!.text()).includes("People/"),
  );
  grantUser("reader@test.local", "note", "a", "view");
  assert.equal(
    (
      await decision(
        "a",
        { ...payload, ifUpdatedAt: fv.notes.get("a")!.updatedAt },
        "reader@test.local",
      )
    ).status,
    403,
  );
  assert.equal(
    (await req("/api/people", config.ownerEmail, "missing-vault")).status,
    409,
  );
  assert.equal(
    (
      await decision(
        "a",
        { ...payload, ifUpdatedAt: a.updatedAt },
        config.ownerEmail,
        "missing-vault",
      )
    ).status,
    409,
  );
});
