# Testing Omni

Benjamin Life · 2026-10-09. How the Omni app is tested, how to run each kind of test, where
the screenshots are, and what still needs a person.

There are four layers. The first two need nothing running; the last two need the laptop dev
backend (`apps/server/scripts/omni-dev.sh` — a stub Hermes and a dev gateway; nothing can be
sent).

| Layer | What it proves | Command | Needs |
|---|---|---|---|
| Unit tests (`Tests/OmniCoreTests`, 99 tests) | Every rule in OmniCore, with a fake server | `swift test --skip OmniUISnapshotTests` | nothing |
| Mac snapshots (`Tests/OmniUISnapshotTests`) | Every Mac screen draws, in light, dark and a narrow window; the app's text colours meet 4.5:1 | `swift test --filter OmniUISnapshotTests` | nothing; nothing appears on screen |
| UI tests (`UITests/`, XCUITest) | The real app, tapped and typed into, on iPhone and iPad (and the Mac, once allowed) | `Scripts/uitest.sh iphone` · `ipad` · `mac` · `all` | dev backend |
| Smoke (`Sources/OmniSmoke`) | The same calls the app makes, through its own view models, incl. the real sign-in | `Scripts/smoke.sh` | dev backend |

Plus `Scripts/check-release.sh`: proves the test-only sign-in path is not in a Release build.

## The screenshot gallery

`qa/screenshots/omni/` (JPEG; regenerate with the commands below, then
`Scripts/gallery.sh` converts the PNGs the tests write).

```
qa/screenshots/omni/
  iphone/iphone-18-pro/{light,dark}/NN-name.jpg       the walk, iPhone 18 Pro portrait
  iphone/iphone-18-pro-xxxl/light/                    the same at the largest Dynamic Type size
  ipad/ipad-pro-13-portrait/{light,dark}/             iPad Pro 13", sidebar + content
  ipad/ipad-pro-13-landscape/light/
  ipad/ipad-pro-13-split/light/                       the iPad window dragged to 375 points wide: tabs
  mac/mac-default/{light,dark}/                       1040 × 700, drawn off-screen from sample data
  mac/mac-narrow/light/                               760 × 500, the window's minimum
```

The numbers follow the order of the walk: first run → sign-in → can't connect → a thread the
agent no longer has → the empty app → reads that fail → the thread list in every state →
search → Today → a new thread, streaming, Stop, tool chips, the keyboard → threads that
failed → record card → approvals (each of the six kinds; Send with sending switched off; Edit;
Revise; Cancel; a draft that does not match its fingerprint) → Settings, Diagnostics, sign out.

**Nothing private is in a picture.** The laptop's dev vault holds real notes and this
repository is public, so the UI tests launch the app with `sample-data`: Today's agenda and
tasks and the title on a record card are made up (`UITestSupport.swift`). Threads and drafts
are the stub's own (`example.com` addresses). The Mac snapshots use only sample data.

## UI tests (iPhone, iPad, Mac)

```bash
cd apps/server && scripts/omni-dev.sh          # leave it running (its own terminal)
cd swift/Omni
Scripts/uitest.sh iphone                       # light, default text size
Scripts/uitest.sh iphone dark
Scripts/uitest.sh iphone light xxxl            # largest Dynamic Type size
Scripts/uitest.sh ipad light portrait          # also: landscape, split
Scripts/uitest.sh all                          # everything above, one after another (~1 h)
```

**Start from a clean dev database now and then.** Each run adds about twenty test threads
(archived afterwards, never deleted). Past 200 sessions the gateway can no longer prove a
thread is gone, so the "no longer available" test fails; `uitest.sh` warns from 170. Stop
`omni-dev.sh`, delete the dev database and its `.stub.json`, start it again.

A second backend on other ports: `OMNI_DEV_PORT`, `OMNI_DEV_DB` (as for `omni-dev.sh`).
`OMNI_UITEST_ONLY=OmniUITests/OmniWalkTests/test08Approvals` runs one test.

What the script does, in order:

1. **Signs in as the dev owner, the way OmniSmoke does.** A ten-minute browser session row is
   added to the DEV database, the real device sign-in is played with it (PKCE, client
   `omni-native`), and the `pd_…` device token goes to the test runner in its environment —
   never printed, never on a command line, revoked when the run ends.
2. **Uses its own simulators**, "Omni UITest iPhone" and "Omni UITest iPad", created on first
   use — never the simulator you use yourself. One is booted at a time, and each is shut down
   when the run ends (`OMNI_UITEST_KEEP_SIMS=1` keeps it up between runs). It waits while the
   Mac has less than 30% of its memory free.
3. Sets the simulator's appearance and text size, adds one "no longer available" sample
   thread to the dev database, and runs `xcodebuild test`.
   For `ipad … split` the test drags the window's bottom-right corner in until the window is
   375 points wide — a real narrow iPad window, with the compact layout the system gives it —
   and the other iPad runs drag it back out to the whole screen.
4. The tests put the backend in a known state through the gateway (`UITests/Seed.swift`:
   one thread per state, one draft per kind), launch the app, and walk it.

The app under test is built with its own bundle id (`com.benjaminlife.omni.uitest`), so it
runs beside the Omni you use and shares nothing with it.

### The test-only launch path

`Sources/OmniUI/UITestSupport.swift`, DEBUG builds only, and only when the process is
launched with `OMNI_UITEST=1`:

- the device token comes from the runner (the browser cannot be driven by a UI test);
- the Keychain and the remembered server are in memory;
- Touch ID / Face ID before Send is let through;
- `OMNI_UITEST_ANIMATIONS=0` turns UIKit's transitions off (the runner waits for every
  animation to end before each step; a spinner removed mid-transition had it waiting a minute
  at a time — one test took 19 minutes instead of one);
- `OMNI_UITEST_FAULTS` changes a few answers to show states the dev backend cannot produce:
  `digest-mismatch`, `today-partial`, `today-fail`, `threads-fail`, `jobs-fail`, `sample-data`;
- it refuses any server that is not `http://127.0.0.1:<port>`.

`Scripts/check-release.sh` checks the source (the file and every use of it sit inside
`#if DEBUG`) and searches a Release build of the Mac app for its names. Run it before a
release.

### What the walk covers

| Test | Screens and checks |
|---|---|
| `test01FirstRunAndSignIn` | Server screen; a refused address says why, and typing again clears it; Sign In; waiting for the browser; Cancel; Change Server |
| `test02CannotConnect` | Can't connect; Try Again; Change Server |
| `test03GoneThread` | "No longer available" in the list and when opened; Check Again; Remove from List returns to the list |
| `test04EmptyApp` | Empty Today, Needs you, Threads; Recurring with Pause and Resume; Today, the list and Recurring when the read fails (each with Try Again) |
| `test05ThreadListSearchAndToday` | All five state groups plus unread; search, no match; Today loaded; opening a thread from Today; Today with a section missing |
| `test06NewThreadStreamingAndStop` | New thread; streaming; Stop; a tool chip; the composer with the keyboard up; a five-line message; the end of the conversation stays visible; the keyboard's Done button; dragging to put the keyboard away |
| `test07ThreadStates` | A failed turn, a dropped connection, a failed tool, an empty answer (each says what happened when reopened); record card; an unread follow-up; re-attaching to a running turn; a stopped thread |
| `test08Approvals` | The queue; all six kinds with their full text; Send → "sending is switched off — nothing was sent"; Edit; Revise; Cancel Draft with its confirmation; a draft that fails its fingerprint has no Send |
| `test09SettingsAndSignOut` | Settings; Diagnostics; Copy All; Sign Out with its confirmation; back at sign-in |
| `test10MacKeysAndWindow` (Mac) | ⌘N, the cursor in the composer, Shift-Return, Return, ⌘R, ⌘F, ⌘, |
| `AccessibilityAuditTests` (iOS) | `performAccessibilityAudit` on sign-in, Today, Needs you, Threads, Recurring, a thread with a draft, a thread with a record card, New Thread, Settings |

**What the accessibility audit asserts, and what it only reports.** A finding fails the test
when it is a touch target that is too small, an element with no or an unhelpful description, a
wrong trait, or text clipped in one of the app's own elements. Two kinds are attached to the
test as "audit notes" instead of failing it, because the audit misjudges them here:

- *Contrast.* The audit samples the screen and fails, for instance, a black title on a white
  row, and it marks the system's own section headers. The app's own text colours are checked
  exactly instead: `ContrastTests` computes each (quiet, warning, failure, accent) against the
  backgrounds it is used on and requires 4.5:1.
- *Dynamic Type.* The audit says "cannot change the font size" of SwiftUI text that uses the
  system text styles. It does change: the whole walk is run at the largest size
  (`iphone light xxxl`), and those screenshots show every one of them grown — and are where
  the real large-text defects were found and fixed.

### On the Mac

macOS will not let a test drive another app until **you** allow UI automation — it asks for
your password the first time (or run `automationmodetool enable-automationmode-without-authentication`
once). Until then `Scripts/uitest.sh mac` fails with "Timed out while enabling automation
mode". The Mac UI tests also take the keyboard and mouse while they run, so run them when you
are not using the Mac.

That is why the Mac screens in the gallery come from the snapshot tests instead.

## Mac snapshots

```bash
cd swift/Omni
swift test --filter OmniUISnapshotTests        # writes qa/screenshots/omni/mac/**.png
```

`Tests/OmniUISnapshotTests` hosts the app's own SwiftUI views in a window that is never shown
(transparent, behind everything, never key) and draws them into PNGs: 36 screens × light,
dark, narrow. (`OMNI_SNAPSHOT_DIR=<folder>` writes them somewhere else.) The data is an in-memory gateway (`SampleService`), shaped as the real one
answers. Safe to run while you work: nothing appears, nothing takes focus.

Its limits, plainly:

- It shows layout, text, colour and every state. It does **not** click, type or check focus.
- The real window is a `NavigationSplitView`; its sidebar is drawn by the system with a
  material that cannot be drawn into a bitmap, so the pictures use a plain column for the
  sidebar. Everything inside the two columns is the app's own views.
- Confirmation dialogs (Cancel Draft, Sign Out) are system alerts and are not drawn.

## What still needs a person

1. **The real browser sign-in.** `OMNI_UITEST_MANUAL=1 Scripts/uitest.sh iphone` (or `mac`,
   `ipad`) opens the app without the test sign-in, presses Sign In and waits three minutes
   for you to finish in the browser (`UITests/ManualSignInTests.swift`). Check that the page
   names "Omni on <this device>" and that the app comes back to the front by itself.
2. **Touch ID / Face ID before Send.** The tests let it through. On a real device, press Send
   on a draft: the system must ask first, and cancelling it must send nothing ("Not sent — it
   wasn't confirmed on this device").
3. **A physical iPhone and iPad.** The simulator has no notch-and-island hardware quirks, no
   real keyboard timing, no cellular network. Walk the list on the phone once: first run (the
   server field starts empty there), sign-in, a thread, a draft.
4. **The Mac, interactively**: the keys (⌘N ⌘F ⌘. ⌘R ⌘,), Return and Shift-Return in the
   composer, the cursor landing in the composer when a thread opens, and the window coming
   back where it was — `Scripts/uitest.sh mac` once UI automation is allowed (above), or two
   minutes by hand.
5. **A real Hermes.** The stub copies it, but speed, real tool calls and real record cards
   are only seen against the real one.
