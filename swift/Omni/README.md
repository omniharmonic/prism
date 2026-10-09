# Omni

Benjamin Life · 2026-10-08. The native client for **Omni**, Benjamin's agent (Hermes, reached
through the Prism Server's Omni gateway, `/api/omni/*`). This is the first runnable shell —
milestone M1 "app" of `omniharmonicagent/docs/omni/build-plan.md`. macOS first; the same
SwiftUI code compiles for iPhone and iPad.

Bundle id `com.benjaminlife.omni` · team `83Y42N33H8` · development signing only · macOS 26
/ iOS 26 (the build plan's minimums; Xcode 27 builds both). No App Store, push or
associated-domains entitlements yet.

## Run it on your Mac

You need two things running: the laptop dev backend, and the app.

1. **Start the dev backend.** In Terminal:
   ```bash
   cd ~/dev/prism-omni-dev/apps/server     # any Prism checkout with apps/server/.env.dev
   scripts/omni-dev.sh                     # leave it running; Ctrl-C stops it
   ```
   It starts a stub Hermes and a dev gateway on `http://127.0.0.1:8797`. The first start
   also builds the web app (about a minute) — the browser sign-in page needs it. Every
   executor is off, so nothing can be sent. (Details: `docs/omni-module.md` § Developing against a stub
   Hermes.)
2. **Open the project.** `open swift/Omni/Omni.xcodeproj` (in this checkout).
3. In Xcode's toolbar choose the **Omni** scheme and **My Mac**, then press **Run** (⌘R).
   The first build takes a minute.
4. The app shows **Welcome to Omni** with `http://127.0.0.1:8797` filled in. Press
   **Continue**.
5. Press **Sign In**. Your browser opens the dev gateway.
6. **Sign in as the dev owner** in the browser: your dev password, or ask for the email
   link — on the dev server no email is sent; the link is printed, in a box, in the
   Terminal window from step 1 (open it in the same browser). Then press **Approve** on the
   page that names "Omni on <your Mac>".
7. Omni comes to the front, signed in. The browser tab says "Signed in"; the tab you
   started on, if it is still open, says "You're signed in" — both can be closed. Press ⌘N and type something. To see the scripted
   behaviours, put a marker in the message: `stub:approval`, `stub:slow` (then ⌘. to stop),
   `stub:followup`, `stub:error` — the full list: `scripts/omni-dev.sh scenarios`.

Sign out: Omni → Settings (⌘,) → Sign Out. The server address is remembered.

**When something fails:** Omni → Settings (⌘,) → **Diagnostics** (development builds only)
lists the app's last 200 requests — time, method, path, status and the server's error code;
no sign-in token, no message text. **Copy All**, and paste it.

If macOS asks whether Omni may use your **login keychain**, allow it: a development build
keeps its sign-in there (see "Decisions" below).

## What it does today

- **Server and sign-in.** First-run server address (validated; the dev gateway is the
  default in Debug builds only, empty in Release), a credential-free check that it is an
  Omni server, device sign-in through the system browser (loopback redirect on the Mac,
  `ASWebAuthenticationSession` on iOS), the token in the Keychain, sign out (revoke +
  forget), a "Can't connect" screen with Try Again, and a confirmed 401 → back to sign-in
  on the same server.
- **Threads**, grouped by state in the product spec's words: Needs you · Working ·
  Waiting · Scheduled · Done. Search, new thread, unread dots, refresh, loading and empty
  states. A thread the agent no longer has is shown dimmed as "No longer available";
  opening it says so once (no retries) with **Remove from List** and **Check Again**. Any
  thread can be archived from its row's menu (right-click).
- **Thread view.** History, a composer (Return sends, Shift-Return starts a new line),
  live streaming, tool chips, record cards that open the note in Prism, Stop, plain-language
  errors, automatic re-attach, and agent-initiated messages arriving on an open thread.
- **Approvals**, as a card in the thread and in **Needs you**: every field and the whole
  text of what would be sent; Send / Edit / Revise / Cancel Draft. Send is not offered when
  the draft does not match the server's fingerprint. Send asks for Touch ID or your
  password first.
- **Today** and **Recurring** (jobs, with Pause / Resume): read-only lists. Today shows
  what loaded and names what did not ("Some of Today couldn't be loaded: the agenda"), with
  Try Again; a refresh that fails keeps what was on screen.
- Mac keys: ⌘N new thread · ⌘F search · ⌘. stop · ⌘R refresh (whatever the window shows) ·
  ⌘, settings.

Not here: voice (the composer has a marked slot for the microphone), push, nudges, task
dispatch, a read-only record preview, the context inspector, the app lock.

## Layout

| Path | What |
|---|---|
| `Package.swift` | SwiftPM package; depends on `../PrismKit` by path |
| `Sources/OmniCore` | View models, stores, navigation state, plain-language errors. No SwiftUI. Everything behind protocols (`OmniService`, `SessionAuth`, `ServerProbe`), so it is tested with fakes |
| `Sources/OmniUI` | The shared SwiftUI screens |
| `Sources/OmniSmoke` | A command-line walk through the same calls, against the dev gateway |
| `Tests/OmniCoreTests` | 92 tests, no network |
| `App/`, `Support/Info.plist`, `Omni.xcodeproj` | The thin app target (one file) |

## Build and test from Terminal

```bash
cd swift/Omni
swift build
swift test
xcodebuild -project Omni.xcodeproj -scheme Omni -destination 'platform=macOS' build
xcodebuild -project Omni.xcodeproj -scheme Omni -destination 'generic/platform=iOS Simulator' build
Scripts/smoke.sh        # needs the dev backend from step 1 running
```

`Scripts/smoke.sh` signs in the way the app does (PrismKit, client `omni-native`, both the
Mac loopback redirect and the iPhone `omni://auth/callback` redirect), then creates a
thread, streams a turn, cancels `stub:slow`, receives `stub:approval`, decides (the answer
is "sending is switched off"), edits, cancels, reads Today and jobs, and checks the 401
path. It then does what each screen does on appearing, through the app's own view models:
one thread from every sidebar group, the Needs you badge, Today, Recurring, ⌘R on each,
search; `stub:error`, `stub:drop`, `stub:truncate` and a refused chat request end in plain
words and the thread still works; every thread from an earlier run opens or says it is no
longer available (and one is removed); the sign-in is repeated with the callback arriving
twice and the other browser tab resuming after Approve; and the diagnostics list is checked
for the run's failures and for secrets. `OMNI_SMOKE_EXPECT_EMPTY=1`, `OMNI_SMOKE_EXPECT_OLD=1`
and `OMNI_SMOKE_EXPECT_GONE=1` make it fail unless the backend is empty, holds older threads,
or holds threads the stub has forgotten (`OMNI_DEV_RECONCILE=0` after deleting the stub's
state file). It prints PASS/FAIL per step and every difference
between PrismKit's models and the gateway's JSON. The browser step is played with a
ten-minute dev-owner session row the script adds to the dev database and removes again
(the same dev tooling `omni-walkthrough.ts` uses). It refuses anything but
`http://127.0.0.1`.

## Rules the code keeps

- **A stream that ends without a `result` proves nothing.** The thread is read again and,
  while it still names an active turn, the stream is attached again from the last event
  seen (`ThreadModel.follow`).
- **One `Idempotency-Key` per press.** A retry after an unclear outcome resends the same
  key — for a message (`ThreadModel`) and for an approval decision (`ApprovalCenter`).
  Creating a thread and editing a draft have no key on the server, so they are never
  retried automatically: the list is read instead.
- **`decide` and `editApproval` are called only from a tap.** Nothing in OmniCore calls
  them on its own.
- **Send is refused locally on a digest mismatch**, and never offered.
- **Outcomes are stated as they are:** executor off → "Sending is switched off on this
  server — nothing was sent"; `failed` → provably not sent; `unknown` → may have been
  sent, check first.
- **A sign-in is never started by the app itself.**
- **After a sign-in attempt, the screen follows the stored token.** A token in the Keychain
  means signed in, whatever the attempt reported last; "sign-in failed" is only shown when
  there is none.
- **A 404 on a thread is final until the person asks again.** Not retried by a notice, a
  reconnect or coming back to it.
- **The diagnostics list never holds a token, a header, a query string or a body.**

## Decisions made where the docs were silent

- **The Xcode project is committed, hand-written.** XcodeGen is not installed on the
  laptop, and nothing was installed for this. `Omni.xcodeproj` is one multi-platform target
  using Xcode's folder-synchronised group for `App/`, so adding a file to `App/` needs no
  project edit; everything else is in the Swift package. If XcodeGen is adopted later, a
  `project.yml` can replace it.
- **Debug builds keep the token in the login keychain on macOS**
  (`useDataProtectionKeychain: false`), because a build without a provisioned application
  identifier cannot use the data-protection keychain. Release builds use it.
- **No App Sandbox yet.** Hardened runtime is on. The sandbox (with the network client and
  server entitlements the loopback redirect needs) comes with the TestFlight setup.
- **Release builds have no default server address.** The docs name none.
- **"Needs you" is the approvals list.** The spec puts approvals and nudges in one queue;
  nudges arrive in M3. "Recurring" is the jobs list.
- **Edit changes wording only** (subject, body, title, description, a tweet's text).
  Recipients, times and amounts are changed by asking Omni to revise.
- **Send asks for Touch ID / Face ID / the device password** (integration-contract.md § 6).
  On a device with no passcode at all, a Debug build lets the send through; a Release
  build refuses.
- **Tool chips of a finished turn come from Hermes' stored messages.** The dev stub stores
  none, so chips show while a turn streams and are gone after it.
