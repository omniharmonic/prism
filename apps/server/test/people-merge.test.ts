/**
 * Duplicate detection + the explicit, owner-only merge (src/people-merge.ts,
 * src/people-metadata.ts). In-memory vault with two-sided links whose metadata
 * PATCH can run as a DEEP (RFC 7386) or a SHALLOW merge — the merge must be
 * right under both. Synthetic people only.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Note, NoteLink, NoteLinkInput } from "../src/parachute";
import { config } from "../src/config";
import { db, setMembership } from "../src/db";
import { adminApi } from "../src/routes/admin";
import { IdentityIndex } from "../src/identity";
import { stripIdentityPatch, unionIdentities } from "../src/people-metadata";
import { bodyBeyondHeading, chooseCanonical, detectDuplicates, mergePeople, MergeError, type MergeOptions, type MergeVault } from "../src/people-merge";
import { _resetPeopleCache } from "../src/people-cache";
import { _resetPeopleLock, acquirePeopleLock } from "../src/people-lock";
import { saveOwnerSettings } from "../src/people-owner";
import { resetDb, makeSession, sessionCookie, makeCapability, installFakeVault, type FakeVault } from "./helpers";

class MemVault implements MergeVault {
  notes = new Map<string, Note>();
  edges: NoteLink[] = [];
  writes: Array<{ id: string; keys: string[]; ifUpdatedAt?: string }> = [];
  lists: Array<Record<string, unknown>> = [];
  gets: string[] = [];
  conflictOn = new Set<string>();
  failOn = new Set<string>();
  private clock = 0;
  constructor(public deep = true) {}
  put(n: Partial<Note> & { id: string }, links: Array<[string, string, string]> = []): void {
    this.notes.set(n.id, { content: "", path: null, metadata: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01T00:00:00.000Z", tags: [], ...n });
    for (const [s, t, r] of links) this.edges.push({ sourceId: s, targetId: t, relationship: r });
  }
  linksOf(id: string): NoteLink[] {
    return this.edges.filter((e) => e.sourceId === id || e.targetId === id).map((e) => ({ ...e }));
  }
  out(id: string): string[] {
    return this.edges.filter((e) => e.sourceId === id).map((e) => `${e.relationship}->${e.targetId}`).sort();
  }
  people(): Note[] {
    return [...this.notes.values()].filter((n) => (n.tags ?? []).includes("person")).map((n) => structuredClone({ ...n, links: this.linksOf(n.id) }));
  }
  async listNotes(o: { includeMetadata?: string[] }): Promise<Note[]> {
    this.lists.push({ ...o });
    return [...this.notes.values()].map((n) => ({ ...n, content: "" }));
  }
  async getNote(id: string): Promise<Note> {
    this.gets.push(id);
    const n = this.notes.get(id);
    if (!n) throw Object.assign(new Error("not found"), { status: 404 });
    return structuredClone({ ...n, links: this.linksOf(id) });
  }
  async updateNote(id: string, p: Parameters<MergeVault["updateNote"]>[1]): Promise<Note> {
    const n = this.notes.get(id);
    if (!n) throw Object.assign(new Error("not found"), { status: 404 });
    if (this.failOn.has(id)) throw Object.assign(new Error("boom"), { status: 500 });
    if (!p.ifUpdatedAt) throw new Error("TEST: a write without if_updated_at would be a force write");
    if (this.conflictOn.has(id) || p.ifUpdatedAt !== n.updatedAt) throw Object.assign(new Error("conflict"), { status: 409 });
    this.writes.push({ id, keys: Object.keys(p).filter((k) => k !== "ifUpdatedAt").sort(), ifUpdatedAt: p.ifUpdatedAt });
    if (p.content !== undefined) n.content = p.content;
    if (p.metadata) n.metadata = this.deep ? deepPatch(n.metadata ?? {}, p.metadata) : shallowPatch(n.metadata ?? {}, p.metadata);
    for (const t of p.tags?.add ?? []) if (!n.tags!.includes(t)) n.tags!.push(t);
    for (const r of p.links?.remove ?? []) this.edges = this.edges.filter((e) => !(e.sourceId === id && e.targetId === r.target && e.relationship === r.relationship));
    for (const a of (p.links?.add ?? []) as NoteLinkInput[]) if (!this.edges.some((e) => e.sourceId === id && e.targetId === a.target && e.relationship === a.relationship)) this.edges.push({ sourceId: id, targetId: a.target, relationship: a.relationship });
    n.updatedAt = new Date(Date.UTC(2026, 0, 2, 0, 0, ++this.clock)).toISOString();
    return structuredClone(n);
  }
}
function deepPatch(target: Record<string, unknown>, p: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [k, v] of Object.entries(p)) {
    if (v === null) delete out[k];
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = deepPatch((out[k] as Record<string, unknown>) ?? {}, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}
/** A vault that only merges the TOP level: a nested object REPLACES the stored one. */
function shallowPatch(target: Record<string, unknown>, p: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [k, v] of Object.entries(p)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

const note = (id: string, metadata: Record<string, unknown>, extra: Partial<Note> = {}): Note => ({ id, content: "", path: `vault/people/${id}`, tags: ["person"], metadata, createdAt: "", updatedAt: "u", ...extra });
const person = (id: string, path: string, metadata: Record<string, unknown>, extra: Partial<Note> = {}): Partial<Note> & { id: string } => ({ id, path, tags: ["person"], metadata, ...extra });

function seed(v: MemVault): void {
  v.put(person("canon", "vault/people/Morgan Example", { name: "Morgan Example", email: "morgan@example.org", role: "Organizer", aliases: "Dr. Morgan (she/her)", organizations: ["Acme, Inc."], channels: { twitter: "@twitter_5500012:h.test" } }, { content: "# Morgan Example\n\nMet at the summit." }), [
    ["thread-1", "canon", "messages-with"],
    ["canon", "org-1", "member-of"],
  ]);
  v.put(
    person(
      "stub",
      "vault/people/morgan-example-org",
      { name: "morgan-example-org", email: "morgan@example.org", emails: ["m.example@other.test"], channels: { matrix: "@telegram_4242001:h.test", email: ["morgan@example.org"], signal: 42 }, phone: "+1 555 010 0700", contact: "ask at the front desk", matrixRoomIds: ["!dm:h.test"], role: "Someone else", organizations: ["Org Two"] },
      { content: "# morgan-example-org\n\nAuto-created by Prism sync.\n\nPrefers calls after lunch." },
    ),
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
const merge = (v: MemVault, o: Partial<MergeOptions> = {}) => mergePeople(v, { canonicalId: "canon", secondaryId: "stub", dryRun: false, by: "owner@test.local", ...o });

beforeEach(() => {
  resetDb();
  _resetPeopleCache();
  _resetPeopleLock();
});

test("detectDuplicates: strength + evidence KINDS only; tombstones, job titles, bare words and local numbers never pair people", () => {
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
  // Things that are NOT identity: the same job title, `telegram: "none"`, the same local phone number.
  v.put(person("x1", "vault/people/Ana One", { name: "Ana One", title: "Director", telegram: "none", phone: "555 0100" }));
  v.put(person("x2", "vault/people/Bea Two", { name: "Bea Two", title: "Director", telegram: "none", phone: "555 0100" }));
  const pairs = detectDuplicates(v.people());
  const find = (a: string, b: string) => pairs.find((p) => [p.a.id, p.b.id].sort().join() === [a, b].sort().join());

  const s = find("canon", "stub")!;
  assert.equal(s.strength, "strong");
  assert.deepEqual(s.evidence, ["email", "email-derived-name"]);
  assert.equal(s.suggestedCanonicalId, "canon", "the named profile, not the address-shaped stub");
  assert.deepEqual(find("m1", "m2")!.evidence, ["name"]);
  assert.equal(find("m1", "m2")!.strength, "medium");
  assert.deepEqual(find("n1", "n2")!.evidence, ["email-as-name"]);
  assert.equal(find("w1", "w2")!.strength, "weak");
  assert.equal(find("w2", "w3"), undefined);
  assert.equal(find("x1", "x2"), undefined, "a shared title / 'none' / local number is not a duplicate");
  assert.ok(!pairs.some((p) => p.a.id === "dead" || p.b.id === "dead"));
  const order = pairs.map((p) => "smw".indexOf(p.strength[0]!));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "strongest first");
  const wire = JSON.stringify(pairs.map((p) => p.evidence));
  for (const secret of ["morgan@example.org", "@telegram_4242001", "555"]) assert.ok(!wire.includes(secret), "evidence never carries a value");
});

test("H2 unionIdentities: append-only, existing entries verbatim, unexpected types skipped, complete nested objects", () => {
  const v = new MemVault();
  seed(v);
  const [c, s] = [v.people().find((n) => n.id === "canon")!, v.people().find((n) => n.id === "stub")!];
  assert.equal(chooseCanonical(c, s).id, "canon", "a written name beats a slug stub with more links");
  assert.equal(bodyBeyondHeading("# Name\n\nAuto-created by Prism sync.\n"), "");
  assert.equal(bodyBeyondHeading("# Name\n\nAuto-created by Prism sync.\n\nReal note."), "Real note.");
  const u = unionIdentities(c, s);
  assert.deepEqual(u.patch, {
    // the WHOLE channels object: the canonical's own twitter key rides along untouched
    channels: { twitter: "@twitter_5500012:h.test", email: ["m.example@other.test"], matrix: "@telegram_4242001:h.test" },
    phone: "+1 555 010 0700",
    aliases: "Dr. Morgan (she/her), morgan-example-org",
    organizations: ["Acme, Inc.", "Org Two"],
  });
  assert.deepEqual(u.skipped, ["secondary channels.signal"], "a non-string channel on the secondary is reported, not copied");
  assert.ok(!("role" in u.patch!) && !("email" in u.patch!), "an existing scalar is never overwritten");

  // A NUMBER on the canonical is never replaced.
  const numeric = unionIdentities(note("c", { name: "Pat Lane", channels: { telegram: 123456789 } }), note("s", { name: "pat-l", channels: { telegram: "@telegram_555000111:h.test" }, telegram: "@pat_lane" }));
  assert.ok(numeric.skipped.includes("channels.telegram"));
  assert.equal((numeric.patch?.channels as Record<string, unknown> | undefined)?.telegram, undefined, "channels.telegram: 123456789 is left exactly as it is");
  assert.equal(numeric.patch?.telegram, undefined, "and the top-level field is not used to sneak a value past it");

  // Aliases / organizations: nothing existing is re-serialized or split.
  const keep = unionIdentities(note("c", { name: "Pat Lane", aliases: ["Lane, Pat", "Dr. Pat (they/them)"], organizations: "Acme, Inc." }), note("s", { name: "P. Lane", aliases: "Patty; Dr. Pat (they/them)", organizations: ["Acme, Inc.", "Beta, LLC"] }));
  assert.deepEqual(keep.patch!.aliases, ["Lane, Pat", "Dr. Pat (they/them)", "P. Lane", "Patty"]);
  assert.equal(keep.patch!.organizations, undefined, "a value with a comma cannot join a CSV string without changing its meaning");
  assert.ok(keep.skipped.includes("organizations"));
  const csv = unionIdentities(note("c", { name: "Pat Lane", organizations: "Acme, Inc." }), note("s", { name: "pat", organizations: ["Gamma Co"] }));
  assert.equal(csv.patch!.organizations, "Acme, Inc., Gamma Co", "the existing string is kept character for character");
});

test("H2 stripIdentityPatch: only fields the canonical verifiably holds are removed", () => {
  const stub = note("s", { email: "a@example.test", emails: ["b@example.test", "c@example.test"], phone: "+1 555 010 0700", contact: "front desk, mornings", matrixRoomIds: ["!dm:h.test"], telegram: 987654321, channels: { matrix: "@telegram_4242001:h.test", signal: 42, email: ["a@example.test"] } });
  const holder = note("c", { email: "a@example.test", channels: { email: ["b@example.test"], matrix: "@telegram_4242001:h.test" } });
  const r = stripIdentityPatch(stub, holder);
  assert.deepEqual(Object.keys(r.patch).sort(), ["channels", "email"], "emails (c@ is not held), phone, telegram, contact, matrixRoomIds are NOT stripped");
  assert.deepEqual(r.patch.channels, { matrix: null, signal: 42, email: null }, "the complete channels object: untouched keys kept, removed keys null");
  assert.deepEqual(r.left.sort(), ["channels.signal", "emails", "matrixRoomIds", "phone", "telegram"]);
  assert.deepEqual(r.kept, { email: "a@example.test", channels: { matrix: "@telegram_4242001:h.test", email: ["a@example.test"] } });
});

for (const deep of [true, false])
  test(`merge under a ${deep ? "DEEP" : "SHALLOW"} metadata merge: dry run writes nothing; a write run re-points both directions, unions identities, tombstones the secondary, deletes nothing`, async () => {
    const v = new MemVault(deep);
    seed(v);
    const dry = await merge(v, { dryRun: true });
    assert.equal(v.writes.length, 0);
    assert.deepEqual(
      { inbound: dry.inbound, outbound: dry.outbound, alreadyPresent: dry.alreadyPresent, notesToWrite: dry.notesToWrite, bodyAppended: dry.bodyAppended, complete: dry.complete },
      { inbound: 4, outbound: 2, alreadyPresent: 2, notesToWrite: 6, bodyAppended: true, complete: false },
    );
    assert.deepEqual(dry.expect, { canonicalUpdatedAt: "2026-01-01T00:00:00.000Z", secondaryUpdatedAt: "2026-01-01T00:00:00.000Z" });

    const before = v.notes.size;
    const r = await merge(v, { now: Date.parse("2026-10-02T12:00:00Z"), expect: { canonicalUpdatedAt: dry.expect.canonicalUpdatedAt!, secondaryUpdatedAt: dry.expect.secondaryUpdatedAt! } });
    assert.deepEqual({ notesWritten: r.notesWritten, conflicts: r.conflicts, errors: r.errors, noStamp: r.noStamp, tombstoned: r.tombstoned, complete: r.complete }, { notesWritten: 6, conflicts: 0, errors: 0, noStamp: 0, tombstoned: true, complete: true });
    assert.equal(v.notes.size, before, "nothing is ever deleted");
    assert.ok(v.writes.every((w) => w.ifUpdatedAt), "CAS on every write");
    assert.equal(v.writes[0]!.id, "canon", "canonical first");
    assert.equal(v.writes.at(-1)!.id, "stub", "tombstone last");
    for (const w of v.writes.filter((x) => !["canon", "stub"].includes(x.id))) assert.deepEqual(w.keys, ["links"], "linking notes get links-only writes");
    assert.equal(v.lists.length, 0, "M4: four linking notes → their versions are read one by one, no vault listing");

    // Links: inbound re-pointed, outbound moved, the wikilink left with a references twin.
    assert.deepEqual(v.out("email-1"), ["email-from->canon"]);
    assert.deepEqual(v.out("thread-1"), ["messages-with->canon"]);
    assert.deepEqual(v.out("doc-1"), ["references->canon", "wikilink->stub"]);
    assert.deepEqual(v.out("canon"), ["member-of->org-1", "member-of->proj-1"]);
    assert.deepEqual(v.out("stub"), []);

    // Canonical: gained identities; everything it had is untouched — under either merge semantics.
    const c = v.notes.get("canon")!;
    assert.equal(c.metadata!.email, "morgan@example.org");
    assert.equal(c.metadata!.role, "Organizer");
    assert.deepEqual(c.metadata!.channels, { twitter: "@twitter_5500012:h.test", email: ["m.example@other.test"], matrix: "@telegram_4242001:h.test" });
    assert.equal(c.metadata!.aliases, "Dr. Morgan (she/her), morgan-example-org");
    assert.deepEqual(c.metadata!.organizations, ["Acme, Inc.", "Org Two"]);
    assert.equal(c.metadata!.phone, "+1 555 010 0700");
    assert.equal(c.content, "# Morgan Example\n\nMet at the summit.\n\n## Merged from vault/people/morgan-example-org (2026-10-02)\n\nPrefers calls after lunch.\n");
    assert.ok(!c.content.includes("<!--"), "no HTML comment marker in the body");
    assert.deepEqual(c.metadata!.prism_merged_from, ["stub"], "'body appended' is recorded in metadata");
    assert.equal((c.metadata!.prism_merge_history as unknown[]).length, 1);

    // Secondary: the owner's tombstone convention; only verifiably-moved keys are gone.
    const s = v.notes.get("stub")!;
    assert.ok(s.tags!.includes("merged-stub") && s.tags!.includes("person"));
    assert.equal(s.metadata!.merged_into, "vault/people/Morgan Example");
    assert.equal(s.metadata!.status, "merged_into_canonical");
    assert.equal(s.metadata!.merged_at, "2026-10-02T12:00:00.000Z");
    for (const k of ["email", "emails", "phone"]) assert.ok(!(k in s.metadata!), `${k} stripped`);
    assert.equal(s.metadata!.contact, "ask at the front desk", "prose in `contact` is not an identity and stays");
    assert.deepEqual(s.metadata!.matrixRoomIds, ["!dm:h.test"], "never copied, so never stripped");
    assert.equal((s.metadata!.channels as Record<string, unknown>).signal, 42, "an unreadable channel stays");
    assert.ok(!(s.metadata!.channels as Record<string, unknown>).matrix, "the moved Matrix id is gone (deleted, or a null nobody reads)");
    assert.deepEqual(r.leftOnSecondary.sort(), ["channels.signal", "matrixRoomIds"]);
    assert.ok((s.metadata!.prism_merged_identities as Record<string, unknown>).email);
    assert.match(s.content, /Prefers calls after lunch/, "the secondary's own body is untouched");

    // The identity index agrees: every key resolves to the canonical person.
    const idx = new IdentityIndex(v.people());
    for (const q of [{ email: "morgan@example.org" }, { email: "m.example@other.test" }, { matrixId: "@telegram_4242001:h.test" }, { phone: "+15550100700" }]) {
      const m = idx.match(q);
      assert.equal(m.status === "linked" ? m.person.id : m.status, "canon", JSON.stringify(q));
    }
    assert.equal(detectDuplicates(v.people()).length, 0);

    // Re-running the same merge is a no-op.
    const n = v.writes.length;
    const again = await merge(v);
    assert.equal(v.writes.length, n, "idempotent: zero writes");
    assert.deepEqual({ resumed: again.resumed, notesToWrite: again.notesToWrite, complete: again.complete }, { resumed: true, notesToWrite: 0, complete: true });
  });

test("merge: a failure at EACH step leaves more links, never fewer, and the same call finishes it", async () => {
  // Step 1 — the canonical write conflicts → nothing else is touched.
  const a = new MemVault();
  seed(a);
  a.conflictOn.add("canon");
  const s1 = await merge(a);
  assert.deepEqual({ conflicts: s1.conflicts, written: s1.notesWritten, tombstoned: s1.tombstoned, complete: s1.complete }, { conflicts: 1, written: 0, tombstoned: false, complete: false });
  assert.equal(a.writes.length, 0);
  assert.deepEqual(a.out("email-1"), ["email-from->stub"]);
  assert.equal(a.notes.get("stub")!.metadata!.email, "morgan@example.org", "the secondary still holds everything");

  // Step 1 — the canonical write ERRORS (500) → same: nothing else moves.
  const b = new MemVault();
  seed(b);
  b.failOn.add("canon");
  const s1e = await merge(b);
  assert.deepEqual({ errors: s1e.errors, written: s1e.notesWritten, tombstoned: s1e.tombstoned }, { errors: 1, written: 0, tombstoned: false });

  // Step 2 — one linking note conflicts, another errors → both keep their old link; the rest land.
  const c = new MemVault();
  seed(c);
  c.conflictOn.add("email-2");
  c.failOn.add("doc-1");
  const s2 = await merge(c);
  assert.deepEqual({ conflicts: s2.conflicts, errors: s2.errors, tombstoned: s2.tombstoned, complete: s2.complete }, { conflicts: 1, errors: 1, tombstoned: true, complete: false });
  assert.deepEqual(c.out("email-2"), ["email-from->stub"], "never forced, never dropped");
  assert.deepEqual(c.out("doc-1"), ["wikilink->stub"]);
  assert.deepEqual(c.out("email-1"), ["email-from->canon"]);
  c.conflictOn.clear();
  c.failOn.clear();
  const resume = await merge(c);
  assert.deepEqual({ resumed: resume.resumed, inbound: resume.inbound, written: resume.notesWritten, complete: resume.complete }, { resumed: true, inbound: 2, written: 2, complete: true });
  assert.deepEqual(c.out("email-2"), ["email-from->canon"]);
  assert.deepEqual(c.notes.get("canon")!.metadata!.prism_merged_from, ["stub"]);
  assert.equal(c.notes.get("canon")!.content.split("## Merged from").length, 2, "the body is appended once");

  // Step 2 — a linking note with NO version is skipped (never force-written).
  const d = new MemVault();
  seed(d);
  d.notes.get("email-1")!.updatedAt = null;
  const s2n = await merge(d);
  assert.deepEqual({ noStamp: s2n.noStamp, complete: s2n.complete }, { noStamp: 1, complete: false });
  assert.deepEqual(d.out("email-1"), ["email-from->stub"]);

  // Step 3 — the tombstone write conflicts → links already moved, secondary still live; the re-run tombstones it.
  const e = new MemVault();
  seed(e);
  e.conflictOn.add("stub");
  const s3 = await merge(e);
  assert.deepEqual({ conflicts: s3.conflicts, tombstoned: s3.tombstoned, complete: s3.complete }, { conflicts: 1, tombstoned: false, complete: false });
  assert.deepEqual(e.out("email-1"), ["email-from->canon"]);
  assert.deepEqual(e.out("stub").sort(), ["member-of->org-1", "member-of->proj-1", "same-as->canon"], "its outgoing links stay until the tombstone write lands");
  assert.ok(e.out("canon").includes("member-of->proj-1"), "…and the canonical already has them: more links, never fewer");
  e.conflictOn.clear();
  const s3r = await merge(e);
  assert.deepEqual({ tombstoned: s3r.tombstoned, complete: s3r.complete }, { tombstoned: true, complete: true });
  assert.deepEqual(e.out("stub"), []);

  // A vault that keeps failing stops the merge instead of grinding through every note.
  const f = new MemVault();
  seed(f);
  for (const id of ["email-1", "email-2", "thread-1", "doc-1"]) f.failOn.add(id);
  const ab = await merge(f, { maxConsecutiveErrors: 2 });
  assert.deepEqual({ aborted: ab.aborted, errors: ab.errors, tombstoned: ab.tombstoned, complete: ab.complete }, { aborted: true, errors: 2, tombstoned: false, complete: false });
});

test("merge: `expect` pins the reviewed versions; a large fan-in reads versions from ONE lean listing", async () => {
  const v = new MemVault();
  seed(v);
  await assert.rejects(() => merge(v, { expect: { canonicalUpdatedAt: "2025-01-01T00:00:00.000Z", secondaryUpdatedAt: "2026-01-01T00:00:00.000Z" } }), (e) => e instanceof MergeError && e.code === "stale");
  assert.equal(v.writes.length, 0);
  for (let i = 0; i < 45; i++) v.put({ id: `mail-${i}`, path: `vault/x/mail-${i}`, tags: [] }, [[`mail-${i}`, "stub", "email-from"]]);
  v.gets = [];
  const r = await merge(v);
  assert.equal(r.complete, true);
  assert.equal(v.lists.length, 1);
  assert.deepEqual(v.lists[0]!.includeMetadata, ["type"], "lean: never content");
  assert.ok(!v.gets.some((id) => id.startsWith("mail-")), "no per-note reads for a large fan-in");
});

test("M6: an open collab document — links are written and reconciled, a body append is skipped until it is closed; collab HTML gets HTML", async () => {
  const v = new MemVault();
  seed(v);
  const marks: string[] = [];
  let liveCanon = true;
  const live = { isLive: (id: string) => id === "email-1" || (liveCanon && id === "canon"), markReconciled: (id: string) => void marks.push(id) };
  const r = await merge(v, { live });
  assert.deepEqual({ bodyAppended: r.bodyAppended, bodySkippedLive: r.bodySkippedLive, tombstoned: r.tombstoned, complete: r.complete }, { bodyAppended: false, bodySkippedLive: true, tombstoned: true, complete: false });
  assert.equal(v.notes.get("canon")!.content, "# Morgan Example\n\nMet at the summit.", "an open document's body is not touched");
  assert.equal(v.notes.get("canon")!.metadata!.prism_merged_from, undefined);
  assert.deepEqual(marks.sort(), ["canon", "email-1"], "metadata/links-only writes to live notes tell the reconciler");
  liveCanon = false;
  const later = await merge(v, { live });
  assert.deepEqual({ resumed: later.resumed, bodyAppended: later.bodyAppended, complete: later.complete }, { resumed: true, bodyAppended: true, complete: true });
  assert.match(v.notes.get("canon")!.content, /## Merged from .*\n\nPrefers calls after lunch\.\n$/);

  const h = new MemVault();
  seed(h);
  h.notes.get("canon")!.content = "<h1>Morgan Example</h1><p>Met at the summit.</p>";
  await merge(h, { now: Date.parse("2026-10-02T12:00:00Z") });
  assert.equal(h.notes.get("canon")!.content, "<h1>Morgan Example</h1><p>Met at the summit.</p><h2>Merged from vault/people/morgan-example-org (2026-10-02)</h2><p>Prefers calls after lunch.</p>");
});

test("merge refuses: the same note, a non-person, a merged canonical, a secondary merged elsewhere; busy while the job holds the lock", async () => {
  const v = new MemVault();
  seed(v);
  v.put(person("other", "vault/people/Other One", { name: "Other One" }));
  v.put(person("gone", "vault/people/gone", { merged_into: "vault/people/Other One" }, { tags: ["person", "merged-stub"] }));
  const code = async (canonicalId: string, secondaryId: string) => {
    try {
      await merge(v, { canonicalId, secondaryId });
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
  const release = acquirePeopleLock("people-link-job")!;
  assert.equal(await code("canon", "stub"), "conflict");
  release();
  assert.equal(v.writes.length, 0);
});

// ── routes ───────────────────────────────────────────────────────────────────

let fv: FakeVault | null = null;
afterEach(() => fv?.restore());
const J = { "content-type": "application/json" };
const owner = () => ({ ...J, cookie: sessionCookie(makeSession(config.ownerEmail)) });
const post = (p: string, h: Record<string, string>, body: unknown = {}) => adminApi.request(p, { method: "POST", headers: h, body: JSON.stringify(body) });
type MergeBody = { merge: { dryRun: boolean; canonicalId: string; notesToWrite: number; complete: boolean; tombstoned: boolean; notesWritten: number; expect: { canonicalUpdatedAt: string; secondaryUpdatedAt: string } }; pair: { strength: string } | null; requiresConfirmUnrelated: boolean };

function seedRoute(): void {
  fv = installFakeVault();
  fv.put({ id: "a", path: "vault/people/Morgan Example", tags: ["person"], content: "# Morgan Example", metadata: { name: "Morgan Example", email: "morgan@example.org" }, links: [{ sourceId: "e1", targetId: "a", relationship: "email-from" }, { sourceId: "e2", targetId: "a", relationship: "email-from" }] });
  fv.put({ id: "b", path: "vault/people/morgan-example-org", tags: ["person"], content: "# morgan-example-org", metadata: { name: "morgan-example-org", email: "morgan@example.org" }, links: [{ sourceId: "e3", targetId: "b", relationship: "email-from" }] });
  fv.put({ id: "e3", path: "vault/messages/email/e3", tags: ["email"], links: [{ sourceId: "e3", targetId: "b", relationship: "email-from" }] });
  fv.put({ id: "u", path: "vault/people/Unrelated Person", tags: ["person"], content: "# Unrelated Person", metadata: { name: "Unrelated Person" } });
  fv.put({ id: "w", path: "vault/people/M Example", tags: ["person"], content: "# M Example", metadata: { name: "M Example" } });
}

test("routes: owner only, CSRF, dry run by default, paged duplicates from ONE cached listing", async () => {
  seedRoute();
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
  for (const bad of [{}, { personIds: ["a"] }, { personIds: ["a", "a"] }, { personIds: ["a", "b"], canonicalId: "c" }, { personIds: ["a", "b"], dryRun: "no" }, { personIds: ["a", "b"], confirmUnrelated: "yes" }])
    assert.equal((await post("/people/merge", owner(), bad)).status, 400, JSON.stringify(bad));
  assert.equal(fv!.calls.length, 0, "nothing reached the vault");
  for (const bad of ["?limit=0", "?limit=500", "?offset=-1", "?strength=certain"]) assert.equal((await adminApi.request(`/people/duplicates${bad}`, { headers: owner() })).status, 400);

  const page = async (q: string) => (await (await adminApi.request(`/people/duplicates${q}`, { headers: owner() })).json()) as { pairs: Array<{ strength: string; a: { id: string }; b: { id: string } }>; total: number; counts: Record<string, number>; next: number | null };
  const first = await page("?limit=1");
  assert.equal(first.total, 2);
  assert.deepEqual(first.counts, { strong: 1, medium: 0, weak: 1 });
  assert.equal(first.next, 1);
  const second = await page("?limit=1&offset=1");
  assert.equal(second.pairs[0]!.strength, "weak");
  await page("?strength=strong");
  const lists = fv!.calls.filter((c) => c.method === "GET" && c.path.endsWith("/notes"));
  assert.equal(lists.length, 1, "M4: three pages, one vault listing");
  assert.ok(!lists[0]!.search.includes("include_content") && lists[0]!.search.includes("include_metadata"), "lean");
});

test("H1 merge route: a write must name the survivor, quote the reviewed versions, be a detected non-weak pair, and come from a person", async () => {
  seedRoute();
  const dryRes = await post("/people/merge", owner(), { personIds: ["b", "a"] });
  const dry = (await dryRes.json()) as MergeBody;
  assert.equal(dry.merge.dryRun, true, "dry run by default");
  assert.equal(dry.merge.canonicalId, "a", "the detector's suggestion");
  assert.equal(dry.pair!.strength, "strong");
  assert.equal(fv!.calls.filter((c) => c.method !== "GET").length, 0);
  assert.equal((db.prepare("SELECT count(*) n FROM action_audit").get() as { n: number }).n, 0);
  const expect = dry.merge.expect;

  const write = (body: Record<string, unknown>, h: Record<string, string> = owner()) => post("/people/merge", h, { dryRun: false, ...body });
  const err = async (r: Response | Promise<Response>) => {
    const res = await r;
    return `${res.status} ${((await res.json()) as { error?: string }).error}`;
  };
  assert.equal(await err(write({ personIds: ["a", "b"], expect })), "400 canonical_required");
  assert.equal(await err(write({ personIds: ["a", "b"], canonicalId: "a" })), "400 expect_required");
  assert.equal(await err(write({ personIds: ["a", "b"], canonicalId: "a", expect: { canonicalUpdatedAt: "x" } })), "400 expect_required");
  assert.equal(await err(write({ personIds: ["a", "b"], canonicalId: "a", expect }, { ...owner(), "x-prism-action-origin": "agent" })), "403 agent_origin_refused");
  assert.equal(await err(write({ personIds: ["a", "b"], canonicalId: "a", expect: { canonicalUpdatedAt: "2020-01-01T00:00:00.000Z", secondaryUpdatedAt: expect.secondaryUpdatedAt } })), "409 stale");
  // Two notes the detector does not pair, and a weak pair: refused unless explicitly confirmed.
  assert.equal(await err(write({ personIds: ["a", "u"], canonicalId: "a", expect })), "409 not_a_duplicate");
  assert.equal(await err(write({ personIds: ["a", "w"], canonicalId: "a", expect })), "409 weak_match");
  // The owner's own person note can never be the note that disappears.
  saveOwnerSettings("primary", { person: "b", emails: [], aliases: [] });
  _resetPeopleCache();
  assert.equal(await err(write({ personIds: ["a", "b"], canonicalId: "a", expect })), "409 owner_is_secondary");
  assert.equal(await err(write({ personIds: ["a", "b"], canonicalId: "a", expect, confirmUnrelated: true })), "409 owner_is_secondary", "confirmUnrelated does not override it");
  saveOwnerSettings("primary", null);
  _resetPeopleCache();
  // Mutually exclusive with the job / a resolve.
  const release = acquirePeopleLock("people-link-job")!;
  assert.equal(await err(write({ personIds: ["a", "b"], canonicalId: "a", expect })), "409 busy");
  release();
  assert.equal(fv!.calls.filter((c) => c.method !== "GET").length, 0, "every refusal happened before any write");

  const wet = await write({ personIds: ["a", "b"], canonicalId: "a", expect });
  assert.equal(wet.status, 200);
  const m = ((await wet.json()) as MergeBody).merge;
  assert.deepEqual({ complete: m.complete, tombstoned: m.tombstoned, notesWritten: m.notesWritten }, { complete: true, tombstoned: true, notesWritten: 3 });
  assert.equal(fv!.calls.filter((c) => c.method === "DELETE").length, 0);
  assert.ok(fv!.calls.filter((c) => c.method === "PATCH").every((c) => (c.body as { if_updated_at?: string; force?: boolean }).if_updated_at && !(c.body as { force?: boolean }).force), "CAS, never force");
  assert.ok(fv!.notes.get("b")!.tags!.includes("merged-stub"));
  assert.deepEqual(fv!.notes.get("e3")!.links, [{ sourceId: "e3", targetId: "a", relationship: "email-from" }]);
  const row = db.prepare("SELECT action, status, target FROM action_audit").get() as { action: string; status: string; target: string };
  assert.equal(row.action, "admin.people-merge");
  assert.equal(row.status, "ok");
  assert.ok(!row.target.includes("morgan") && !row.target.includes("example.org"), "ids and counts only");

  // An explicitly confirmed unrelated merge is possible — and recorded as such.
  const d2 = (await (await post("/people/merge", owner(), { personIds: ["a", "u"], canonicalId: "a" })).json()) as MergeBody;
  assert.equal(d2.requiresConfirmUnrelated, true);
  assert.equal((await write({ personIds: ["a", "u"], canonicalId: "a", expect: d2.merge.expect, confirmUnrelated: true })).status, 200);
  const last = db.prepare("SELECT target FROM action_audit ORDER BY id DESC LIMIT 1").get() as { target: string };
  assert.equal(JSON.parse(last.target).confirmUnrelated, true);
});
