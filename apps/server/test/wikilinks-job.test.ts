/**
 * Parity A: the vault-wide "Resolve all wikilinks" server job + its owner-only
 * route. Fake vaults only (an in-memory WikilinkJobVault, and installFakeVault
 * for the route); synthetic note fixtures.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Note, NoteLinkInput } from "../src/parachute";
import { config } from "../src/config";
import { db, setMembership } from "../src/db";
import { adminApi } from "../src/routes/admin";
import { _resetWikilinkJob, buildIndex, extractWikilinks, matchTarget, startWikilinkJob, type WikilinkJobVault } from "../src/wikilinks-job";
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

test("matchTarget: exact path, then vault/-stripped path, then a UNIQUE file name; shared names are ambiguous (M2); never self", () => {
  const mk = (id: string, path: string) => ({ id, path, content: "", metadata: null, createdAt: "", updatedAt: null, tags: [] }) as Note;
  const idx = buildIndex([mk("1", "vault/x/Report"), mk("2", "Report"), mk("3", "vault/a/Plan"), mk("4", "vault/b/plan"), mk("5", "vault/c/Solo")]);
  const id = (r: ReturnType<typeof matchTarget>) => (r.kind === "match" ? r.note.id : r.kind);
  assert.equal(id(matchTarget("Report", idx, "z")), "2", "exact path wins over a file-name match");
  assert.equal(id(matchTarget("x/Report", idx, "z")), "1");
  assert.equal(id(matchTarget("SOLO", idx, "z")), "5", "a unique file name, case-insensitive");
  assert.equal(id(matchTarget("REPORT", idx, "z")), "ambiguous", "two notes are named report");
  assert.equal(id(matchTarget("REPORT", idx, "2")), "1", "excluding self leaves one");
  assert.equal(id(matchTarget("Plan", idx, "z")), "ambiguous");
  assert.equal(id(matchTarget("x/Report", idx, "1")), "none", "never links a note to itself");
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

test("M2/M3: ambiguous file names are never linked (counted + sampled); machine-written notes are not fetched; the end hook fires", async () => {
  const v = new MemVault();
  v.add("r1", "vault/a/Report", "x");
  v.add("r2", "vault/b/Report", "y");
  v.add("e", "vault/notes/Uses", "See [[Report]] and [[a/Report]].");
  v.add("disp", "vault/agent/dispatches/2026-10-01/run", "mentions [[Uses]]");
  v.notes.get("disp")!.tags = ["agent-dispatch", "agent-output"];
  const fetched: string[] = [];
  const getNote = v.getNote.bind(v);
  v.getNote = async (id: string) => {
    fetched.push(id);
    return getNote(id);
  };
  let ended: unknown = null;
  const { done } = startWikilinkJob(v, "primary", { dryRun: false, paceMs: 0, onEnd: (j) => (ended = j) });
  await done;
  const { wikilinkJobStatus } = await import("../src/wikilinks-job");
  const j = wikilinkJobStatus()!;
  assert.equal(j.ambiguous, 1);
  assert.deepEqual(j.ambiguousSample, ["Report"]);
  assert.equal(j.resolved, 1, "only the exact a/Report path link");
  assert.deepEqual(v.patches[0]!.add, [{ target: "r1", relationship: "references" }]);
  assert.equal(j.total, 4);
  assert.equal(j.candidates, 3);
  assert.ok(!fetched.includes("disp"), "a dispatch note is never fetched");
  assert.equal((ended as { status: string }).status, "done");
});

test("batch linking uses stable IDs and decoded aliases while preserving manual references",async()=>{
  const v=new MemVault();
  v.add('src','Source','<p>[[target|Renamed title]] and [[Research &amp; design]]</p>',[{sourceId:'src',targetId:'manual',relationship:'references'}]);
  v.add('target','Renamed','Body');
  v.notes.get('target')!.metadata={aliases:['Research & design']};
  v.add('manual','Manual','Body');
  await startWikilinkJob(v,'primary',{dryRun:false,paceMs:0}).done;
  assert.equal(v.patches.length,1);
  assert.deepEqual(v.patches[0]!.add,[{target:'target',relationship:'references'}]);
  assert.deepEqual(v.patches[0]!.keys.sort(),['ifUpdatedAt','links']);
  assert.ok(v.notes.get('src')!.content.includes('&amp;'),"the stored document is not rewritten");
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
  assert.equal((db.prepare("SELECT count(*) n FROM action_audit").get() as { n: number }).n, 0, "a dry run is not audited");

  // A WRITE run records one audit row (counts only) when it ends.
  assert.equal((await post("/wikilinks/resolve", owner(), { dryRun: false })).status, 202);
  for (let i = 0; i < 100; i++) {
    const w = (await (await adminApi.request("/wikilinks/resolve", { headers: owner() })).json()) as { job: { status: string } };
    if (w.job.status !== "running") break;
    await new Promise((res) => setTimeout(res, 10));
  }
  const row = db.prepare("SELECT * FROM action_audit").get() as Record<string, unknown>;
  assert.equal(row.action, "admin.wikilinks-resolve");
  assert.equal(row.status, "ok");
  assert.equal(JSON.parse(String(row.target)).resolved, 1);
  assert.ok(!String(row.target).includes("vault/"), "no paths in the audit");
});
