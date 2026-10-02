/**
 * The identity index (src/identity.ts) + the tombstone-aware PeopleIndex.
 * Pure — no vault, synthetic people only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note } from "../src/parachute";
import { IdentityIndex, aliasList, cleanName, isNonHumanPerson, isTombstone, matrixKeys, mergedIntoRef, nameTokens, normalizePhone, personKeys, slugKey, telegramKeys } from "../src/identity";
import { PeopleIndex } from "../src/worker/people";

const person = (id: string, name: string, metadata: Record<string, unknown> = {}, extra: Partial<Note> = {}): Note => ({
  id,
  content: "",
  path: `vault/people/${name}`,
  tags: ["person"],
  metadata: { name, ...metadata },
  createdAt: "",
  updatedAt: `u-${id}`,
  ...extra,
});
const stub = (id: string, leaf: string, into: string, metadata: Record<string, unknown> = {}): Note => ({
  id,
  content: "",
  path: `vault/people/${leaf}`,
  tags: ["person", "merged-stub"],
  metadata: { merged_into: into, status: "merged_into_canonical", ...metadata },
  createdAt: "",
  updatedAt: `u-${id}`,
});
const linkedId = (m: ReturnType<IdentityIndex["match"]>) => (m.status === "linked" ? m.person.id : m.status === "review" ? `review:${m.reason}` : "none");

test("slugKey folds the three person-path slug rules to one key", () => {
  for (const v of ["J. Smith", "j--smith", "j-smith", "J Smith", "j_smith", " J.  Smith "]) assert.equal(slugKey(v), "j-smith");
  assert.equal(slugKey("Zoë Ångström"), "zoe-angstrom", "ASCII-fold slugify and the Unicode-keeping Rust rule agree");
  assert.equal(slugKey("zoë-ångström"), "zoe-angstrom");
});

test("phone normalization: digits only, no country guessing, junk refused", () => {
  assert.equal(normalizePhone("+1 (303) 555-0100"), "13035550100");
  assert.equal(normalizePhone("0013035550100"), "13035550100");
  assert.equal(normalizePhone("303.555.0100"), "3035550100");
  assert.notEqual(normalizePhone("303 555 0100"), normalizePhone("+1 303 555 0100"), "a missing country code is never inferred");
  for (const bad of ["", "12345", "call me", "a@b.test", "1234567890123456"]) assert.equal(normalizePhone(bad), null);
});

test("bridge puppets carry the remote identity; bots carry nothing extra", () => {
  assert.deepEqual(matrixKeys("@Telegram_4242:Bridge.test"), [
    { kind: "matrix", value: "@telegram_4242:bridge.test" },
    { kind: "telegram", value: "4242" },
  ]);
  assert.deepEqual(matrixKeys("@whatsapp_15550100200:h.test")[1], { kind: "phone", value: "15550100200" });
  assert.deepEqual(matrixKeys("@whatsapp_lid-998877:h.test")[1], { kind: "handle", value: "whatsapp-lid:998877" });
  assert.deepEqual(matrixKeys("@twitter_55:h.test")[1], { kind: "handle", value: "twitter:55" });
  assert.deepEqual(matrixKeys("@meta_77:h.test")[1], { kind: "handle", value: "messenger:77" });
  assert.equal(matrixKeys("@telegrambot:h.test").length, 1);
  assert.equal(matrixKeys("@alex:h.test").length, 1);
  assert.deepEqual(matrixKeys("not-an-mxid"), []);
  assert.deepEqual(telegramKeys("telegram_4242"), [{ kind: "telegram", value: "4242" }]);
  assert.deepEqual(telegramKeys("4242"), [{ kind: "telegram", value: "4242" }]);
  assert.deepEqual(telegramKeys("@Some_Handle"), [{ kind: "telegram", value: "@some_handle" }]);
  assert.deepEqual(telegramKeys("https://t.me/Some_Handle"), [{ kind: "telegram", value: "@some_handle" }]);
});

test("personKeys reads every field shape: emails, contact, channels, telegram, phone, aliases", () => {
  const k = personKeys(
    person("p", "Riley Quartz", {
      email: "Riley@Example.test",
      emails: ["second@example.test"],
      contact: "third@example.test",
      contact_emails: ["fourth@example.test"],
      channels: { email: ["fifth@example.test"], matrix: "@telegram_9001:h.test", whatsapp: "@whatsapp_15550100300:h.test" },
      telegram: "@riley_q",
      phone: "+1 555 010 0400",
      aliases: "RQ Quartz; Riles Quartz",
    }),
  );
  const have = new Set(k.strong.map((x) => `${x.kind}:${x.value}`));
  for (const want of [
    "email:riley@example.test", "email:second@example.test", "email:third@example.test", "email:fourth@example.test", "email:fifth@example.test",
    "matrix:@telegram_9001:h.test", "telegram:9001", "telegram:@riley_q", "phone:15550100300", "phone:15550100400",
  ]) assert.ok(have.has(want), want);
  assert.deepEqual(new Set(k.names), new Set(["riley-quartz", "rq-quartz", "riles-quartz"]));
  assert.deepEqual(aliasList(["A One", "B Two, C Three"]), ["A One", "B Two", "C Three"]);
  assert.deepEqual(personKeys(person("e", "x", { name: "someone@example.test" }, { path: null })).names, [], "an address used as a name is not a name key");
});

test("tombstones: tag, status or merged_into; non-humans by tag/type", () => {
  assert.ok(isTombstone(stub("s", "x", "vault/people/Y")));
  assert.ok(isTombstone(person("s", "X", { status: "merged_into_canonical" })));
  assert.ok(isTombstone(person("s", "X", { superseded_by: "[[vault/people/Y]]" })));
  assert.ok(isTombstone(person("s", "X", {}, { tags: ["person", "superseded"] })));
  assert.ok(!isTombstone(person("s", "X", { merged_into: "" })), "an empty merged_into on a live note is not a tombstone");
  assert.equal(mergedIntoRef(person("s", "X", { merged_into: "[[vault/people/Y|Y]]" })), "vault/people/Y");
  assert.ok(isNonHumanPerson(person("b", "B", {}, { tags: ["person", "non-human"] })));
  assert.ok(isNonHumanPerson(person("b", "B", { type: "bot" })));
});

test("a tombstone never claims a key: its email resolves THROUGH merged_into to the canonical person", () => {
  const canonical = person("c", "Morgan Vale", { email: "morgan@example.test" });
  const dead = stub("s", "morgan-example-test", "vault/people/Morgan Vale", { email: "morgan@example.test", emails: ["old@example.test"], channels: { matrix: "@telegram_770077:h.test" } });
  for (const seed of [[canonical, dead], [dead, canonical]]) {
    const idx = new IdentityIndex(seed);
    assert.equal(linkedId(idx.match({ email: "MORGAN@example.test" })), "c", "was ambiguous before the identity layer");
    assert.equal(linkedId(idx.match({ email: "old@example.test" })), "c", "a key only the stub knew is inherited");
    assert.equal(linkedId(idx.match({ matrixId: "@telegram_770077:h.test" })), "c");
    assert.equal(linkedId(idx.match({ telegram: "770077" })), "c", "puppet → telegram id → person");
    assert.deepEqual(idx.live().map((n) => n.id), ["c"]);
    // The shared PeopleIndex (every existing ingester) gets the same fix.
    const people = new PeopleIndex(seed);
    assert.equal(people.find({ email: "morgan@example.test" })?.id, "c");
    assert.equal(people.resolve({ name: "morgan-example-test" }).status, "candidates");
  }
});

test("merged_into chains are followed, by path or id, and cycles / dead ends are dropped", () => {
  const live = person("z", "Sam Final", {});
  const a = stub("a", "sam-a", "vault/people/sam-b", { email: "a@example.test" });
  const b = stub("b", "sam-b", "z", { email: "b@example.test" }); // by id
  const idx = new IdentityIndex([a, b, live]);
  assert.equal(linkedId(idx.match({ email: "a@example.test" })), "z");
  assert.equal(idx.canonicalOf(a)?.id, "z");

  const x = stub("x", "loop-x", "vault/people/loop-y", { email: "x@example.test" });
  const y = stub("y", "loop-y", "vault/people/loop-x", { email: "y@example.test" });
  const lost = stub("l", "lost", "vault/people/Nobody Here", { email: "lost@example.test" });
  const blank = person("k", "Blank", { status: "merged_into_canonical", email: "blank@example.test" });
  const loops = new IdentityIndex([x, y, lost, blank, live]);
  for (const e of ["x@example.test", "y@example.test", "lost@example.test", "blank@example.test"]) assert.equal(linkedId(loops.match({ email: e })), "none");
  assert.equal(loops.canonicalOf(x), null);
});

test("strong keys: one claimant links, two go to review, never a pick", () => {
  const idx = new IdentityIndex([
    person("a", "Alex Example", { email: "shared@example.test" }),
    person("b", "Blake Example", { email: "shared@example.test", phone: "+44 20 7946 0000" }),
    person("c", "Casey Example", { telegram: "@casey_ex" }),
  ]);
  const m = idx.match({ email: "shared@example.test", name: "Alex Example" });
  assert.equal(m.status, "review");
  if (m.status === "review") {
    assert.equal(m.reason, "ambiguous-key");
    assert.deepEqual(m.candidates.map((n) => n.id), ["a", "b"]);
    assert.deepEqual(m.key, { kind: "email", value: "shared@example.test" });
  }
  assert.equal(linkedId(idx.match({ phone: "+44 (20) 7946-0000" })), "b");
  assert.equal(linkedId(idx.match({ telegram: "@Casey_Ex" })), "c");
  assert.equal(linkedId(idx.match({ email: "nobody@example.test" })), "none");
});

test("name rule: a unique full name or alias links; a single token or a shared name never does", () => {
  const idx = new IdentityIndex([
    person("a", "Jordan Rivers", { aliases: "Jordy Rivers" }),
    person("b", "Jordan Lake", {}),
    person("c", "Taylor Brook", {}),
    person("d", "Taylor Brook", {}, { path: "vault/people/taylor-brook" }),
    person("e", "Zoë Ångström", {}),
  ]);
  assert.equal(linkedId(idx.match({ name: "Jordan Rivers (Telegram)" })), "a");
  assert.equal(linkedId(idx.match({ name: "jordy rivers" })), "a", "alias");
  assert.equal(linkedId(idx.match({ name: "zoe-angstrom" })), "e", "slug-equivalent");
  assert.equal(linkedId(idx.match({ name: "Jordan" })), "none", "no person is NAMED just Jordan — nothing to review");
  assert.equal(linkedId(idx.match({ name: "Taylor Brook" })), "review:ambiguous-name");
  assert.equal(linkedId(idx.match({ name: "Nobody Known" })), "none");
  assert.deepEqual(nameTokens("J. Smith (WA)"), ["j", "smith"]);
  assert.equal(cleanName("@riley:h.test"), "riley");

  const solo = new IdentityIndex([person("s", "Cher", {})]);
  assert.equal(linkedId(solo.match({ name: "Cher" })), "review:single-token-name", "single-token names never link, even when unique");
});

test("an unknown strong key beside a matching name links only when the person has nothing of that kind", () => {
  const idx = new IdentityIndex([
    person("a", "Avery Stone", { email: "avery@example.test" }),
    person("b", "Bryn Marsh", { channels: { matrix: "@telegram_10:h.test" } }),
  ]);
  assert.equal(linkedId(idx.match({ name: "Avery Stone", email: "other@example.test" })), "review:name-key-mismatch");
  assert.equal(linkedId(idx.match({ name: "Bryn Marsh", email: "bryn@example.test" })), "b", "no email on file → nothing contradicts");
  assert.equal(linkedId(idx.match({ name: "Bryn Marsh", matrixId: "@telegram_11:h.test" })), "review:name-key-mismatch");
  assert.equal(linkedId(idx.match({ name: "Bryn Marsh", matrixId: "@twitter_11:h.test" })), "b", "a different network is a different kind");
  assert.equal(linkedId(idx.match({ name: "Avery Stone", matrixId: "@avery:h.test" })), "a");
});

test("a [[wikilink]] / path / id reference resolves directly, through tombstones", () => {
  const idx = new IdentityIndex([person("a", "Dana Field", {}), stub("s", "dana-f", "vault/people/Dana Field")]);
  assert.equal(linkedId(idx.match({ ref: "[[vault/people/Dana Field]]" })), "a");
  assert.equal(linkedId(idx.match({ ref: "Dana Field" })), "a");
  assert.equal(linkedId(idx.match({ ref: "vault/people/dana-f" })), "a");
  assert.equal(linkedId(idx.match({ ref: "s" })), "a");
});

test("non-human person notes never claim or match", () => {
  const idx = new IdentityIndex([person("b", "Bridge Bot", { email: "bot@example.test" }, { tags: ["person", "non-human"] })]);
  assert.equal(linkedId(idx.match({ email: "bot@example.test" })), "none");
  assert.equal(linkedId(idx.match({ name: "Bridge Bot" })), "none");
});
