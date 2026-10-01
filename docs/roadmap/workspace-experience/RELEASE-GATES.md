# Verification and release gates

Companion to the [final implementation plan](POST-MIGRATION-PLAN.md). All unchecked release requirements below are future work, not completed test claims. This document supersedes runtime assumptions in the original VALIDATION.md while retaining its detailed UI scenarios.

## Audit baseline: 2026-10-01

Source reviewed at `29d18b3a712072494f46105fcc514de88c7e0603`, plus the verification-script fix at `55de6007b946398a47f9f805242ff8b3d9ef9ad3`. That final delta changes only one missing brace in the host verification script.

| Check actually run | Result | Scope and limitation |
| --- | --- | --- |
| `npm test` in `apps/server` | **1,329 passed; 0 failed/skipped** | Fixture suite using test configuration/in-memory database. Final run at the parity A/B/C source; the later one-brace delta does not change server code. |
| `npm run typecheck` | **Passed** | Core, legacy desktop frontend, web, server. Not a Rust/native runtime or verification-script check. |
| `npm run verify:host -w @prism/web` | **18 checks passed** | Initially failed to parse at `29d18b3`; migration agent fixed it in `55de600`; rerun passed. Tests injected host service contracts, not live providers. |
| `npm run verify:agent -w @prism/web` | **15 checks passed** | Reducer, event replay/stream handling, client error/profile behavior. Not a real Claude execution. |
| `npm run verify:events -w @prism/web` | **Passed** | Event client fixture checks. |
| `npm run verify:media -w @prism/web` | **Passed** | Proxy/client fixture checks. Not a WKWebView rendering test. |

Initial socket-using fixture tests failed with sandbox `listen EPERM`; they passed with localhost socket permission. This environment failure is not counted as an application defect. Temporary logs were kept under `/tmp/prism-audit-*`; they are not durable repository evidence. The table records the commands/outcomes; R00 should capture fresh durable summaries at the final handoff.

**Not run in this planning pass:** production browser workflows, real mobile PWA, actual installed thin desktop app, native build/Rust tests, provider sends/exports, guest/publication/governance mutations, or an application build over the shared deployment directory. There is no claim yet that the redesign is implemented or all features work in production.

## G0 — Isolated, repeatable baseline

- [ ] Final migration handoff SHA, deployment identifiers, runtime capability flags, and known limitations recorded.
- [ ] Separate checkout/build directories and explicit fixture database/vault. No implicit loading of production `.env` for mutation tests; external workers, schedules, sends, and exports off by default.
- [ ] Browser fixtures reject unintended server origins. Production tests are a separate explicit project/command with an allowlisted destination and private synthetic fixtures.
- [ ] Existing host/agent/event/media verifiers and application typecheck pass. Parse/typecheck verification scripts as well.
- [ ] Every renderer, account role, integration, and native feature has a baseline entry. Report absent/blocked features honestly; no blanket “parity complete” based only on a command count.

The current `apps/web/playwright.config.ts` defaults to `http://localhost:8787` and describes a live vault, while helpers can load server environment values. Do not run it as if it were an isolated suite. Its blocked service workers and Chromium-only project cannot establish PWA or Safari behavior.

## G1 — Required automated checks

Run focused checks per changed slice, then the release suite in the isolated checkout. Do not repeatedly run unrelated suites after a cosmetic change without a reason. Conversely, collaboration, permission, migration, and replay changes require meaningful state-transition/failure tests, not tests that simply repeat implementation details.

```sh
npm run typecheck
npm test
npm run verify:host -w @prism/web
npm run verify:agent -w @prism/web
npm run verify:events -w @prism/web
npm run verify:media -w @prism/web
npm run typecheck:e2e -w @prism/web
npm run build -w @prism/web
npm run check:sw -w @prism/web
npm run build:native -w @prism/web
npm run verify:native -w @prism/web
npm run check -w @prism/client
npm run test -w @prism/client
npm run verify -w @prism/client
npm run build -w @prism/desktop
```

The script names above exist at the audit cutoff. Check any generated-artifact prerequisite before invocation. Add explicit isolated browser/PWA test commands in R00; do not invent a command here and imply it already exists. Build and launch the actual `apps/client` app for G3; static native verification is insufficient. Preserve the legacy desktop build as rollback coverage, not as evidence the thin client works.

Required new contract tests:

- [ ] Outbox scope switching, transaction failure, legacy quarantine, 409/404/410 recovery, unknown outcomes, repeat-safe create, actor revocation, and temporary-ID dependencies.
- [ ] Identity collisions/aliases/manual overrides; lossless multi-line legacy rendering; source event reconciliation; archive cursors and stable ordering; two accounts with similar display names.
- [ ] Agent context permission checks, draft/selection revision, replay/resume, queue cancellation, and document binding.
- [ ] Independent persistent Read-only / Suggested edits only / Read/write sessions. Every forbidden mutation is denied through HTTP/MCP/CLI tool paths; Read/write direct edits succeed only within effective grants. Downgrade races, queued/resumed turns, device switching, and policy-version recording are covered. No prompt-only enforcement.
- [ ] Multi-human+agent Yjs edits, repeated text anchors, idempotent review, concurrent accept/reject, role revocation, governed proposals, and renderer limitations.
- [ ] Transcript ambiguity/recurrence/timezones, multiple recordings, partial-write recovery, durable manual override, no source deletion side effects.
- [ ] Same-ID cross-vault embeddings, authorized snippet/count handling, deletions, model/index migration, keyword fallback, ambiguous/renamed wikilinks.
- [ ] Multiple canvases asserting one relation, manual edge ownership, failed writes/reconnect, derived overlay isolation, both-endpoint access checks.
- [ ] Board configuration migration, custom/unknown statuses, concurrent card moves, unrelated metadata preservation, persisted ranks.
- [ ] Guest/capability/account/publication boundaries, governance precedence, dynamic publication membership, private neighbor/link leakage, theme validation, sync visibility and mapping preservation.

## G2 — Functional and visual feature ledger

R00 adds actual test IDs, fixture names, expected results, environment/build IDs, and evidence links to each row. Use statuses **not started**, **passing**, **failing**, or **blocked with reason**. A screenshot confirms appearance only; pair it with observable persistence/authorization outcomes.

| Surface | Required positive flow | Required recovery/negative flow |
| --- | --- | --- |
| Shell/navigation | Vault switch, pinned/recent items, deep links, back/forward, keyboard search | No cross-scope drafts or stale private titles; narrow layout and zoom |
| Documents/rich text | Formatting, tables, embeds, attachments, wikilinks, properties, history, comments | Round-trip fidelity; stale/offline save; revoked edit permission |
| Specialized renderers | Every registered renderer opens and retains its existing actions | Unsupported format read-only/fallback; no hidden legacy Tauri invocation |
| Agent sessions | All three permission modes; live response, source preview, direct edit and suggestion review; device resume | Mode-change races, unavailable profile, denied context, budget limit, cancel/reconnect |
| Messages/email | Speaker/account identity, multi-line content, attachments, archive, controlled reply | Duplicate/unknown send outcome, malformed content, keyboard/scroll, draft retention |
| People | Email + bridge conversation + meeting + task on canonical person | Same-name ambiguity, rename, aliases, manual correction and backfill |
| Calendar/transcripts | Recurring occurrence edit, transcript link/review, participants and tasks | Wrong candidate refused; notification/scope choice; cancel and partial-write repair |
| Search/context | Keyword and semantic retrieval in each supported vault, references/backlinks | Revoked/deleted source absent; index unavailable clearly labeled |
| Canvas/graph | Drop note, create typed edge, verify metadata/graph, open linked note | Failed write, shared edge deletion, large graph bounds, WebGL/list fallback |
| Tasks/views | Custom board columns/filter/order, same tasks in another view | Touch/keyboard movement, concurrent update, unknown status remains visible |
| Guest collaboration | Invitation, capability access, multiuser editing and presence | Expiry/revocation; no-grant state; denied writes via alternate paths |
| Governance | Policy preview, proposal, discussion/vote/quorum, apply, audit | Author/role restrictions and conflicting scope precedence enforced |
| Publishing | Draft/preview/publish appearance, navigation/templates, password access | Private neighbor titles absent; invalid theme; revocation and appearance restore |
| Integrations | Config/mappings, controlled sync, conflict readback, skills/model route/cancel | No accidental auto-export; preserve private flags/unmapped fields; provider failure |
| PWA/offline | Install/update, offline draft, reconnect, lock/unlock, resume | Storage failure, stale cache, revoked account, interrupted write |
| Desktop client | PKCE login, editing/agent, tray/capture, notifications, import/export, window state | Denied/revoked token, external navigation lock, media/map fallback, no local ingestion |
| Branding/accessibility | Consistent assets, themes, focus order, contrast, reduced motion | 16px icon, 200% zoom, screen-reader names, color-independent statuses |

Existing manual native verification lives in `apps/client/scripts/verify-client-flow.md`. Reuse it but reconcile superseded items: its old “external images do not load” expectation predates parity C, and calendar controls must follow delivered capabilities rather than old `isDesktop` assumptions. Keep genuine unsupported cases explicit, including some native external media/iframe forms and unsupported import formats.

## G3 — Cross-device and performance evidence

- [ ] Desktop Chrome and Safari/WebKit cover real navigation/editing, not just headless screenshot rendering. Include Firefox where supported, documenting any limit.
- [ ] A real mobile Safari installed PWA covers keyboard, safe areas, touch/IME, backgrounding, update, offline and lock/reopen. Device emulation supplements this evidence; it does not replace it.
- [ ] The actual built thin desktop client covers its WKWebView, PKCE/keychain, WSS/SSE, proxy images/maps, and native extras. Verify external original URLs survive save/reload; no blob URL is persisted to vault content.
- [ ] Two signed-in users plus a scoped guest run simultaneous collaboration tests, including revocation and governance boundaries. Two windows of one owner session do not prove guest permissions.
- [ ] Long threads, large rich-text documents, large canvases, graph expansion, and the architecture-v2 multi-client note corpus are measured against the handoff baseline. Record query counts, payload sizes, idle CPU/network, memory, input latency, and time to usable content.
- [ ] New views preserve bounded queries and targeted invalidation. No routine UI list fetches every note body or undoes the migration's node-resource reduction.

Set measurable performance budgets from R00's actual baseline/device corpus and record them before the relevant rewrite. Investigate any material regression even when absolute loading time still appears acceptable. Keep visual review cases stable across themes, widths, long names, missing avatars, many tags, and permission-limited controls.

## G4 — Controlled production verification

The user's final requested boundary is approval of this plan plus the migration handoff before implementation. After that, the authorized execution includes controlled production testing and regular commits. Do not claim production verification from fixture results or use a live vault to debug an untested migration.

1. Record the release candidate's server/web/native build IDs, migrations, backups, rollback artifacts, expected runtime flags, and private test object namespace. Do not change the native bundle identifier or auth/keychain namespaces as part of branding.
2. Deploy compatible server/readers before dependent UI/native writers where needed. Confirm PWA cache version and native bundled web build actually changed; a stale client can make a test misleading.
3. Run production smoke tests using private synthetic notes, controlled collaborators, test publications, and supported integration sandboxes. Exercise real readback from the vault, not only local optimistic state.
4. For outbound email/Telegram/provider changes, use a known owner-controlled test mailbox/room/repository/calendar/database. If none is identified, obtain that specific destination before sending or exporting. Do not message arbitrary contacts or claim an untested provider path is passing.
5. Complete the final journey set in POST-MIGRATION-PLAN.md on production web/PWA and actual desktop. Record time, versions, device/browser, expected/actual outcomes, and screenshots/traces with sensitive content excluded.
6. Watch errors, queue/job health, invalidation volume, and resource use through the relevant background/reconnect cycles. Recheck post-release ingestion links and sync outcomes; an immediate page load is not enough.
7. Clean up only known synthetic fixtures and their intentional remote counterparts, retaining test evidence and avoiding normal vault content. Any untested area remains an open gate with an exact reason and required next action.

## Commit and rollback discipline

- Make small, meaningful commits for passing vertical slices: contract/migration + tests, then connected UI + tests, with documentation/evidence updated. Cosmetic adjustments can be grouped logically; do not create artificial one-line commit noise.
- Stage explicit paths and inspect staged diffs. Never sweep concurrent agent changes, credentials, live databases, private screenshots, or logs into a commit. Keep the migration agent's work intact.
- Use feature switches when mixed client versions or new data writes make rollout risky; do not add flags for every CSS change. Document ownership and removal conditions for temporary switches.
- Prefer additive migrations and tolerant old/new readers. Rollback disables new behavior without discarding drafts, suggestion marks, identity decisions, or relationship evidence. Exercise backup restoration in isolation before relying on it.
- Keep the previous web/server artifacts and actual native app available. A source revert is not sufficient rollback for already-migrated data or a PWA caching an old bundle.

## Completion record

Release is complete only when all required ledger rows have evidence, the production journeys pass across the required clients, and unresolved defects are explicitly resolved or a scope change has been agreed. Record commit range, deployed versions, automated outcomes, manual/device evidence, migration/backfill results, and any remaining limitation. Do not make an absolute “nothing can break” claim; state exactly what was exercised and what remains unknown.
