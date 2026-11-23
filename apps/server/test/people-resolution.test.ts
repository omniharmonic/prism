import { test } from "node:test";
import assert from "node:assert/strict";
import { PeopleIndex } from "../src/worker/people";
import type { Note } from "../src/parachute";
const person = (id: string, metadata: Record<string, unknown>): Note => ({ id, content: "# Alex Example", path: `vault/people/${id}`, tags: ["person"], metadata: { name: "Alex Example", ...metadata }, createdAt: "", updatedAt: "" });

test("external identity collisions remain ambiguous regardless of listing order", () => {
  const a = person("a", { email: "alex@example.test" });
  const b = person("b", { channels: { email: ["ALEX@example.test"] } });
  for (const seed of [[a, b], [b, a]]) {
    const index = new PeopleIndex(seed);
    const resolution = index.resolve({ email: "alex@example.test" });
    assert.equal(index.find({ email: "alex@example.test" }), null);
    assert.equal(resolution.status, "ambiguous");
    if (resolution.status === "ambiguous") assert.deepEqual(resolution.candidates.map((n) => n.id), ["a", "b"]);
  }
});

test("same names and changed display names do not override stable identities", () => {
  const index = new PeopleIndex([person("a", { email: "a@example.test" }), person("b", { email: "b@example.test" })]);
  assert.equal(index.find({ name: "Alex Example" }), null);
  assert.equal(index.resolve({ name: "Alex Example", email: "unknown@example.test" }).status, "candidates");
  assert.equal(index.find({ name: "A new name", email: "b@example.test" })?.id, "b");
});

test("conflicting email and Matrix claims cannot pick the first provider", () => {
  const index = new PeopleIndex([person("a", { email: "a@example.test" }), person("b", { channels: { matrix: "@b:example.test" } })]);
  assert.equal(index.resolve({ email: "a@example.test", matrixId: "@b:example.test" }).status, "ambiguous");
});

test("ambiguous/name-only candidates never trigger duplicate creation or automatic linking", async () => {
  const index = new PeopleIndex([person("a", { email: "a@example.test" }), person("b", { email: "a@example.test" })]);
  const vault = { createNote: async () => { throw new Error("must not create"); } };
  assert.equal(await index.findOrCreate(vault, "Alex Example", { email: "a@example.test" }), null);
  assert.equal(await index.findOrCreate(vault, "Alex Example", { email: "other@example.test" }), null);
});

test("an if_exists collision never fabricates an alias for subsequent messages", async () => {
  const index = new PeopleIndex();
  const existing = person("existing", { email: "someone-else@example.test" });
  const vault = { createNote: async () => ({ ...existing, existed: true }) };
  assert.equal(await index.findOrCreate(vault, "Alex Example", { email: "new@example.test" }), null);
  assert.equal(index.find({ email: "new@example.test" }), null);
  assert.equal(index.find({ email: "someone-else@example.test" })?.id, "existing");
});

test("an existing stable identity is usable even when a new display name is unsuitable for creation", async () => {
  const index = new PeopleIndex([person("a", { channels: { matrix: "@123:example.test" } })]);
  const vault = { createNote: async () => { throw new Error("must not create"); } };
  assert.deepEqual(await index.findOrCreate(vault, "123", { matrixId: "@123:example.test" }), { id: "a", created: false });
});
