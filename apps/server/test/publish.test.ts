/**
 * Publishing (Horizon B) — the public, anonymous read path (`/api/p/*`, the
 * `publish` router) and the owner publish lifecycle (`/acl/tags/:tag/publish`).
 *
 * These run the REAL Hono routers against the fake in-memory vault, so they
 * exercise the same authorization spine the live deployment does — without a
 * vault. The invariants under test are the ones a publishing leak would
 * violate:
 *   - only notes carrying the publication's tag are ever exposed (anon actor =
 *     the `anyone` grant only; tag-membership is re-checked on the single-note
 *     route so a reader can't pull an arbitrary id);
 *   - the graph is built from the in-set notes only — a wikilink to an
 *     out-of-publication note produces NO node and NO edge;
 *   - a password-gated publication withholds its nav and 401s its content until
 *     a valid per-slug unlock cookie is presented;
 *   - the owner lifecycle (publish → list → password → unpublish) is idempotent
 *     and owner-only, and unpublish removes the backing `anyone` grant.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { publish } from "../src/routes/publish";
import { acl } from "../src/routes/acl";
import {
  installFakeVault,
  resetDb,
  makeSession,
  sessionCookie,
  type FakeVault,
} from "./helpers";
import {
  addGrant,
  createPublication,
  getPublicationByResource,
  grantsForResource,
} from "../src/db";

const OWNER = "owner@test.local";
let fv: FakeVault;

/** Read a JSON response body with a caller-supplied shape (json() is `unknown`
 *  under strict mode). */
async function readJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
});
afterEach(() => fv.restore());

// ── fixtures ────────────────────────────────────────────────────────────────
/** Two in-publication wiki notes that link to each other and to an out-of-set
 *  note, plus a private note that does NOT carry the wiki tag. */
function seedWiki() {
  fv.put({ id: "n1", path: "wiki/alpha.md", tags: ["wiki"], content: "# Alpha\n\nsee [[Beta]] and [[Secret]]" });
  fv.put({ id: "n2", path: "wiki/beta.md", tags: ["wiki"], content: "# Beta\n\nback to [[Alpha]]" });
  fv.put({ id: "secret", path: "private/secret.md", tags: ["private"], content: "# Secret\n\nhidden" });
}
/** Create an OPEN publication for `tag` + its backing anyone-grant. */
function publishTag(slug: string, tag: string, extra: Partial<Parameters<typeof createPublication>[0]> = {}) {
  createPublication({
    id: slug, resource_type: "tag", resource: tag, template: "wiki",
    title: extra.title ?? null, home_note_id: extra.home_note_id ?? null,
    password_hash: extra.password_hash ?? null, theme: null,
    expires_at: extra.expires_at ?? null, created_by: OWNER,
  });
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: tag, level: "view", created_by: "test" });
}
const ownerReq = (path: string, init?: RequestInit) =>
  acl.request(path, { ...init, headers: { ...(init?.headers ?? {}), cookie: sessionCookie(makeSession(OWNER)) } });

// ── manifest ─────────────────────────────────────────────────────────────────
test("manifest lists only in-tag notes, never out-of-publication notes", async () => {
  seedWiki();
  publishTag("mysite", "wiki", { title: "My Wiki" });

  const res = await publish.request("/mysite");
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.title, "My Wiki");
  assert.equal(body.template, "wiki");
  assert.equal(body.passwordRequired, false);
  const ids = body.notes.map((n: { id: string }) => n.id).sort();
  assert.deepEqual(ids, ["n1", "n2"]);
  assert.ok(!ids.includes("secret"), "private note must not appear in nav");
  assert.equal(body.homeNoteId, "n1", "home defaults to first note when unset");
});

test("unknown slug → 404; expired publication → 404", async () => {
  seedWiki();
  publishTag("live", "wiki");
  publishTag("dead", "wiki", { expires_at: Date.now() - 1000 });

  assert.equal((await publish.request("/nope")).status, 404);
  assert.equal((await publish.request("/dead")).status, 404);
  assert.equal((await publish.request("/live")).status, 200);
});

// ── single note authorization ────────────────────────────────────────────────
test("single note: in-publication note 200, out-of-publication note 403", async () => {
  seedWiki();
  publishTag("mysite", "wiki");

  const ok = await publish.request("/mysite/notes/n1");
  assert.equal(ok.status, 200);
  const note = await readJson(ok);
  assert.equal(note.id, "n1");
  assert.equal(note.title, "Alpha");
  assert.match(note.content, /Alpha/);

  // `secret` exists in the vault but lacks the wiki tag → must be forbidden even
  // though the id is guessable. (defense-in-depth: tag re-checked on the route)
  const forbidden = await publish.request("/mysite/notes/secret");
  assert.equal(forbidden.status, 403);
});

// ── graph leak-prevention ────────────────────────────────────────────────────
test("graph exposes only in-set nodes/edges; out-of-set wikilinks are dropped", async () => {
  seedWiki();
  publishTag("mysite", "wiki");

  const res = await publish.request("/mysite/graph");
  assert.equal(res.status, 200);
  const { nodes, edges } = await readJson(res);

  const nodeIds = nodes.map((n: { id: string }) => n.id).sort();
  assert.deepEqual(nodeIds, ["n1", "n2"], "graph nodes are the in-set notes only");
  assert.ok(!nodeIds.includes("secret"));

  // Alpha→Beta and Beta→Alpha resolve; Alpha→[[Secret]] points outside the set
  // and MUST NOT produce an edge or leak the 'secret' id anywhere.
  const pairs = edges.map((e: { source: string; target: string }) => `${e.source}->${e.target}`).sort();
  assert.deepEqual(pairs, ["n1->n2", "n2->n1"]);
  for (const e of edges) {
    assert.ok(e.source !== "secret" && e.target !== "secret", "no edge may reference an out-of-set note");
  }
});

// ── password gate ────────────────────────────────────────────────────────────
import { hashPassword } from "../src/auth/password";

function lockedFixture() {
  fv.put({ id: "d1", path: "docs/intro.md", tags: ["docs"], content: "# Intro" });
  publishTag("locked", "docs", { password_hash: hashPassword("hunter2") });
}

test("locked publication withholds nav and 401s content until unlocked", async () => {
  lockedFixture();

  // manifest: identity returned, but nav withheld so structure never leaks.
  const man = await readJson(await publish.request("/locked"));
  assert.equal(man.passwordRequired, true);
  assert.deepEqual(man.notes, []);
  assert.equal(man.homeNoteId, null);

  // content + graph locked.
  assert.equal((await publish.request("/locked/notes/d1")).status, 401);
  assert.equal((await publish.request("/locked/graph")).status, 401);

  // wrong password → 401, no cookie.
  const bad = await publish.request("/locked/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "nope" }),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null);

  // correct password → 200 + a pub_locked unlock cookie.
  const good = await publish.request("/locked/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "hunter2" }),
  });
  assert.equal(good.status, 200);
  const setCookie = good.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /pub_locked=/);
  const cookie = setCookie.split(";")[0]!; // "pub_locked=<token>"

  // with the unlock cookie, nav + content are served.
  const man2 = await readJson(await publish.request("/locked", { headers: { cookie } }));
  assert.deepEqual(man2.notes.map((n: { id: string }) => n.id), ["d1"]);
  assert.equal((await publish.request("/locked/notes/d1", { headers: { cookie } })).status, 200);
});

test("a tampered/foreign unlock cookie does not unlock the publication", async () => {
  lockedFixture();
  // garbage token, and a structurally-valid-looking but unsigned one.
  for (const cookie of ["pub_locked=garbage", "pub_locked=eyJzbHVnIjoibG9ja2VkIn0.deadbeef"]) {
    const man = await readJson(await publish.request("/locked", { headers: { cookie } }));
    assert.deepEqual(man.notes, [], "forged cookie must keep the site locked");
    assert.equal((await publish.request("/locked/notes/d1", { headers: { cookie } })).status, 401);
  }
});

// ── owner lifecycle (acl) ────────────────────────────────────────────────────
test("owner publish is idempotent and creates the backing anyone-grant; non-owner is 403", async () => {
  seedWiki();

  // non-owner (no cookie) is rejected by the acl owner guard.
  const anon = await acl.request("/tags/wiki/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anon.status, 403);

  const res = await ownerReq("/tags/wiki/publish", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ template: "wiki", title: "Wiki" }),
  });
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.tag, "wiki");
  assert.equal(body.count, 2, "live count reflects the 2 wiki notes");
  assert.match(body.url, /\/p\//);

  // the anyone-grant primitive now backs the tag.
  const anyone = grantsForResource("tag", "wiki").filter((g) => g.subject_type === "anyone");
  assert.equal(anyone.length, 1);
  assert.equal(anyone[0]!.level, "view");

  // idempotent: re-publishing the same tag reuses the slug, no duplicate row.
  const again = await readJson(await ownerReq("/tags/wiki/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(again.slug, body.slug, "same tag → same slug");
});

test("owner can set a password then unpublish, which clears the anyone-grant", async () => {
  seedWiki();
  await ownerReq("/tags/wiki/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

  // set a password → manifest now requires it.
  const pw = await ownerReq("/tags/wiki/publish/password", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "s3cret" }),
  });
  assert.equal(pw.status, 200);
  const pub = getPublicationByResource("tag", "wiki")!;
  const man = await readJson(await publish.request(`/${pub.id}`));
  assert.equal(man.passwordRequired, true);

  // unpublish removes the publication AND the anyone-grant.
  const del = await ownerReq("/tags/wiki/publish", { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(getPublicationByResource("tag", "wiki"), null);
  assert.equal(grantsForResource("tag", "wiki").filter((g) => g.subject_type === "anyone").length, 0);
});
