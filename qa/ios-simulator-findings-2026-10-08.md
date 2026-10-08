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
| 2 | **The owner cannot finish an app sign-in with the email link.** The link opens in Safari; the app's `ASWebAuthenticationSession` sheet stays on the "link sent" page and is never told. A password sign-in inside the sheet works. | Open |
| 3 | The sheet DOES share Safari's session: after the link signed Safari in, reloading the sheet went straight to consent. So the "link sent" page could poll or offer "I've opened the link" and continue. | Lead for #2 |
| 4 | **A 401 makes the app sign in again by itself, and each time it mints another device.** Four "Prism on iPhone" device tokens were created in about six minutes (two of them 3.4 s apart, seen by the owner as two consent prompts). | Open; first 401's cause unknown |
| 5 | **After such a 401 the page keeps sending requests with NO bearer** (`auth=none` in the server's error log: `/api/notes`, `/api/actions`, `/api/events`, `/auth/me`, `/api/vaults`) until the app is relaunched. Seen by the owner as an empty sidebar and a 403 in Workspace settings while the footer still showed his name and "Synced". | Open |
| 6 | Live-editing connections were closed with "Access changed. Reconnect." eight times on two pages in the first session. Not seen after a clean relaunch. Probably the same token churn as #4. | To confirm |
| 7 | "Tags" is shown twice on a page's property area (a property row and the tag chips). Not checked against the web build. | Open |

## How these were seen

`PRISM_HTTP_ERRLOG=1` (new, off by default) makes the server print one line per refused or
failed request: status, method, path, origin, whether a bearer was sent, and the server's own
error code. Nothing else. Without it the server logs no request outcomes.

## Not yet exercised

Typing in a page, Search, Inbox, the More tab, Settings, app lock, push, export / share sheet,
universal links, anything on a real device.
