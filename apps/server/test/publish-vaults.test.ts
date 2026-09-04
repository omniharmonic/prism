/**
 * Vault-scoped publishing — publications carry a vault_id and the public path
 * (/api/p/*) serves the publication's OWN vault, not the primary. The
 * invariants under test are the ones the Front Range commons publish relies on:
 *   - publishing with X-Prism-Vault stamps the vault on the publication row AND
 *     on the backing anyone-grant (which lives in that vault only);
 *   - the anonymous read path (manifest / note / graph / map) reads from the
 *     publication's vault — a primary-vault publication is untouched, and the
 *     same tag published from two vaults yields two independent sites;
 *   - unpublish removes the grant in the publication's vault and never the
 *     other vault's;
 *   - the map endpoint exposes geometry of in-set notes ONLY (excluded ids and
 *     invalid/default-filled geometry dropped), and honors the password gate.
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
  addVaultEntry,
  getPublicationBySlug,
  grantsForResource,
} from "../src/db";

const OWNER = "owner@test.local";
let fv: FakeVault;

async function readJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(() => {
  resetDb();
  fv = installFakeVault();
  // A registered second vault, served by the fake at /vault/frb/api.
  addVaultEntry({ id: "frb", label: "Front Range", url: "http://vault.test", vault: "frb", token: "tok-frb" });
  fv.addVault("frb");
});
afterEach(() => fv.restore());

/** Owner request against the acl router, optionally in a non-primary vault. */
const ownerReq = (path: string, init?: RequestInit, vaultId?: string) =>
  acl.request(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      cookie: sessionCookie(makeSession(OWNER)),
      ...(vaultId ? { "x-prism-vault": vaultId } : {}),
    },
  });

/** Seed the same tag into both vaults with distinct notes. */
function seedBothVaults() {
  fv.put({ id: "p1", path: "wiki/primary-one.md", tags: ["commons"], content: "# Primary One\n\n[[Primary Two]]" });
  fv.put({ id: "p2", path: "wiki/primary-two.md", tags: ["commons"], content: "# Primary Two" });
  fv.putIn("frb", { id: "f1", path: "places/frb-one.md", tags: ["commons"], content: "# FRB One\n\nsee [[FRB Two]]" });
  fv.putIn("frb", { id: "f2", path: "places/frb-two.md", tags: ["commons"], content: "# FRB Two" });
}

// ── owner lifecycle: publish stamps the vault ───────────────────────────────

test("publish with X-Prism-Vault stamps vault_id on the row and the anyone-grant", async () => {
  seedBothVaults();

  const res = await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "front-range" }) }, "frb");
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.slug, "front-range");
  assert.equal(body.count, 2, "count is taken from the PUBLICATION's vault (frb has 2 commons notes)");

  const pub = getPublicationBySlug("front-range")!;
  assert.equal(pub.vault_id, "frb");

  // The backing anyone-grant lives in vault frb — and ONLY there.
  const inFrb = grantsForResource("tag", "commons", "frb").filter((g) => g.subject_type === "anyone");
  const inPrimary = grantsForResource("tag", "commons", "primary").filter((g) => g.subject_type === "anyone");
  assert.equal(inFrb.length, 1);
  assert.equal(inFrb[0]!.vault_id, "frb");
  assert.equal(inPrimary.length, 0, "publishing frb's tag must not open the same tag in the primary vault");
});

test("publish without the header targets the primary vault (byte-identical legacy behavior)", async () => {
  seedBothVaults();
  const res = await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({}) });
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.count, 2, "count from the primary vault");
  assert.equal(getPublicationBySlug(body.slug)!.vault_id, "primary");
  assert.equal(grantsForResource("tag", "commons", "primary").length, 1);
  assert.equal(grantsForResource("tag", "commons", "frb").length, 0);
});

test("the same tag published from two vaults yields two independent publications", async () => {
  seedBothVaults();
  const a = await readJson(await ownerReq("/tags/commons/publish", { method: "POST", body: "{}" }));
  const b = await readJson(await ownerReq("/tags/commons/publish", { method: "POST", body: "{}" }, "frb"));
  assert.notEqual(a.slug, b.slug, "slug collision resolved — two distinct sites");
  assert.equal(getPublicationBySlug(a.slug)!.vault_id, "primary");
  assert.equal(getPublicationBySlug(b.slug)!.vault_id, "frb");

  // Re-publishing in the same vault is idempotent (reuses the slug)…
  const b2 = await readJson(await ownerReq("/tags/commons/publish", { method: "POST", body: "{}" }, "frb"));
  assert.equal(b2.slug, b.slug);
});

// ── the anonymous public path serves the publication's vault ────────────────

test("manifest/note/graph read from the publication's vault, not the primary", async () => {
  seedBothVaults();
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "front-range" }) }, "frb");

  const manifest = await readJson(await publish.request("/front-range"));
  const ids = manifest.notes.map((n: { id: string }) => n.id).sort();
  assert.deepEqual(ids, ["f1", "f2"], "nav lists the frb notes only — never p1/p2 from the primary vault");

  // Single note: an frb note is served; a PRIMARY-vault note id 404s (it does
  // not exist in the publication's vault — no cross-vault id guessing).
  const ok = await publish.request("/front-range/notes/f1");
  assert.equal(ok.status, 200);
  assert.equal((await readJson(ok)).title, "FRB One");
  const cross = await publish.request("/front-range/notes/p1");
  assert.equal(cross.status, 404);

  // Graph: nodes/edges from the frb set only.
  const graph = await readJson(await publish.request("/front-range/graph"));
  assert.deepEqual(graph.nodes.map((n: { id: string }) => n.id).sort(), ["f1", "f2"]);
  assert.deepEqual(graph.edges, [{ source: "f1", target: "f2" }]);
});

test("a primary-vault publication is unaffected by (and isolated from) a vault-B publication", async () => {
  seedBothVaults();
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "primary-site" }) });
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "front-range" }) }, "frb");

  const primary = await readJson(await publish.request("/primary-site"));
  assert.deepEqual(primary.notes.map((n: { id: string }) => n.id).sort(), ["p1", "p2"]);
  const frb = await readJson(await publish.request("/front-range"));
  assert.deepEqual(frb.notes.map((n: { id: string }) => n.id).sort(), ["f1", "f2"]);
});

// ── unpublish removes the grant in the right vault only ─────────────────────

test("unpublish by slug drops the anyone-grant in the publication's vault, not the other's", async () => {
  seedBothVaults();
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "primary-site" }) });
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "front-range" }) }, "frb");

  const res = await ownerReq("/publications/front-range", { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(getPublicationBySlug("front-range"), null);
  assert.equal(grantsForResource("tag", "commons", "frb").length, 0, "frb grant removed");
  assert.equal(grantsForResource("tag", "commons", "primary").length, 1, "primary publication untouched");
  assert.equal((await publish.request("/front-range")).status, 404);
  assert.equal((await publish.request("/primary-site")).status, 200);
});

test("tag-route unpublish is scoped by the ACTIVE vault header", async () => {
  seedBothVaults();
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "primary-site" }) });
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "front-range" }) }, "frb");

  // DELETE with the frb header removes the frb publication + frb grant only.
  await ownerReq("/tags/commons/publish", { method: "DELETE" }, "frb");
  assert.equal(getPublicationBySlug("front-range"), null);
  assert.equal(getPublicationBySlug("primary-site")?.vault_id, "primary");
  assert.equal(grantsForResource("tag", "commons", "primary").length, 1);
  assert.equal(grantsForResource("tag", "commons", "frb").length, 0);
});

// ── the map endpoint: publication-scoped geometry only ──────────────────────

/** Seed geo-bearing commons notes into the frb vault. */
function seedGeo() {
  fv.putIn("frb", {
    id: "ws1",
    path: "places/watersheds/boulder-creek.md",
    tags: ["commons", "watershed"],
    content: "# Boulder Creek",
    metadata: {
      hucName: "Boulder Creek",
      // The type-specific field name — readers must check all three.
      boundaryGeometry: { type: "Polygon", coordinates: [[[-105.5, 40.0], [-105.2, 40.0], [-105.2, 40.1], [-105.5, 40.0]]] },
    },
  });
  fv.putIn("frb", {
    id: "sp1",
    path: "species/abert-squirrel.md",
    tags: ["commons", "species"],
    content: "# Abert's Squirrel",
    // The vault default-fills omitted schema'd fields with "" — not a location.
    metadata: { scientificName: "Sciurus aberti", rangeGeometry: "" },
  });
  fv.putIn("frb", {
    id: "pl1",
    path: "places/chautauqua.md",
    tags: ["commons", "place"],
    content: "# Chautauqua",
    metadata: { name: "Chautauqua Park", geo: { lat: 39.999, lon: -105.281 } },
  });
  fv.putIn("frb", {
    id: "doc1",
    path: "docs/charter.md",
    tags: ["commons"],
    content: "# Charter",
  });
  // Geometry-bearing but NOT tagged commons — must never appear on the map.
  fv.putIn("frb", {
    id: "secret-geo",
    path: "private/nest-site.md",
    tags: ["sensitive"],
    content: "# Nest",
    metadata: { geometry: { type: "Point", coordinates: [-105.3, 40.05] } },
  });
}

test("map serves in-set geometry only: tag-scoped, invalid geometry dropped, out-of-set never leaks", async () => {
  seedGeo();
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "front-range" }) }, "frb");

  const res = await publish.request("/front-range/map");
  assert.equal(res.status, 200);
  const { features } = await readJson<{ features: Array<{ id: string; name: string; kind: string; geometry: unknown; geo: unknown }> }>(res);
  const byId = new Map(features.map((f) => [f.id, f]));

  assert.deepEqual([...byId.keys()].sort(), ["pl1", "ws1"], "only in-set notes WITH real location appear");
  assert.equal(byId.get("ws1")!.kind, "watershed");
  assert.equal(byId.get("ws1")!.name, "Boulder Creek");
  assert.equal((byId.get("ws1")!.geometry as { type: string }).type, "Polygon");
  assert.equal(byId.get("pl1")!.kind, "place");
  assert.deepEqual(byId.get("pl1")!.geo, { lat: 39.999, lon: -105.281 });
  assert.ok(!byId.has("sp1"), "default-filled '' geometry is not a location");
  assert.ok(!byId.has("doc1"), "no geometry → not a feature");
  assert.ok(!byId.has("secret-geo"), "out-of-publication geometry must never leak");
});

test("map honors exclusions and the manifest advertises mapFeatureCount", async () => {
  seedGeo();
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "front-range" }) }, "frb");

  let manifest = await readJson(await publish.request("/front-range"));
  assert.equal(manifest.mapFeatureCount, 2);

  // Owner "tends" ws1 out of the public set → gone from the map AND the count.
  await ownerReq("/publications/front-range/settings", { method: "PUT", body: JSON.stringify({ excludeNoteIds: ["ws1"] }) });
  const { features } = await readJson<{ features: Array<{ id: string }> }>(await publish.request("/front-range/map"));
  assert.deepEqual(features.map((f) => f.id), ["pl1"]);
  manifest = await readJson(await publish.request("/front-range"));
  assert.equal(manifest.mapFeatureCount, 1);
});

test("map is behind the password gate (401 until unlocked); unknown slug 404s", async () => {
  seedGeo();
  await ownerReq("/tags/commons/publish", { method: "POST", body: JSON.stringify({ slug: "front-range", password: "pw" }) }, "frb");

  assert.equal((await publish.request("/front-range/map")).status, 401);
  assert.equal((await publish.request("/nope/map")).status, 404);

  // Unlock → cookie → map opens.
  const auth = await publish.request("/front-range/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "pw" }),
  });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  const res = await publish.request("/front-range/map", { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal((await readJson(res)).features.length, 2);
});

// ── path publications are vault-scoped too ──────────────────────────────────

test("path publication in vault B serves that vault's prefix", async () => {
  seedBothVaults();
  const res = await ownerReq("/publish/path", { method: "POST", body: JSON.stringify({ pathPrefix: "places", slug: "frb-places" }) }, "frb");
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.count, 2, "counted in the frb vault");
  assert.equal(getPublicationBySlug("frb-places")!.vault_id, "frb");

  const manifest = await readJson(await publish.request("/frb-places"));
  assert.deepEqual(manifest.notes.map((n: { id: string }) => n.id).sort(), ["f1", "f2"]);
});
