# Fixtures

`approval-digest-vectors.json` is the output of the **server's own** `canonicalJson` and
`approvalDigest` (`apps/server/src/omni/approvals.ts`), printed by
`swift/PrismKit/Scripts/digest-vectors.ts`. PrismKit's Swift canonicaliser must reproduce
every `canonical` string and `digest` byte for byte (`ApprovalDigestTests`).

Regenerate from the repo root after any change to the server's canonical form (needs
`npm install`; `DB_PATH=:memory:` keeps it off any real database; it reads no secret and
makes no network call):

```bash
DB_PATH=:memory: npx tsx swift/PrismKit/Scripts/digest-vectors.ts \
  "$PWD/apps/server/src/omni/approvals.ts" \
  > swift/PrismKit/Tests/PrismModelsTests/Fixtures/approval-digest-vectors.json
```

All addresses, ids and text in the vectors are made up.
