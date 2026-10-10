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
4. The app shows **Welcome to Omni** with `http://127.0.0.1:8797` filled in (on the Mac and
   in a simulator; on a real iPhone or iPad the field starts empty — type your server's
   address). Press **Continue**. The address is remembered from then on.
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
- **Today** reads the day’s agenda and tasks, names unavailable sections, and keeps
  previous content when refresh fails. **Recurring** creates and edits guarded local agent
  jobs, dispatches Run Now, and manages schedules; legacy script runners remain read-only.
- Mac keys: ⌘N new thread · ⌘F search · ⌘. stop · ⌘R refresh (whatever the window shows) ·
  ⌘, settings.
- **iPhone and iPad.** iPhone: tabs Today · Needs you · Threads. iPad: the Mac's sidebar
  beside the content, in portrait too; a narrow iPad window gets the iPhone's tabs. The
  keyboard has a Done button and goes away when the conversation is dragged; every screen
  reflows at the largest text sizes.

Conversational voice uses local Apple/Parakeet transcription with Hermes text streaming,
speech output and explicit interruption. Completion push, contextual source navigation,
nudges and biometric privacy lock are implemented. Voice hardware/quality acceptance and
extended record/context inspection remain separate follow-ups; skills editing is in progress.

## Layout

| Path | What |
|---|---|
| `Package.swift` | SwiftPM package; depends on `../PrismKit` by path |
| `Sources/OmniCore` | View models, stores, navigation state, plain-language errors. No SwiftUI. Everything behind protocols (`OmniService`, `SessionAuth`, `ServerProbe`), so it is tested with fakes |
| `Sources/OmniUI` | The shared SwiftUI screens |
| `Sources/OmniSmoke` | A command-line walk through the same calls, against the dev gateway |
| `Tests/OmniCoreTests` | 99 tests, no network |
| `Tests/OmniUISnapshotTests` | Draws every Mac screen off-screen from sample data (PNGs); checks the app's colours for contrast |
| `UITests/` | XCUITest: the walk through every screen on iPhone and iPad (and the Mac), the accessibility audit — see [TESTING.md](TESTING.md) |
| `Scripts/` | `smoke.sh`, `uitest.sh` (UI tests + screenshots), `check-release.sh` (the test sign-in is not in a Release build), `gallery.sh` |
| `App/`, `Support/Info.plist`, `Omni.xcodeproj` | The thin app target (one file) and the UI-test target |

## Build and test from Terminal

```bash
cd swift/Omni
swift build
swift test
xcodebuild -project Omni.xcodeproj -scheme Omni -destination 'platform=macOS' build
xcodebuild -project Omni.xcodeproj -scheme Omni -destination 'generic/platform=iOS Simulator' build
Scripts/smoke.sh        # needs the dev backend from step 1 running
Scripts/uitest.sh iphone   # the UI tests on a simulator, with screenshots (TESTING.md)
Scripts/check-release.sh   # the test-only sign-in path is not in a Release build
```

Testing in full — the UI tests, the screenshot gallery (`qa/screenshots/omni/`), the Mac
snapshots, and what still needs a person: **[TESTING.md](TESTING.md)**.

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

- **The app's bundle id can take a suffix** (`OMNI_BUNDLE_SUFFIX`, empty by default). The UI
  tests build `com.benjaminlife.omni.uitest`, so the copy under test runs beside the Omni you
  use and never touches its sign-in or settings.
- **Text colours are the app's own** (`Sources/OmniUI/Colors.swift`): the system's orange,
  red, blue and secondary grey measure 2:1–4:1 as small text on white; these are 4.5:1 or
  better, computed in `ContrastTests`.
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

### Branding and conversation history

The app icon and Settings mark use the owner's supplied 2026-06-29 artwork unchanged,
with standard PNG sizing for iPhone/iPad and Mac. The same image is available to web
clients at `/omni-icon.png`; Prism's separate branding is unchanged.

An imported conversation with no persisted Omni state is grouped under
“Conversations”, rather than asserting that it is waiting or completed. The server
preserves stored history and state; active Omni turns and pending approvals still take
precedence, and all persisted states, including an owner-selected Waiting state, remain. Hermes' current persisted session
API does not prove that an external CLI/cron turn is idle, so message age and old assistant
text are not used as completion evidence. This is a display correction, not a history
migration or cancellation of work.

For Mac hardened-runtime signing, retain `com.apple.security.device.audio-input = true`
from `Support/Omni-macOS.entitlements` alongside the verified production APNs, app/team
and Keychain entitlements. Earlier signing sidecars lacking audio input must be updated,
not reused unchanged. Permission copy now describes explicit conversational recording
and on-device transcription. Microphone/speech permission and actual capture remain
physical acceptance checks.
