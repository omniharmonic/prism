/** The canonical relationship vocabulary + synonym normalization (pure). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_RELATIONSHIPS, REL, SYNONYMS, VAULT_MANAGED, isCanonicalRelationship, normalizeRelationship, noteKinds } from "../src/relationships";

test("the canonical set is exactly what the UI and ingesters read", () => {
  assert.deepEqual([...CANONICAL_RELATIONSHIPS].sort(), ["assigned-to", "attended-by", "belongs-to", "email-from", "email-to", "has-transcript", "member-of", "messages-with", "references", "related-to", "works-at"]);
  // VaultMessagesDashboard filters on these two literals; EventTranscripts on has-transcript.
  assert.equal(REL.MESSAGES_WITH, "messages-with");
  assert.equal(REL.EMAIL_FROM, "email-from");
  assert.equal(REL.HAS_TRANSCRIPT, "has-transcript");
  for (const target of Object.values(SYNONYMS)) assert.ok(isCanonicalRelationship(target));
  for (const s of Object.keys(SYNONYMS)) assert.ok(!isCanonicalRelationship(s), `${s} is a synonym, not canonical`);
});

test("noteKinds reads tags and metadata.type", () => {
  assert.deepEqual(noteKinds({ tags: ["meeting", "transcript"] }), ["meeting"]);
  assert.deepEqual(noteKinds({ tags: [], metadata: { type: "person" } }), ["person"]);
  assert.deepEqual(noteKinds({ tags: ["doc"] }), ["other"]);
  assert.deepEqual(noteKinds({ tags: ["person", "organization"] }), ["person", "organization"]);
});

test("a synonym is rewritten only when the endpoint kinds fit", () => {
  assert.deepEqual(normalizeRelationship("attendee", ["meeting"], ["person"]), { canonical: "attended-by", reversed: false });
  assert.deepEqual(normalizeRelationship("attended", ["person"], ["meeting"]), { canonical: "attended-by", reversed: true }, "person → meeting is the same fact, written on the meeting");
  assert.deepEqual(normalizeRelationship("from", ["email"], ["person"]), { canonical: "email-from", reversed: false });
  assert.equal(normalizeRelationship("from", ["other"], ["person"]), null, "`from` between a doc and a person is not an email sender");
  assert.deepEqual(normalizeRelationship("owner", ["task"], ["person"]), { canonical: "assigned-to", reversed: false });
  assert.equal(normalizeRelationship("owner", ["project"], ["person"]), null);
  assert.deepEqual(normalizeRelationship("has-member", ["organization"], ["person"]), { canonical: "member-of", reversed: true });
  assert.deepEqual(normalizeRelationship("Relates To", ["other"], ["task"]), { canonical: "related-to", reversed: false });
  assert.deepEqual(normalizeRelationship("attended_by", ["meeting"], ["person"]), { canonical: "attended-by", reversed: false }, "a mis-spelled canonical name is normalized");
});

test("canonical, vault-managed and unknown names are left alone", () => {
  assert.equal(normalizeRelationship("attended-by", ["meeting"], ["person"]), null);
  assert.equal(normalizeRelationship("attended-by", ["person"], ["meeting"]), null, "a reversed canonical link is not rewritten");
  assert.ok(VAULT_MANAGED.has("wikilink"));
  assert.equal(normalizeRelationship("wikilink", ["other"], ["person"]), null);
  for (const unknown of ["mentions", "promised-to", "transcript-of", "same-as", "collaborates-with"]) assert.equal(normalizeRelationship(unknown, ["other"], ["person"]), null);
});
