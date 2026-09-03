/**
 * The capability vocabulary (P1) — the pure algebra plus its storage.
 *
 * The load-bearing invariant of this phase is BACKWARD COMPATIBILITY: a grant
 * that carries no explicit caps must behave exactly as it always has. That is
 * proven here two ways — the level→caps expansions are nested, and effectiveCaps
 * agrees with expandLevel(effectiveLevel(...)) for every cap-less grant shape.
 * The db half proves the coherence rule: a caps grant's `level` column is
 * DERIVED, so a level-only consumer can never see an inflated ladder value.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  CAPS,
  LEVELS,
  isCap,
  expandLevel,
  levelForCaps,
  effectiveCaps,
  effectiveLevel,
  type Cap,
  type Level,
  type NoteRef,
} from "../src/permissions";
import {
  addGrant,
  upsertGrant,
  grantsForUser,
  grantsForResource,
  listGrantsForVault,
  db,
  type Grant,
} from "../src/db";
import { resetDb } from "./helpers";

const g = (over: Partial<Grant>): Grant => ({
  id: "g",
  vault_id: "primary",
  subject_type: "user",
  subject: "a@b.co",
  resource_type: "note",
  resource: "n1",
  level: "view",
  created_by: null,
  created_at: 0,
  expires_at: null,
  caps: null,
  ...over,
});

const sorted = (s: Iterable<Cap>) => [...s].sort();

// ------------------------------------------------------------------ pure: expansion

test("CAPS is the eight-verb vocabulary and isCap rejects anything else", () => {
  assert.deepEqual([...CAPS], ["view", "comment", "suggest", "edit", "create", "organize", "delete", "share"]);
  assert.equal(isCap("organize"), true);
  assert.equal(isCap("own"), false); // a LEVEL, not a cap
  assert.equal(isCap(null), false);
});

test("level expansions are monotone: each level's caps ⊇ the weaker level's", () => {
  for (let i = 1; i < LEVELS.length; i++) {
    const weaker = expandLevel(LEVELS[i - 1]!);
    const stronger = expandLevel(LEVELS[i]!);
    for (const c of weaker) assert.ok(stronger.has(c), `${LEVELS[i]} must keep ${c} from ${LEVELS[i - 1]}`);
    assert.ok(stronger.size > weaker.size, `${LEVELS[i]} must add something over ${LEVELS[i - 1]}`);
  }
});

test("the ladder expands to the pre-caps meanings (edit implies create, own is everything)", () => {
  assert.deepEqual(sorted(expandLevel("view")), ["view"]);
  assert.deepEqual(sorted(expandLevel("comment")), ["comment", "view"]);
  assert.deepEqual(sorted(expandLevel("suggest")), ["comment", "suggest", "view"]);
  assert.deepEqual(sorted(expandLevel("edit")), ["comment", "create", "edit", "suggest", "view"]);
  assert.deepEqual(sorted(expandLevel("own")), sorted(CAPS));
  // The two powers `edit` does NOT confer — this is what P1 makes expressible.
  assert.equal(expandLevel("edit").has("organize"), false);
  assert.equal(expandLevel("edit").has("delete"), false);
});

// ---------------------------------------------------------------- pure: levelForCaps

test("levelForCaps round-trips every level: levelForCaps(expandLevel(l)) === l", () => {
  for (const l of LEVELS) assert.equal(levelForCaps(expandLevel(l)), l);
});

test("levelForCaps is the HIGHEST fully-contained level, never an inflated one", () => {
  assert.equal(levelForCaps(["view", "create"]), "view"); // create alone ≠ edit
  assert.equal(levelForCaps(["view", "organize"]), "view");
  assert.equal(levelForCaps(["view", "comment", "suggest", "edit"]), "suggest"); // create missing
  assert.equal(levelForCaps(["view", "comment", "suggest", "edit", "create", "delete"]), "edit");
  assert.equal(levelForCaps(CAPS), "own");
});

test("a view-less cap set floors at 'view' on the ladder (documented degenerate case)", () => {
  // No level's expansion fits in a set without `view`, so the ladder has nothing
  // truthful to say; it returns its weakest value and the CAPS stay authoritative
  // (the gateway's read check goes through the caps — see gateway-caps.test.ts).
  assert.equal(levelForCaps(["create"]), "view");
  assert.equal(levelForCaps([]), "view");
});

// -------------------------------------------------------- pure: effectiveCaps agreement

test("effectiveCaps == expandLevel(effectiveLevel) for cap-less grants (every shape)", () => {
  const note: NoteRef = { id: "n1", tags: ["team", "docs"], spaceIds: ["s1"], creator: "bob@x.co" };
  const shapes: Array<{ grants: Grant[]; floor: Level | null }> = [
    { grants: [], floor: null },
    { grants: [], floor: "own" },
    { grants: [g({ level: "view" })], floor: null },
    { grants: [g({ resource_type: "tag", resource: "team", level: "edit" })], floor: null },
    { grants: [g({ resource_type: "tag", resource: "nope", level: "own" })], floor: null },
    { grants: [g({ resource_type: "space", resource: "s1", level: "comment" })], floor: null },
    { grants: [g({ resource_type: "vault", resource: "primary", level: "suggest" })], floor: null },
    // max-over-grants: the union of nested expansions is the strongest one
    {
      grants: [
        g({ id: "a", level: "view" }),
        g({ id: "b", resource_type: "tag", resource: "docs", level: "edit" }),
        g({ id: "c", resource_type: "tag", resource: "team", level: "comment" }),
      ],
      floor: null,
    },
    { grants: [g({ level: "comment" })], floor: "own" },
  ];
  for (const { grants, floor } of shapes) {
    const lvl = effectiveLevel(grants, note, floor, "alice@x.co");
    const caps = effectiveCaps(grants, note, floor, "alice@x.co");
    assert.deepEqual(sorted(caps), lvl ? sorted(expandLevel(lvl)) : [], JSON.stringify({ grants, floor }));
  }
});

test("effectiveCaps mirrors private-note semantics exactly", () => {
  const priv: NoteRef = { id: "n1", tags: ["team"], creator: "bob@x.co", visibility: "private" };
  // 1. the creator gets everything, even with no grants and no floor
  assert.deepEqual(sorted(effectiveCaps([], priv, null, "bob@x.co")), sorted(CAPS));
  // 2. a tag grant + an owner floor still reach nothing (the deny-by-construction path)
  const tagGrant = [g({ resource_type: "tag", resource: "team", level: "own" })];
  assert.deepEqual([...effectiveCaps(tagGrant, priv, "own", "alice@x.co")], []);
  // 3. only an explicit NOTE grant lets someone else in, at its own caps
  const noteGrant = [g({ resource_type: "note", resource: "n1", caps: ["view", "comment"] })];
  assert.deepEqual(sorted(effectiveCaps(noteGrant, priv, "own", "alice@x.co")), ["comment", "view"]);
  // 4. no subject = fail-closed (no creator shortcut), matching effectiveLevel
  assert.deepEqual([...effectiveCaps([], priv, "own", null)], []);
});

test("an explicit caps list overrides the grant's level, and unions across grants", () => {
  const note: NoteRef = { id: "n1", tags: ["team"] };
  // level says "own" but caps say otherwise — caps win (and the db keeps the
  // level coherent anyway; this proves the pure layer never falls back to level).
  const narrow = [g({ level: "own", caps: ["view", "create"] })];
  assert.deepEqual(sorted(effectiveCaps(narrow, note, null)), ["create", "view"]);
  // union of a caps grant and a level grant
  const union = [
    g({ id: "a", caps: ["organize"] }),
    g({ id: "b", resource_type: "tag", resource: "team", level: "comment" }),
  ];
  assert.deepEqual(sorted(effectiveCaps(union, note, null)), ["comment", "organize", "view"]);
});

test("an empty caps array falls back to the level (never 'no access by accident')", () => {
  const note: NoteRef = { id: "n1", tags: [] };
  assert.deepEqual(sorted(effectiveCaps([g({ level: "edit", caps: [] })], note, null)), sorted(expandLevel("edit")));
});

// ------------------------------------------------------------------------------- db

beforeEach(() => resetDb());

test("db: caps round-trip through the JSON column", () => {
  addGrant({ subject_type: "user", subject: "a@x.co", resource_type: "tag", resource: "team", level: "view", created_by: "t", caps: ["view", "organize"] });
  const [got] = grantsForUser("a@x.co");
  assert.deepEqual(got!.caps, ["view", "organize"]);
});

test("db: a grant with no caps reads back as null (derive from level)", () => {
  addGrant({ subject_type: "user", subject: "a@x.co", resource_type: "tag", resource: "team", level: "edit", created_by: "t" });
  assert.equal(grantsForUser("a@x.co")[0]!.caps, null);
});

test("db coherence rule: the stored level is DERIVED from the caps", () => {
  addGrant({ subject_type: "user", subject: "a@x.co", resource_type: "tag", resource: "t1", level: "own", created_by: "t", caps: ["view", "create"] });
  assert.equal(grantsForResource("tag", "t1")[0]!.level, "view", "create ≠ edit: the ladder must not inflate");

  upsertGrant({ subject_type: "user", subject: "a@x.co", resource_type: "tag", resource: "t2", level: "view", created_by: "t", caps: ["view", "comment", "suggest", "edit", "create"] });
  assert.equal(grantsForResource("tag", "t2")[0]!.level, "edit", "the full edit expansion projects back to edit");

  upsertGrant({ subject_type: "user", subject: "a@x.co", resource_type: "tag", resource: "t3", level: "view", created_by: "t", caps: [...CAPS] });
  assert.equal(grantsForResource("tag", "t3")[0]!.level, "own");
});

test("db: upsert replaces the caps in place, and a level-only re-grant clears them", () => {
  const args = { subject_type: "user", subject: "a@x.co", resource_type: "tag", resource: "team", created_by: "t" } as const;
  upsertGrant({ ...args, level: "view", caps: ["view", "organize"] });
  upsertGrant({ ...args, level: "view", caps: ["view", "delete"] });
  const rows = grantsForResource("tag", "team");
  assert.equal(rows.length, 1, "upsert must not duplicate");
  assert.deepEqual(rows[0]!.caps, ["view", "delete"]);

  upsertGrant({ ...args, level: "edit" }); // a plain level re-grant states access in full
  const after = grantsForResource("tag", "team")[0]!;
  assert.equal(after.caps, null);
  assert.equal(after.level, "edit");
});

test("db: caps are deduped and unknown names are dropped on write", () => {
  addGrant({
    subject_type: "user",
    subject: "a@x.co",
    resource_type: "tag",
    resource: "team",
    level: "own",
    created_by: "t",
    caps: ["view", "view", "wat" as Cap, "edit"],
  });
  assert.deepEqual(grantsForUser("a@x.co")[0]!.caps, ["view", "edit"]);
});

test("db: a caps list of only unknown names stores null (degrades to the level)", () => {
  addGrant({ subject_type: "user", subject: "a@x.co", resource_type: "tag", resource: "team", level: "edit", created_by: "t", caps: ["nope" as Cap] });
  const row = grantsForUser("a@x.co")[0]!;
  assert.equal(row.caps, null);
  assert.equal(row.level, "edit", "level is NOT derived when there are no usable caps");
});

test("db: garbage in the caps column reads back as null, never throws", () => {
  const grant = addGrant({ subject_type: "user", subject: "a@x.co", resource_type: "tag", resource: "team", level: "comment", created_by: "t" });
  for (const junk of ["not json", "{}", "[]", '["nope"]', '"view"', "17"]) {
    db.prepare("UPDATE grants SET caps = ? WHERE id = ?").run(junk, grant.id);
    assert.equal(grantsForUser("a@x.co")[0]!.caps, null, `junk: ${junk}`);
  }
});

test("db: the caps column exists and its migration is idempotent (re-running is a no-op)", () => {
  const cols = () => (db.prepare("PRAGMA table_info(grants)").all() as Array<{ name: string }>).filter((c) => c.name === "caps");
  assert.equal(cols().length, 1);
  // The migration guard is "add only if absent" — replay it verbatim.
  const info = db.prepare("PRAGMA table_info(grants)").all() as Array<{ name: string }>;
  if (info.length && !info.some((c) => c.name === "caps")) db.exec("ALTER TABLE grants ADD COLUMN caps TEXT");
  assert.equal(cols().length, 1);
});

test("db: the grants audit list carries caps through", () => {
  addGrant({ subject_type: "user", subject: "a@x.co", resource_type: "tag", resource: "team", level: "view", created_by: "t", caps: ["view", "share"] });
  assert.deepEqual(listGrantsForVault("primary")[0]!.caps, ["view", "share"]);
});
