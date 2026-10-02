---
name: graph-gardener
description: "Weekly graph health pass for Benjamin's Parachute vault: dangling and ambiguous links, unlinked notes by kind, relationship-name drift, stale tombstones and review-queue ageing, reported with week-over-week trend numbers. Read-mostly; every destructive or structural change is written up as a proposal for the owner, never performed."
version: 1.0.0
---

# Graph gardener (weekly)

A heavier, slower pass than `nightly-graph-weave`. It measures the graph's
health, compares with last week, and proposes fixes. It changes nothing in the
graph itself.

## Tools and credential

- **Parachute vault MCP**: `query-notes` (with `aggregate`, `has_links`,
  `has_broken_links`, `include_broken_links`, `has_ambiguous_links`,
  `include_ambiguous_links`, `include_link_count`), `list-tags`, `vault-info`,
  `doctor`, and `create-note` / `update-note` for the report and state notes
  only.
- **Prism MCP**, Benjamin's token (read is enough for measuring; the
  `prism-ro` profile): `prism_people_link_status`, `prism_people_duplicates`,
  `prism_people_review_queue`. With a Read & write token (`prism-rw`) it may
  also record merge recommendations with `prism_people_recommend_merge` (≤ 5
  per run, same rules as `nightly-graph-weave` Step 3).

## Budget and stop conditions

- ≤ 60 tool calls. Counts use `aggregate: { op: "count" }` — never list a tag
  to count it. Samples are `limit` ≤ 10 with `include_content: false`.
- Three tool errors in a row → stop and write what you have.
- If `prism_people_link_status.running` is not null, measure only (no
  recommendations).

## The canonical vocabulary

`messages-with`, `email-from`, `email-to`, `attended-by`, `has-transcript`,
`assigned-to`, `belongs-to`, `member-of`, `works-at`, `references`,
`related-to` — plus the vault-managed `wikilink`. Anything else is **drift**.

## Measurements

State note: `vault/agent/graph-gardener/state` (tag `agent-state`), metadata
`{schema: 1, lastRunAt, lastReportId, last: {<every number below>}}`. Read it
first; write it once at the end with `if_updated_at`.

1. **Linking layer** — `prism_people_link_status`: queue `open.total`,
   `byReason`, `byRelationship`, `oldestAt`, `olderThan7d`, `olderThan30d`,
   `closedLastDay`; `duplicates`; `openMergeRecommendations`; `lastJob`
   (status, at, linked, queued). Flag: queue growing week over week, any row
   older than 30 days, a last job older than 14 days or `status: error`.
2. **Unlinked notes by kind** — for each of `person`, `email`,
   `message-thread`, `meeting`, `transcript`, `task`, `project`,
   `organization`: `query-notes { tag, has_links: false, aggregate: { op: "count" } }`
   and the total `query-notes { tag, aggregate: { op: "count" } }`. Report
   count and percent. Sample 5 ids of each with `limit: 5`.
3. **Dangling links** — `query-notes { has_broken_links: true, aggregate: { op: "count" } }`,
   then a sample `query-notes { has_broken_links: true, include_broken_links: true, limit: 10, include_content: false }`.
   Group the samples' targets: a misspelt path, a renamed note, or a target
   that never existed.
4. **Ambiguous links** — the same with `has_ambiguous_links` /
   `include_ambiguous_links` (a link target that matched two or more notes —
   often a duplicate person or a duplicate path leaf).
5. **Relationship drift** — sample the links of recent notes:
   `query-notes { order_by: "updated_at", sort: "desc", limit: 25, include_links: true, include_content: false }`
   for each of `meeting`, `email`, `message-thread`, `task`, `person`. Count
   every relationship name not in the vocabulary, by name, with the source
   note's tag and `last_updated_via` / `created_via` when shown. A
   non-canonical name appearing on notes written THIS week means some writer
   (an agent, a skill, an importer) still invents names — name the writer if
   the attribution says so. **Report it; do not rewrite links.** The server's
   `normalize` phase (owner-run link job) is the only fixer.
6. **Stale tombstones** — `query-notes { tag: ["merged-stub", "superseded"], include_link_count: true, include_metadata: ["merged_into","merged_at"], limit: 25 }`.
   A stub that still has links (linkCount > 0), or whose `merged_into` does
   not resolve (`query-notes { id }` → not found), is stale: the link job's
   `tombstones` / `repoint` phases fix these — propose a run.
7. **Duplicates** — `prism_people_duplicates` counts by strength; how many
   pairs have an open recommendation; pairs older than a week with none.
8. **Vault integrity** — `doctor` (read-only); report its findings verbatim in
   one short section.

## Proposals (never performed)

For each problem, write a proposal the owner can act on, in this shape:
"**Proposal:** <what> — **why:** <numbers> — **how:** <the owner action>".
Owner actions available: run the link job phase(s) X as a dry run in Prism
(`tombstones`, `repoint`, `normalize`, `emails`, …), review the queue rows of
reason R, merge recommended pair P, create a person note for a frequently
filed unmatched sender, fix a writer that invents relationship names.

## Report

`create-note { path: "vault/agent/reports/graph-gardener/<YYYY-MM-DD>", tags: ["report"], if_exists: "error" }`:
a table of every measurement with last week's value and the change (from the
state note; "—" on the first run), then the samples (ids only), then the
proposals in priority order. Numbers come from tool results only.

## What this skill must never do

- Never delete, merge, retag or rewrite a note; never add or remove a link;
  never "normalize" a relationship name itself.
- Never decide review-queue rows (that is the nightly weave's bounded job).
- Never list a whole tag to count it, never use `force: true`.
