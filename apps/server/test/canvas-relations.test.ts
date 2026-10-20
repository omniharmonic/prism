import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { db, addVaultEntry } from "../src/db";
import * as Y from "yjs";
import { hocuspocus, docNameFor, CANVAS_FIELD } from "../src/collab";
import { config } from "../src/config";
import {
  resetDb,
  installFakeVault,
  makeSession,
  sessionCookie,
  grantUser,
  type FakeVault,
} from "./helpers";
import { canvasRelations } from "../../../packages/core/src/components/renderers/canvas-relations";
let fv: FakeVault;
beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  for (const id of ["source", "target", "other"])
    fv.put({
      id,
      path: id,
      tags: ["team"],
      content: "UNCHANGED",
      metadata: { preserve: "yes" },
    });
});
afterEach(() => fv.restore());
function scene(arrow = "arrow", target = "target", relationship = "supports") {
  return [
    { id: "from", type: "rectangle", customData: { prismNoteId: "source" } },
    { id: "to", type: "rectangle", customData: { prismNoteId: target } },
    {
      id: arrow,
      type: "arrow",
      startBinding: { elementId: "from" },
      endBinding: { elementId: "to" },
    },
    { id: "label", type: "text", containerId: arrow, text: relationship },
  ];
}
function canvas(id: string, elements: any[]) {
  return fv.put({
    id,
    path: id,
    tags: ["canvas", "team"],
    metadata: { type: "canvas" },
    content: JSON.stringify({ elements }),
  });
}
async function reconcile(
  id: string,
  elements: any[],
  email = config.ownerEmail,
) {
  return createApp().request("/api/canvas/" + id + "/relationships", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: sessionCookie(makeSession(email)),
      "X-Prism-Vault": "primary",
    },
    body: JSON.stringify({
      fingerprint: JSON.stringify(canvasRelations(elements)),
    }),
  });
}
const links = () => fv.notes.get("source")!.links ?? [];
test("durable assertions survive reload, retries and removal of one canvas contributor", async () => {
  const e = scene();
  canvas("a", e);
  canvas("b", e);
  assert.equal((await reconcile("a", e)).status, 200);
  assert.equal((await reconcile("a", e)).status, 200);
  assert.equal((await reconcile("b", e)).status, 200);
  assert.equal(links().length, 1);
  canvas("a", []);
  assert.equal((await reconcile("a", [])).status, 200);
  assert.equal(links().length, 1);
  canvas("b", []);
  assert.equal((await reconcile("b", [])).status, 200);
  assert.equal(links().length, 0);
  assert.equal(fv.notes.get("source")!.content, "UNCHANGED");
  assert.equal(fv.notes.get("source")!.metadata!.preserve, "yes");
});
test("manual and externally changed relationships are preserved when the last arrow goes away", async () => {
  const e = scene();
  fv.notes.get("source")!.links = [
    { sourceId: "source", targetId: "target", relationship: "supports" },
  ];
  canvas("a", e);
  assert.equal((await reconcile("a", e)).status, 200);
  canvas("a", []);
  let response = await reconcile("a", []);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as any).retained, true);
  assert.equal(links().length, 1);
  fv.notes.get("source")!.links = [];
  canvas("b", e);
  assert.equal((await reconcile("b", e)).status, 200);
  fv.notes.get("source")!.updatedAt = "external-revision";
  canvas("b", []);
  response = await reconcile("b", []);
  assert.equal(((await response.json()) as any).retained, true);
  assert.equal(links().length, 1);
});
test("scene guards reject stale clients; failed CAS keeps durable work retryable", async () => {
  const e = scene();
  canvas("a", e);
  assert.equal((await reconcile("a", [])).status, 409);
  assert.equal(links().length, 0);
  fv.conflictOnNextWrite = true;
  assert.equal((await reconcile("a", e)).status, 409);
  assert.equal(links().length, 0);
  assert.equal(
    (db.prepare("SELECT count(*) n FROM canvas_relation_jobs").get() as any).n,
    1,
  );
  assert.equal((await reconcile("a", e)).status, 200);
  assert.equal(links().length, 1);
  assert.equal(
    (db.prepare("SELECT count(*) n FROM canvas_relation_jobs").get() as any).n,
    0,
  );
  const next = scene("arrow", "other", "next");
  canvas("a", next);
  assert.equal((await reconcile("a", next)).status, 200);
  assert.deepEqual(links(), [
    { sourceId: "source", targetId: "other", relationship: "next" },
  ]);
});
test("both endpoints and canvas need current edit permission; denied requests expose no source data", async () => {
  const e = scene();
  canvas("a", e);
  grantUser("editor@test.local", "note", "a", "edit");
  grantUser("editor@test.local", "note", "source", "edit");
  grantUser("editor@test.local", "note", "target", "view");
  let r = await reconcile("a", e, "editor@test.local");
  assert.equal(r.status, 404);
  assert.ok(!(await r.text()).includes("target"));
  assert.equal(
    (db.prepare("SELECT count(*) n FROM canvas_assertions").get() as any).n,
    0,
  );
  grantUser("editor@test.local", "note", "target", "edit");
  assert.equal((await reconcile("a", e, "editor@test.local")).status, 200);
  db.prepare("DELETE FROM grants WHERE resource='target'").run();
  canvas("a", []);
  assert.equal((await reconcile("a", [], "editor@test.local")).status, 404);
  assert.equal(links().length, 1);
});
test("preview arrows, decorative connections and deleted cards never create assertions", () => {
  const e = scene();
  const arrow = e[2] as any;
  arrow.customData = { prismLinkViz: true };
  assert.deepEqual(canvasRelations(e), []);
  arrow.customData = { prismRelationship: false };
  assert.deepEqual(canvasRelations(e), []);
  arrow.customData = {};
  (e[1] as any).isDeleted = true;
  assert.deepEqual(canvasRelations(e), []);
});
test("an uncertain projection after a crash never steals manual deletion authority", async () => {
  const e = scene();
  canvas("a", e);
  assert.equal((await reconcile("a", e)).status, 200);
  db.prepare(
    "UPDATE canvas_relation_sources SET updated_at='before-write'",
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO canvas_relation_jobs VALUES('primary','a','source')",
  ).run();
  canvas("a", []);
  const r = await reconcile("a", []);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).retained, true);
  assert.equal(links().length, 1);
});

test("live collaborative state is authoritative over the last saved scene", async () => {
  const saved = scene(),
    live = scene("new-arrow", "other", "next");
  canvas("a", saved);
  const doc = new Y.Doc();
  for (const el of live) doc.getMap(CANVAS_FIELD).set(el.id, el);
  hocuspocus.documents.set(docNameFor("primary", "a"), doc as never);
  try {
    assert.equal((await reconcile("a", saved)).status, 409);
    assert.equal((await reconcile("a", live)).status, 200);
    assert.deepEqual(links(), [
      { sourceId: "source", targetId: "other", relationship: "next" },
    ]);
  } finally {
    hocuspocus.documents.delete(docNameFor("primary", "a"));
    doc.destroy();
  }
});
test("same canvas and endpoint IDs in separate vaults cannot share assertion ownership", async () => {
  const e = scene();
  canvas("a", e);
  assert.equal((await reconcile("a", e)).status, 200);
  addVaultEntry({
    id: "secondary",
    label: "Secondary",
    url: "http://vault.test",
    vault: "secondary",
    token: "test-token",
  });
  for (const id of ["a", "source", "target"])
    fv.putIn("secondary", {
      id,
      path: id,
      tags: id === "a" ? ["canvas"] : [],
      metadata: id === "a" ? { type: "canvas" } : {},
      content: id === "a" ? JSON.stringify({ elements: e }) : "SECONDARY",
    });
  const r = await createApp().request("/api/canvas/a/relationships", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: sessionCookie(makeSession(config.ownerEmail)),
      "X-Prism-Vault": "secondary",
    },
    body: JSON.stringify({ fingerprint: JSON.stringify(canvasRelations(e)) }),
  });
  assert.equal(r.status, 200);
  canvas("a", []);
  assert.equal((await reconcile("a", [])).status, 200);
  assert.equal(links().length, 0);
  assert.equal(
    (
      db
        .prepare(
          "SELECT count(*) n FROM canvas_assertions WHERE vault_id='secondary'",
        )
        .get() as any
    ).n,
    1,
  );
});

test("two arrows in one canvas independently claim an edge; rebinding one preserves the other", async () => {
  const e = scene();
  const arrow = { ...e[2], id: "second-arrow" };
  const both = [...e, arrow, {...e[3], id:"second-label", containerId:"second-arrow"}];
  canvas("a", both);
  assert.equal((await reconcile("a", both)).status, 200);
  assert.equal(links().length, 1);
  canvas("a", e);
  assert.equal((await reconcile("a", e)).status, 200);
  assert.equal(links().length, 1);
  const decorative = e.map((el) =>
    el.type === "arrow"
      ? { ...el, customData: { prismRelationship: false } }
      : el,
  );
  canvas("a", decorative);
  assert.equal((await reconcile("a", decorative)).status, 200);
  assert.equal(links().length, 0);
});
