/**
 * Per-page style (wave 2E, NP-PG-08) through POST /api/notes/:id/meta: edit is
 * enough, values are strictly validated + normalised, CAS required, locked
 * pages refuse, and organize-only keys keep needing organize.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetPagesForTests } from "../src/pages";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";
import { parsePageStyle, pageStyleOf } from "@prism/core/pages";

let fv: FakeVault;
const J = { "content-type": "application/json" };
beforeEach(() => { resetDb(); resetTreeForTests(); resetPagesForTests(); fv = installFakeVault(); });
afterEach(() => { fv.restore(); resetTreeForTests(); });
const as = (email: string) => sessionCookie(makeSession(email));
const post = (path: string, body: unknown, cookie: string) => {
  const headers = new Headers(J);
  headers.set("cookie", cookie);
  return api.request(path, { method: "POST", headers, body: JSON.stringify(body) });
};
const stamp = (id: string) => fv.notes.get(id)!.updatedAt;

test("page style: edit access is enough, values are normalised, CAS required", async () => {
  fv.put({ id: "n", path: "Team/N", content: "c", tags: ["team"], metadata: { prism_creator: "x@test.local" } });
  grantUser("ed@test.local", "tag", "team", "edit");
  grantUser("viewer@test.local", "tag", "team", "view");
  const ed = as("ed@test.local");
  assert.equal((await post("/notes/n/meta", { set: { prism_page_style: { full: true } } }, ed)).status, 428);
  assert.equal((await post("/notes/n/meta", { set: { prism_page_style: { full: true } }, if_updated_at: stamp("n") }, as("viewer@test.local"))).status, 403, "view can't restyle");
  assert.equal((await post("/notes/n/meta", { set: { prism_page_style: { full: true }, prism_order: 2 }, if_updated_at: stamp("n") }, ed)).status, 403, "order still needs organize");
  const ok = await post("/notes/n/meta", { set: { prism_page_style: { full: true, small: false } }, if_updated_at: stamp("n") }, ed);
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as any).metadata.prism_page_style, { small: false, full: true });
  assert.deepEqual(fv.notes.get("n")!.metadata!.prism_page_style, { small: false, full: true });
  // A partial set changes only the flag it names (review low)…
  assert.equal((await post("/notes/n/meta", { set: { prism_page_style: { small: true } }, if_updated_at: stamp("n") }, ed)).status, 200);
  assert.deepEqual(fv.notes.get("n")!.metadata!.prism_page_style, { small: true, full: true });
  // …and turning one off is stored as an explicit false, so the vault's metadata merge can't keep it on.
  assert.equal((await post("/notes/n/meta", { set: { prism_page_style: { full: false } }, if_updated_at: stamp("n") }, ed)).status, 200);
  assert.deepEqual(fv.notes.get("n")!.metadata!.prism_page_style, { small: true, full: false });
  assert.equal(fv.notes.get("n")!.metadata!.prism_creator, "x@test.local", "merge, never replace");
  assert.equal((await post("/notes/n/meta", { set: { prism_page_style: { full: true } }, if_updated_at: "2000-01-01T00:00:00.000Z" }, ed)).status, 409);
});

test("page style: malformed values and locked pages are refused", async () => {
  fv.put({ id: "n", path: "Team/N", content: "c", tags: ["team"] });
  fv.put({ id: "l", path: "Team/L", content: "c", tags: ["team"], metadata: { prism_locked: true } });
  const owner = as("owner@test.local");
  for (const bad of [{ full: "yes" }, { width: 900 }, ["full"], "full", null]) {
    assert.equal((await post("/notes/n/meta", { set: { prism_page_style: bad }, if_updated_at: stamp("n") }, owner)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post("/notes/l/meta", { set: { prism_page_style: { small: true } }, if_updated_at: stamp("l") }, owner)).status, 423);
  assert.deepEqual(parsePageStyle({ small: true }), { small: true });
  assert.deepEqual(pageStyleOf({ metadata: { prism_page_style: { full: 1 } } }), {});
});

test("page style: combined with lock/order it needs BOTH edit and organize; a plain PATCH can't set it", async () => {
  fv.put({ id: "n", path: "Team/N", content: "c", tags: ["team"] });
  const { addGrant } = await import("../src/db");
  // organize without edit: may reorder, may not restyle — and not both in one request.
  addGrant({ subject_type: "user", subject: "org@test.local", resource_type: "tag", resource: "team", level: "view", created_by: "test", caps: ["view", "organize"] });
  const org = as("org@test.local");
  assert.equal((await post("/notes/n/meta", { set: { prism_order: 3 }, if_updated_at: stamp("n") }, org)).status, 200);
  assert.equal((await post("/notes/n/meta", { set: { prism_order: 4, prism_page_style: { full: true } }, if_updated_at: stamp("n") }, org)).status, 403);
  assert.equal((await post("/notes/n/meta", { set: { prism_page_style: { full: true } }, if_updated_at: stamp("n") }, org)).status, 403);
  assert.equal(fv.notes.get("n")!.metadata!.prism_page_style, undefined);
  // The gateway PATCH never writes the key for a non-owner (arbitrary shapes would bypass validation).
  grantUser("ed@test.local", "tag", "team", "edit");
  const headers = new Headers(J);
  headers.set("cookie", as("ed@test.local"));
  const r = await api.request("/notes/n", { method: "PATCH", headers, body: JSON.stringify({ metadata: { prism_page_style: { evil: "<script>" } }, if_updated_at: stamp("n") }) });
  assert.equal(r.status, 403);
  assert.equal(fv.notes.get("n")!.metadata?.prism_page_style, undefined);
});
