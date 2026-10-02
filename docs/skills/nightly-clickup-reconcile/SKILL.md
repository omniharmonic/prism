---
name: nightly-clickup-reconcile
description: "Nightly ClickUp mirror reconcile: flag mirror notes whose ClickUp task was deleted or archived, and write Benjamin's local status/priority/due edits back to ClickUp. Moved unchanged out of the old nightly-parachute-weave (Step 6 and its guardrails)."
version: 1.0.0
---

# Nightly ClickUp mirror reconcile

These instructions were MOVED, not redesigned, from Step 6 of the old
`nightly-parachute-weave` task when graph maintenance became its own skill
(`nightly-graph-weave`). Run it as its own scheduled routine (or as the last
step of another nightly routine), with the Parachute vault tools and the
ClickUp connector loaded.

Load the Parachute tools with ToolSearch ("parachute notes"): `query-notes`,
`update-note`, `create-note`. Write a short report note at the end (tag
`report`, path `vault/agent/reports/clickup-reconcile/<YYYY-MM-DD>`) with the
"ClickUp mirror" section described below; if the old weave report is still
written by another routine, you may append the section there instead.

## ClickUp task mirror: reconcile and write back

Prism's server polls ClickUp every 5 minutes and mirrors tasks assigned to Benjamin into notes tagged `clickup` (metadata: `source: "clickup"`, `source_id` = the ClickUp task id, `clickup_status`, `clickup_date_updated`, `synced_at`, `clickup_url`, `clickup_team_id`). The poller is pull-only and cannot see deletions. This step closes both gaps, once nightly.

First load the ClickUp tools via ToolSearch (query "clickup task"). If the ClickUp connector is not available in this session, say so in the report's Run notes and skip this entire step — never improvise another way to reach ClickUp.

**a. Reconcile (detect deletions/archival).** Query Parachute for all notes tagged `clickup` that do not carry `clickup-orphaned`. For each, look up the ClickUp task by `metadata.source_id` (clickup_get_task). If the task no longer exists, is archived, or is no longer accessible: add the tag `clickup-orphaned` to the note (do NOT delete the note — it is Benjamin's record) and list it in the report. If it exists, do nothing — the 5-minute poller owns freshness.

**b. Write back Benjamin's local edits.** For each mirror note where the vault copy was edited after the last sync (`updatedAt` later than `metadata.synced_at`) AND `metadata.status`, `metadata.priority`, or `metadata.due` now disagrees with the live ClickUp task: push Benjamin's values to ClickUp with clickup_update_task. Mappings: vault priority critical→urgent, high→high, medium→normal, low→low; due = the ClickUp due_date; for status, use the target task's own list statuses — pick the list status whose meaning matches the vault status (`done` → the list's done/closed status, `in-progress` → its in-progress-type status, etc.). If the list has no status matching the vault value, do not push; report it instead. After a successful push do not edit the mirror note yourself — the next poller pass converges it; just note the push in the report.

**c. ClickUp guardrails (bind hard — this writes into Gitcoin's shared workspace).** Only ever UPDATE existing tasks that a `clickup`-tagged mirror note points to; never create or delete ClickUp tasks, never post ClickUp comments or chat messages, never touch a task with no mirror note. Only push the three fields above, and only when the vault edit is unambiguously Benjamin's (the note changed after `synced_at`). When in doubt, report instead of pushing. Include a "ClickUp mirror" section in the report: counts checked / orphaned / pushed / skipped, with task names.

## Guardrails (carried over)

- Never create notes tagged `task` or `promise`. Do NOT send any outward-facing communication; the single exception is step b's ClickUp field updates under step c's guardrails.
- If a Parachute query comes up empty or a tool fails, note it plainly in the report rather than failing silently.
- Vault writes carry `if_updated_at` (the tag add in step a included); never `force`.
