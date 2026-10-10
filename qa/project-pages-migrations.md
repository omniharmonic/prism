Project-page repair and hygiene are optional steps, never part of the default migration run. Run them on the Mini through `scripts/vault-hygiene/apply-all.sh`, after reviewing a counts/paths-only dry run and keeping its verified backup. The script obtains tokens from Keychain without placing them in command arguments.

Order:

1. `scripts/vault-hygiene/apply-all.sh --only m-project-repair --i-have-a-backup <backup-directory>`
2. `scripts/vault-hygiene/apply-all.sh --only m-project-hygiene --i-have-a-backup <backup-directory>`
3. Deploy live project sections and verify Meetings, Tasks, Documents and People.
4. `PROJECT_LIVE_SECTIONS_CONFIRMED=1 scripts/vault-hygiene/apply-all.sh --only m-project-indexes --i-have-a-backup <backup-directory>`

Each invocation first prints a dry run and asks whether to apply. Answer no to obtain a read-only preview. Do not pass `--yes` before reviewing the preview. The existing script verifies the backup manifest; if no backup directory is supplied, it takes a fresh backup first.

Repair creates canonical PROJECT notes for missing top-level folders and the two approved nested folders (`opencivics/icfc` and `opencivics-case-studies/planetary-regeneration-alliance`). A tagged legacy folder project already represents a project and is retained at its existing path; creating and trashing its parent would risk cascading through its child pages. The named duplicate pairs use `eth-boulder` and `bioregional-food-chain` as canonical folders. Old wikilinks resolve through canonical aliases; ordinary and ingester-owned note bodies are preserved. Membership IDs/paths and outgoing typed project links are redirected before Trash. A duplicate or index with descendants is never trashed, because Prism Trash cascades. Migration and created-note undo requests pass `require_leaf: true`; the server rechecks the subtree inside its mutation lock, and partial Trash responses fail the step. If a write conflicts, the source remains live and the step exits nonzero.

Project prose exceeding 40,000 characters is copied exactly to `Project background`, with provenance and project membership. A short project body links to that child. An existing archive with different content/provenance blocks the split or merge; nothing overwrites it. No status inference or placeholder-objective deletion occurs.

Hygiene gives populated `projects` precedence over singular `project`, preserves unknown/ambiguous values, normalizes resolvable membership to canonical wikilinks, and backfills the deepest project folder only when membership is absent. Only project bodies are read for cleanup: an exact repeated first title and the named agent boilerplate sections move out of human prose into metadata. Meeting/email/document bodies are never downloaded or rewritten. Index retirement accepts only INDEX notes containing pure generated Dataview blocks and headings; human prose prevents retirement.

Writes use fresh compare-and-set revisions and never force. Create-if-absent preserves a preexisting path. Undo logs contain private restored values, use 0600 permissions, and belong with the backup. Use the undo command printed by apply-all first without `--apply`, review it, then add `--apply`. Undo restores Trash entries, prior metadata/body and removed links; it sends unedited created notes to Prism Trash. A later human edit blocks body/metadata restoration and removal of created notes. Successful undo carries its new revision through earlier writes to the same note.


For large previews, pass `--summary-only` to `project-pages.ts`. The final `summary:` JSON counts creates, patches, body edits, membership edits, agent-context edits, other metadata edits, metadata field names, typed-link operations/additions/removals, and Trash operations. It contains no note titles, paths, metadata values or body text. Categories overlap when one patch changes multiple categories. Omit the flag for exact per-note link add/remove evidence after reviewing the compact counts. Repair rewrites only the selected duplicate’s references; general normalization and folder backfill remain in hygiene.
