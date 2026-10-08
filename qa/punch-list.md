# Prism punch list — Phase 1A

Prepared for Benjamin Life (@omniharmonic) · 2026-10-08 · branch `claude/optimistic-gauss-av0cql`

**How this was made.** From a cloud workspace with the repo and read-only access to the
production vault. There was no Mac Mini, no dev vault and no real browser session against
live data, so the "QA sweep" is the repo's fixture suite: real Prism UI running against
recorded/fake servers in headless Chromium, plus a read-only vault health report. Anything
that only shows up on live data still needs your click-through.

Severity: **S1** crash or data-loss risk · **S2** feature broken or misleading · **S3** polish.

## Fixed (with tests)

| # | Sev | Area | Issue | Fix | Tests | Commit |
|---|---|---|---|---|---|---|
| 1 | S1 | Canvas | New canvas crashed, then loaded: a failed editor-chunk download was remembered by the browser, so Retry never refetched and Prism reloaded the page | Chunks retry with a cache-busting re-import; "Loading the canvas…" + Try again instead of the crash card; stale-build reload waits and is cancelled by a good retry | `canvas-create.spec`, `collab-storage.spec` | 0527a1a |
| 2 | S1 | Canvas | Some shared-scene entries (invalid order key, line without points, typeless element) froze or crashed Excalidraw | Every scene is sanitised before painting; the stored scene is never changed | `canvas-scene-guard.spec` (3 fail on old code) | 0527a1a |
| 3 | S1 | Canvas / collab | A failed first vault read made the server seed a canvas as a text document → empty canvas, and a store could write HTML over the scene | Unknown kind → load refused as `busy` (client retries); store never writes an unknown kind | `collab-kind-guard.test` (2 fail on old code) | 0527a1a |
| 4 | S2 | Agent visibility | History / Updates credited agent and sync edits to the last human who typed (vault merges metadata, old stamp survived) | Stamp counts only within 10 s of the change; otherwise "Changed outside Prism"; owner sees which agent/connection (vault actor/via) | `agent-visibility.test` (client = server matrix), `notion-history.spec` | d7993dc |
| 5 | S2 | Agent visibility | External edit folded into an open page was saved under the last typist's name | Folded store is stamped `external` | same | 0527a1a |
| 6 | S2 | Agent visibility | Agent sessions didn't list notes changed through Prism MCP tools | `note_touched` for every Prism MCP write tool | `agent-visibility.test` | d7993dc |
| 7 | S2 | Databases | A field's type could only be set after creating it; no select options at creation; no "+" column | One "New property" form (type, options + colours, number format, relation target + one/many, date) from Add property and a new "+" table header; one schema write | `notion-db-relations.spec`, `database-relations.test` | d092e4e |
| 8 | S2 | Databases | `projects` didn't link to `project`; pickers searched all pages; no inline create | Relation fields carry a target (tag or folder); picker searches only it, offers "Create “…”"; writes full-path links; reads all 4 stored encodings (incl. folder links → PROJECT); targets inferred from field names | same | d092e4e |
| 9 | S2 | Databases | Only "from a tag" creation | **New database** dialog (approved path): name → new tag → fields → first view; resumable | `notion-db-new.spec`, `database-new.test` | be00a81 |
| 10 | S2 | Messages | Category tags in Title Case, hard-coded colours, collapsible tiers that made rows jump, `triage-failed` stuck in Needs triage | One chip row with counts, one status chip per row, stable newest-first order, "Couldn't classify" + send back | `messages-triage.spec`, `inbox*.spec` | 325db08 |
| 11 | S2 | Messages | A status change was two writes (could land half-done); members' status changes were silently ignored | `changeTags`: one PATCH in the owner or member dialect | `messages-triage.spec` | 325db08 |
| 12 | S3 | Global UI | Buttons too padded on desktop (44 px touch size applied everywhere) | Control-size tokens; desktop buttons ≥ 40 px: 105 → 45 of ~890; phones keep 44 px | `ui-controls.spec`, a11y touch/reflow specs | be00a81 |
| 13 | S3 | Global UI | Long URLs / emails / ids pushed layouts wide | Wrap rules + `.u-truncate` / `.u-clamp-2`; no horizontal scroll at 320 px | `ui-controls.spec` | be00a81 |

Before/after screenshots for #12–13: `qa/screenshots/ui-tokens/{before,after}/` (14 surfaces, desktop + phone).

## Needs your eyes / decisions

| # | Item | Options |
|---|---|---|
| D1 | Messages opens on **All, newest first** (not priority tiers) | Keep, or open on Urgent + Action required |
| D2 | Search in Messages stays inside the selected category | Keep, or search everything |
| D3 | Relation-target backfill (`POST /api/schemas/relation-targets`, owner, dry run first) — adds target hints to existing fields, never touches values | Run the dry run, then decide on fields it can't infer (e.g. `epic`, `parent`, `related`, `area`) |
| D4 | New database: a board/calendar needs a Status/Date field; the dialog explains instead of adding one | Keep, or auto-add |
| D5 | Vault schema fixes S1–S13 and data migrations M-a…M-e | See `qa/vault-migrations.md`; each needs your yes + a backup |
| D6 | Per-agent vault tokens + a "Recent agent changes" feed (so every agent is named, not just "outside Prism") | Design notes in the agent-visibility fix; your call on token lifetimes and the feed |

## Deferred (with reason)

| # | Item | Why |
|---|---|---|
| X1 | Other database-creation paths (template, folder, search/selection) | You chose "blank with schema" only for now; designs in the root-cause notes |
| X2 | Rewriting stored relation values to full-path links | Data migration — needs approval (reads already handle every form) |
| X3 | Email has no status control inside the opened email | Outside this pass; list chips cover it |
| X4 | Heading links (`/page/<id>#h-…`) open the page at the top in the native app | `links.rs` drops the fragment; for the native-apps phase |
| X5 | ~64 hand-styled button classes still set their own padding (only the 44 px desktop ones were changed) | Lower value; tokens are in place for a follow-up sweep |
| X6 | A move / trash / restore inside Prism writes no stamp, so it can read "Changed outside Prism" | Small follow-up to the attribution fix |

## Pre-existing failures (not caused by this work)

Checked by running the same tests on the commit this work started from (`95491a4`):

- `notion-sidebar.spec`: 3 tests (sidebar peek ×2, new-page timing) fail on the original code too — likely this headless browser build, not the app. Re-check on the laptop.
- Server timing tests `conversion-round5` H-1/H-2 and `duplicate` S3 fail on the original code here (event-loop timing on a 4-core container). `conversion-round5` C-1 failed in this run and passed on the original code; it is load-sensitive.
- `lazy-editors.spec` "a delayed code engine…" (redo loses a local edit) — pre-existing.
- `settings-appearance` clipping — fails with the UI changes reverted.

Full-suite results: see "Regression run" below.

## Regression run

_Filled in when the full fixture run finishes._
