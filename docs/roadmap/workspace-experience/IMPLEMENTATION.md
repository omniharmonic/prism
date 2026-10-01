# Implementation progress

Approved by the user on 2026-10-01. Implementation branch: `feat/workspace-experience`, isolated worktree `/private/tmp/prism-workspace-experience`. Base: `615f34b`, incorporating migration parity A/B/C and `55de600` verification fix. No newer migration commit was present when execution began.

| Package | State | Evidence / remaining work |
| --- | --- | --- |
| R00 baseline | In progress | Isolated checkout; fixture-only default browser tests; live test credentials/origins now explicit; verifier syntax gate. Checks: verifier syntax, e2e typecheck, and 1 Chromium isolation test passed. Runtime/device inventory and feature ledger still required. |
| R01 integrity | In progress | Scoped durable outbox; no forced conflict retries; unknown outcomes retained; temporary-ID reconciliation and local draft reads; actor-bound gateway requests; recovery UI; account-scoped read cache; removed URL-only service-worker API cache; unavailable web agent no longer falls back to Tauri. Browser regressions and server tests passing (see checkpoints). Agent/message composer draft scoping and final crash/recovery checks remain. |
| R02 brand/primitives | In progress | Canonical vector and deterministic web/native exports; neutral surface tokens, navigation states, keyboard title rename, list marker restoration. Concept boards 17/18 added. 19 browser fixtures passed; application/e2e typechecks passed. Native rendering and remaining surfaces still require verification. |
| R03–R16 | Not started | Follow POST-MIGRATION-PLAN.md; no completion inferred from baseline tests |

Every implementation commit updates this record with actual checks and limitations. Production deployment/testing has not started. Existing audit tests remain baseline evidence only.

## Checkpoints

- `d35abcc`: fixture-only browser default and explicit live-test opt-in. Verifier syntax, e2e typecheck and browser isolation test passed.
- R01 working slice: 17 Chromium fixtures passed, including real IndexedDB scope/conflict/reload/multi-tab tests and the recovery UI. 1,331 server tests passed after adding actor-binding checks. Application typechecks pass; final rerun: 17/17 browser fixtures and 1,331/1,331 server tests passed; application/e2e typechecks and service-worker guard passed.
- Additional audit finding: the PWA had a URL-only `vault-api` runtime cache alongside its scoped IndexedDB cache. Removed that runtime rule and added legacy-cache cleanup; cached reads now include actor identity and snapshot request headers with their scope. A production PWA update is needed before claiming the old worker is replaced.
- Native build prerequisite: macOS began reporting an unaccepted Xcode/Apple SDK license. Requested that the user review/accept it; web/server work continues. Using the installed Command Line Tools Git binary for source control avoids the Xcode launcher dependency; no license was accepted on the user's behalf.
- Production test destinations: user authorizes only private destinations in their own accounts (self/bot rooms, self-addressed mail, private resources). Verify membership/visibility before any outward production test.

- R02 working slice: real shared-workspace fixtures at 1280×720 and 390×844 uncovered a pre-existing font-registration render loop. Stable Canvas mutation callbacks and scoped store selectors fix it. These tests use fictional notes and never connect to production.
