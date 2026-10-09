# Device pass — one sitting

The checks of the Notion-parity checklist that only a person with a device can make, in the order
you would do them. About 100 minutes. Each step is "do this → expect this", with a box for the result.

- **What counts.** A result on a physical device, written down here with the device, OS and build.
  A simulator result does not count. Something seen in passing does not count until it is written
  in a box.
- **Build.** iPhone / iPad: `apps/client/scripts/ios-release.sh -adhoc` (ad hoc profile,
  production APNs, nothing uploaded — TestFlight stays closed until parity sign-off). Mac: the
  Prism Client in daily use. All against the production server, on synthetic `_test` pages only;
  delete them afterwards.
- **Bring.** A small iPhone (SE class) and a large one (Pro Max class), an iPad with a keyboard
  and trackpad, a Mac, a second account (a member), a YouTube link, a Vimeo link, a Spotify link.
- **Before you start.** On a Mac: `node apps/client/scripts/verify-client.mjs` is clean;
  `curl -s https://<server>/.well-known/apple-app-site-association` answers 200 with JSON and no
  redirect. Prepare one `_test` page that holds: an uploaded image, a cover, a PDF, an audio file,
  a video file, a YouTube embed, a Vimeo embed, a Spotify embed, and a `_test` database with a
  Calendar view and a few dated rows.
- **Marks.** `◐ 10-08` = this was exercised informally on the owner's iPhone on 2026-10-08 (debug
  build against production) and looked right, but **no result was recorded** — do it again and
  write it down. `NEW` = built since the last script and never seen on a device.
- **If a step fails:** write what you saw, take a screenshot, carry on. One failure does not stop
  the sitting.

## Session record

| | iPhone (small) | iPhone (large) | iPad | Mac |
|---|---|---|---|---|
| Device model | | | | |
| OS version | | | | |
| App build (version + build number) | | | | |
| Server version (`/health`) | | | | |
| Date · tester | | | | |

Result boxes: write **P** (pass), **F** (fail) or **–** (not done), and a note when it is F.

---

## Part A — iPhone, first launch (15 min)

| # | Row | Do | Expect | Seen | Result | Note |
|---|---|---|---|---|---|---|
| A1 | NP-NA-05 | Look at the home-screen icon in light, dark and tinted mode. | The icon is right in all three. | | ☐ | |
| A2 | NP-NA-05, NP-AX-01 | With the phone in dark mode, launch the app. | The launch screen is dark — no white flash. | | ☐ | |
| A3 | NP-NA-01 | First run: type the server address → Continue. | The address is accepted once; the app reloads to the sign-in screen. A wrong address says so and keeps what you typed. | ◐ 10-08 | ☐ | |
| A4 | NP-NA-01 | Tap **Sign in** → the system sign-in sheet → sign in. | You are back in the app, signed in. ONE new "Prism on iPhone" device appears in Settings → Account on the web — not two. | ◐ 10-08 | ☐ | |
| A5 | NP-NA-01 | Settings → Account → **Sign out**. | The sign-in screen, no page content behind it. The device is gone from "Signed-in devices" on the web. | | ☐ | |
| A6 | NP-NA-01 | Sign in again. Use the app for five minutes. | No second sign-in sheet appears by itself. | ◐ 10-08 | ☐ | |
| A7 | NP-NA-02 | Settings → turn the app lock on. Force-quit, relaunch. | Face ID is asked at launch; the passcode works as a fallback. | | ☐ | |
| A8 | NP-NA-02 | Background the app past the idle time, come back. Open the app switcher. | Face ID on return. The app's card in the switcher is blurred. | | ☐ | |
| A9 | NP-NA-03 | Settings → Account → "Notify me…" on. | The notification prompt appears NOW — not at first launch, not before sign-in. | | ☐ | |
| A10 | (offline storage) NEW | Use the app, background it for 10+ minutes (open a heavy app meanwhile), come back. Repeat after installing a new build over the old one. | No "Save needs attention" / "Offline storage unavailable" pill. If a pill does appear: it names storage, and it goes away by itself within a few seconds. | | ☐ | |

## Part B — iPhone, writing (25 min)

Do B1–B9 on the small phone; repeat the ones marked **×2** on the large phone and in landscape.

| # | Row | Do | Expect | Seen | Result | Note |
|---|---|---|---|---|---|---|
| B1 | NP-MB-01 | Open a page. Tap in the text. | The bottom bar (Notes, Inbox, Search, Agent, More) is labelled and shows where you are; it hides while the keyboard is up and returns when it goes. | ◐ 10-08 | ☐ | |
| B2 | NP-MB-01 | Open a message thread. | The reply field owns the bottom edge; the bar does not sit over it. | | ☐ | |
| B3 | NP-MB-02, NP-SB-13 | Notes → **New page**. | "Untitled" title focused with the keyboard up, in one tap. | | ☐ | |
| B4 | NP-MB-04 **×2** | Type. Use every button of the toolbar above the keyboard. Rotate the phone. | The toolbar sits on the keyboard and never covers the caret; every button works; nothing jumps on rotation. | ◐ 10-08 | ☐ | |
| B5 | NP-MB-04 | Attach an external keyboard and type. | The toolbar does not float in the middle of the screen. | | ☐ | |
| B6 | NP-MB-08 **×2** | Tap into the title, the body, a comment, a search field, a database cell. | The page never zooms on focus. Nothing sits under the notch or the home indicator. Accept / Send controls stay above the keyboard. | ◐ 10-08 | ☐ | |
| B7 | NP-MB-05 | Scroll a long page starting with your thumb on text. Then tap the block handle. | No block is dragged while scrolling. The handle opens a menu with Move up / down and Turn into. | | ☐ | |
| B8 | NP-MB-09 | Long-press a word; drag the handles. Long-press a link. | Native selection handles. Prism's toolbar does not sit under the iOS callout. A link previews — it does not navigate. | | ☐ | |
| B9 | NP-MB-03 | Header **⋯**. | A sheet with every page action, large rows. It closes by dragging down, by Close, and by tapping outside. It slides in (it does not just appear). | | ☐ | |
| B10 | NP-MB-06 | Swipe from the left edge on a page. Swipe an Inbox row and a Trash row. Pull down on Inbox, Trash, Messages, Notes. | Back / drawer. Row actions (Messages: only "mark read" — archive is never a swipe). Pull-to-refresh without fighting the system bounce. | | ☐ | |
| B11 | NP-SR-08 | Tap **Search**. | Full-screen search with the keyboard up at once; recents listed. | | ☐ | |
| B12 | NP-PG-05 | Open a page with properties. Tap a status, a date, a checkbox, a URL, a number. | Each opens its own editor; values save; the property area does not scroll sideways. A checkbox you add appears unticked. | ◐ 10-08 | ☐ | |
| B13 | NP-AX-07 NEW | Open the `_test` database → Calendar → **Month**. Tap days. Tap **+** on a day. Change a page's date from the list under the grid. | Each day is one finger-sized cell; the tapped day's pages are listed under the grid; the new page lands on that day; the moved page's mark moves. | | ☐ | |
| B14 | (Calendar tool) | Tools → Calendar. Switch Agenda / Day / Week / Month; tap a day; open an event. | Controls stay put between views; the month is finger-sized; an event opens. | ◐ 10-08 | ☐ | |
| B15 | NP-AX-08 | Japanese kana and Chinese pinyin keyboards: type "/", "@", "[[" in the middle of a composition; commit with Return in the body, the title, a comment reply. Dictate a sentence. Insert an emoji. | No menu opens mid-composition. The committing Return sends nothing and splits nothing. No text appears twice. | | ☐ | |
| B16 | NP-AX-05 | iOS Settings → Accessibility → Larger Text at the largest size. Open a page, the tree, a database, Share. | No clipped control, no sideways page scroll. | | ☐ | |
| B17 | NP-AX-03 | VoiceOver on: open a page from the tree, edit a line, open the slash menu, wait for a save, trash a page. | Buttons are named; the tree says expanded / collapsed; the save state and "Moved to Trash" are spoken. | | ☐ | |

## Part C — iPhone, media, offline, push (25 min)

| # | Row | Do | Expect | Seen | Result | Note |
|---|---|---|---|---|---|---|
| C1 | NP-ED-12, NP-PG-02 | Open the `_test` media page. Tap the image. | The cover and the image show in the app; the image opens full screen. | | ☐ | |
| C2 | NP-ED-13 | Tap the PDF, the audio and the video blocks. Add a file with the picker. | The players work; the picked file becomes a block. | | ☐ | |
| C3 | NP-ED-15 NEW | Look at the **YouTube** embed. Tap play. | A player inside the page (not a card). It plays — inline or full screen. | | ☐ | |
| C4 | NP-ED-15 NEW | Look at the **Vimeo** embed. Tap play. | A player inside the page. It plays. | | ☐ | |
| C5 | NP-ED-15 NEW | In either player, tap the provider's logo / "Watch on …". | Nothing opens and the app does not leave the page. | | ☐ | |
| C6 | NP-ED-15 NEW | Tap the block's own **Open in YouTube** button (top right of the embed). | A native "open this link?" confirmation with the address; Safari opens only after you confirm. | | ☐ | |
| C7 | NP-ED-15 NEW | Look at the **Spotify** embed. | An "Open in Spotify" card that says only YouTube and Vimeo play inside the app. No blank box. | | ☐ | |
| C8 | NP-ED-15 NEW | After playing a video: go back to the page list, open another page, come back. | The app is still the app — no stuck player page, no blank screen. | | ☐ | |
| C9 | NP-TX-03 | Page ⋯ → Export → Markdown. | The iOS share sheet opens with the file. | | ☐ | |
| C10 | NP-OF-04 | Star a page; wait a minute; airplane mode; open it. Turn "Make available offline" on for another page and repeat. | Both open offline and say "Offline copy from <time>". | | ☐ | |
| C11 | NP-OF-03, NP-NA-06 | Airplane mode: type in a live page and in a plain page. Force-quit. Reopen. Reconnect. | All the text is there after the relaunch. One merge on reconnect: nothing lost, nothing doubled. The header never says "Saved" while offline. | | ☐ | |
| C12 | NP-NA-06 | Mid-draft, background the app for 10 minutes; return. | The page, the scroll position and the draft are back. Nothing was sent twice; no second agent turn started. | | ☐ | |
| C13 | NP-NA-03, NP-CO-04 | From the second account: mention the owner; reply to their comment. | A push for each (generic words, no page text). Tapping one opens the page at the passage. | | ☐ | |
| C14 | NP-RF-06 | Set a reminder two minutes ahead. | A push at the time; tapping it opens the page. | | ☐ | |
| C15 | in-app dialogs NEW | In a `_test` page type `/embed`, tap **Embed**. Type a YouTube address, tap **Embed**. Repeat with `/bookmark` and **Image from URL**. | A field named "Link to embed" appears just above the keyboard with the cursor in it (the keyboard stays up). The player / card / image lands where the cursor was. No system pop-up at any point. | | ☐ | |
| C16 | in-app dialogs NEW | `/embed` again, then tap **Cancel**. Then type some words. | Nothing was added; the `/embed` text is gone; the cursor is back in the same line and the words go there. | | ☐ | |
| C17 | in-app dialogs NEW | `/image` → **Image**. Then the keyboard toolbar's Image button. Then `/file`, `/video`, `/audio`, `/pdf`. | Each tap opens the iOS chooser at once (Photo Library / Take Photo / Choose File for an image). Pick a photo: it uploads and shows in the page. Cancel a chooser: nothing happens and the next tap still opens it. | | ☐ | |
| C18 | in-app dialogs NEW | In the image chooser pick **Take Photo**. | iOS asks for camera access with Prism's sentence (first time), the camera opens, the photo lands in the page. The app does not close. | | ☐ | |
| C19 | in-app dialogs NEW | Settings → Account → Signed-in devices → **Revoke** on a device. Tap **Cancel**; then again and tap **Sign out**. Same for an agent token (**Revoke**). | A confirmation inside the app, on top of Settings, both times. Cancel changes nothing; the red button does it. | | ☐ | |
| C20 | in-app dialogs NEW | Type `[[` and `@` on a line near the bottom of a page, keyboard up. Then `/table view` → **Cancel**. | Each list opens where it can be seen (not behind the keys). After Cancel the cursor is back in the page and the keyboard toolbar is there. | | ☐ | |
| C15 | NP-NA-03 | Start an agent turn and background the app. | A push when the turn ends; tapping it opens that session. Turning the category off in notification settings stops it. | | ☐ | |
| C16 | NP-NA-02 × push | With the app lock on and the app locked: tap a notification. | Nothing opens until Face ID succeeds; then the page opens. | | ☐ | |
| C17 | NP-NA-04, NP-PG-16 NEW | Tap an `https://<server>/page/<id>` link in Messages and in Mail. Then a `prism://page/<id>` link. | The app opens that page (as a tab; the app does not reload). On a phone without the app, Safari opens it. | | ☐ | |
| C18 | NP-CO-04 | Leave an item unread for 30+ minutes on an account that is not open anywhere. | One digest email. | | ☐ | |
| C19 | NP-PF-01, PF-03, PF-07 | Safari Web Inspector attached: 20 cold starts; type in the 10,000-word page; Instruments (Allocations) for 30 minutes and 50 page opens. | ≤ 3.0 s p95 to an editor you can type in; no long task over 50 ms and ≤ 16 ms p50 from key to paint; ≤ 300 MB with no steady growth. Write the numbers in the note. | | ☐ | |

## Part D — iPad (10 min)

The iPad uses the iPhone build — it is not its own project. These steps check that the same app is
usable at iPad sizes; anything iPad-only that fails is a note, not a blocker for the iPhone gate.

| # | Row | Do | Expect | Seen | Result | Note |
|---|---|---|---|---|---|---|
| D1 | NP-MB-10 | Landscape, then portrait, with a trackpad and keyboard. | Landscape: the sidebar is always there. Portrait: it overlays the page. Nothing is cut off in either. | | ☐ | |
| D2 | NP-MB-10 | Hover a tree row and a block with the trackpad. | The hover controls (⋯, +, the block handle) appear. | | ☐ | |
| D3 | NP-MB-10 | Press ⌘K, ⌘\, ⌘/, ⌘N. | Quick find; sidebar toggle; the block menu (in a block) or the shortcut sheet; a new page. | | ☐ | |
| D4 | NP-AX-07 | A database Calendar view (the desktop month grid on a touch screen). | The "+" on each day is visible without hovering and can be tapped. Note whether the small page chips are hard to hit — they are not finger-sized on an iPad yet. | | ☐ | |
| D5 | NP-ED-15 NEW | The YouTube and Vimeo embeds. | They play, as on the iPhone. | | ☐ | |
| D6 | NP-ED-13 | Split View with Files: drag a file into a page. | The file becomes a block. | | ☐ | |

## Part E — Mac, Prism Client (15 min)

| # | Row | Do | Expect | Seen | Result | Note |
|---|---|---|---|---|---|---|
| E1 | NP-NA-07, NP-SB-13 | Press ⌘N. | A new "Untitled" page with the title focused. (If nothing happens: the native menu is swallowing it — note it.) | | ☐ | |
| E2 | NP-NA-07, NP-ED-05 | ⌘K with text selected; ⌘K with nothing selected. | The link editor; quick find. | | ☐ | |
| E3 | NP-NA-07 | ⌘\, ⌘/ (in a block), ⌘⇧/, ⌘P, ⌘[ and ⌘], ⌘F, ⌘⌥F, ⌘B / I / U / E. | Each reaches the app; none is taken by a native menu. | | ☐ | |
| E4 | NP-NA-07 | Open a second window. Use quick capture from the tray and with the global shortcut. | Both windows work; the capture lands in the vault. | | ☐ | |
| E5 | NP-TX-03 | Page ⋯ → Export. Then ⌘P. | A native save dialog; a print preview without the app's chrome. | | ☐ | |
| E6 | NP-ED-13 | Drag a PDF and an image in from Finder. | Blocks are created. | | ☐ | |
| E7 | NP-ED-15 NEW | Open the `_test` media page: YouTube, Vimeo, Spotify. Play a video. Click the provider logo inside the player. Click the block's **Open in …**. | YouTube and Vimeo play in the page; Spotify is a card. The logo opens nothing. "Open in …" asks for confirmation, then opens the browser. | | ☐ | |
| E8 | NP-NA-04 NEW | Click an `https://<server>/page/<id>` link in Mail / Messages. | The page opens in Prism Client (or, where universal links are not set up for the Mac build, in the browser — note which). | | ☐ | |
| E9 | NP-NA-01 | Sign out and in. | The token lives in the Keychain; the old device is revoked on the server. | | ☐ | |
| E10 | NP-AX-03 | VoiceOver: the tree, the block menu, a database cell, Share. | Named controls; the tree says expanded / collapsed. | | ☐ | |
| E11 | in-app dialogs NEW | Type `/embed` → Enter, paste a YouTube address → Enter. `/bookmark`, `/image from url` the same. Open **Formatting** → **Link** with a word selected, and **Image**. Press Esc in one of them. | A small field opens by the cursor each time (never a system prompt — the Mac app showed none, so these did nothing before). Enter inserts; Esc inserts nothing and the cursor is back. | | ☐ | |
| E12 | in-app dialogs NEW | Agent panel → archive a session. Settings → Account → revoke a device. ⌘K → "Resolve wikilinks in this note". | A confirmation / message inside the app each time; the action happens only after its button. | | ☐ | |

## Part F — Safari and the installed web app (10 min)

| # | Row | Do | Expect | Seen | Result | Note |
|---|---|---|---|---|---|---|
| F1 | NP-CO-04, NP-RF-06 | On the iPhone: add the web app to the home screen, allow notifications. Repeat the mention and the reminder. | A web push arrives; tapping it opens `/inbox/<id>`, then the page. | | ☐ | |
| F2 | WebKit caveats | Desktop Safari with DEFAULT settings (Tab does not highlight each item): Tab through a link card and a database cell edit. | Both can be walked with plain Tab. | | ☐ | |
| F3 | NP-ED-15 | Safari (web, not the app): the `_test` media page. | Every provider plays as before, Spotify included — the web is unchanged. | | ☐ | |
| F4 | (offline storage) NEW | Installed web app on the iPhone: use it, leave it in the background for 10+ minutes, return. | No storage pill; the page you left is there. | | ☐ | |

---

## After the sitting

1. Copy each row's result into `docs/roadmap/workspace-experience/PARITY-EVIDENCE.md` (the row's
   `[D]` note: device, OS, build, result) and change the row's status in
   `NOTION-PARITY-CHECKLIST.md` only where every step of that row passed.
2. A failed step becomes a line in `qa/punch-list.md` with the screenshot.
3. Delete the `_test` pages and the second account's test mentions.
