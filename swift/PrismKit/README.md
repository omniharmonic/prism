# PrismKit

Benjamin Life · 2026-10-08. The shared Swift package under the **Omni** app (macOS + iOS):
sign-in, one pinned HTTP client, server-sent events, and typed calls for the Omni gateway
(`/api/omni/*`). SwiftPM, Swift 6 language mode (strict concurrency), **no third-party
dependencies**. Platforms: macOS 14+, iOS 17+.

Authoritative contracts: [`docs/native-auth.md`](../../docs/native-auth.md) (device sign-in)
and [`docs/omni-module.md`](../../docs/omni-module.md) (the gateway). The Rust it was ported
from: `apps/client/src-tauri/src/{pkce,signin,auth,secure_store,origin,loopback}.rs`.

```bash
cd swift/PrismKit
swift build
swift test          # no network, no real server, no real Keychain
xcodebuild -scheme PrismKit-Package -destination 'generic/platform=iOS Simulator' build
```

## Modules

| Module | What it is |
|---|---|
| `PrismAuth` | `ServerOrigin` (one validated origin). PKCE S256 (`PKCE`, `PKCESession`), authorize URL, redirect validation (exact redirect + `state`). `DeviceAuthClient` (code → `pd_…`, revoke, `/auth/me` liveness). `TokenStore` + `KeychainTokenStore` + `InMemoryTokenStore`. The browser leg behind `RedirectFlow`: `LoopbackRedirectFlow` (macOS, RFC 8252 §7.3) and `WebAuthenticationSessionFlow` (iOS, `ASWebAuthenticationSession`). `DeviceSignIn` runs the whole flow; `signOut()` = revoke + forget. `PrismURLSession` (never follows a redirect, no cookies). |
| `PrismTransport` | `PrismClient`: bound to one origin, bearer only to it, typed `PrismError`, `IdempotencyKey`, JSON, `openStream` for SSE bodies. |
| `PrismSSE` | `SSEParser` (pure, incremental) and `SSEStream` (reconnect with backoff + `Last-Event-ID`). |
| `PrismModels` | `JSONValue` + the server-identical canonical JSON / `ApprovalDigest`; Codable Omni models; `OmniStreamEnvelope`; `TurnTranscript` (apply-once by seq, delta → final replacement); `PrismJSON`. |
| `OmniClient` | One method per built `/api/omni/*` route. Re-exports `PrismModels`. |

## Using it

```swift
import OmniClient
import PrismAuth
import PrismTransport

let origin = try ServerOrigin("https://prism.example.com")
let tokens = KeychainTokenStore(service: "com.example.omni")

// Sign in — only for a person's press (every run mints a device on the server).
let signIn = DeviceSignIn(origin: origin, configuration: .omniNative, tokenStore: tokens)
#if os(macOS)
let flow = LoopbackRedirectFlow.systemBrowser()
#else
let flow = WebAuthenticationSessionFlow(configuration: .omniNative) { window }   // an ASPresentationAnchor
#endif
try await signIn.signIn(using: flow, label: "Omni on Ben's iPhone")

let client = PrismClient(origin: origin, tokenStore: tokens, onSignedOut: { /* show sign-in */ })
let omni = OmniClient(transport: client)

let list = try await omni.threads(states: [.working, .needsYou])
let created = try await omni.createThread(NewThread(prompt: "Create a task to call Dana Friday"))

var transcript = TurnTranscript()
for try await update in omni.threadStream(threadID: created.thread.id, after: transcript.lastSeq) {
    if case .event(let e) = update { transcript.apply(e) }
}

// Approvals: decide on the approval the person SAW, with one key per press.
let approval = try await omni.approval("apr_…")
guard approval.digestMatchesPayload else { /* do not offer Send */ return }
let key = IdempotencyKey.random()          // keep it; resend the SAME key on retry
let outcome = try await omni.decide(shown: approval, .send, idempotencyKey: key)
```

## Rules the package enforces

- **One origin.** Every URL is `ServerOrigin` + a path; a full URL is never accepted. The
  bearer is attached only after re-checking the final URL is on that origin. `https` only,
  except `http` to a loopback host; loopback ports 1939/1940 (the vault and hub) are refused.
- **No redirects.** A 3xx is never followed (`PrismError.redirectRefused`,
  `DeviceAuthError.redirectRefused`), so a token, code or verifier cannot be forwarded.
- **No cookies, no cache, no stored URL credentials.**
- **The token is never logged.** `DeviceCredential` and `PKCESession` redact their
  descriptions; errors carry status codes and sanitised reasons, never a URL or a secret.
  Keychain item: this-device-only (`AfterFirstUnlockThisDeviceOnly`), non-synchronizable.
- **One 401 is a suspicion.** The same token is asked `GET /auth/me` once (concurrent 401s
  share the question). Only a 401 there forgets the token, runs `onSignedOut` once and throws
  `PrismError.signedOut`; alive or no answer → `PrismError.unauthorized`, token kept.
  Nothing in the package starts a sign-in by itself.
- **Outcome unknown is its own error.** 5xx, timeouts and a lost connection are
  `PrismError.outcomeUnknown`: re-read, or retry with the same `Idempotency-Key`. A failure
  to connect at all is `unreachable` (nothing was delivered).
- **The approval digest is recomputed locally.** `decide` refuses before sending when the
  payload held does not hash to the digest it carries.
- **This client is a human origin.** It never sends `X-Prism-Action-Origin`; call `decide`
  and `editApproval` only from a person's tap.

## Errors

| `PrismError` | When |
|---|---|
| `notSignedIn` | no token stored; nothing sent |
| `signedOut` | 401 confirmed dead; token forgotten |
| `unauthorized` | 401 not confirmed |
| `forbidden(ServerFailure)` | 403 (`forbidden`, `csrf_refused`, `human_origin_required`) |
| `conflict(ServerFailure)` | 409 — `.code` is the server's `error` (`conflict`, `digest_mismatch`, `already_decided`, `in_progress`) |
| `rejected(ServerFailure)` | any other 4xx (400, 404 — also "Omni is off" —, 410 `expired`, 415, 422, 429) |
| `redirectRefused` | a 3xx |
| `unreachable` | never connected |
| `outcomeUnknown(OutcomeUnknown)` | 5xx (`.code` = `hermes_unavailable` …), timeout, connection lost |
| `decoding` | a 2xx with an unexpected body (the message names the field, never the value) |

`OmniError.executorNotReady` (503 `executor_disabled` / `executor_unavailable`: nothing ran,
the approval is still pending) and `OmniError.localDigestMismatch`.

## Diagnostics

`PrismClient(…, onRequest:)` is told about every finished request as a `RequestRecord`:
time, method, **path only** (the query is dropped), status, the server's `error` code,
duration, and — when no answer came — a sanitised reason. A record has no field that could
hold a token, a header, a query or a body. Streams are recorded when they connect or are
refused. Omni lists these in its development build's Settings.

## Sign-in, a second time round

The loopback listener accepts the callback **once**. For eight seconds afterwards it still
answers: the same callback again (a reload, a browser's retry) gets the "Signed in" page and
delivers nothing; anything else gets 404. So a browser never shows "can't connect" on a
sign-in that worked. On the server, a second visit to `/auth/device/continue` after the
decision answers "You're signed in" (200) instead of "expired or already used".

## Streams

`omni.threadStream(threadID:after:)` replays persisted events after `after`, follows the
running turn and ends when the server closes (after the turn's final `status`). A dropped
connection reconnects with jittered backoff, resuming from the last **persisted** event id
(`?after=` and `Last-Event-ID`). Live `text_delta` events have no id and never move the
cursor; the block's final `text` replaces them (`TurnTranscript`). A clean close cannot be
told from an intermediary ending the response: if the sequence ends without a `result`, read
the thread and attach again when `activeTurnId` is set. `omni.notices()` follows the
owner-wide change channel and reconnects when the server recycles it; notices are not
replayed, so re-read what is on screen after every `.connected`.

## Approval digest vectors

`Tests/PrismModelsTests/Fixtures/approval-digest-vectors.json` is the output of the server's
own `canonicalJson` / `approvalDigest`. Regenerate (from the repo root, after `npm install`):

```bash
DB_PATH=:memory: npx tsx swift/PrismKit/Scripts/digest-vectors.ts \
  "$PWD/apps/server/src/omni/approvals.ts" \
  > swift/PrismKit/Tests/PrismModelsTests/Fixtures/approval-digest-vectors.json
```

## Checked against a real gateway

`swift/Omni/Scripts/smoke.sh` (2026-10-08) ran every call above against the laptop dev
gateway + stub Hermes, signing in as `omni-native` over both redirects (loopback and
`omni://auth/callback`). The models matched what the gateway sends: every thread, message,
approval (all six kinds — each digest recomputed locally equals the server's), record
card, job and Today object decoded with no unread and no missing key, and no stream event
arrived as `.unknown`. `DeviceAuthConfiguration.omniNative` is registered on a server with
`OMNI_ENABLED=true`; `.prismNative` stays the default for Prism's own client. What that
run cannot show is listed in `docs/omni-module.md` § What the stub cannot tell us.

## Tests

`URLProtocol` stubs only (`Tests/PrismTestSupport`): no socket to any server. The loopback
listener test binds `127.0.0.1` in-process. The Keychain store is compile-checked; its
round-trip test is skipped unless `PRISMKIT_KEYCHAIN_TESTS=1`.

## Not here yet (typed seams only)

- `/api/omni/push`, `/nudges*`, `POST /tasks/:id/dispatch`, voice — not built on the server.
  `OmniToday.needsYou.nudges`, `openLoops` and `brief` decode as open JSON.
- From the wider PrismKit plan (`integration-contract.md` § 11): `PrismTypes`, `PrismLinks`,
  `PrismPush`, `AppLock`, `NoteReader`, `ReadCache`, the `/health?live=1` probe.
