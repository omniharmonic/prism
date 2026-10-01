/**
 * Parity A: the vault-wide "Resolve all wikilinks" server job + its owner-only
 * route. Fake vaults only (an in-memory WikilinkJobVault, and installFakeVault
 * for the route); synthetic note fixtures.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Note, NoteLinkInput } from "../src/parachute";
import { config } from "../src/config";
import { setMembership } from "../src/db";
import { adminApi } from "../src/routes/admin";
import { _resetWikilinkJob, extractWikilinks, matchTarget, startWikilinkJob, type WikilinkJobVault } from "../src/wikilinks-job";
import { resetDb, makeSession, sessionCookie, makeCapability, installFakeVault, type FakeVault } from "./helpers";

const J = { "content-type": "application/json" };

class MemVault implements WikilinkJobVault {
  notes = new Map<string, Note>();
  patches: Array<{ id: string; add: NoteLinkInput[]; ifUpdatedAt?: string; keys: string[] }> = [];
  conflictOn = new Set<string>();
  add(id: string, path: string, content: string, links: Note["links"] = []): void {
    this.notes.set(id, { id, path, content, metadata: null, createdAt: "", updatedAt: `u-${id}`, tags: [], links });
  }
  async listNotes(): Promise<Note[]> {
    return [...this.notes.values()].map((n) => ({ ...n, content: "" }));
  }
  async getNote(id: string): Promise<Note> {
    return { ...this.notes.get(id)! };
  }
  async updateNote(id: string, p: { links?: { add?: NoteLinkInput[] }; ifUpdatedAt?: string }): Promise<Note> {
    if (this.conflictOn.has(id)) throw Object.assign(new Error("conflict"), { status: 409 });
    this.patches.push({ id, add: p.links?.add ?? [], ifUpdatedAt: p.ifUpdatedAt, keys: Object.keys(p) });
    return this.notes.get(id)!;
  }
}

function seed(v: MemVault) {
  v.add("a", "vault/projects/Alpha", "See [[Beta]] and [[vault/people/Carol]] and [[beta|the beta]] and [[Missing One]].");
  v.add("b", "vault/projects/Beta", "Back to [[Alpha]]. Self: [[Beta]].", [{ sourceId: "b", targetId: "a", relationship: "references" }]);
  v.add("c", "vault/people/Carol", "No links here.");
  v.add("d", "vault/notes/Broken", "Half [[open and [[people/Carol]] fine.");
}

beforeEach(() => {
  _resetWikilinkJob();
  resetDb();
});

test("extractWikilinks: desktop semantics (|label dropped, trimmed, de-duplicated) + bracket balance", () => {
  assert.deepEqual(extractWikilinks("[[ A ]] [[b|B]] [[A]] [[]]"), { links: ["A", "b"], balanced: true });
  assert.equal(extractWikilinks("x [[open and [[ok]]").balanced, false);
});

test("matchTarget: exact path, then vault/-stripped path, then file name (case-insensitive); never the note itself", () => {
  const notes = [
    { id: "1", path: "vault/x/Report", content: "", metadata: null, createdAt: "", updatedAt: null, tags: [] },
    { id: "2", path: "Report", content: "", metadata: null, createdAt: "", updatedAt: null, tags: [] },
  ] as Note[];
  const idx = { byPath: new Map(notes.map((n) => [n.path!, n])), byStripped: new Map([["x/Report", notes[0]!], ["Report", notes[1]!]]), byName: new Map([["report", notes[0]!]]) };
  assert.equal(matchTarget("Report", idx, "z")!.id, "2", "exact path wins over a file-name match");
  assert.equal(matchTarget("x/Report", idx, "z")!.id, "1");
  assert.equal(matchTarget("REPORT", idx, "z")!.id, "1");
  assert.equal(matchTarget("x/Report", idx, "1"), null, "never links a note to itself");
});

test("dry run (the default): counts what a real run would add, writes nothing", async () => {
  const v = new MemVault();
  seed(v);
  const { done } = startWikilinkJob(v, "primary", { dryRun: true });
  await done;
  const { wikilinkJobStatus } = await import("../src/wikilinks-job");
  const j = wikilinkJobStatus()!;
  assert.equal(j.status, "done");
  assert.equal(j.dryRun, true);
  assert.equal(j.total, 4);
  assert.equal(j.scanned, 4);
  assert.equal(j.notesWithWikilinks, 3);
  assert.equal(j.wikilinks, 4 + 2 + 1, "a: Beta, vault/people/Carol, beta, Missing One; b: Alpha, Beta; d: people/Carol");
  // a→b (Beta), a→c, (beta dup → already), b→a already linked, b→Beta self → unresolved, d→c
  assert.equal(j.resolved, 3);
  assert.equal(j.alreadyLinked, 2);
  assert.equal(j.unresolved, 2);
  assert.deepEqual(j.unresolvedSample.sort(), ["Beta", "Missing One"]);
  assert.equal(j.unparseable, 1);
  assert.equal(j.notesUpdated, 2);
  assert.equal(v.patches.length, 0, "a dry run writes nothing");
});

test("real run: one links-only PATCH per note (if_updated_at, never content), already-linked notes not written, conflicts counted", async () => {
  const v = new MemVault();
  seed(v);
  v.conflictOn.add("d");
  const { done } = startWikilinkJob(v, "primary", { dryRun: false, concurrency: 2 });
  await done;
  const { wikilinkJobStatus } = await import("../src/wikilinks-job");
  const j = wikilinkJobStatus()!;
  assert.equal(j.status, "done");
  assert.equal(v.patches.length, 1);
  const p = v.patches[0]!;
  assert.equal(p.id, "a");
  assert.deepEqual(p.add, [{ target: "b", relationship: "references" }, { target: "c", relationship: "references" }]);
  assert.equal(p.ifUpdatedAt, "u-a");
  assert.deepEqual(p.keys.sort(), ["ifUpdatedAt", "links"], "no content, no metadata");
  assert.equal(j.resolved, 2);
  assert.equal(j.notesUpdated, 1);
  assert.equal(j.conflicts, 1, "d changed meanwhile → counted, not forced");
});

// ── route ────────────────────────────────────────────────────────────────────

let fv: FakeVault;
afterEach(() => fv?.restore());

const post = (p: string, h: Record<string, string>, body: unknown = {}) => adminApi.request(p, { method: "POST", headers: h, body: JSON.stringify(body) });
const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });

test("route: server owner only (403 for anon/link/guest/member/admin/vault-role owner), CSRF on POST, dry run unless dryRun:false, 409 while running", async () => {
  fv = installFakeVault();
  fv.put({ id: "a", path: "vault/A", content: "[[B]]" });
  fv.put({ id: "b", path: "vault/B", content: "x" });
  setMembership("primary", "admin@example.test", "admin", null);
  setMembership("primary", "coowner@example.test", "owner", null);
  for (const h of [
    J,
    { ...J, authorization: `Capability ${makeCapability("note", "a", "edit")}` },
    { ...J, cookie: sessionCookie(makeSession("guest@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("admin@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("coowner@example.test")) },
  ]) {
    assert.equal((await post("/wikilinks/resolve", h, { dryRun: false })).status, 403);
    assert.equal((await adminApi.request("/wikilinks/resolve", { headers: h })).status, 403);
  }
  assert.equal((await post("/wikilinks/resolve", { ...owner(), "content-type": "text/plain" })).status, 415);
  assert.equal((await post("/wikilinks/resolve", { ...owner(), "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/wikilinks/resolve", owner(), { dryRun: "no" })).status, 400);
  assert.equal(fv.calls.length, 0, "nothing reached the vault");

  const r = await post("/wikilinks/resolve", owner(), {});
  assert.equal(r.status, 202);
  const { job } = (await r.json()) as { job: { dryRun: boolean; status: string } };
  assert.equal(job.dryRun, true, "dry run by default");
  assert.equal((await post("/wikilinks/resolve", owner(), {})).status, 409, "one job at a time");
  for (let i = 0; i < 50; i++) {
    const s = (await (await adminApi.request("/wikilinks/resolve", { headers: owner() })).json()) as { job: { status: string } };
    if (s.job.status !== "running") break;
    await new Promise((res) => setTimeout(res, 5));
  }
  const s = (await (await adminApi.request("/wikilinks/resolve", { headers: owner() })).json()) as { job: { status: string; resolved: number } };
  assert.equal(s.job.status, "done");
  assert.equal(s.job.resolved, 1);
  assert.equal(fv.calls.filter((c) => c.method === "PATCH").length, 0, "dry run never writes");
});
