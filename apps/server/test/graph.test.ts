import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { graphNeighborhood } from "../src/graph";
import type { Note } from "../src/parachute";
import { createApp } from "../src/app";
import {
  resetDb,
  installFakeVault,
  makeSession,
  sessionCookie,
  grantUser,
  makeCapability,
  type FakeVault,
} from "./helpers";
import { addVaultEntry, addGrant, db } from "../src/db";
import { signCapability } from "../src/auth/capability";
import { config } from "../src/config";
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());
const edge = (
  sourceId: string,
  targetId: string,
  relationship = "related",
) => ({ sourceId, targetId, relationship });
const note = (id: string, links: Note["links"] = []): Note => ({
  id,
  path: `Notes/${id}`,
  content: "BODY_MUST_NOT_APPEAR",
  metadata: {},
  tags: ["team"],
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
  links,
});

test("neighborhood preserves direction/types, deduplicates hydration, and discloses node/edge bounds", () => {
  const links = [
    edge("a", "b", "supports"),
    edge("b", "c"),
    edge("a", "b", "supports"),
  ];
  const notes = [note("a", links), note("b", links), note("c"), note("d")];
  const first = graphNeighborhood(notes, "a", 1, 10)!;
  assert.deepEqual(
    first.nodes.map((n) => n.id),
    ["a", "b"],
  );
  assert.deepEqual(first.edges, [
    { source: "a", target: "b", relationship: "supports" },
  ]);
  assert.equal(first.truncated, false);
  assert.deepEqual(
    graphNeighborhood(notes, "a", 2, 10)!.nodes.map((n) => n.id),
    ["a", "b", "c"],
  );
  assert.equal(graphNeighborhood(notes, "a", 2, 2)!.truncated, true);
  assert.equal(graphNeighborhood(notes, "missing", 2, 2), null);
  const dense = Array.from({ length: 66 }, (_, i) =>
    note(
      String(i),
      Array.from({ length: 66 }, (_, j) => edge(String(i), String(j))),
    ),
  );
  const bounded = graphNeighborhood(dense, "0", 1, 500)!;
  assert.equal(bounded.edges.length, 2000);
  assert.equal(bounded.truncated, true);
});

test("graph labels use explicit names or filenames, never generated body excerpts", () => {
  const unnamed = { ...note("a"), displayTitle: "<p>Private body excerpt</p>" };
  assert.equal(graphNeighborhood([unnamed], "a", 1, 10)!.nodes[0]?.title, "a");
  assert.equal(
    graphNeighborhood(
      [{ ...unnamed, metadata: { title: "  Project plan  " } }],
      "a",
      1,
      10,
    )!.nodes[0]?.title,
    "Project plan",
  );
  assert.equal(
    graphNeighborhood(
      [{ ...unnamed, path: null, metadata: { title: "  " } }],
      "a",
      1,
      10,
    )!.nodes[0]?.title,
    "a",
  );
});

test("graph authorizes both endpoints before traversal and never discloses hidden totals or bodies", async () => {
  Object.assign(fv.put(note("a")), {
    links: [edge("a", "b"), edge("a", "secret")],
  });
  fv.put(note("b"));
  Object.assign(
    fv.put({ ...note("secret"), tags: ["secret"], path: "Hidden/Private" }),
    { links: [edge("secret", "c")] },
  );
  fv.put(note("c"));
  const email = "reader@test.local";
  grantUser(email, "tag", "team", "view");
  const cookie = sessionCookie(makeSession(email));
  const app = createApp();
  const response = await app.request(
    "/api/graph/neighborhood?center=a&depth=3",
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as ReturnType<typeof graphNeighborhood>;
  assert.deepEqual(
    body?.nodes.map((n) => n.id),
    ["a", "b"],
  );
  assert.equal(body?.truncated, false);
  assert.ok(!JSON.stringify(body).includes("BODY_MUST_NOT_APPEAR"));
  assert.ok(!JSON.stringify(body).includes("secret"));
  const call = fv.calls.find((c) => c.path.endsWith("/api/notes"))!;
  assert.ok(call.search.includes("include_links=true"));
  assert.ok(!call.search.includes("include_content=true"));
  assert.equal(
    (
      await app.request("/api/graph/neighborhood?center=secret", {
        headers: { cookie },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request("/api/graph/neighborhood?center=missing", {
        headers: { cookie },
      })
    ).status,
    404,
  );
  const cap = makeCapability("note", "a", "view");
  const capped = await app.request("/api/graph/neighborhood?center=a", {
    headers: { authorization: `Capability ${cap}` },
  });
  assert.deepEqual(((await capped.json()) as { edges: unknown[] }).edges, []);
  db.prepare("DELETE FROM grants").run();
  assert.equal(
    (
      await app.request("/api/graph/neighborhood?center=a", {
        headers: { cookie },
      })
    ).status,
    404,
  );
  assert.equal(
    (await app.request("/api/graph/neighborhood?center=a")).status,
    401,
  );
});

test("graph is vault-bound, validates bounds, and rejects retired capability vaults", async () => {
  const app = createApp();
  fv.put({ ...note("same"), path: "Primary/Secret" });
  addVaultEntry({
    id: "secondary",
    label: "Secondary",
    url: "http://vault.test",
    vault: "secondary",
    token: "test-token",
  });
  fv.putIn("secondary", { ...note("same"), path: "Secondary/Target" });
  const cookie = sessionCookie(makeSession(config.ownerEmail));
  const request = (query: string) =>
    app.request("/api/graph/neighborhood?" + query, {
      headers: { cookie, "x-prism-vault": "secondary" },
    });
  const result = await request("center=same");
  assert.equal(result.status, 200);
  assert.equal(
    ((await result.json()) as { nodes: { path: string }[] }).nodes[0]?.path,
    "Secondary/Target",
  );
  for (const query of [
    "center=same&limit=501",
    "center=same&depth=0",
    "center=same&depth=1.5",
    "depth=2",
  ])
    assert.equal((await request(query)).status, 400);
  addGrant({
    subject_type: "link",
    subject: "retired-graph-link",
    resource_type: "note",
    resource: "same",
    level: "view",
    vault_id: "secondary",
    created_by: "test",
  });
  const cap = signCapability({
    id: "retired-graph-link",
    exp: Date.now() + 60_000,
  });
  db.prepare("DELETE FROM prism_vaults WHERE id=?").run("secondary");
  assert.equal(
    (
      await app.request("/api/graph/neighborhood?center=same", {
        headers: { authorization: `Capability ${cap}` },
      })
    ).status,
    409,
  );
});
