# iOS simulator findings — 2026-10-08

For Benjamin Life (@omniharmonic). First run of the Prism iOS app: debug simulator build
(Xcode 27.0, iOS 27.0, iPhone 18 Pro simulator) against a dev Prism Server on the laptop
(`http://127.0.0.1:8787`) and a scrubbed copy of the vault. Simulator results do not count
for the device checklist in `docs/client-app.md`.

## Worked

- The build compiled with no source change and the app launches to "Enter your server".
- `http://127.0.0.1:8787` is accepted by the debug build; the sign-in sheet opens.
- After sign-in the workspace loads pages from the vault; the phone tab bar renders.
- `xcrun simctl openurl booted prism://page/<id>` opens that page (after iOS's own
  "Open in Prism?" prompt).

## Findings

| # | Finding | Status |
|---|---|---|
| 1 | The server-address field was near-black on the light card: two iOS-only screens named a colour token that does not exist (`--surface-sunken`). | Fixed (PR #21) |
| 2 | **The owner cannot finish an app sign-in with the email link.** The link opens in Safari; the app's `ASWebAuthenticationSession` sheet stays on the "link sent" page and is never told. A password sign-in inside the sheet works. | Fixed in code (the "link sent" page continues once the browser is signed in; see #3). **Not yet seen on a simulator or device.** |
| 3 | The sheet DOES share Safari's session: after the link signed Safari in, reloading the sheet went straight to consent. So the "link sent" page could poll or offer "I've opened the link" and continue. | Done: it does both (`LoginScreen`, only mid app sign-in; the server's consent step is unchanged) |
| 4 | **A 401 makes the app sign in again by itself, and each time it mints another device.** Four "Prism on iPhone" device tokens were created in about six minutes (two of them 3.4 s apart, seen by the owner as two consent prompts). | Fixed in code: a 401 is confirmed with one `/auth/me` before the token is dropped, sign-in is one at a time, and only a press starts one (`native/sessionGuard.ts`). The trigger is #8. **Not yet seen on a simulator or device.** |
| 5 | **After such a 401 the page keeps sending requests with NO bearer** (`auth=none` in the server's error log: `/api/notes`, `/api/actions`, `/api/events`, `/auth/me`, `/api/vaults`) until the app is relaunched. Seen by the owner as an empty sidebar and a 403 in Workspace settings while the footer still showed his name and "Synced". | Fixed in code: with no token the request is not sent and the page reloads into the sign-in screen. **Not yet seen on a simulator or device.** |
| 6 | Live-editing connections were closed with "Access changed. Reconnect." eight times on two pages in the first session. Not seen after a clean relaunch. Probably the same token churn as #4. | To confirm |
| 7 | "Tags" is shown twice on a page's property area (a property row and the tag chips). Not checked against the web build. | Open |
| 8 | **Root trigger: the vault now and then refuses the server's own valid token, and the owner passthrough forwarded that 401 to the client.** Reproduced against the laptop vault (0.7.9, hub 0.7.19) with a fresh token: 1 refusal in 40 requests, then 0 in 300; the Mini's vault gave 0 in 150. Why the vault does it is not known. Every client reads a 401 as "signed out" — on the web that would be the login screen. | Fixed server-side: the passthrough and the server's vault client send the request once more, and a second refusal is a 502 `vault_auth` (`test/vault-token-refused.test.ts`) |
| 9 | Slash menu → "Page": the sub-page IS created, but its row does not appear in the page being edited until the page refreshes, so it looks as if nothing happened. Reported by the owner; not investigated, not yet compared with the web build. | Open (polish pass) |
| 10 | Email: Reply does not open an input. The dev server runs with `ACTIONS_EMAIL_ENABLED=false`, which may be the whole cause (the reply composer needs live email actions); not verified. If so, a Reply button that does nothing should be hidden or say why. | Open (polish pass) |
| 11 | The page zooms in and out on its own at phone width (the usual iOS behaviour when something is wider than the screen or an input is under 16 px). | Open (polish pass) |
| 12 | Page properties and some editor chrome render poorly at phone width. Known mobile issue. | Open (polish pass) |

After fix #8 the owner used the app for a session with no sign-out and no new device. The
session was not clean, though: six database requests (`/api/query`, `/api/schemas`) answered
502 `vault_error`, because the tag-schema read in `routes/databases.ts` called the vault with
its own `fetch` and had no retry. It now goes through `fetchVault` (parachute.ts).

### What the vault does (measured on the laptop, vault 0.7.9, hub 0.7.19, Bun 1.2.17)

- 1,633 sequential authenticated reads over 150 s while Prism was also running: 5 refused,
  each a single request, body `{"error":"Unauthorized","message":"API key required"}` — the
  message for a request with NO Authorization header, though one was sent. Two of them were
  exactly 10.00 s apart.
- With two authenticated clients, two anonymous clients and a `/health` poller running flat
  out together: 9 authenticated requests answered 200 and 34,820 answered 401.
- In that run no anonymous request was answered 200 (0 of 30,372), so no sign of an
  anonymous request being let in. That is one test, not a proof.
- So the vault appears to mis-read the Authorization header of a request that overlaps
  unauthenticated ones (the hub's health probe included). Cause not established; this is in
  Parachute or Bun, not Prism. The Mini's vault gave 0 refusals in 150 sequential reads; it
  has not been tested under concurrency.

### What the code did (findings 4 and 5), read after the session

- `serverFetch` called `host.onUnauthorized()` on ANY 401 that carried the device token, and
  the shell's `onUnauthorized` deletes the Keychain token (`sign_out {revoke:false}`). So one
  refused request threw away a good token.
- Nothing then reloaded the page. `serverFetch` adds the bearer only `if (token)`, so every
  later request simply went out without one (finding 5).
- No code path started a sign-in after a 401: the only caller of `signIn()` was, and is, the
  "Sign in" button. Each lost token still cost a new sign-in — and so a new device — the next
  time the person reached that button. Two presses could also overlap: on iOS `signIn` did
  not wait for the sheet that was already up. That is the likeliest reading of the two
  devices 3.4 s apart, but it was not reproduced.

## How these were seen

`PRISM_HTTP_ERRLOG=1` (new, off by default) makes the server print one line per refused or
failed request: status, method, path, origin, whether a bearer was sent, and the server's own
error code. Nothing else. Without it the server logs no request outcomes.

## Not yet exercised

Typing in a page, Search, Inbox, the More tab, Settings, app lock, push, export / share sheet,
universal links, anything on a real device.
