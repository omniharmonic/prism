# D06 publication navigation contract

Verified 2026-10-02 in isolated branch `feat/publication-contract`, based on
`a36876f` (combined backend `412db96` already integrated). Source checkpoint:
`dee27c6`. This completes the reserved server half of the existing D06 navigation
contract; it is not a production deployment or full-roadmap completion claim.

## Exact scope

- Ported the held `51ec5bc` changes to `apps/server/src/publication-presentation.ts`,
  `apps/server/src/routes/acl.ts`, `apps/server/src/routes/publish.ts`, and
  `apps/server/test/publish.test.ts`.
- Imported `packages/core/src/lib/publishing/navigation.ts` unchanged from
  `c17d357` solely as the shared dependency. Its Git blob is
  `4532e47b12c926d90379fa0ada78adbb6fd4b1ff`; deduplicate this identical file when
  integrating the corresponding frontend branch.
- Added one test-only regression for persisted unknown/malformed navigation.
  The three production server files match `51ec5bc` exactly. No configuration,
  identity, MCP, schema, job, or additional route changes were made.

## Contract and privacy

The existing revisioned presentation draft accepts `theme.navigation` version 1:
up to eight named sections and 64 unique page IDs across all sections. Existing
theme size limits and draft/live revision conflict checks remain in force.
Owner drafts and history retain the configured order and stale references.

Public manifests and owner reader previews independently project preferences
against their already-authorized current note membership. Private, excluded,
missing, and out-of-publication IDs disappear; empty sections disappear with
their labels. Locked sites receive empty navigation sections. These preferences
cannot fetch a page or override access. Unsupported or malformed stored
navigation is omitted from reader themes, preserving other theme choices and
the ordinary note list for the frontend's path-tree fallback. Reader projection
does not rewrite owner preferences or advance presentation revisions.

## Verification performed

From `apps/server`:

```sh
node --import tsx --test --test-concurrency=2 --env-file=.env.test test/publish.test.ts test/publish-vaults.test.ts
```

**47 passed, 0 failed.** The checked-in fixture environment uses in-memory SQLite
and a fake vault. No production credentials, service startup, or external writes
were used. Coverage includes existing password and access behavior, current
membership/privacy, multi-vault isolation, draft/publish/restore conflict
behavior, ordered preferences, invalid-write revision stability, locked-site
section hiding, and persisted unknown/malformed-format filtering in both public
and private preview manifests.

From the worktree root:

```sh
npm run typecheck --workspace @prism/server
git diff --check
```

Both passed. The server typecheck traverses the imported shared helper. No full
suite or browser/native verification was rerun for this bounded server port.
The combined frontend/server integration and production acceptance remain the
release owner's next gates; this checkpoint does not claim they have run.
