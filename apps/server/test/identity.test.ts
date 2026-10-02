/**
 * The identity index (src/identity.ts) + the tombstone-aware PeopleIndex.
 * Pure — no vault, synthetic people only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note } from "../src/parachute";
import { IdentityIndex, aliasList, cleanName, isGenericName, isNonHumanPerson, isPuppet, isTombstone, matrixKeys, mergedIntoRef, nameTokens, normalizePhone, personKeys, slugKey, telegramKeys } from "../src/identity";
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

test("phone keys need a country code; a local number is not a key; junk refused", () => {
  assert.equal(normalizePhone("+1 (303) 555-0100"), "13035550100");
  assert.equal(normalizePhone("0013035550100"), "13035550100");
  for (const bad of ["303.555.0100", "303 555 0100", "", "+12345", "call me", "a@b.test", "+1234567890123456", "ext 5", "+1 555 0100 or email"]) assert.equal(normalizePhone(bad), null, bad);
});

test("only KNOWN bridge prefixes with an id-shaped remote part are puppets", () => {
  assert.deepEqual(matrixKeys("@Telegram_424242:Bridge.test"), [
    { kind: "matrix", value: "@telegram_424242:bridge.test" },
    { kind: "telegram", value: "424242" },
  ]);
  assert.deepEqual(matrixKeys("@whatsapp_15550100200:h.test")[1], { kind: "phone", value: "15550100200" });
  assert.deepEqual(matrixKeys("@whatsapp_lid-998877:h.test")[1], { kind: "handle", value: "whatsapp-lid:998877" });
  assert.deepEqual(matrixKeys("@twitter_5500012:h.test")[1], { kind: "handle", value: "twitter:5500012" });
  assert.deepEqual(matrixKeys("@facebook_7700012:h.test")[1], { kind: "handle", value: "messenger:7700012" });
  assert.deepEqual(matrixKeys("@signal_0a1b2c3d-1111-2222-3333-444455556666:h.test")[1], { kind: "handle", value: "signal:0a1b2c3d-1111-2222-3333-444455556666" });
  // A native Matrix id with an underscore, an unknown prefix, a word after a known prefix, a bot: just an mxid.
  for (const native of ["@pat_smith:matrix.test", "@linkedin_123456:h.test", "@telegram_fan:h.test", "@telegrambot:h.test", "@alex:h.test", "@first_last_99:h.test"]) {
    assert.equal(matrixKeys(native).length, 1, native);
    assert.equal(isPuppet(native), false);
  }
  assert.deepEqual(matrixKeys("not-an-mxid"), []);
  assert.deepEqual(telegramKeys("telegram_424242"), [{ kind: "telegram", value: "424242" }]);
  assert.deepEqual(telegramKeys("424242"), [{ kind: "telegram", value: "424242" }]);
  assert.deepEqual(telegramKeys("@Some_Handle"), [{ kind: "telegram", value: "@some_handle" }]);
  assert.deepEqual(telegramKeys("https://t.me/Some_Handle"), [{ kind: "telegram", value: "@some_handle" }]);
  for (const word of ["none", "yes", "morgan", "n/a", "1234", "ask me"]) assert.deepEqual(telegramKeys(word), [], `"${word}" is not a handle`);
});

test("personKeys reads every field shape; a number-typed telegram id counts; metadata.title never names anyone", () => {
  const k = personKeys(
    person("p", "Riley Quartz", {
      email: "Riley@Example.test",
      emails: ["second@example.test"],
      contact: "third@example.test",
      contact_emails: ["fourth@example.test"],
      channels: { email: ["fifth@example.test"], matrix: "@telegram_9001001:h.test", whatsapp: "@whatsapp_15550100300:h.test", telegram: 123456789 },
      telegram: "@riley_q",
      phone: "+1 555 010 0400",
      aliases: "RQ Quartz; Riles Quartz",
      title: "Head of Research",
    }),
  );
  const have = new Set(k.strong.map((x) => `${x.kind}:${x.value}`));
  for (const want of [
    "email:riley@example.test", "email:second@example.test", "email:third@example.test", "email:fourth@example.test", "email:fifth@example.test",
    "matrix:@telegram_9001001:h.test", "telegram:9001001", "telegram:@riley_q", "telegram:123456789", "phone:15550100300", "phone:15550100400",
  ]) assert.ok(have.has(want), want);
  assert.deepEqual(k.names, ["riley-quartz"]);
  assert.deepEqual(new Set(k.aliases), new Set(["rq-quartz", "riles-quartz"]));
  assert.ok(![...k.names, ...k.aliases].includes("head-of-research"), "a job title is not a name");
  assert.deepEqual(aliasList(["A One", "B Two, C Three"]), ["A One", "B Two", "C Three"]);
  assert.deepEqual(personKeys(person("e", "x", { name: "someone@example.test" }, { path: null })).names, [], "an address used as a name is not a name key");
  // `contact` prose / a local number / a bare word in `telegram` yield nothing.
  const junk = personKeys(person("j", "Jo Bloggs", { contact: "ask at the front desk 555 0100", phone: "555 0100", telegram: "none" }));
  assert.deepEqual(junk.strong, []);
  assert.deepEqual(personKeys(person("g", "Deleted Account", {})).names, [], "a generic name is not a name key");
});

test("tombstones: tag, status or merged_into; non-humans by tag/type", () => {
  assert.ok(isTombstone(stub("s", "x", "vault/people/Y")));
  assert.ok(isTombstone(person("s", "X", { status: "merged_into_canonical" })));
  assert.ok(isTombstone(person("s", "X", { superseded_by: "[[vault/people/Y]]" })));
  assert.ok(isTombstone(person("s", "X", {}, { tags: ["person", "superseded"] })));
  assert.ok(!isTombstone(person("s", "X", { merged_into: "" })), "an empty merged_into on a live note is not a tombstone");
  assert.equal(mergedIntoRef(person("s", "X", { merged_into: "[[vault/people/Y|Y]]" })), "vault/people/Y");
  assert.ok(isTombstone(person("s", "X", { mergedInto: "vault/people/Y" })), "camelCase mergedInto too");
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

test("a name alone is a REVIEW item; allowName links a unique full name or alias, never a single token, a shared or a generic name", () => {
  const idx = new IdentityIndex([
    person("a", "Jordan Rivers", { aliases: "Jordy Rivers", title: "Chief Gardener" }),
    person("b", "Jordan Lake", {}),
    person("c", "Taylor Brook", {}),
    person("d", "Taylor Brook", {}, { path: "vault/people/taylor-brook" }),
    person("e", "Zoë Ångström", {}),
    person("u", "Unknown User", {}),
  ]);
  // Default: a display name is sender-controlled free text → review, with the one candidate.
  const def = idx.match({ name: "Jordan Rivers (Telegram)" });
  assert.equal(linkedId(def), "review:name-only");
  if (def.status === "review") assert.deepEqual(def.candidates.map((n) => n.id), ["a"]);
  // allowName (meeting attendee lists, task assignees).
  const allow = { allowName: true };
  const full = idx.match({ name: "Jordan Rivers (Telegram)" }, allow);
  assert.deepEqual(full.status === "linked" ? full.evidence : null, ["full-name"]);
  const alias = idx.match({ name: "jordy rivers" }, allow);
  assert.deepEqual(alias.status === "linked" ? [alias.person.id, ...alias.evidence] : null, ["a", "alias"]);
  assert.equal(linkedId(idx.match({ name: "zoe-angstrom" }, allow)), "e", "slug-equivalent");
  assert.equal(linkedId(idx.match({ name: "Chief Gardener" }, allow)), "none", "metadata.title is not a name");
  assert.equal(linkedId(idx.match({ name: "Jordan" }, allow)), "none", "no person is NAMED just Jordan — nothing to review");
  assert.equal(linkedId(idx.match({ name: "Taylor Brook" }, allow)), "review:ambiguous-name");
  assert.equal(linkedId(idx.match({ name: "Nobody Known" }, allow)), "none");
  for (const generic of ["Unknown User", "Deleted Account", "Guest", "Admin", "Support", "Team", "unknown", "N/A"]) {
    assert.ok(isGenericName(generic), generic);
    assert.equal(linkedId(idx.match({ name: generic }, allow)), "none", `${generic} never links or queues`);
  }
  assert.ok(!isGenericName("Guest Speaker Person"));
  assert.deepEqual(nameTokens("J. Smith (WA)"), ["j", "smith"]);
  assert.equal(cleanName("@riley:h.test"), "riley");

  const solo = new IdentityIndex([person("s", "Cher", {})]);
  assert.equal(linkedId(solo.match({ name: "Cher" }, allow)), "review:single-token-name", "single-token names never link, even when unique");
});

test("allowName: an unknown strong key beside a matching name links only when the person has nothing of that kind", () => {
  const allow = { allowName: true };
  const idx = new IdentityIndex([
    person("a", "Avery Stone", { email: "avery@example.test" }),
    person("b", "Bryn Marsh", { channels: { matrix: "@telegram_1000010:h.test" } }),
  ]);
  assert.equal(linkedId(idx.match({ name: "Avery Stone", email: "other@example.test" }, allow)), "review:name-key-mismatch");
  assert.equal(linkedId(idx.match({ name: "Bryn Marsh", email: "bryn@example.test" }, allow)), "b", "no email on file → nothing contradicts");
  assert.equal(linkedId(idx.match({ name: "Bryn Marsh", matrixId: "@telegram_1000011:h.test" }, allow)), "review:name-key-mismatch");
  assert.equal(linkedId(idx.match({ name: "Bryn Marsh", matrixId: "@twitter_1000011:h.test" }, allow)), "b", "a different network is a different kind");
  assert.equal(linkedId(idx.match({ name: "Avery Stone", matrixId: "@avery:h.test" }, allow)), "a");
  // Evidence is reported by kind; a puppet reports its network identity.
  const tg = idx.match({ matrixId: "@telegram_1000010:h.test" });
  assert.deepEqual(tg.status === "linked" ? tg.evidence : null, ["telegram"]);
  const em = idx.match({ email: "avery@example.test", name: "Whoever" });
  assert.deepEqual(em.status === "linked" ? em.evidence : null, ["email"]);
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

test("a key held only by a non-human note or an unresolvable tombstone is CLAIMED: no link, no review, no creation", () => {
  const idx = new IdentityIndex([
    person("bot", "Notetaker", { email: "notetaker@bots.test" }, { tags: ["person", "bot"] }),
    stub("lost", "lost-one", "vault/people/Nobody Here", { email: "lost@example.test" }),
    person("live", "Live One", { email: "shared@example.test" }),
    person("org", "Some Org", { email: "shared@example.test", type: "organization" }),
  ]);
  assert.deepEqual(idx.match({ email: "notetaker@bots.test", name: "Live One" }), { status: "none", claimed: true });
  assert.deepEqual(idx.match({ email: "lost@example.test" }), { status: "none", claimed: true });
  assert.equal(linkedId(idx.match({ email: "shared@example.test" })), "review:ambiguous-key", "a live person sharing a key with a non-human is not a clean match");
  assert.equal(idx.claimedBy({ kind: "email", value: "notetaker@bots.test" }).length, 1);
});

test("merged_into may be an exact NAME of one other live person", () => {
  const idx = new IdentityIndex([person("c", "Fay Grove", {}), stub("s", "fay-old", "Fay Grove", { email: "fay@example.test" }), stub("t", "who-old", "Shared Name", { email: "who@example.test" }), person("x", "Shared Name", {}, { path: "vault/people/shared-1" }), person("y", "Shared Name", {}, { path: "vault/people/shared-2" })]);
  assert.equal(linkedId(idx.match({ email: "fay@example.test" })), "c");
  assert.deepEqual(idx.match({ email: "who@example.test" }), { status: "none", claimed: true }, "a name two people share resolves nothing");
});
