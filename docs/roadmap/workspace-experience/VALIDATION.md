# Workspace validation and release gates

> **Historical design reference (2026-09-30, pre-migration `c191b52`).** The [post-migration plan](POST-MIGRATION-PLAN.md), [current contracts](DOMAIN-CONTRACTS.md), and [release gates](RELEASE-GATES.md) supersede runtime assumptions, sequencing, and authority statements below. Retain applicable interaction details. Each agent session now supports **Read-only, Suggested edits only, and Read/write**; earlier Ask/Suggest examples are not a restriction. Concept logos are placeholders pending [BRAND.md](BRAND.md).

Status: implementation requirements, **not test results**. No application builds, runtime mutation tests, external sends, or backend cutovers were run to author this plan. Documentation verification is limited to file/link checks and preservation of the upstream documents.

## Safe test environment

Follow the sandbox and operating rules in [architecture v2 WORKPLAN.md](../architecture-v2/WORKPLAN.md). Its overseer owns production actions. This plan adds no permission to restart services, read private research/config into published docs, write live notes, mint credentials, or send real messages.

- Run server tests only through the guarded package script: from `apps/server`, run `npm test`. Never use raw `node --test` against the application environment.
- Existing web e2e helpers read the production server `.env` and default to live ports. Do not reuse that behavior for this work. Create an isolated fixture/sandbox configuration with explicit origins and credentials supplied only by the harness.
- New tests must fail before writes if a required sandbox origin, disposable vault, or test-instance marker is missing. A port override alone is insufficient if the backing server still points to production.
- A copied Parachute sandbox needs a separate home, empty service supervisor configuration, no expose/tunnel state, and the upstream worker/mirror-disable settings. Only one sandbox runs at once on the constrained node.
- Use synthetic fixtures for messages, names, emails, tokens, titles, and source text. No private transcripts or screenshots enter this public repository.
- Mock CLI execution for deterministic tests; use sanitized stream-json fixtures. Live model verification is a separate explicitly configured sandbox smoke test, not a default CI dependency.
- Stub external send providers for retry/delivery tests. A final real-send test, if needed, uses an explicitly designated test recipient/channel and the existing approval process.

## Baseline evidence to collect at F00

Record the actual upstream handoff commit and package status; relevant schema/capability versions; supported devices/browsers; fixture sizes; build/chunk sizes; request counts; and screenshot dimensions. Keep observations distinct from goals.

Create a defect ledger with ID, report/source, minimal reproduction, expected/actual behavior, package owner, automated test, and verification status. Include the user's reported sender identity, top-bar/tagging, and intermittent message-rendering categories even if their exact cause is still unknown.

Inventory all existing renderer and route entry points. Record existing failures before implementation; do not count a pre-existing failure as a new regression or silently ignore it in the final release report.

## Primary workflow acceptance

| ID | Scenario | Required result |
| --- | --- | --- |
| FLOW01 | Desktop web: select an unsaved passage, ask using two permitted notes | The agent sees the intended draft/selection; supplied and retrieved context are distinguishable |
| FLOW02 | Open a citation, inspect metadata/history, then return to Agent | Session, composer draft, working-document binding, and useful scroll remain intact |
| FLOW03 | Start on desktop, background/lock mobile, reopen or follow completion notification | One continuous transcript; missed events replay once; no duplicate turn or accidental cancellation |
| FLOW04 | Agent suggests two edits, human changes an overlapping passage in another client | Independent edits survive; stale overlap becomes a visible conflict, not a full-document overwrite |
| FLOW05 | Accept one edit, dismiss another, then reopen on another device | Both proposal states and canonical content agree across devices; double-accept is idempotent |
| FLOW06 | Open a thread with multiple senders, long bodies, and earlier archives | Identity is clear where known; all available message text remains accessible; old history pages correctly |
| FLOW07 | Read older messages while a new message arrives and an image loads | Reading anchor stays stable; New messages indicates unseen arrivals |
| FLOW08 | Compose, simulate provider failure or timeout, navigate away/back, retry | Draft survives; destination remains correct; confirmed sends are not duplicated; unknown delivery is explicit |
| FLOW09 | Change a triage tag while the ingester appends/reclassifies the thread | Unrelated tags survive; authoritative tag/chip/list grouping reconcile; no hidden partial mutation |
| FLOW10 | Mobile: write, open Agent with keyboard, review change, return to writing | One usable primary surface; keyboard/safe areas do not hide composer/actions; document selection/scroll restore |
| FLOW11 | Draft a follow-up during a run, then queue or Stop and refine while completion races | No lost prompt, duplicate turn, or overlapping writer; context/mode changes affect only the intended next turn |

## Synthetic fixture library

| Fixture group | Cases |
| --- | --- |
| Legacy Matrix transcript | Header/pointers; empty body; multiline text/blank paragraphs; `[unknown]`; malformed entries; UTC timestamps; repeated bodies; sender colon; raw Matrix-like handle; non-Latin sender; very long URL |
| Structured messages | Incoming/outgoing/group senders; two identical display names; renamed person; emoji; code; attachment metadata; image sizing; reply to unavailable target; edit/redaction/reaction; timestamp ties and out-of-order arrival |
| Rollover | Several archives; archive-before-trim overlap; concurrent rollover while paginating; denied/deleted archive; missing pointer; valid identical repeated messages; giant single entry |
| Email | Several senders; reply/reply-all; separate accounts; long subject; quoted history/signature; body not yet synced; attachment-only; HTML/plain fallback; missing recipient/thread metadata |
| Agent | Text/tool/source/proposal events; partial frame; duplicated sequence; replay gap; expired cursor; queued/admission refusal; auth failure; interrupted turn; cancel/complete race; large output |
| Documents | Rich prose, tables, images, tasks, comments, suggestions, links; same phrase repeated; long selection; unsaved local draft; live Yjs edits; deleted target; governed note |
| Navigation and scale | 10,000 synthetic tree entries, many tabs, long titles, several vaults/accounts; 10,000 message events and bounded pages; thousands of conversation summaries |

Use the smallest fixture that proves a behavior in unit tests; reserve large fixtures for explicit performance tests. Do not repeat costly full-suite runs without a changed concern.

## Automated layers

### Pure and domain tests

Test legacy parsing against entry/body preservation, known UTC interpretation, unknown times, sender ambiguity, and rollover boundary semantics. Test structured normalization against event identity, relations, repeated text, and deterministic ordering. Test grouping independently of presentation: sender, direction, day, and time-gap boundaries.

Test proposal baseline/anchor validation and capability gates through the shared service used by MCP and browser callers. Include repeated target text, stale ranges, revoked access, safe revert, idempotent acceptance, and partial/crash recovery.

Test agent replay normalization, contiguous cursors, gap recovery, draft revisions, account/vault state keys, and duplicate-send protection. Keep fixtures compatible with the upstream AgentEvent contract; do not invent a second event parser just for tests.

### Server and transport tests

Exercise authenticated routes with owner/admin/editor/viewer/comment/suggest/create-only/link/anonymous actors as applicable. Runtime remains owner-only and external live actions admin-only per architecture v2 until explicitly changed. Cover wrong-vault IDs, stale cursors, hidden archives/people, private transcripts, revoked tokens, capability changes during operations, and media access.

Exercise cookie and device-token transports; replay, cancel, and draft endpoints must obey the same actor policy. API errors need typed user actions. A downgraded role cannot keep sending or applying changes from a previously open tab.

Exercise provider failure, duplicate request IDs, network timeout after provider acceptance, process restart before receipt persistence, and late ingest echo. Assert audit correlation and accurate accepted/unknown/confirmed distinctions; do not pretend a provider offers guarantees it does not.

### Collaborative editing tests

Use two real Yjs clients against the disposable server. Verify concurrent human/agent changes, comments and formatting preservation, cursor/selection stability, duplicate acceptance, rejected updates, and reconnect. Inspect the persisted canonical note after convergence and after server restart. Typechecking or visually seeing an edit in one browser is insufficient.

Round-trip every supported node/mark between persisted representation and client/server schema. Test history restore separately from proposal acceptance. Existing code/sheet/canvas collab tests remain intact even if new agent apply controls initially support only prose.

### Browser interaction tests

Use the fixture-backed web app for fast CI checks. Cover document navigation, panel/sheet lifecycle, keyboard shortcuts, context attachment, streaming status, review actions, thread pagination/anchors, failed send, tag update, and accessible empty/error states.

Use Chromium and WebKit in the isolated browser suite where available. The existing CI's e2e job permits zero non-live tests; add real assertions for these new flows so passing CI proves behavior rather than only installing the browser toolchain.

Add screenshot checkpoints after layout settles for both themes: desktop document+agent, source peek, change review, message list/detail, tag menu, long/malformed message, mobile keyboard-adjacent layout, permission error, and reconnect state. Evaluate intentional differences; do not accept a regenerated image blindly.

### PWA and native verification

Current ordinary e2e config blocks service workers. Add a separate controlled PWA profile with service workers enabled to test offline cache/outbox policy, update prompt/chunk reload, push click routing, and background/reconnect behavior. Do not change the existing profile's isolation merely to make one PWA test pass.

On real iOS Safari and installed PWA, verify keyboard geometry, selection toolbar, safe-area padding, touch targets, scroll/drag interaction, orientation, background/reopen, and notification landing. Repeat against upstream native builds when available; verify server origin, token lifecycle, no service worker in native mode, and no client ingest. Keep tests for existing share-sheet/capture and notification extras.

## Protected functionality matrix

| Existing area | Minimum regression check |
| --- | --- |
| Plain and collaborative documents | Load, edit, save/sync, rename, formatting, links, comments/suggestions, read-only modes |
| Code, spreadsheet, canvas | Content-kind routing, rendering, save/collab convergence; no HTML conversion of non-prose |
| Presentation, website, task board, project, dashboard | Open and perform existing supported actions; preserve configured layout/metadata |
| Calendar, email, messages | Existing read and authorized action paths; no duplicate ingest or wrong destination |
| Map, graph, bioregion entities | Open, navigate to notes, authorized edits where supported; usable mobile fallback |
| Sharing and public publication | Existing URLs, password sites, capability levels, hidden-note protection, linked-note navigation |
| Governance and history | Propose/review/vote/apply policy, version compare/restore, attribution; no agent bypass |
| Settings, vault/workspace switch | Theme/font/preferences retained; subscriptions/cache/session state isolated |
| Agent profiles and activity | Delivered sessions/history/queue/cancel/budget behavior, no lost upstream power-user capabilities |
| Native shells | Device sign-in/revoke, server origin, deep links, existing capture/export/notification extras |

The ledger from F00 expands this table to every concrete current entry point. Unsupported features in the old app are not advertised as newly working without their own acceptance evidence.

## Performance targets

These are proposed gates to calibrate at F00, not measured claims. Test against the same documented fixture, server, network, and device profile before/after. Preserve architecture v2's own quantitative gates.

| Area | Initial target and measurement |
| --- | --- |
| UI response | Local selection, panel toggle, and typing updates typically within 100 ms; record p95 on the agreed desktop and real phone |
| Stream rendering | Batch rapid text updates; no editor-wide rerender per token; profile a sustained recorded stream |
| Thread scroll | Prepending preserves anchor within about 2 px after stable layout; late media does not relocate the chosen message |
| Conversation summaries | Default page approximately 50 rows, bounded server response; no full body/graph fetch to draw rows |
| Timeline pages | Default approximately 50 messages with a byte ceiling and explicit oversized-message handling; never all history at first open |
| Large threads | Bounded mounted content where profiling requires it; no main-thread tasks above 200 ms during routine scroll on the agreed fixture |
| Tree projection | Preserve upstream target: warm server response under 200 ms, payload under 2 MB, external update visible within 5 s |
| Idle traffic | Preserve upstream target of at least 80% reduction versus its pre-subscription baseline; no added per-view rapid polling |
| Events | No full-vault invalidation on each token/message; compare request counts during a burst and across three open clients |
| Bundle | Record route/chunk sizes and justify increases; maps/canvas/heavy editors remain lazy rather than loading with every agent pane |

Time-to-first-model-token depends on the runtime/model/network and must be reported separately from UI responsiveness. “Queued for capacity” is a valid honest state. Do not weaken the node's memory/concurrency admission to meet a frontend benchmark.

## Accessibility and layout gates

- Full primary workflows usable by keyboard, including message actions, source picker, proposal review, and modal escape/return focus.
- Descriptive names on icon controls; status announcements use appropriate live regions and do not read every streamed token or incoming message aloud.
- Normal text contrast at least 4.5:1; large text and relevant control boundaries at least 3:1; no status relying on color alone.
- Touch targets at least 44 px where touch is expected; selected text and body reading remain comfortable.
- At 320, 390, 768, 1024, and 1440 px widths, important controls remain usable with long labels. At 200% text zoom, content reflows without losing actions.
- No keyboard-hidden composer; no global pill covering message/review actions; no stacked sticky bars obscuring text.
- Reduced motion honored; no forced auto-scroll away from the reader; menus/sheets never trap focus after closing.

## Package verification commands

During implementation, use the repository's existing guarded commands in the isolated environment:

```text
npm run typecheck
npm run build -w @prism/web
npm run check:sw -w @prism/web
npm run typecheck:e2e -w @prism/web
```

For server tests, change into `apps/server` and run `npm test`. Use the new explicitly isolated Playwright configuration for UI tests. Add native/client and Rust checks only where those files changed or the delivered shell requires them. Do not copy the current live e2e defaults into an unattended command. The exact safe e2e invocation is recorded when F00 creates or identifies that configuration.

## Rollout and rollback

1. Deploy additive contract/schema support through the existing release process after sandbox checks. Old clients must still read documents/messages and use supported upstream features.
2. Enable new shell, document-agent review, message reads/UI, and structured-message writes separately. These are proposed feature boundaries; reuse an existing flag mechanism if available rather than adding a framework.
3. Validate the primary workflows with the owner on actual desktop/mobile use before broad enablement. Release authorization follows the existing owner process; this document is not a deployment approval.
4. Monitor error/fallback/conflict/reconnect/delivery states and bounded resource metrics without storing private content in telemetry.
5. Rehearse disabling each flag against the same persisted data. Preserve sessions, drafts, proposal/operation IDs, accepted edits, archive notes, and new structured records. A rollback must not restore the legacy host ingest or weaker auth/tool permissions.
6. Remove obsolete paths only in a later independently reviewed cleanup once old entry points and readers have a compatibility route.

## Evidence required to finish

For each F package, record the commit, exact checks/results, synthetic screenshots or task recording, capability/flag state, and any remaining issue. Release needs the two primary workflows, protected functionality matrix, permission/concurrency tests, real mobile checks, and rollback rehearsal. Missing evidence stays explicitly unverified.

This directory contains a plan and visual references. It does not claim runtime verification, a completed redesign, a deployed API, or a resolved user-reported bug.
