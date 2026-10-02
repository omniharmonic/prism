/**
 * Duplicate detection + the explicit, owner-only merge (src/people-merge.ts).
 * In-memory vault with two-sided links and JSON-merge-patch metadata;
 * synthetic people only.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Note, NoteLink, NoteLinkInput } from "../src/parachute";
import { config } from "../src/config";
import { db, setMembership } from "../src/db";
import { adminApi } from "../src/routes/admin";
import { IdentityIndex } from "../src/identity";
import { unionIdentities } from "../src/people-metadata";
import { bodyBeyondHeading, chooseCanonical, detectDuplicates, mergePeople, MergeError, type MergeVault } from "../src/people-merge";
import { resetDb, makeSession, sessionCookie, makeCapability, installFakeVault, type FakeVault } from "./helpers";

class MemVault implements MergeVault {
  notes = new Map<string, Note>();
  edges: NoteLink[] = [];
  writes: Array<{ id: string; keys: string[]; ifUpdatedAt?: string }> = [];
  lists: Array<Record<string, unknown>> = [];
  deletes = 0;
  conflictOn = new Set<string>();
  private clock = 0;
  put(n: Partial<Note> & { id: string }, links: Array<[string, string, string]> = []): void {
    this.notes.set(n.id, { content: "", path: null, metadata: {}, createdAt: "2026-01-01", updatedAt: `v0-${n.id}`, tags: [], ...n });
    for (const [s, t, r] of links) this.edges.push({ sourceId: s, targetId: t, relationship: r });
  }
  linksOf(id: string): NoteLink[] {
    return this.edges.filter((e) => e.sourceId === id || e.targetId === id).map((e) => ({ ...e }));
  }
  out(id: string): string[] {
    return this.edges.filter((e) => e.sourceId === id).map((e) => `${e.relationship}->${e.targetId}`).sort();
  }
  people(): Note[] {
    return [...this.notes.values()].filter((n) => (n.tags ?? []).includes("person")).map((n) => ({ ...n, links: this.linksOf(n.id) }));
  }
  async listNotes(o: { includeMetadata?: string[] }): Promise<Note[]> {
    this.lists.push({ ...o });
    return [...this.notes.values()].map((n) => ({ ...n, content: "" }));
  }
  async getNote(id: string): Promise<Note> {
    const n = this.notes.get(id);
    if (!n) throw Object.assign(new Error("not found"), { status: 404 });
    return { ...n, metadata: structuredClone(n.metadata), links: this.linksOf(id) };
  }
  async updateNote(id: string, p: Parameters<MergeVault["updateNote"]>[1]): Promise<Note> {
    const n = this.notes.get(id);
    if (!n) throw Object.assign(new Error("not found"), { status: 404 });
    if (this.conflictOn.has(id) || (p.ifUpdatedAt && p.ifUpdatedAt !== n.updatedAt)) throw Object.assign(new Error("conflict"), { status: 409 });
    this.writes.push({ id, keys: Object.keys(p).filter((k) => k !== "ifUpdatedAt").sort(), ifUpdatedAt: p.ifUpdatedAt });
    if (p.content !== undefined) n.content = p.content;
    if (p.metadata) n.metadata = patch(n.metadata ?? {}, p.metadata);
    for (const t of p.tags?.add ?? []) if (!n.tags!.includes(t)) n.tags!.push(t);
    for (const r of p.links?.remove ?? []) this.edges = this.edges.filter((e) => !(e.sourceId === id && e.targetId === r.target && e.relationship === r.relationship));
    for (const a of (p.links?.add ?? []) as NoteLinkInput[]) if (!this.edges.some((e) => e.sourceId === id && e.targetId === a.target && e.relationship === a.relationship)) this.edges.push({ sourceId: id, targetId: a.target, relationship: a.relationship });
    n.updatedAt = `v${++this.clock}-${id}`;
    return { ...n };
  }
}
function patch(target: Record<string, unknown>, p: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [k, v] of Object.entries(p)) {
    if (v === null) delete out[k];
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = patch((out[k] as Record<string, unknown>) ?? {}, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

const person = (id: string, path: string, metadata: Record<string, unknown>, extra: Partial<Note> = {}): Partial<Note> & { id: string } => ({ id, path, tags: ["person"], metadata, ...extra });

function seed(v: MemVault): void {
  v.put(person("canon", "vault/people/Morgan Example", { name: "Morgan Example", email: "morgan@example.org", role: "Organizer", aliases: "Mo Example", organizations: ["Org One"] }, { content: "# Morgan Example\n\nMet at the summit." }), [
    ["thread-1", "canon", "messages-with"],
    ["canon", "org-1", "member-of"],
  ]);
  v.put(
    person("stub", "vault/people/morgan-example-org", { name: "morgan-example-org", email: "morgan@example.org", emails: ["s.example@other.test"], channels: { matrix: "@telegram_4242001:h.test", email: ["morgan@example.org"] }, phone: "+1 555 010 0700", role: "Someone else", organizations: ["Org Two"] }, { content: "# morgan-example-org\n\nAuto-created by Prism sync.\n\nPrefers calls after lunch." }),
    [
      ["email-1", "stub", "email-from"],
      ["email-2", "stub", "email-from"],
      ["thread-1", "stub", "messages-with"],
      ["doc-1", "stub", "wikilink"],
      ["stub", "org-1", "member-of"],
      ["stub", "proj-1", "member-of"],
      ["stub", "canon", "same-as"],
    ],
  );
  for (const id of ["email-1", "email-2", "thread-1", "doc-1", "org-1", "proj-1"]) v.put({ id, path: `vault/x/${id}`, tags: [] });
}

beforeEach(() => resetDb());

test("detectDuplicates: strength + evidence KINDS only; tombstones never appear", () => {
  const v = new MemVault();
  seed(v);
  v.put(person("m1", "vault/people/Robin Vale", { name: "Robin Vale" }));
  v.put(person("m2", "vault/people/robin-vale", { name: "Robin Vale" }));
  v.put(person("w1", "vault/people/J Marsh", { name: "J Marsh" }));
  v.put(person("w2", "vault/people/Jamie Marsh", { name: "Jamie Marsh" }));
  v.put(person("w3", "vault/people/Jordan Marsh", { name: "Jordan Marsh" }));
  v.put(person("n1", "vault/people/weird", { name: "kit@example.net" }));
  v.put(person("n2", "vault/people/Kit Stone", { name: "Kit Stone", email: "kit@example.net" }));
  v.put(person("dead", "vault/people/robin-old", { name: "Robin Vale", merged_into: "vault/people/Robin Vale" }, { tags: ["person", "merged-stub"] }));
  const pairs = detectDuplicates(v.people());
  const find = (a: string, b: string) => pairs.find((p) => [p.a.id, p.b.id].sort().join() === [a, b].sort().join());

  const s = find("canon", "stub")!;
  assert.equal(s.strength, "strong");
  assert.deepEqual(s.evidence, ["email", "email-derived-name"]);
  assert.equal(s.suggestedCanonicalId, "canon", "the named profile, not the address-shaped stub");
  assert.equal(find("m1", "m2")!.strength, "medium");
  assert.deepEqual(find("m1", "m2")!.evidence, ["name"]);
  assert.deepEqual(find("n1", "n2")!.evidence, ["email-as-name"]);
  assert.equal(find("w1", "w2")!.strength, "weak");
  assert.equal(find("w1", "w3")!.strength, "weak");
  assert.equal(find("w2", "w3"), undefined, "two different full names are not abbreviations of each other");
  assert.ok(!pairs.some((p) => p.a.id === "dead" || p.b.id === "dead"));
  assert.deepEqual(pairs.map((p) => p.strength), [...pairs.map((p) => p.strength)].sort((x, y) => "smw".indexOf(x[0]!) - "smw".indexOf(y[0]!)), "strongest first");
  const wire = JSON.stringify(pairs.map((p) => p.evidence));
  for (const secret of ["morgan@example.org", "@telegram_4242001", "555"]) assert.ok(!wire.includes(secret), "evidence never carries a value");
});

test("chooseCanonical / bodyBeyondHeading / unionIdentities are conservative", () => {
  const v = new MemVault();
  seed(v);
  const [c, s] = [v.people().find((n) => n.id === "canon")!, v.people().find((n) => n.id === "stub")!];
  assert.equal(chooseCanonical(c, s).id, "canon", "a written name beats a slug stub with more links");
  assert.equal(chooseCanonical({ ...c, metadata: { name: "a b" } }, { ...s, metadata: { name: "c d" } }).id, "stub", "otherwise the note with more links");
  assert.equal(bodyBeyondHeading("# Name\n\nAuto-created by Prism sync.\n"), "");
  assert.equal(bodyBeyondHeading("# Name\n\nAuto-created by Prism sync.\n\nReal note."), "Real note.");
  const u = unionIdentities(c, s);
  assert.deepEqual(u.patch, {
    channels: { email: ["s.example@other.test"], matrix: "@telegram_4242001:h.test" },
    phone: "+1 555 010 0700",
    aliases: "Mo Example, morgan-example-org",
    organizations: ["Org One", "Org Two"],
  });
  assert.ok(!("role" in u.patch!), "an existing scalar is never overwritten");
  assert.ok(!("email" in u.patch!));
});

test("merge: dry run by default writes nothing; a write run re-points both directions, unions identities, tombstones the secondary, deletes nothing", async () => {
  const v = new MemVault();
  seed(v);
  const dry = await mergePeople(v, { canonicalId: "canon", secondaryId: "stub", dryRun: true, by: "owner@test.local" });
  assert.equal(v.writes.length, 0);
  assert.deepEqual({ inbound: dry.inbound, outbound: dry.outbound, alreadyPresent: dry.alreadyPresent, notesToWrite: dry.notesToWrite, bodyAppended: dry.bodyAppended, complete: dry.complete }, { inbound: 4, outbound: 2, alreadyPresent: 2, notesToWrite: 6, bodyAppended: true, complete: false });

  const before = v.notes.size;
  const r = await mergePeople(v, { canonicalId: "canon", secondaryId: "stub", dryRun: false, by: "owner@test.local", now: Date.parse("2026-10-02T12:00:00Z") });
  assert.deepEqual({ notesWritten: r.notesWritten, conflicts: r.conflicts, errors: r.errors, tombstoned: r.tombstoned, complete: r.complete }, { notesWritten: 6, conflicts: 0, errors: 0, tombstoned: true, complete: true });
  assert.equal(v.notes.size, before, "nothing is ever deleted");
  assert.equal(v.deletes, 0);
  assert.ok(v.writes.every((w) => w.ifUpdatedAt), "CAS on every write");
  assert.equal(v.writes[0]!.id, "canon", "canonical first");
  assert.equal(v.writes.at(-1)!.id, "stub", "tombstone last");
  for (const w of v.writes.filter((x) => !["canon", "stub"].includes(x.id))) assert.deepEqual(w.keys, ["links"], "linking notes get links-only writes");
  assert.equal(v.lists.length, 1);
  assert.deepEqual(v.lists[0]!.includeMetadata, ["type"], "one lean listing for versions, never content");

  // Links: inbound re-pointed, outbound moved, the wikilink left with a references twin.
  assert.deepEqual(v.out("email-1"), ["email-from->canon"]);
  assert.deepEqual(v.out("email-2"), ["email-from->canon"]);
  assert.deepEqual(v.out("thread-1"), ["messages-with->canon"]);
  assert.deepEqual(v.out("doc-1"), ["references->canon", "wikilink->stub"]);
  assert.deepEqual(v.out("canon"), ["member-of->org-1", "member-of->proj-1"]);
  assert.deepEqual(v.out("stub"), []);

  // Canonical: gained identities, kept its own values, got the body under a marked section.
  const c = v.notes.get("canon")!;
  assert.equal(c.metadata!.email, "morgan@example.org");
  assert.equal(c.metadata!.role, "Organizer");
  assert.deepEqual(c.metadata!.channels, { email: ["s.example@other.test"], matrix: "@telegram_4242001:h.test" });
  assert.equal(c.metadata!.aliases, "Mo Example, morgan-example-org");
  assert.deepEqual(c.metadata!.organizations, ["Org One", "Org Two"]);
  assert.match(c.content, /Met at the summit\.\n\n## Merged from vault\/people\/morgan-example-org \(2026-10-02\)\n\n<!-- prism-merge:stub -->\n\nPrefers calls after lunch\.\n$/);
  assert.equal((c.metadata!.prism_merge_history as unknown[]).length, 1);

  // Secondary: the owner's tombstone convention, no identity keys left.
  const s = v.notes.get("stub")!;
  assert.ok(s.tags!.includes("merged-stub") && s.tags!.includes("person"));
  assert.equal(s.metadata!.merged_into, "vault/people/Morgan Example");
  assert.equal(s.metadata!.status, "merged_into_canonical");
  assert.equal(s.metadata!.merged_at, "2026-10-02T12:00:00.000Z");
  for (const k of ["email", "emails", "phone"]) assert.ok(!(k in s.metadata!), `${k} stripped`);
  assert.deepEqual(s.metadata!.channels, {});
  assert.ok((s.metadata!.prism_merged_identities as Record<string, unknown>).email, "kept for undo, where nothing indexes it");
  assert.match(s.content, /Prefers calls after lunch/, "the secondary's own body is untouched");

  // The identity index agrees: every key resolves to the canonical person.
  const idx = new IdentityIndex(v.people());
  for (const q of [{ email: "morgan@example.org" }, { email: "s.example@other.test" }, { matrixId: "@telegram_4242001:h.test" }, { phone: "+15550100700" }, { name: "morgan-example-org" }]) {
    const m = idx.match(q);
    assert.equal(m.status === "linked" ? m.person.id : m.status, "canon", JSON.stringify(q));
  }
  assert.equal(detectDuplicates(v.people()).length, 0);

  // Re-running the same merge is a no-op.
  const n = v.writes.length;
  const again = await mergePeople(v, { canonicalId: "canon", secondaryId: "stub", dryRun: false, by: "owner@test.local" });
  assert.equal(v.writes.length, n, "idempotent: zero writes");
  assert.deepEqual({ resumed: again.resumed, notesToWrite: again.notesToWrite, complete: again.complete }, { resumed: true, notesToWrite: 0, complete: true });
});

test("merge: a partial failure leaves more links, never fewer, and the same call finishes it", async () => {
  const v = new MemVault();
  seed(v);
  // The canonical write fails → nothing else is touched.
  v.conflictOn.add("canon");
  const blocked = await mergePeople(v, { canonicalId: "canon", secondaryId: "stub", dryRun: false, by: "o" });
  assert.deepEqual({ conflicts: blocked.conflicts, written: blocked.notesWritten, tombstoned: blocked.tombstoned, complete: blocked.complete }, { conflicts: 1, written: 0, tombstoned: false, complete: false });
  assert.equal(v.writes.length, 0);
  assert.deepEqual(v.out("email-1"), ["email-from->stub"]);

  // One linking note conflicts → it keeps its old link; everything else lands.
  v.conflictOn.clear();
  v.conflictOn.add("email-2");
  const partial = await mergePeople(v, { canonicalId: "canon", secondaryId: "stub", dryRun: false, by: "o" });
  assert.deepEqual({ conflicts: partial.conflicts, tombstoned: partial.tombstoned, complete: partial.complete }, { conflicts: 1, tombstoned: true, complete: false });
  assert.deepEqual(v.out("email-2"), ["email-from->stub"], "never forced, never dropped");
  assert.deepEqual(v.out("email-1"), ["email-from->canon"]);

  v.conflictOn.clear();
  const resume = await mergePeople(v, { canonicalId: "canon", secondaryId: "stub", dryRun: false, by: "o" });
  assert.deepEqual({ resumed: resume.resumed, inbound: resume.inbound, written: resume.notesWritten, complete: resume.complete }, { resumed: true, inbound: 2, written: 1, complete: true });
  assert.deepEqual(v.out("email-2"), ["email-from->canon"]);
  assert.equal((v.notes.get("canon")!.content.match(/prism-merge:stub/g) ?? []).length, 1, "the body is appended once");
});

test("merge refuses: the same note, a non-person, a merged canonical, a secondary merged elsewhere", async () => {
  const v = new MemVault();
  seed(v);
  v.put(person("other", "vault/people/Other One", { name: "Other One" }));
  v.put(person("gone", "vault/people/gone", { merged_into: "vault/people/Other One" }, { tags: ["person", "merged-stub"] }));
  const code = async (canonicalId: string, secondaryId: string) => {
    try {
      await mergePeople(v, { canonicalId, secondaryId, dryRun: false, by: "o" });
      return "ok";
    } catch (e) {
      return e instanceof MergeError ? e.code : String(e);
    }
  };
  assert.equal(await code("canon", "canon"), "same_person");
  assert.equal(await code("canon", "email-1"), "not_a_person");
  assert.equal(await code("canon", "nope"), "not_found");
  assert.equal(await code("gone", "canon"), "canonical_is_merged");
  assert.equal(await code("canon", "gone"), "secondary_merged_elsewhere");
  assert.equal(v.writes.length, 0);
});

// ── routes ───────────────────────────────────────────────────────────────────

let fv: FakeVault | null = null;
afterEach(() => fv?.restore());
const J = { "content-type": "application/json" };
const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
const post = (p: string, h: Record<string, string>, body: unknown = {}) => adminApi.request(p, { method: "POST", headers: h, body: JSON.stringify(body) });

test("routes: owner only, CSRF, dry run by default, one audit row per write merge", async () => {
  fv = installFakeVault();
  fv.put({ id: "a", path: "vault/people/Morgan Example", tags: ["person"], content: "# Morgan Example", metadata: { name: "Morgan Example", email: "morgan@example.org" }, links: [{ sourceId: "e1", targetId: "a", relationship: "email-from" }, { sourceId: "e2", targetId: "a", relationship: "email-from" }] });
  fv.put({ id: "b", path: "vault/people/morgan-example-org", tags: ["person"], content: "# morgan-example-org", metadata: { name: "morgan-example-org", email: "morgan@example.org" }, links: [{ sourceId: "e3", targetId: "b", relationship: "email-from" }] });
  fv.put({ id: "e3", path: "vault/messages/email/e3", tags: ["email"], links: [{ sourceId: "e3", targetId: "b", relationship: "email-from" }] });
  setMembership("primary", "admin@example.test", "admin", null);
  setMembership("primary", "coowner@example.test", "owner", null);
  for (const h of [
    J,
    { ...J, authorization: `Capability ${makeCapability("note", "a", "edit")}` },
    { ...J, cookie: sessionCookie(makeSession("guest@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("admin@example.test")) },
    { ...J, cookie: sessionCookie(makeSession("coowner@example.test")) },
  ]) {
    assert.equal((await adminApi.request("/people/duplicates", { headers: h })).status, 403);
    assert.equal((await post("/people/merge", h, { personIds: ["a", "b"], dryRun: false })).status, 403);
  }
  assert.equal((await post("/people/merge", { ...owner(), "content-type": "text/plain" }, { personIds: ["a", "b"] })).status, 415);
  assert.equal((await post("/people/merge", { ...owner(), "sec-fetch-site": "cross-site" }, { personIds: ["a", "b"] })).status, 403);
  for (const bad of [{}, { personIds: ["a"] }, { personIds: ["a", "a"] }, { personIds: ["a", "b"], canonicalId: "c" }, { personIds: ["a", "b"], dryRun: "no" }]) assert.equal((await post("/people/merge", owner(), bad)).status, 400, JSON.stringify(bad));
  assert.equal(fv.calls.length, 0, "nothing reached the vault");
  for (const bad of ["?limit=0", "?limit=500", "?offset=-1", "?strength=certain"]) assert.equal((await adminApi.request(`/people/duplicates${bad}`, { headers: owner() })).status, 400);

  const d = (await (await adminApi.request("/people/duplicates", { headers: owner() })).json()) as { pairs: Array<{ strength: string; evidence: string[]; suggestedCanonicalId: string }>; total: number; counts: Record<string, number>; next: number | null };
  assert.equal(d.total, 1);
  assert.deepEqual(d.counts, { strong: 1, medium: 0, weak: 0 });
  assert.equal(d.pairs[0]!.suggestedCanonicalId, "a");
  assert.ok(fv.calls.every((c) => c.method === "GET" && !c.search.includes("include_content")), "detection is read-only and lean");

  const dry = (await (await post("/people/merge", owner(), { personIds: ["b", "a"] })).json()) as { merge: { dryRun: boolean; canonicalId: string; notesToWrite: number } };
  assert.equal(dry.merge.dryRun, true, "dry run by default");
  assert.equal(dry.merge.canonicalId, "a", "the server picks the profile with more links");
  assert.equal(fv.calls.filter((c) => c.method !== "GET").length, 0);
  assert.equal((db.prepare("SELECT count(*) n FROM action_audit").get() as { n: number }).n, 0);
  assert.equal((await post("/people/merge", owner(), { personIds: ["a", "missing"] })).status, 404);

  const wet = await post("/people/merge", owner(), { personIds: ["a", "b"], canonicalId: "a", dryRun: false });
  assert.equal(wet.status, 200);
  const m = ((await wet.json()) as { merge: { complete: boolean; tombstoned: boolean; notesWritten: number } }).merge;
  assert.deepEqual(m, { ...m, complete: true, tombstoned: true, notesWritten: 3 });
  assert.equal(fv.calls.filter((c) => c.method === "DELETE").length, 0);
  assert.ok(fv.notes.get("b")!.tags!.includes("merged-stub"));
  assert.deepEqual(fv.notes.get("e3")!.links, [{ sourceId: "e3", targetId: "a", relationship: "email-from" }]);
  const row = db.prepare("SELECT action, status, target FROM action_audit").get() as { action: string; status: string; target: string };
  assert.equal(row.action, "admin.people-merge");
  assert.equal(row.status, "ok");
  assert.ok(!row.target.includes("morgan") && !row.target.includes("example.org"), "ids and counts only");
});
