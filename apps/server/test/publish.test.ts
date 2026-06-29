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
  db,
  addGrant,
  createPublication,
  getPublicationByResource,
  getPublicationBySlug,
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

test("single-line HTML note → title is the heading, not the whole body", async () => {
  // TipTap notes are stored as ONE line of HTML (no newlines). deriveTitle must
  // not return the entire document as the title — that's what dumped raw HTML
  // into the published wiki's title heading.
  const body =
    "<h1>Accelerationism</h1><p>A long body with [[wetiko]] and lots more text that must never become the title heading.</p><h2>Further Reading</h2><ul><li><p>x</p></li></ul>";
  fv.put({ id: "html1", path: "wiki/concept.md", tags: ["wiki"], content: body });
  publishTag("htmlsite", "wiki");

  const r = await publish.request("/htmlsite/notes/html1");
  assert.equal(r.status, 200);
  const note = await readJson(r);
  assert.equal(note.title, "Accelerationism");
  assert.ok(note.title.length < 40, `title must be short, got ${note.title.length} chars`);
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

// ── publish-by-path-prefix ────────────────────────────────────────────────────
/** Notes that exercise prefix membership: two inside `docs/guide`, a sibling
 *  `docs/guidance/...` that must NOT match `docs/guide`, and an out-of-prefix
 *  note. The in-set notes wikilink each other and an out-of-set note. */
function seedPaths() {
  fv.put({ id: "g1", path: "docs/guide/intro.md", tags: ["anything"], content: "# Intro\n\nsee [[Setup]] and [[Other]]" });
  fv.put({ id: "g2", path: "docs/guide/setup.md", tags: [], content: "# Setup\n\nback to [[Intro]]" });
  fv.put({ id: "sibling", path: "docs/guidance/oops.md", tags: [], content: "# Sibling\n\nnot in docs/guide" });
  fv.put({ id: "other", path: "blog/post.md", tags: [], content: "# Other\n\nelsewhere" });
}

test("path publish: manifest lists ONLY in-prefix notes (sibling prefix excluded)", async () => {
  seedPaths();
  const res = await ownerReq("/publish/path", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pathPrefix: "docs/guide", title: "Guide" }),
  });
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.pathPrefix, "docs/guide");
  assert.equal(body.count, 2, "only the two docs/guide notes count");
  assert.equal(body.passwordRequired, false);
  assert.match(body.url, /\/p\//);

  const man = await readJson(await publish.request(`/${body.slug}`));
  const ids = man.notes.map((n: { id: string }) => n.id).sort();
  assert.deepEqual(ids, ["g1", "g2"], "sibling docs/guidance and blog/post excluded");
});

test("path publish: out-of-prefix + sibling notes 403 on the single-note route", async () => {
  seedPaths();
  const { slug } = await readJson(await ownerReq("/publish/path", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pathPrefix: "docs/guide" }),
  }));

  assert.equal((await publish.request(`/${slug}/notes/g1`)).status, 200, "in-prefix note served");
  // guessable ids that are out of the prefix must never be pulled.
  assert.equal((await publish.request(`/${slug}/notes/sibling`)).status, 403, "docs/guidance is NOT under docs/guide");
  assert.equal((await publish.request(`/${slug}/notes/other`)).status, 403, "blog/post is out of prefix");
});

test("path publish: graph is in-set only; out-of-prefix wikilink dropped", async () => {
  seedPaths();
  const { slug } = await readJson(await ownerReq("/publish/path", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pathPrefix: "docs/guide" }),
  }));

  const { nodes, edges } = await readJson(await publish.request(`/${slug}/graph`));
  assert.deepEqual(nodes.map((n: { id: string }) => n.id).sort(), ["g1", "g2"]);
  // g1→[[Setup]] resolves (g2); g2→[[Intro]] resolves (g1); g1→[[Other]] is
  // out-of-set and MUST NOT appear.
  const pairs = edges.map((e: { source: string; target: string }) => `${e.source}->${e.target}`).sort();
  assert.deepEqual(pairs, ["g1->g2", "g2->g1"]);
  for (const e of edges) assert.ok(e.target !== "other" && e.source !== "other");
});

test("path publish rejects traversal/empty prefixes", async () => {
  seedPaths();
  for (const pathPrefix of ["../etc", "docs/../secret", "..", "/", "   ", ""]) {
    const res = await ownerReq("/publish/path", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pathPrefix }),
    });
    assert.equal(res.status, 400, `prefix ${JSON.stringify(pathPrefix)} must be rejected`);
  }
});

test("path publish normalizes the prefix and is idempotent per prefix", async () => {
  seedPaths();
  // leading/trailing slashes + double slash all normalize to "docs/guide".
  const a = await readJson(await ownerReq("/publish/path", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pathPrefix: "/docs//guide/" }),
  }));
  assert.equal(a.pathPrefix, "docs/guide");
  const b = await readJson(await ownerReq("/publish/path", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pathPrefix: "docs/guide" }),
  }));
  assert.equal(b.slug, a.slug, "same normalized prefix → same slug, no duplicate row");
  // a path publication creates NO anyone-grant (guarded by path membership only).
  assert.equal(grantsForResource("path", "docs/guide").length, 0);
  assert.equal(grantsForResource("tag", "docs/guide").filter((g) => g.subject_type === "anyone").length, 0);
});

test("slug-based unpublish removes a path publication", async () => {
  seedPaths();
  const { slug } = await readJson(await ownerReq("/publish/path", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pathPrefix: "docs/guide" }),
  }));
  assert.ok(getPublicationBySlug(slug), "publication exists after publish");

  const del = await ownerReq(`/publications/${slug}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(getPublicationBySlug(slug), null, "row removed");
  assert.equal((await publish.request(`/${slug}`)).status, 404, "manifest 404s after unpublish");
});

test("slug-based password set/clear gates a path publication", async () => {
  seedPaths();
  const { slug } = await readJson(await ownerReq("/publish/path", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pathPrefix: "docs/guide" }),
  }));

  // set a password by slug → manifest withholds nav.
  await ownerReq(`/publications/${slug}/password`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "open-sesame" }),
  });
  const locked = await readJson(await publish.request(`/${slug}`));
  assert.equal(locked.passwordRequired, true);
  assert.deepEqual(locked.notes, []);

  // clear it → nav returns.
  await ownerReq(`/publications/${slug}/password`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  const open = await readJson(await publish.request(`/${slug}`));
  assert.equal(open.passwordRequired, false);
  assert.deepEqual(open.notes.map((n: { id: string }) => n.id).sort(), ["g1", "g2"]);
});

// ── per-publication tending (exclude notes + home note) ──────────────────────
/** Three in-tag notes (so we can exclude the middle one). */
function seedThree() {
  fv.put({ id: "t1", path: "wiki/one.md", tags: ["wiki"], content: "# One" });
  fv.put({ id: "t2", path: "wiki/two.md", tags: ["wiki"], content: "# Two" });
  fv.put({ id: "t3", path: "wiki/three.md", tags: ["wiki"], content: "# Three" });
}

test("excludeNoteIds drops a note from manifest, single-note route, and graph", async () => {
  seedThree();
  publishTag("site3", "wiki");

  // exclude t2 via the settings endpoint.
  const set = await ownerReq("/publications/site3/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ excludeNoteIds: ["t2"] }),
  });
  assert.equal(set.status, 200);
  assert.deepEqual(await readJson(set), { ok: true });

  // manifest lists 2 notes, t2 absent.
  const man = await readJson(await publish.request("/site3"));
  assert.deepEqual(man.notes.map((n: { id: string }) => n.id).sort(), ["t1", "t3"]);
  assert.ok(!man.notes.some((n: { id: string }) => n.id === "t2"));

  // single-note route for the excluded id → forbidden (same leak-proofing as
  // an out-of-set id — see the `secret` 403 case above).
  assert.equal((await publish.request("/site3/notes/t2")).status, 403);
  assert.equal((await publish.request("/site3/notes/t1")).status, 200);

  // graph excludes t2 (routes through publicationNotes).
  const { nodes } = await readJson(await publish.request("/site3/graph"));
  assert.deepEqual(nodes.map((n: { id: string }) => n.id).sort(), ["t1", "t3"]);
});

test("homeNoteId reflects an in-set note, and degrades to nav[0] when out-of-set/excluded", async () => {
  seedThree();
  publishTag("site4", "wiki");

  // set home to an in-set note → manifest reflects it.
  await ownerReq("/publications/site4/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ homeNoteId: "t3" }),
  });
  let man = await readJson(await publish.request("/site4"));
  assert.equal(man.homeNoteId, "t3");

  // exclude t3 → home falls back to nav[0] (an excluded id is not in the set).
  await ownerReq("/publications/site4/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ excludeNoteIds: ["t3"] }),
  });
  man = await readJson(await publish.request("/site4"));
  assert.equal(man.homeNoteId, "t1", "excluded home degrades to nav[0]");

  // point home at an entirely out-of-set id → also nav[0].
  await ownerReq("/publications/site4/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ homeNoteId: "does-not-exist", excludeNoteIds: [] }),
  });
  man = await readJson(await publish.request("/site4"));
  assert.equal(man.homeNoteId, "t1", "out-of-set home degrades to nav[0]");
});

test("GET /publications surfaces homeNoteId + excludeNoteIds", async () => {
  seedThree();
  publishTag("site5", "wiki");
  await ownerReq("/publications/site5/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ homeNoteId: "t2", excludeNoteIds: ["t1"] }),
  });

  const rows = await readJson<Array<any>>(await ownerReq("/publications"));
  const row = rows.find((r) => r.slug === "site5");
  assert.ok(row);
  assert.equal(row.homeNoteId, "t2");
  assert.deepEqual(row.excludeNoteIds, ["t1"]);
});

test("settings endpoint is owner-only and 404s an unknown slug", async () => {
  seedThree();
  publishTag("site6", "wiki");

  // anon (no cookie) → 403 from the acl owner guard.
  const anon = await acl.request("/publications/site6/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ excludeNoteIds: ["t1"] }),
  });
  assert.equal(anon.status, 403);

  // unknown slug → 404.
  const missing = await ownerReq("/publications/nope/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ excludeNoteIds: [] }),
  });
  assert.equal(missing.status, 404);

  // bad excludeNoteIds type → 400.
  const bad = await ownerReq("/publications/site6/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ excludeNoteIds: "t1" }),
  });
  assert.equal(bad.status, 400);
});

test("settings endpoint persists a valid theme and rejects bad shapes/oversize", async () => {
  seedThree();
  publishTag("site-theme", "wiki");

  // Valid theme → 200, echoed back (parsed) by GET /publications and the manifest.
  const theme = { logoUrl: "https://ex.com/l.png", accent: "#ff0066", font: "serif" };
  const ok = await ownerReq("/publications/site-theme/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme }),
  });
  assert.equal(ok.status, 200);

  const rows = await readJson<Array<any>>(await ownerReq("/publications"));
  const row = rows.find((r) => r.slug === "site-theme");
  assert.deepEqual(row.theme, theme);

  const man = await readJson<any>(await publish.request("/site-theme"));
  assert.deepEqual(man.theme, theme);

  // Non-object theme → 400.
  const badShape = await ownerReq("/publications/site-theme/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: "blue" }),
  });
  assert.equal(badShape.status, 400);

  // Oversize theme (>4KB) → 400.
  const huge = await ownerReq("/publications/site-theme/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: { logoUrl: "x".repeat(5000) } }),
  });
  assert.equal(huge.status, 400);

  // null theme → 200, clears it.
  const cleared = await ownerReq("/publications/site-theme/settings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: null }),
  });
  assert.equal(cleared.status, 200);
  const rows2 = await readJson<Array<any>>(await ownerReq("/publications"));
  assert.equal(rows2.find((r) => r.slug === "site-theme").theme, null);
});

test("migration: a pre-column publications row reads excludeNoteIds as []", async () => {
  seedThree();
  // Insert a row directly WITHOUT excluded_note_ids (simulates a row created
  // before the migration added the column).
  db.prepare(
    `INSERT INTO publications (id, resource_type, resource, template, title, home_note_id, password_hash, theme, expires_at, created_by, created_at)
     VALUES ('legacy', 'tag', 'wiki', 'wiki', NULL, NULL, NULL, NULL, NULL, 'owner', ?)`,
  ).run(Date.now());
  addGrant({ subject_type: "anyone", subject: "*", resource_type: "tag", resource: "wiki", level: "view", created_by: "test" });

  const rows = await readJson<Array<any>>(await ownerReq("/publications"));
  const row = rows.find((r) => r.slug === "legacy");
  assert.ok(row);
  assert.deepEqual(row.excludeNoteIds, []);
  // and it still serves its full set.
  const man = await readJson(await publish.request("/legacy"));
  assert.equal(man.notes.length, 3);
});

test("GET /publications reports kind + pathPrefix/tag for both kinds", async () => {
  seedWiki();
  seedPaths();
  await ownerReq("/tags/wiki/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await ownerReq("/publish/path", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pathPrefix: "docs/guide" }),
  });

  const rows = await readJson<Array<any>>(await ownerReq("/publications"));
  const tagRow = rows.find((r) => r.kind === "tag");
  const pathRow = rows.find((r) => r.kind === "path");
  assert.ok(tagRow && tagRow.tag === "wiki" && (tagRow.pathPrefix ?? null) === null);
  assert.ok(pathRow && pathRow.pathPrefix === "docs/guide" && !pathRow.tag);
});
