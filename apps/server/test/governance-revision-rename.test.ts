/**
 * governance-revision's live flag moved from `published` to `is_published` (2026-10-20,
 * tag-schemas.json: vault 0.7.9 keeps one type per field name, and `published` is a date on
 * `writing`). Signatures must not notice: the signed projection carries the VALUE under its
 * logical name, so a revision signed before the rename still verifies, one migrated by
 * scripts/vault-hygiene/migrate-field-renames.ts (a copy into `is_published`) still verifies, and a
 * revision written now (both keys) verifies too. The golden signatures below were computed with
 * the code from BEFORE the rename (commit 3ab05a2a) and the test secret.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { govSigStatus, setGovernanceSigningSecret, withGovSig } from "../src/governance-integrity";
import { parseRevision, revisionToMetadata } from "../src/governance-store";
import { revisionPublished } from "../src/governance-fields";

const SECRET = "test-governance-signing-secret-0123456789abcdef";
const TAG = "governance-revision" as const;
const legacy = (published: boolean) => ({ note: "n1", parent: "", proposal: "p9", author: "a1@test.local", origin: "proposal", published, at: "2026-01-01T00:00:00.000Z", payload: "" });
/** gov_sig of `legacy(true|false)` as id "rev-legacy", content "the text", from the pre-rename code. */
const GOLDEN = {
  true: "v1.601e5fc622e4de8e9d33c684d0d27105c2102c6d1d33b13f39b385146290e034",
  false: "v1.3d7c83cda92afa3067ee1199768f6d02fefacbe55b4c62ca7463ce9677eedc21",
};

beforeEach(() => setGovernanceSigningSecret(SECRET));
afterEach(() => setGovernanceSigningSecret(undefined));

test("revisionPublished: is_published first, else the legacy key; coerced like every governance field", () => {
  assert.equal(revisionPublished({ published: true }), true);
  assert.equal(revisionPublished({ is_published: false, published: true }), false);
  assert.equal(revisionPublished({ is_published: "true" }), true);
  assert.equal(revisionPublished({ is_published: null, published: true }), true);
  assert.equal(revisionPublished({}), false);
});

test("a revision signed BEFORE the rename (legacy key) still verifies and parses — the signature did not change", () => {
  for (const v of [true, false] as const) {
    const md = withGovSig(TAG, "rev-legacy", legacy(v), "the text") as Record<string, unknown>;
    assert.equal(md.gov_sig, GOLDEN[`${v}`], "the projection is unchanged for legacy notes");
    const note = { id: "rev-legacy", content: "the text", metadata: { ...legacy(v), gov_sig: GOLDEN[`${v}`] } };
    assert.equal(govSigStatus(TAG, note), "valid");
    assert.equal(parseRevision(note as never).published, v);
  }
});

test("the migration's copy into is_published keeps the old signature valid; a forged is_published breaks it", () => {
  const migrated = { id: "rev-legacy", content: "the text", metadata: { ...legacy(true), is_published: true, gov_sig: GOLDEN.true } };
  assert.equal(govSigStatus(TAG, migrated), "valid");
  assert.equal(parseRevision(migrated as never).published, true);
  const forged = { ...migrated, metadata: { ...migrated.metadata, is_published: false } };
  assert.equal(govSigStatus(TAG, forged), "invalid", "flipping the key that is read must break the signature");
  // A staged legacy revision cannot be made "published" by adding the new key either.
  const staged = { id: "rev-legacy", content: "the text", metadata: { ...legacy(false), is_published: true, gov_sig: GOLDEN.false } };
  assert.equal(govSigStatus(TAG, staged), "invalid");
});

test("a revision written now carries is_published plus the legacy mirror; it verifies, and an older build's reading (published) agrees", () => {
  const md = revisionToMetadata({ note: "n1", parent: "", proposal: "p9", author: "a1@test.local", origin: "proposal", published: true, at: "2026-01-01T00:00:00.000Z", payload: "" });
  assert.equal(md.is_published, true);
  assert.equal(md.published, true, "mirror for a rollback to an older build");
  const signed = withGovSig(TAG, "rev-new", md, "body") as Record<string, unknown>;
  assert.equal(govSigStatus(TAG, { id: "rev-new", content: "body", metadata: signed }), "valid");
  // The same note signed under the pre-rename projection (published only) has the same signature.
  const asLegacy = withGovSig(TAG, "rev-new", { ...md, is_published: undefined }, "body") as Record<string, unknown>;
  assert.equal(asLegacy.gov_sig, signed.gov_sig);
});
