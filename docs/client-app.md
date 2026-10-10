# Prism Client (`apps/client`)

A thin Tauri 2 app that bundles the **native build of `apps/web`** and talks to exactly
one **Prism Server** with a revocable **device token**. It is the laptop client of
Architecture v2 (WP4.1) and the shell the iPhone app joins in WP5.

It holds **no vault token**, runs **no ingest**, spawns **no CLI**, and has **no fs/shell
access**. Everything it can see or change goes through the server gateway, so
`effectiveLevel`/governance apply exactly as they do in a browser.

| | Legacy desktop (`apps/desktop`) | Prism Client (`apps/client`) |
|---|---|---|
| Trust model | Holds the vault JWT, talks to `localhost:1940` | Holds a per-device `pd_…` token, talks to one Prism Server |
| Status | **Legacy since WP4.3** (rollback path only, `apps/desktop/README.md`) | The client for every Mac, the Mac mini included |
| Backend | ~100 Rust commands, sync services, `claude`/`gog`/`gh` subprocesses | 10 commands for the main window (`get_token`, `sign_in`, `sign_out`, `get_server_origin`, `set_server_origin`, `open_external`, `notify`, `export_note`, `save_export`, `save_attachment`) + `quick_capture` for the capture window |
| UI | Desktop build of `@prism/core` | `apps/web` built with `--mode native` |
| Identity | `Prism`, `com.benjaminlife.prism` | **`Prism Client`**, `com.benjaminlife.prism.client` |
| Agent / ingest | Local | Server-side (`/api/agent/*`, server workers) |

**Why "Prism Client".** During the transition both apps are installed. The bundle name
comes from the product name, so a second `Prism.app` would overwrite the legacy one in
`/Applications`. A distinct name and identifier keep them side by side, with separate
keychain items and settings. WP4.3 kept the name: renaming the bundle to "Prism" would
overwrite the archived legacy `Prism.app` if it is ever restored for a rollback. Rename
only once the legacy app is gone for good (a product-name change; the identifier, and so
the keychain item and settings, stay the same).

Feature parity with the legacy desktop, command by command, is
`docs/roadmap/architecture-v2/desktop-parity.md`.

## Build and run

```bash
npm install --prefer-offline                   # at the repo root
cd apps/client
npm run tauri build -- --bundles app           # -> <target>/release/bundle/macos/Prism Client.app
npm run tauri dev                              # same bundle, debug build, devtools on
cd src-tauri && cargo test                     # PKCE, loopback, origin/CSP, token exchange (local fakes)
node apps/client/scripts/verify-client.mjs     # static invariants (CSP, capabilities, bundle); --build to rebuild web first
```

Both `tauri build` and `tauri dev` first run `npm run build:native -w @prism/web`
(→ `apps/web/dist-native`). There is no dev server: dev serves the same bundled build,
so no `localhost` origin is ever needed. Rebuild after web changes.

### Server origin

The client talks to one origin, chosen in this order:

1. **Prism → Server Settings…** (Cmd-,): saved in
   `~/Library/Application Support/com.benjaminlife.prism.client/client-settings.json`. Saving
   restarts the app, because the CSP is built from the origin at startup.
2. `PRISM_SERVER_ORIGIN` at **build time**, e.g.
   `PRISM_SERVER_ORIGIN=https://prism.example.com npm run tauri build -- --bundles app`.
3. The default, `https://prism.omniharmonic.com`.

Accepted: `https://host[:port]`; `http://` only for `127.0.0.1`/`localhost`/`[::1]` (a local
test server). Ports 1939/1940 (hub/vault) are refused: the client never talks to a vault.
No path, query, fragment or userinfo.

The Server Settings dialog is page UI, so page script could alter what it submits. Two
gates stand behind it:

1. A **single-use grant**. The shell mints it only when the user picks the native menu
   item. It is valid for 10 minutes and is consumed by any save attempt, right or wrong.
2. A **native confirmation**, which is the real boundary. It shows the normalized origin
   that will actually be saved ("Point Prism Client at https://…? You will need to sign
   in…", with Cancel as the default button).

Only the dialog's **Change Server** button persists. Cancel or closing it saves nothing and
still consumes the grant.

The same file stores the main window's size/position/maximized state. It never holds a
token.

## Sign-in (PKCE + loopback redirect)

The server side is documented in [native-auth.md](native-auth.md). The client leg:

1. The web app shows **Sign in to Prism** (`NativeSignInScreen`) when it has no token or
   gets a 401. The button calls `__PRISM_HOST__.signIn()` → `sign_in` command.
2. Rust generates a fresh PKCE verifier (32 random bytes, base64url), its S256 challenge and a
   random `state`, and binds **`127.0.0.1:<random port>`** (RFC 8252 §7.3).
3. The **system browser** opens
   `/auth/device/authorize?client_id=prism-native&redirect_uri=http://127.0.0.1:<port>/callback&code_challenge=…&code_challenge_method=S256&state=…&label=Prism Client on <host>`.
   The user signs in with the normal web login (password or owner magic link) and approves.
4. Each local connection is served in its own task: at most 8 at once, extras dropped,
   2 s to send the request. An idle or slow local socket therefore can't stall sign-in.
   The listener accepts exactly **one** `GET /callback` carrying our `state` (constant-time
   compare), answers with a static page, and closes. Wrong paths get 404, and forged or
   stale `state` gets 400. Neither ends the wait, so a local process can't cancel a real
   sign-in. The whole wait times out after 10 minutes. Pressing Sign in again cancels the
   previous attempt.
5. Rust POSTs `grant_type=authorization_code, code, code_verifier, redirect_uri,
   client_id` to `/auth/device/token`. Redirects are refused, and the response must be a
   `Bearer` `pd_…` token.
6. The token is stored in the **Keychain**, the window is focused, and the page reloads. The
   auth gate then calls `/auth/me` with the bearer.

The verifier and code never enter the webview. Only the resulting token does, through
`getToken()`, because the page's `fetch` needs it.

**Why loopback rather than `prism://`.** A custom scheme can be claimed by any app on the
machine. A loopback port is bound by us for the duration of one attempt. This is the RFC
8252 recommendation for desktop apps, and it needs no deep-link plugin or `Info.plist`
URL-type registration. The server allowlist already accepts it (`DEVICE_ALLOW_LOOPBACK`,
default on). iOS (WP5.2) uses `ASWebAuthenticationSession` with `prism://auth/callback`
or a universal link. It plugs into the `#[cfg(mobile)]` arm of `signin.rs` and reuses
`pkce.rs`, `auth.rs` and `secure_store.rs` unchanged.

### Sign-out and 401

- **Account → Sign out** (web `logout()`): revokes with the bearer, then
  `onSignedOut()` → `sign_out {revoke:false}` deletes the keychain item.
- **Prism → Sign Out** (menu): `sign_out {revoke:true}` works in this order:
  1. It revokes (`POST /auth/device/revoke token=…`) with whatever token it knows, from
     memory or else from the keychain.
  2. It then forgets the token: first in memory, then in the keychain. A keychain failure
     can therefore never skip the revoke, and it is reported to the UI as a toast.
  3. It deletes the offline read cache (`prism-read-cache`) and reloads.
- **401** on our token is a suspicion, not a sign-out (`apps/web/src/native/sessionGuard.ts`
  states the rule). The page asks ONE `GET /auth/me` with the same token. Only a 401 from
  `/auth/me` itself ends the session: `onUnauthorized()` → `sign_out {revoke:false}`, then
  the page reloads into the sign-in screen. A 200 keeps the token; no answer, a 5xx or a
  proxy page keeps it too. Nothing ever starts a sign-in except the person's press — each
  sign-in mints a device. `signIn()` is one at a time: on iOS a call while the sheet is up
  joins it; on desktop a second click restarts the flow (the shell cancels the first).
- **No token under a running page** (signed out from the menu, the Keychain item gone): the
  request is not sent at all — it is answered 401 locally — and the page reloads into the
  sign-in screen. A page never carries on without a bearer behind a signed-in workspace.

## Keychain

`secure_store.rs` calls Security.framework's `SecItem*` API via the `security-framework`
crate, the same code on macOS and iOS. It stores one generic-password item per server:

- service `com.benjaminlife.prism.client`
- account = the origin
- label "Prism device token"
- **non-synchronizable** (never iCloud Keychain)

Setting deletes and re-adds the item, so its ACL binds to the current binary. The token is
read from the keychain once per process and then served from memory, because `getToken()`
runs on every request. On platforms without a binding the store refuses to save, and the
app stays signed out. It never falls back to a file or `localStorage`.

Unsigned or ad-hoc-signed dev builds: macOS ties the item's ACL to the binary's code
signature, so after a rebuild the first read may show an "allow access" prompt. Signed
release builds don't.

## Host hook

`src-tauri/src/host.js` is injected as an initialization script, before the app bundle.
The origin is JSON-injected by `host.rs`. It defines a frozen `window.__PRISM_HOST__` with
`apiOrigin`, `getToken`, `onUnauthorized`, `signIn`, `onSignedOut` (the WP2.2
contract) and `frameOrigins` (the embed players this shell frames — see "Embeds"). It also defines `window.__PRISM_SHELL__` (`showServerSettings(grant)`,
`signOut()`, `toast()`, and since NP-NA-04 `openLink(path)` / `takePendingLink()` — see
"Links and New Page"), which the native menu and the shell's link handler drive. It uses Tauri's
`__TAURI_INTERNALS__.invoke`, captured at startup. `withGlobalTauri` is off, and the web
build aliases `@tauri-apps/api/core` to its own shim.

Because the host hook is present, `@prism/core`'s `isDesktop` is **false** in the client
(`lib/platform.ts`). Desktop-only affordances such as Google Calendar writes stay hidden,
just as in the PWA.

## Native extras (WP4.2, desktop only)

Five extras. None changes the navigation lock, the CSP, the origin-change confirmation or
how the token is handled. Each is least-privilege; the command table is the whole new IPC
surface.

| Extra | Command | Window / capability file | Notes |
|---|---|---|---|
| Quick capture | `quick_capture {text}` | `quick-capture` window only, `capabilities/quick-capture.json` (grants `allow-quick-capture` and nothing else) | POSTs from Rust. The window never gets `get_token`. |
| Notifications | `notify {title, body, sessionId?}` | `main`, `capabilities/default.json` | Shown only while the main window is NOT focused. |
| Export | `export_note {content, suggestedName, format}` | `main`, `capabilities/default.json` | Destination comes from the native save panel only. |
| Export archive | `save_export {jobId, suggestedName, cancel?}` | `main`, `capabilities/default.json` | Rust downloads from the configured server (no redirects) and writes only where the save panel says. |
| Save an attachment | `save_attachment {attachmentId, suggestedName}` | `main`, `capabilities/default.json` + `mobile.json` | Rust downloads `/api/attachments/<id>` from the configured server (no redirects, size cap, no page/script types), names the file from a fixed extension list, and writes only where the save panel says (iOS: the share sheet). |
| Tray / global shortcut | none (Rust only) | none | No page-callable surface at all. |
| Drag-drop | none (OS event, Rust only) | none | Content reaches the page as a DOM event. |

**Menu-bar icon (tray).** Items: Quick capture…, Open Prism, Sign out, Quit Prism. Sign out
runs the same path as the app menu (`signOut()` in `host.js`). Closing the main window now
**hides** it, so the app stays in the menu bar; Cmd-Q or tray Quit exits, and a dock click
or "Open Prism" shows the window again. The tray uses the app icon (a monochrome template
icon is a polish item).

**Quick capture** (tray item, File menu, global shortcut). A small always-on-top window
that loads the static `quick-capture.html` from the bundle (apps/web/public). It has no app
code, no host hook and no token. Its only call is `quick_capture {text}`:
- Rust validates the text (non-empty, ≤100,000 bytes, no control characters except
  `\n \r \t`), builds the request itself (`capture.rs`: one fixed destination, `POST
  <configured origin>/api/notes`, path `vault/capture/<utc-date>/<HHMMSS>-<rand4>`, tag
  `capture`, metadata `source`/`capturedAt`) and sends it with the stored device token. It
  doesn't follow redirects, and no error message echoes a response body.
- The page controls only the text. An empty text means "dismiss" (Esc/Cancel): the window
  closes and nothing is sent. A signed-out client returns "You're signed out…".
- It writes to the server's primary vault (the shell has no vault switcher). The note
  appears in the app via the normal invalidation stream.

**Global shortcut.** Default `CommandOrControl+Shift+Space`. Configure it in
`client-settings.json` as `"quickCaptureShortcut"`: absent = default, `""` = off. It must
include a modifier; an invalid or already-taken value is logged and ignored (the tray
still works). Restart required. It is registered from Rust with the official
`tauri-plugin-global-shortcut`; none of its commands is granted to any window, so page
script can't register or observe global shortcuts.

**Notifications.** The web layer wraps the agent client's stream (`native/notifyTurnEnd.ts`);
the terminal `status` event of a turn (`done`, `error`, `interrupted`) calls
`__PRISM_SHELL__.notify(...)` with generic text and the session id (no reply text).
Rust (`notify.rs`) treats everything as untrusted display text: HTML tags and angle
brackets are removed, control/bidi characters collapsed, title ≤80 and body ≤240 characters,
session id must match `[A-Za-z0-9_-]{8,64}`; shown only if the main window is unfocused or
hidden, and at most one per 1.5 s. Clicking a notification activates the app; notify-rust
has no click callback on desktop, so the shell remembers the session id for 60 s and, when
the main window next gains focus within that time, dispatches the in-app DOM event
`prism:open-agent-session` (the same event the push deep link uses: no navigation). A
focus change within 60 s of a notification therefore also opens that session. Background
notifications for a closed app need APNs (WP5).
`tauri-plugin-notification`/`-dialog` are deliberately not used: they inject JS shims
(`window.Notification`, `alert`, `confirm`) into every webview. The shell calls their
underlying libraries (`notify-rust`, `rfd`) from Rust, so there is no JS-reachable plugin
surface. `verify-client.mjs` fails if either plugin is added.

**Export.** File → Export Note as Markdown… (Cmd-Shift-E) / as HTML…. The menu fires
`prism:export-note`; the page builds the content from the open note (turndown/marked,
`native/extras.ts`) and calls `export_note`. Rust shows the native save panel, with a
name sanitised by `export.rs` (no separators, reserved characters, leading dots, ≤80
characters), and writes **only** to the path the panel returns (extension added if the user
left it off; a folder is refused). The command has no path parameter (a unit test and
`verify-client.mjs`-style checks keep it that way), and no fs permission exists for JS. HTML
exports are wrapped in a standalone document whose CSP forbids script, so a note carrying
markup can't run code when the file is opened. Content cap 20 MB. It returns only the file
name.

**Drag-drop.** Files dropped on the main window arrive as the OS drop event in Rust
(`dropfiles.rs`). `.md/.markdown/.txt` up to 1 MiB each, 10 files and 4 MiB per drop, valid
UTF-8, regular files only, are read; everything else is reported as "Attachments aren't
supported yet." (binaries are never read or uploaded in this WP). The shell then delivers
the CONTENT to the page as `prism:files-dropped`, and the page creates the notes through
its normal gateway client (`native/extras.ts`: path `vault/imports/<date>/<slug>-<rand>`, tag
`document`; `.md` rendered to HTML for the editor), then opens the first one.
*Why not create them from Rust?* That would be a second note writer holding the bearer
that ignores the active vault, the offline outbox and invalidation; and the page already
has write authority through its own token path, so routing a user-dropped file's text
through it adds none. The part that must stay in Rust (reading local files) can't be
reached by the page: paths exist only inside the OS event, never as an argument.

**Verified by** the Rust unit tests (`capture`, `notify`, `export`, `dropfiles`,
`shortcut`) and `verify-client.mjs` (each capability file lists exactly its window's
commands; quick-capture never holds `get_token`; the capture page calls only
`quick_capture`; no notification/dialog plugin). Manual checklist:
`apps/client/scripts/verify-client-flow.md` §8.

## Links and New Page (NP-NA-04, NP-SB-13)

### Universal links and `prism://`

Three pieces, one allowlist — **keep them in step**:

| Where | File | Role |
|---|---|---|
| Server | `apps/server/src/routes/app-links.ts` | `GET /.well-known/apple-app-site-association` (and `/apple-app-site-association`): what the OS may hand to the app |
| Shell | `apps/client/src-tauri/src/links.rs` | validates what the OS handed over; holds one pending link |
| Page | `apps/web/src/native/appLinks.ts` | opens the validated path as a tab |

**Routes that open in the app:** `/page/<id>`, `/collab/<id>` (opens the same page in the
workspace), `/inbox[/<notification id>]`, `/agent[/<session uuid>]`. Nothing else.
**Never captured:** `/auth/*`, `/accept-invite`, `/api/*`, `/acl/*`, `/mcp`, `/health`,
`/.well-known/*`, `/p/*` (published sites are public web pages), **every URL with a query**
(`{"/": "*", "?": "?*", "exclude": true}` — a `/collab/<id>?t=…` capability link would lose
its access in the app, and since the app refuses every query a `/page/<id>?utm=…` handed to
it would dead-end with no way back to the browser) and paths deeper than `/<route>/<id>`
(`/page/*/*` …, which also keeps the trailing-slash form in the browser). The sign-in flow opens
`/auth/device/authorize` in the SYSTEM browser and returns through a loopback redirect
(macOS) or `prism://auth/callback` (iOS, WP5): the association file excludes `/auth/*`
explicitly, and `links.rs` refuses everything under `prism://auth` (silently, and without
logging the URL — it can carry a code).

**Omni source links.** `prism://source/<id>?server=<encoded HTTPS origin>&vault=primary`
is the explicit contextual source route. The shell validates both query keys, server
origin and identifiers, then hands the page a canonical source descriptor, including
whether the server matches this pairing. The page opens the note only when the paired
server and authenticated vault both match. Otherwise it explains the mismatch and
offers the original server's page in the browser with its explicit vault. The browser
checks that vault before opening; if different, an explicit selection verifies the
permitted vault list and reloads to re-check identity. It never changes pairing or vault
selection. Omni also exposes an Open in Browser source action; OS acceptance of a
custom URL does not establish receiver acceptance. External browser opening uses
the existing host `window.open` interception → `open_external` native confirmation. Query/capability source URLs remain
web links. This route is separate from the legacy context-free `prism://page/<id>`.

**Server.** `APPLE_APP_ID` = `<TeamID>.<bundle id>` (comma-separated for several apps);
unset = `83Y42N33H8.com.benjaminlife.prism.client`; set to an empty string → both paths
answer 404 (the host advertises no app). The file is public JSON (`application/json`, no
redirect, no auth, `Cache-Control: public, max-age=3600`), `applinks` only — no
`webcredentials`. Exclusions come first (Apple takes the first matching component). The file
is served only when the request's host NAME equals `APP_ORIGIN`'s (`isAppHost`): an alias the
server also answers on (a tunnel hostname, `localhost`, an IP) gets 404, so Apple can never
associate the app with it. **After a deploy, check the public host with `curl`** — a proxy
that rewrites `Host` would turn the file into a 404. Both
paths are in the PWA's `navigateFallbackDenylist` (`npm run check:sw -w @prism/web`).
Apple fetches the file through its CDN and caches it (up to ~a day; a new install re-fetches),
so it must be reachable at `https://<host>/.well-known/apple-app-site-association` on the
PUBLIC host name before the app is installed.

**Shell.** tao delivers both a custom-scheme open and a universal link (NSUserActivity
`webpageURL`) as `RunEvent::Opened { urls }` on macOS and iOS — no deep-link plugin, no new
dependency, no new IPC command. `links::parse(raw, origin)`:
- `https://…` — scheme + host + port must **equal** the configured server origin (compared in
  `ServerOrigin`'s normalized form, never by prefix); no userinfo; **no query**; path exactly
  `/<route>[/<id>]` (optional trailing slash) after the URL parser resolved it;
- `prism://<route>[/<id>]` — no userinfo, port or query;
- ids are `[A-Za-z0-9_-]` only (page ≤ 128, notification ≤ 64, session = a uuid); a raw value
  with a backslash, a character ≤ 0x20 or DEL, or longer than 2048 bytes is refused before
  parsing.

The result is a canonical PATH rebuilt from the validated parts (`/page/<id>`,
`/inbox[/<id>]`, `/agent[/<id>]`) — the original URL is never passed on and **nothing ever
navigates**. Delivery is `window.__PRISM_SHELL__.openLink(path)` (host.js): the hook keeps
the path and fires a payload-free `prism:open-link` event; the app takes it with
`takePendingLink()` and opens a tab (`openTab`), so access is the account's own — a page it
cannot view shows "Document unavailable".

**Validate first, then act** (`links::classify` / `accept`, the pure half of `on_opened`):
only a VALID link brings the window to the front. A refused `https` link (one the OS routed
here as a universal link) shows the shell toast "This link can’t be opened in Prism." in the
window as it is; an unknown `prism://…` — which any web page can fire — and a sign-in
redirect (`prism://auth/…`, any case, also the host-less `prism:auth/…` spelling) have no
visible effect at all. In a batch, a valid link is kept and an auth redirect beside it is
skipped; nothing of a refused URL is stored or logged (the decision type carries no URL).

**Signed out / stale token / cold start.** The shell keeps ONE pending link (`LinkState`,
newest wins) and hands it over when the main window's page has finished loading AND a device
token exists; undelivered after 10 minutes → dropped. The shell cannot know whether the
server still accepts that token, so the PAGE covers the rest (`native/appLinks.ts`):
`captureAppLinks()` runs before the sign-in gate and takes the link at once; while nobody is
signed in it keeps the validated PATH (never a URL, never a token) in `sessionStorage`
(`prism:pending-link`, ≤ 10 minutes) across the sign-in reload, and `initAppLinks()` opens it
once the signed-in workspace is up, then removes it. (host.js itself may not use web
storage; the page half may.)

**The `prism://` scheme** is registered by `src-tauri/Info.plist` (macOS) and, with the same
entry, `src-tauri/Info.ios.plist` (iOS) — merged by the Tauri bundler; `verify-client.mjs` pins
each to exactly that one scheme. On iOS the sign-in redirect `prism://auth/callback` still does
not come through here: `ASWebAuthenticationSession` returns it to `signin.rs` (see the iOS
section).

**iOS differences** (`links.rs`; macOS is unchanged): with no server configured (first run, or
after "Sign out & change server") every link is refused silently and nothing is kept; and a
link is handed to the page only while the app is UNLOCKED — see "Links behind the lock" in the
iOS section.

**The Associated Domains entitlement is generated per install** — the server host is
configuration, so no host is committed:

```bash
node apps/client/scripts/universal-links.mjs                       # show (hosts: --hosts, PRISM_ASSOCIATED_DOMAINS, PRISM_SERVER_ORIGIN, DEFAULT_ORIGIN)
node apps/client/scripts/universal-links.mjs --write --profile <Prism Client .provisionprofile>
cd apps/client && npm run tauri build -- --bundles app --config src-tauri/gen/universal-links/tauri.macos.conf.json
node apps/client/scripts/universal-links.mjs --ios                 # iOS (WP5): patches gen/apple/prism-client_iOS/*.entitlements, keeps aps-environment
```

- **macOS:** `com.apple.developer.associated-domains` is a *restricted* entitlement. The app
  only launches when it is signed by the team AND embeds a provisioning profile whose App ID
  (`83Y42N33H8.com.benjaminlife.prism.client`) has the Associated Domains capability
  (`--profile` → `bundle.macOS.files["embedded.provisionprofile"]`). An ad-hoc/unsigned build
  carrying it is killed at launch — hence an opt-in overlay (`gen/universal-links/`,
  git-ignored), never `tauri.conf.json`. Without the overlay the app still handles
  `prism://` links.
- **iOS:** run `--ios` before `ios-release.sh` and restore the two entitlements files after
  the build (owner procedure, steps 4 and 7 — the patched files must not be committed); enable
  Associated Domains on the App ID and regenerate the provisioning profiles.
  The iOS app asks for its server at first run, but the entitlement is fixed at build time:
  a build lists the hosts it may open links for, and the runtime rule (origin = configured
  server) picks among them.
- `--developer` adds `?mode=developer` (development-signed builds only; never for
  distribution; on iOS it is written to the debug entitlements only).

**Not verified without a signed build + device** (state this in any hand-off): that the OS
hands the link to the app at all. Universal links work only when the installed app is signed
with an entitlement naming a host that serves the association file over https with the same
app id. Everything after the OS hand-off is covered: `cargo test` (`links::tests`),
`apps/server/test/app-links.test.ts`, `apps/web/e2e-fixtures/native-shell.spec.ts` (the
shell's real `host.js` in a browser, against the real server fixture).

**Device check (owner).**
1. Server: `curl -sI https://<host>/.well-known/apple-app-site-association` → `200`,
   `content-type: application/json`, no redirect; the body names
   `83Y42N33H8.com.benjaminlife.prism.client`. Apple's view:
   `curl -s https://app-site-association.cdn-apple.com/a/v1/<host>`.
2. Build with the entitlement (above), install, sign in.
3. macOS: `open "prism://page/<id>"` → the page opens as a tab. `open
   "https://<host>/page/<id>"` (or click it in Notes/Mail; Safari's address bar never
   triggers a universal link) → the app, not the browser. `swcutil dl -d <host>` /
   `sudo swcutil show` shows what the OS cached.
4. iOS: tap an `https://<host>/page/<id>` link in Messages/Mail/Notes → the app opens the
   page; long-press shows "Open in Prism". A `…/collab/<id>?t=…` share link, `/p/<slug>`,
   an invite link and the sign-in page open in Safari. Sign out, tap a page link, sign in →
   the page opens after sign-in.
5. A page you cannot view → "Document unavailable"; a link to another host or
   `prism://auth/callback` → nothing opens (the first shows the toast).

### New Page (⌘N)

File → **New Page** (`CmdOrCtrl+N`, `menu.rs`) evals a payload-free
`window.dispatchEvent(new CustomEvent("prism:new-page"))`. `useKeyboardShortcuts`
(`@prism/core`) answers it — and the key itself, where the webview receives it — with the
one-action create (`usePagesUI.openCreate({})`: an "Untitled" page beside the open one,
title focused). Never behind an open dialog. A menu item and a keydown for the same key
press make ONE page (`openCreate({})` during a create in flight is the same request). On
Apple platforms the key binding is ⌘N only (Ctrl+N is "next line" in text fields). The
shortcut sheet and the ⌘K hint list ⌘N only in a native shell
(`lib/shortcuts.ts` `NATIVE_ONLY_SHORTCUTS` / `shortcutAvailable`): a browser tab never
receives it. **iOS (hardware keyboard):** there is no menu bar in the Tauri iOS shell; ⌘N
reaches the WKWebView as a keydown and the same handler takes it — NOT verified on a device.
A discoverable entry in the iPad ⌘-hold overlay needs a `UIKeyCommand` in the Swift plugin
(`plugins/prism-ios` on `feat/native-ios`) that evals the same event.

### Saving one attachment (`save_attachment`; macOS: save panel, iOS: share sheet)

"Download" on an image, a file / PDF / audio / video block or a Files property did nothing in
the apps for the same reason as below (the web view cancels downloads; `blob:` navigations are
refused). The page now calls `__PRISM_SHELL__.saveAttachment(id, name)` when the shell offers
it (`packages/core/src/lib/saveFile.ts`; the browser path — a `blob:` download through the
installed transport — is unchanged).

**IPC** `save_attachment { attachmentId, suggestedName }` → the saved file's NAME, or null
(the save panel / share sheet was closed). Module `src-tauri/src/attachment_save.rs`:

- 🔒 The page supplies an attachment **id** (`[A-Za-z0-9_-]{1,64}`, the page's own
  `OWN_ATTACHMENT` rule) and a suggested name — no URL, path or token. Rust builds
  `<configured origin>/api/attachments/<id>`, sends the keychain bearer there only, with the
  no-redirect client of `export_archive.rs`.
- The answer must be `200`, not a page / script / SVG type, within 512 MB by its declared
  length and while streaming, and exactly as long as declared.
- Bytes are streamed into `<tmp>/prism-exports/<random>/` (0700) and never cross IPC. The
  file's name is a sanitised stem + an extension from `SAVE_EXTENSIONS` — the suggested one
  when it is listed, else the one for the type the server declared, else `.bin` (the page
  cannot make the file a `.command`, `.app`, `.html` or `.svg`).
- macOS: the native save panel, then a copy into a fresh sibling `.part` renamed over the
  target. iOS: Swift `shareFile`, which accepts only that folder and the same extension list
  (`attachmentExtensions`; `verify-client.mjs` and a Rust test compare the two lists).
  The tmp folder is removed whatever happened.
- An image or file that is NOT ours (an outside https address) is never fetched with our
  credentials: it opens through `open_external` (the one native confirmation).
- **Text the page built** (a database view's CSV, the "unsent changes" JSON offered before a
  sign-out) goes through `export_note` with the formats `csv` / `json` (written as given).
  Sign-out with unsent changes stays signed in unless that file was really saved.
- **Tests:** `cargo test --lib attachment_save::` (id shapes, the URL, redirects refused and
  never followed, page/script/untyped answers, size caps, incomplete bodies, name
  sanitising, the chosen path); `touch-and-native-actions.spec.ts` "saving a file".

### Saving an export archive (`save_export`; macOS: save panel, iOS: share sheet)

`ExportDialog` used to hand the ZIP to `saveBlob()` (an `<a download href="blob:…">` click).
wry attaches a WKDownloadDelegate only when the window has a download handler; this shell
sets none, so WKWebView's `shouldPerformDownload` navigation is answered `Cancel`
(`wry/src/wkwebview/navigation.rs`): a multi-page export finished and nothing was saved.
Adding a download handler would be the wrong fix — it would let page script start downloads
of arbitrary URLs — and `verify-client.mjs` fails if `window.rs` gains one.

**IPC** `save_export { jobId, suggestedName, cancel? }` → the saved file's NAME, or null
(the person cancelled / the save was stopped). The ninth main-window command
(`native_cmds.rs`, `build.rs`, `capabilities/default.json`; `verify-client.mjs` §9 pins the
whole list). Module `src-tauri/src/export_archive.rs`:

- **The page supplies a job id and a suggested name — no URL, no path, no token**
  (unit test on the command's signature). The id must be the server's shape exactly (22
  base64url characters, `transfer/jobs.ts`); anything else is refused before any I/O.
- **Rust builds the only URL it requests:** `<configured origin>/api/export/<id>/download`,
  `Authorization: Bearer <device token>` from the keychain cache. **Redirects are never
  followed** (`redirect::Policy::none()`; a 3xx is "the server tried to send the download
  somewhere else"), so neither the bearer nor the bytes can be steered to another host.
- The answer must be `200` + `Content-Type: application/zip`; the declared length and the
  streamed total are capped at `MAX_ARCHIVE_BYTES` (0xF0000000, the server's own hard limit);
  more bytes than declared, or fewer, is a failure. 15 s to connect, 60 s without a byte = stalled.
- **Destination = what the native save panel returned** (`rfd`, name pre-filled from
  `zip_name`: `export::sanitize_stem` + `.zip`), `.zip` added only when no extension was
  typed; a folder is refused. Bytes stream (never buffered, never over IPC) into a fresh
  hidden sibling `.<name>.<random>.part` (`create_new`), which is fsynced and RENAMED over
  the target only when the whole body arrived; on any failure or stop it is removed and an
  existing file at the target is untouched.
- **Progress + stop:** the shell evals `prism:export-save-progress {jobId, received, total}`
  (numbers + the id, ≤ 5/s); `save_export {jobId, cancel: true}` stops the running save of
  THAT job (`SaveState`: one save at a time; another job's id cancels nothing).
- **Page** (`@prism/core` `lib/import-export/client.ts` `nativeExportSaver()`, used by
  `ExportDialog` only when `__PRISM_SHELL__.saveExport` exists — the browser path is
  unchanged): after the job is done it calls `saveExport(jobId, fileName)` — it never fetches
  the archive — shows "Choose where to save…" / "Saving x of y…" with Stop, then "Export
  saved … in <chosen name>", or "Export ready — Not saved yet" + **Save…** when the panel was
  cancelled, or the shell's reason + Save… when it failed. Closing the dialog stops the save.
  The export job lives 15 minutes on the server; a later Save… answers "This export has expired".
- **Tests:** `cargo test --lib export_archive::` (a loopback fake server: bearer + exact
  path, a 30x is refused and its target never contacted, wrong type, declared and streamed
  overflow, a short body, cancel before and mid-stream leaves no `.part` and keeps the old
  file, id shapes, names/paths); `apps/web/e2e-fixtures/native-export.spec.ts` (the real
  `host.js` over a scripted IPC: what crosses the bridge, no page download, progress, stop,
  panel cancel, failure, retry).
- **Not verified without a built app:** the save panel itself (`rfd` on the main thread) and
  a real multi-GB stream. Check on a Mac: export a page with sub-pages → pick a folder →
  the ZIP opens; Stop mid-save leaves no `.part`; with the server stopped mid-download the
  dialog says the download was interrupted.

**iOS (built with `feat/w13-ios-merge`; NOT compiled or run yet — owner procedure step 2).**
Same command, same `download()`; instead of a save panel the archive streams into
`<app tmp>/prism-exports/<random>/<sanitised name>.zip` (the folder is 0700, removed when the
sheet closes and purged at launch), then the Swift plugin presents `UIActivityViewController`
(Save to Files / AirDrop), anchored for iPad, for a file under that folder only. The path never
reaches JS. `export_note` (one note as `.md` / `.html`) takes the same route. The command
returns the file's name when an activity completed and null when the sheet was dismissed, so the
dialog reads "Export saved …" or "Export ready — Not saved yet" + **Save…** exactly as on the
Mac. On iOS the dialog's "Choose where to save…" line is shown while the download runs (the
sheet comes after it); the wording is the Mac's.

## Security surface

- **CSP** is built at startup from the origin (`origin.rs` `build_csp`). The copy in
  `tauri.conf.json` is only the build-time placeholder for the default origin.
  - `connect-src 'self' ipc: http://ipc.localhost <origin> <wss-origin>`: the page can
    reach nothing else.
  - `img-src 'self' data: blob: <origin>`.
  - `frame-src 'self' https://www.youtube-nocookie.com/embed/ https://player.vimeo.com/video/`
    — the two embed players, and nothing remote before a server is configured (see "Embeds").
  - `script-src 'self' 'wasm-unsafe-eval'`.
  - Styles and fonts are the same as the PWA (Google Fonts, esm.sh font files).
  - `style-src` nonce injection is disabled (`dangerousDisableAssetCspModification:
    ["style-src"]`) so that `'unsafe-inline'` keeps working for editor libraries that
    inject `<style>`.
- **Capabilities** (`capabilities/default.json`): the `main` window gets (plus, since WP4.2, `allow-notify` and `allow-export-note`; the separate `quick-capture` window gets only `allow-quick-capture`, see Native extras)
  `allow-get-token`, `allow-sign-in`, `allow-sign-out`, `allow-get-server-origin`,
  `allow-set-server-origin` and `allow-open-external`, and nothing else.
  - `build.rs` declares the commands in the app manifest, so anything not granted is denied.
  - There are no `core:*` permissions, and no fs, shell, http or opener permissions for JS.
  - There is no `remote` block: remote pages get no IPC.
- **Navigation** (`window.rs` `navigation_decision`): only the bundled app
  (`tauri://localhost`) and inert `about:` frames load. Every other navigation is cancelled
  silently, with no side effect.
  - This covers the main frame and subframes alike. wry's callback gets only the URL, not
    the frame, so the rule has to be safe for both.
  - A `<meta refresh>` in a website-note iframe goes nowhere, and so does
    `location = "https://evil/?t=…"`. `window.open` is refused the same way
    (`on_new_window` → Deny).
- **Opening links** is a separate, explicit path:
  - The host hook intercepts clicks on external `<a href>` (capture phase) and external
    `window.open(url)` calls, and calls `open_external`.
  - Rust checks the scheme (`http`/`https`/`mailto` only, no userinfo, ≤4096 chars; never a
    bundle, `javascript:`, `file:` or custom-scheme URL).
  - It then shows a **native** `NSAlert` with the URL (`confirm.rs`). Only the user's click
    on **Open** reaches the opener. On iOS it is a `UIAlertController`; on other platforms
    the dialog answers "no".
- **The token is readable by page script, so XSS = token theft.** The WP2.2 contract gives
  `getToken()` to the page, because its `fetch` needs it.
  - The CSP (`connect-src`/`img-src`) limits where the page can *fetch*, but it is **not a
    boundary against navigation**. The shell's navigation lock and the native confirmation
    on `open_external` are what stand in the way of `location = …`/`window.open` exfiltration.
  - Even so, a user who clicks **Open** on a URL carrying the token hands it over. Treat any
    XSS in the web bundle as a full compromise of that device token. It is revocable in
    Account → Signed-in devices, and it dies after 90 idle days.
- **No process spawning** in the shell's code. The opener plugin uses macOS
  LaunchServices (`open`) to show the browser.
- **Verified by** `scripts/verify-client.mjs` and the Rust unit tests.

### External images and the basemap (Client parity C)

The CSP above does **not** widen for these. The server fetches them instead, and the page only
ever talks to its own server, with the bearer in a header.

- **Images in notes.** `apps/web/src/native/externalImages.ts` (native build only) runs one
  document-wide `MutationObserver`. Every `<img>` whose `src` is an external `http(s)` URL is
  re-pointed:
  - It calls `serverFetch("/api/media/proxy?u=<url>")`, which sends `Authorization: Bearer`.
  - The bytes become a `blob:` URL (already allowed by `img-src`). The original URL is kept in
    `data-prism-src`, and `srcset` is dropped.
  - ProseMirror ignores attribute changes on leaf nodes, so the stored note HTML keeps the
    original URL.
  - It keeps a bounded LRU (400 entries / 96 MB, revoked on eviction), 6 fetches at a time, and
    remembers a failure for 60 s.
  - **Why blob URLs, not a signed media token in `<img src>`:** the device token never
    appears in a URL, there is no new credential to mint, sign or leak through logs, and the
    CSP does not change. The cost is no browser HTTP cache; the LRU above and the server's disk
    cache cover it.
- **Basemap.** While the shell has installed `setMapProxyFetch` (native only), `CommonsMap`
  swaps an OpenFreeMap style URL for `prismmap://style/<id>`. It also registers a MapLibre
  custom protocol (`packages/core/src/components/map/mapProxy.ts`). That protocol's handler
  fetches `/api/map/style/<id>` and `/api/map/ofm/<path>` through `serverFetch`, for tiles,
  glyphs and sprites alike, including worker requests. The server inlines the TileJSON and
  rewrites every asset URL to `/api/map/ofm/…`; the client maps those to `prismmap://`. Custom
  style URLs are not proxied: they stay blocked and the map falls back to blank, as before.
- **Server side** (`apps/server/src/routes/media.ts`, `src/media/*`), signed-in users only:
  a session, a device token or the loopback owner token. Capability links, anon and MCP
  dispatches get 401.
  - **SSRF rules.** `https` only (`http` only for `MEDIA_PROXY_HTTP_HOSTS`), port 443 only
    (`MEDIA_PROXY_PORTS` adds others), no userinfo. The host must be a DNS name: every
    IP-literal spelling is refused (decimal, hex, octal and short IPv4, `[v6]`, mapped). So are
    `localhost`, `*.local` / `*.internal` / `*.home.arpa`, single-label names, and the server's
    own, vault and hub hosts.
  - **DNS.** The server resolves the name itself. If any answer is non-public (private,
    loopback, link-local and the metadata IP, CGNAT, multicast, reserved, documentation,
    benchmarking, `0.0.0.0`, IPv4-mapped/-compatible/NAT64/6to4/Teredo IPv6, ULA, …), the
    whole host is refused.
    - Resolution uses c-ares (`dns.promises.Resolver`, 2.5 s timeout, 2 tries), never
      `dns.lookup`. getaddrinfo runs on libuv's 4-thread pool and can't be aborted, so hung
      lookups would also stall fs reads and async scrypt (login).
    - The query is `cancel()`ed at the request deadline.
    - A host that failed or resolved non-public is negative-cached for 60 s.
    - Host names: trailing dots are stripped; empty labels, labels over 63 characters and
      labels starting or ending with `-` are refused.
  - **Pinned connection.** It connects to that address, with TLS SNI, certificate check and
    `Host` all set to the name, so there is no rebinding window.
    - It uses `agent: false`, so `NODE_USE_ENV_PROXY` / `HTTP(S)_PROXY` never route the request
      through a proxy that would re-resolve the name. A test pins this with the proxy env set
      in a child process.
  - **Redirects** are followed manually, at most 3, and each hop is re-validated with fresh DNS.
  - **What is sent upstream:** no cookies, no auth and no client headers.
  - **Limits.** One 15 s deadline covers connect, headers and body, so a slow drip times out.
    There is a 5 MB cap (`MEDIA_PROXY_MAX_BYTES`; declared and streamed, and on
    decompression).
  - **Content check.** `image/*` (or a generic binary type) and magic bytes must both say
    PNG, JPEG, GIF, WebP, AVIF, BMP or ICO. **SVG is refused.**
  - **Response headers** are rebuilt: the sniffed type, `nosniff`,
    `Content-Security-Policy: default-src 'none'; sandbox`, inline `Content-Disposition`,
    `no-referrer`, CORP `same-origin` and `private, max-age`.
  - **Rate limits and load.** Per user per minute: `MEDIA_PROXY_PER_MINUTE` (240) and
    `MAP_PROXY_PER_MINUTE` (1500).
  - **Concurrency pools.** Upstream concurrency is split into two separate pools, images and
    the map, so neither can starve the other. Each pool has a global cap and a per-user cap.
    - Images: `MEDIA_PROXY_MAX_INFLIGHT` (12) global, `MEDIA_PROXY_PER_USER_INFLIGHT` (3)
      per user.
    - Map: `MAP_PROXY_MAX_INFLIGHT` (16) global, `MAP_PROXY_PER_USER_INFLIGHT` (4) per user.
    - A request waits at most `MEDIA_PROXY_QUEUE_WAIT_MS` (5 s) in a bounded queue, then gets
      503. One user parking slow URLs only fills their own slots.
    - Identical in-flight fetches are coalesced, and an upstream failure is remembered per
      URL for 60 s.
    - Concurrent cache-hit disk reads are bounded (8).
  - **Errors.** Every refusal after the pre-network URL check (DNS failure, private answer, a
    bad redirect hop) answers with one generic `{"error":"refused","reason":"refused"}`. That
    way the response is not an oracle for which internal names exist; the detail is logged on
    the server only.
  - **Disk cache.** An on-disk LRU at `MEDIA_CACHE_DIR` (default `media-cache/` next to the
    server DB), with `MEDIA_CACHE_MAX_BYTES` (512 MB). It is keyed by a SHA-256 of the URL and
    honours upstream `max-age`: images 5 min–7 d, tiles 1 h–30 d; `no-store` is never
    persisted. Its index loads asynchronously, and the first load deletes stray `*.tmp-*`
    files and orphaned bodies.
  - **Map extras.** The upstream host is pinned to `tiles.openfreemap.org`, including on
    redirects. Paths must match `planet/<build>/<z>/<x>/<y>.pbf`, `natural_earth/ne2sr/…png`,
    `sprites/<a>/<b>[@2x].(json|png)` or `fonts/<stack>/<a>-<b>.pbf`. Only the
    `liberty` / `positron` / `bright` styles are served. After rewriting, every tile, glyph and
    sprite template in the style must expand to a path the allowlist above would serve.
    Otherwise the style is refused (fail closed).
  - **Client side of the map.** `protocolUrlToPath` refuses `..`, `//` and
    `%2e`/`%2f`/`%5c` (any case). It also requires the URL-normalised path to stay under
    `/api/map/style/` or `/api/map/ofm/`, so a crafted `prismmap://` URL can never point the
    bearer at another `/api` route.
  - **Switches.** `MEDIA_PROXY_ENABLED=false` / `MAP_PROXY_ENABLED=false` turn the routes off
    (404). With either off, the client just shows what it did before: no image, or a blank
    basemap.
- **Privacy (L2).** Image fetches reveal the home server's IP address and the timing of
  views to the image's host. That applies to every signed-in user, members included, and is
  how a tracking pixel in a note sees "someone opened this".
  - Compared with the PWA (where each viewer's own IP and browser go out), the client exposes
    less per person but more about the server.
  - Mitigations: the cache (repeat views within `max-age` make no upstream request), no
    cookies/referrer/client headers forwarded, the fixed User-Agent, and
    `MEDIA_PROXY_ENABLED=false` to turn image proxying off.
  - Not done: a fetch-only-from-trusted-authors mode, or an egress proxy/VPN for the server.
- **PWA:** unchanged. Its own CSP allows `https:` images and connections, so it loads directly.
  Proxying there would only add load to the home server, and the browser already isolates the
  cookie from page script.
- Tests: `apps/server/test/media-proxy.test.ts` covers the SSRF matrix, pinning, rebinding,
  redirects, slow drip, oversize, SVG/HTML, auth, cache, rate limit, and the map allowlist and
  rewrite. `npm run verify:media -w @prism/web` covers the blob cache, the DOM observer and the
  map protocol. `verify-client.mjs` and `origin.rs` tests assert that `img-src` stays
  `'self' data: blob: <server>`.

### Embeds (NP-ED-15, owner decision c.7 of 2026-10-08)

In the apps (macOS and iOS) **YouTube and Vimeo play inside the page; every other provider is an
"Open in …" card.** The web / PWA is unchanged (it frames the whole `EMBED_FRAME_SOURCES` list).

- **Which.** `origin.rs` `EMBED_FRAME_SOURCES`: `https://www.youtube-nocookie.com/embed/` and
  `https://player.vimeo.com/video/` — the security reviewer's minimal set. Path-scoped: a
  trailing "/" is a CSP prefix match, so only the player pages, never the provider's site.
- **CSP.** `frame-src 'self'` + those two, only once a server is configured:
  `build_csp_for(None)` (the iOS first-run screen) still names no remote origin, and
  `retarget_csp` swaps `frame-src` together with `connect-src` / `img-src` when the server is set
  or cleared.
- **Navigation rule.** wry reports a frame's load to `on_navigation` with the URL only — it
  cannot say "this is a subframe". So `window.rs` `navigation_decision(url, embeds)` allows
  those two player paths (`origin::is_embed_player_url`: https, exact host, default port, no
  credentials, under the path), and only while a server is configured. Without this the CSP alone
  would not be enough: the frame's navigation was cancelled.
  **Cost, accepted with the decision:** the MAIN frame could be navigated to one of those two
  player paths too. That page has no IPC (capabilities are local-origin only), `get_token`
  answers only for the configured server, and every navigation onward from it is cancelled. It
  gives no way to send data out that a frame to the same path does not already give. The
  quick-capture window passes `false`: it frames nothing.
- **The page.** `__PRISM_HOST__.frameOrigins` (host.js; frozen; empty before a server is set) is
  what `frameAllowedHere` in `mediaViews.ts` reads to choose a player or a card. It is advice to
  the page — the CSP and the navigation rule enforce.
- **No popups.** In the apps the iframe's sandbox is `allow-scripts allow-same-origin
  allow-presentation` (`EMBED_SANDBOX_NATIVE`): no `allow-popups`, no top navigation, no forms,
  no downloads. The block's own "Open in …" link goes through `open_external` (native
  confirmation) and is the only way out.
- **Pinned by** `verify-client.mjs` (the conf CSP, `origin.rs`, `host.js`, `window.rs`,
  `capture_window.rs` and the sandbox all name the same two), `cargo test --lib` (`origin`,
  `window`, `host`), `native-shell.spec.ts` / `ios-shell.spec.ts` (the real `host.js`).
- **Not verified:** playback in a real app. The simulator build compiles; nobody has seen a
  video play in it (device-pass-script C3–C8, D5, E7). Unknowns to look for there: a player that
  wants a nested frame from another host (it would be cancelled, silently), and inline playback
  on iPhone.

## Switch-over runbook (WP4.3): retire the legacy desktop

For the overseer (server steps) and the user (app steps). Do the Mac mini first, then the
laptop. Nothing here deletes anything: the legacy app and its config are archived, so
every step can be rolled back.

**0. Before you start (overseer).**
- The server runs a build with WP4.3 (the read-only `profile: "vault-ro"` dispatch, the
  Notion page route). Restart pm2 `prism-server` after deploying (it does not hot-reload).
- `GET /acl/workers` is green and `PRISM_OWNER_TOKEN=… scripts/check-desktop-independence.sh`
  exits 0, i.e. the server already owns every ingest source and the desktop runs
  `ingest_mode: "client"`.
- In the legacy app, write down anything in the desktop-only gaps you rely on
  (`desktop-parity.md`, "documented gaps"): **GitHub folder-sync configs** (especially
  auto-sync), Notion database syncs, calendar event edits. Decide per item before step 6.

**1. Back up the legacy config (user, on that Mac).**
```bash
mkdir -p -m 700 ~/prism-legacy-archive
cp -p "$HOME/Library/Application Support/prism/prism-config.json" \
  ~/prism-legacy-archive/prism-config.json.$(date +%Y%m%d)
chmod 600 ~/prism-legacy-archive/prism-config.json.*
```
The backup holds a live vault token. Keep it in that 0700 folder (step 7 revokes it).

**2. Install Prism Client and sign in (user).**
- Build (`cd apps/client && npm run tauri build -- --bundles app`, see Build and run) and copy
  `Prism Client.app` to `/Applications`. Both apps install side by side.
- Launch it → **Sign in** → the system browser opens the server's consent page ("An app
  calling itself Prism Client on <host>") → sign in as the owner → **Approve**.
- Check Settings → Account → **Signed-in devices** lists it.

**3. Decide on live actions (user decides, overseer flips).** The desktop sent email, Matrix
messages and calendar invites itself; the client does that only through the server's live
actions, which are **off** by default. For each family you want: set
`ACTIONS_MATRIX_ENABLED` / `ACTIONS_EMAIL_ENABLED` / `ACTIONS_CALENDAR_ENABLED=true` in
`apps/server/.env` → restart pm2 → `GET /api/actions` shows `enabled: true, configured: true`.
(`docs/live-actions.md`. They act AS the owner: audited, idempotent, owner-only.)

**4. Parity checklist (user, in Prism Client).** Use a throwaway `_test` note for anything
that writes.
- [ ] Open, edit and autosave a document; a second device sees the edit live (collab); add a comment
- [ ] Search; semantic search (Search panel)
- [ ] History panel: open a version, restore it on the `_test` note
- [ ] Inbox: open a thread; reply (Matrix, if enabled); New message to a person
- [ ] Email: open a thread; reply / archive (if enabled)
- [ ] Calendar: change month (the range syncs, no error), create a test event (if enabled), RSVP
- [ ] Tasks / ClickUp tasks list; create a task
- [ ] Agent chat: ask a question; Stop; the turn-end notification
- [ ] ⌘J inline edit on a selection in `_test`; Command bar → "Turn into Email Draft"
- [ ] Note Sync panel: add Google Docs, Push, Pull on `_test` (and Notion if you use it)
- [ ] Agent activity: queue a run of an enabled skill (▶); it shows as run within ~1 min
- [ ] Graph; Map (the OpenFreeMap basemap loads through the server proxy); a note with an external image shows it
- [ ] Dashboards; Network → Server (ingest health), sharing dialog, Governance tab, a publication
- [ ] Quick capture (⌘⇧Space), Export Note, drag a `.md` file in

**5. Quit the legacy app (user).** Cmd-Q `Prism.app`, then confirm it is gone:
`pgrep -fl "Prism.app/Contents/MacOS"` prints nothing. Remove it from Login Items if listed.

**6. Archive, don't delete (user).**
```bash
mkdir -p ~/prism-legacy-archive
mv /Applications/Prism.app ~/prism-legacy-archive/Prism-legacy-$(date +%Y%m%d).app
```

**7. Remove the vault token from the desktop config (user, with the backup from step 1).**
```bash
cfg="$HOME/Library/Application Support/prism/prism-config.json"
jq '.parachute_api_key = "" | .collab_token = "" | .anthropic_api_key = ""' "$cfg" > "$cfg.tmp" \
  && chmod 600 "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
security delete-generic-password -s com.prism.anthropic 2>/dev/null || true   # desktop's Anthropic key, if any
```
Then **revoke** the old desktop token at the hub, because the backup still holds it, but
only if it is not shared: compare its `jti` with the server's `PARACHUTE_TOKEN` and the repo
`.mcp.json` token first (revoking a shared token would cut off the server).
```bash
node -e 'const t=require(process.argv[1]).parachute_api_key;console.log(JSON.parse(Buffer.from(t.split(".")[1],"base64url")).jti)' \
  ~/prism-legacy-archive/prism-config.json.YYYYMMDD
parachute auth revoke-token <jti>      # the vault enforces it after ~60 s (cache TTL)
```
`collab_token` is the server's `COLLAB_TOKEN` (loopback-only); removing it from the desktop
config is enough. Rotate it in `apps/server/.env` only if the config file ever left the Mac.

**8. Verify (overseer + user).**
- `scripts/check-client-no-vault-token.sh` on that Mac → `clean`, exit 0. It reads the Prism
  Client settings dir and the legacy config dir, and the environment of running Prism app
  processes; it prints only where something was found, never a value.
- `GET /acl/workers` (Network → Server → Ingest health) is green, and
  `scripts/check-desktop-independence.sh` still exits 0.

**Laptop.** Same steps 1–8. If the laptop never had the legacy app, steps 1, 5–7 are no-ops;
still run step 8.

**Rollback (any time).**
1. Quit Prism Client (it can stay installed; to cut it off, revoke it in Settings → Account
   → Signed-in devices).
2. `mv ~/prism-legacy-archive/Prism-legacy-YYYYMMDD.app /Applications/Prism.app`.
3. Restore the config: `cp -p ~/prism-legacy-archive/prism-config.json.YYYYMMDD "$HOME/Library/Application Support/prism/prism-config.json"`.
   If step 7 revoked its token, mint a new one
   (`parachute auth mint-token --scope vault:default:write`) and paste it in the legacy
   Settings → Services. Keep `ingest_mode: "client"`: the server still owns ingest.
4. Launch `Prism.app`. The desktop keeps all its Tauri commands; nothing on the server needs
   to change (the WP4.3 server additions are additive).

## Editor schema handshake (block editor release)

The block editor (callouts, toggles, columns, block/text colour, and tables/images in the live editor) changed the shared document schema to **`COLLAB_SCHEMA_VERSION = 2`** (`packages/core/src/editor/collabSchema.ts`). A client built before it is dangerous: y-prosemirror deletes every node or mark its schema cannot represent, so an old live editor would silently remove the new blocks (and whole text runs carrying an unknown mark) for everyone, and the server would persist the loss. Two gates stop stale clients:

- **Socket.** Every live editor opens `/collab?schema=2` (web `CollabDoc`, the legacy desktop `DesktopCollabDocument`, the federation bridge). For a DOCUMENT-kind note the server refuses a socket whose `schema` is missing or older, after authorization, with reason `update_required: Prism was updated. Reload or update the app to keep editing.` The client shows **Update required — Reload** (PWA: asks the service worker for the new build and reloads; native: reloads). Code, sheet and canvas sockets are not gated. Direct connections (MCP tools, human collab commands, federation applier) never pass through authentication and are unaffected.
- **REST.** `serverFetch` sends `X-Prism-Editor-Schema: 2` to the Prism Server. A content `PATCH`/`PUT /api/notes/:id` without it (or older) gets **409 `editor_update_required`**, owner passthrough included, but only when the STORED note already contains v2 content (`data-type="callout|toggle|columns|column"`, `<details`, `data-block-color`, `data-text-color`). Metadata writes, plain notes and notes with only tables/images (the old plain editor already supported them) are unaffected. In-process MCP dispatches (agents) and server workers are exempt. A script that PATCHes content over a v2 note must send the header.

Any future node/mark/attribute change must bump the version; `apps/server/test/collab-schema-gate.test.ts` pins the schema's names and fails otherwise.

**Current version: 6** (history of the versions: the comment in `collabSchema.ts`). Every live editor sends `schema=6` / `X-Prism-Editor-Schema: 6`; a client built at 5 or below is refused as described above.

- **What v6 changed (Suggesting mode):** two attributes `suggestion` (`insert` | `delete`) + `suggestionBy` on the text blocks (`paragraph`, `heading`, `codeBlock`, `toggleSummary`) and on the inline atoms `hardBreak` and `mention` — a paragraph break, line break or chip suggested while Suggesting (HTML `data-suggestion-node` / `data-suggestion-by`); and the existing `insertion` / `deletion` marks may now sit on text in inline code (the `code` mark no longer excludes them) and in a code block (`codeBlock` allows them). No node or mark was added or renamed.
- **Why a v5 client must not write:** its schema drops the two attributes (a suggested break / chip would become a plain edit) and strips suggestion marks from code (the struck and the inserted text would both become plain code).
- **REST markers added for v6** (`needsEditorUpdate`, `apps/server/src/routes/api.ts`): the attribute `data-suggestion-node`, and a suggestion inside code (`<span data-suggestion=…><code>` or a suggestion span inside `<pre>` — `suggestionInCode`). A suggestion on ordinary text is not a marker: a v5 editor represents it exactly.
- **An open v5 tab loses nothing:** its socket is refused on the next connect → **Update required — Reload**; typing that had not reached the server stays on the device (the local document + the unsynced entry, marked `update-required` so it is not retried by the old build) and is sent after the reload loads the current build. Tests: `apps/web/e2e-fixtures/editor-schema.spec.ts` ("a version bump while a tab is open…"), `apps/server/test/collab-schema-gate.test.ts` ("v6: …").

### Release order

1. **Server first:** deploy the server with the gate, then `pm2 restart prism-server`. Old clients are refused from this moment, so no stale editor can write v2-incompatible content.
2. **PWA:** build and deploy `apps/web`. Open tabs get **Update required — Reload**; the reload activates the waiting service worker.
3. **Prism Client:** rebuild (`npm run tauri build -- --bundles app` in `apps/client`) and reinstall on every Mac. An installed old bundle shows the server's refusal as a denied/failed document until it is replaced.
4. **Legacy desktop (`Prism.app`):** it talks to the vault directly for plain notes and cannot be gated there. **Do not use it for editing after this release** — opening a note with callouts/toggles/columns/colours in its plain editor and saving drops them. Its live-collab socket is refused unless it is rebuilt from this tree.

## Known limits (follow-ups)

- **External images and the basemap go through the server** (Client parity C, see "External
  images and the basemap" under Security surface). Still blocked in the client: custom basemap
  style URLs, `<picture><source srcset>` and CSS `background-image` URLs, and website-note
  iframes (navigation lock + `default-src 'self'`).
- Password-gated public `/p/:slug` sites need a cookie. Open them in the browser
  (native-auth.md).
- A collab WebSocket that is already open survives revocation until it reconnects (a server
  property).
- `dirs::config_dir()` is used for settings on desktop because the CSP must be known before
  the Tauri app exists. On iOS the same file lives in the app's sandbox container
  (`$HOME/Library/Application Support/<identifier>/client-settings.json`).
- **L3: keychain hardening.** Blocked on Apple signing (D1). The item currently lives in the
  file-based login keychain with an app-ACL. With a Developer ID/team signature, move it to
  the data-protection keychain (`use_protected_keychain`) with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (plus a keychain-access-group
  entitlement).
- **L4: bundle the fonts.** Ship Inter/JetBrains Mono/Newsreader/DM Sans and Excalidraw's
  hand-drawn fonts in the native build. That would drop `https://fonts.googleapis.com`,
  `https://fonts.gstatic.com` and `https://esm.sh` from the CSP, leaving the server as the
  only remote origin.

## iOS app (WP5) — "Prism" / App Store "Prism Workspace"

The same shell, built for iOS from `apps/client` (`gen/apple`, generated by `tauri ios init`
and committed). Merged into main's line with `feat/w13-ios-merge`. **First compiled for iOS on 2026-10-08**
(Xcode 27.0, iOS 27.0 simulator, Tauri CLI 2.10.1): the debug simulator build in step 2 below
succeeded with no source change, and the app launches in the iPhone 18 Pro simulator to the
first-run "Enter your server" screen. The same day the app was signed in and used in the
simulator (`qa/ios-simulator-findings-2026-10-08.md`) and run on the owner's iPhone against
production as a **debug** build (keyboard toolbar, tab bar, zoom on focus, properties, the
Calendar tool were exercised). **Still not done:** a recorded device pass
(`qa/device-pass-script.md` — the informal session wrote down no per-row result), a release /
ad hoc build, push on a device, a universal-link tap, embeds seen playing. TestFlight stays
gated on parity sign-off.

Identity: bundle id `com.benjaminlife.prism.client` (the registered App ID; the keychain item is
per device, so nothing is shared with the Mac), team `83Y42N33H8`, home-screen name **Prism**
(`tauri.ios.conf.json` `productName` + `Info.ios.plist`), App Store name **Prism Workspace** (set
only in App Store Connect), version `0.1.0` build `1`, deployment target **iOS 16.0**.
`Info.ios.plist` (merged by Tauri at build time): `ITSAppUsesNonExemptEncryption=false`,
`NSFaceIDUsageDescription`, the `prism` URL scheme (the same entry as the macOS `Info.plist`),
and **no ATS key**: Release has ATS fully on. Debug builds get `NSAllowsLocalNetworking` from a
Debug-only build phase (`project.yml` "Debug-only ATS loopback exception") for a loopback test
server, and `origin.rs` refuses `http://` on iOS release builds (`ALLOW_HTTP_LOOPBACK`). No
background modes (pushes are visible alerts). Entitlements as committed: Release
`prism-client_iOS.entitlements` = `aps-environment=production`, Debug
`prism-client_iOS.debug.entitlements` = `development` (per-config `CODE_SIGN_ENTITLEMENTS`) and
nothing else — **Associated Domains is written per build by `universal-links.mjs --ios` and
never committed** (`verify-client.mjs` fails while a host is in those files). Privacy manifest
`prism-client_iOS/PrivacyInfo.xcprivacy` (no tracking, no collected data; required-reason APIs:
file timestamp `C617.1`, system boot time `35F9.1`; UserDefaults is not used). Icons:
full-bleed opaque render of `PrismAppIcon` (`scripts/build-ios-icon.ts`).

**`gen/apple` is generated, then customised — keep the customisations.** `tauri ios init`
rewrites `gen/apple` from Tauri's template (project.yml, Info.plist, entitlements, icons,
ExportOptions). Prefer NOT re-running it. If you must (a Tauri upgrade that needs a new
template):
1. Commit first, run `npx tauri ios init --ci`, then `git diff apps/client/src-tauri/gen/apple`.
2. Restore from git: the two entitlements files, `PrivacyInfo.xcprivacy`, `ExportOptions.plist`,
   `ExportOptions.adhoc.plist`, the AppIcon PNGs, and in `project.yml` the `configs:` block
   (per-config `CODE_SIGN_ENTITLEMENTS`) and the `postBuildScripts` "Debug-only ATS loopback
   exception".
3. Regenerate the Xcode project with **no build outputs present** (otherwise xcodegen adds
   `Externals/*/libapp.a` as resources and the build fails with "Multiple commands produce
   libapp.a"): `cd apps/client/src-tauri/gen/apple && mv Externals /tmp/ext && mkdir Externals
   && xcodegen generate --spec project.yml && rmdir Externals && mv /tmp/ext Externals`.
4. `node apps/client/scripts/verify-client.mjs` must pass (it checks every item above).
Info.plist keys never need re-applying: Tauri merges `src-tauri/Info.ios.plist` on every build.

### How the pieces fit

| Piece | Where | Notes |
|---|---|---|
| First run "Enter your server" | `apps/web/src/native/ServerSetupScreen.tsx` → `set_server_origin` | No built-in server. The PAGE only gives a quick answer for obvious mistakes (`serverInputProblem`: not an address, plain `http://` off-device, sign-in details / a path / a query in the address) and contacts nothing — while no server is set its CSP reaches no remote origin at all. The SHELL decides: `ServerOrigin::parse` (https; http on loopback only in debug builds; the host must be LDH labels after IDNA, IPv4 or [IPv6], so nothing like `*`, `;`, `'`, `,` can reach the CSP), then `auth::probe_server`: `GET /health?live=1` (the liveness form: no vault call; an older server answers the plain `/health`), **no credential, no cookie, no redirect**, ≤ 4 KB read, must be `{ok: boolean}` with 200 or 503. Only then is it saved and applied **in place**: iOS can't restart itself, so `window.rs` rewrites every page's CSP (`origin::retarget_csp`) and injects `<meta name="prism-server-origin">` into `<head>` through `on_web_resource_request`; host.js's `apiOrigin` getter reads it from `document.head` (no build-time fallback on iOS). `get_token` takes the page's origin and returns nothing unless it is exactly the current server. Every server change reloads the page from Rust, also after a partial failure. Only allowed while no server is set. |
| Change server | Settings → Account → Server, `reset_server` | Native `UIAlertController` → `DELETE /api/push/apns` + revoke (in parallel, 8 s overall timeout) + forget token → server cleared → a link that was waiting is dropped (`LinkState::clear`, and the page's `prism:pending-link`) → reload into the first-run screen (each step runs even if an earlier one failed). |
| Sign-in | `signin.rs` iOS arm | `ASWebAuthenticationSession`, `prefersEphemeralWebBrowserSession=false` (shares Safari cookies), redirect `prism://auth/callback` (server default `DEVICE_REDIRECT_URIS`). **The callback never passes through `links.rs`**: the session's completion handler returns the URL to Swift → Rust (`PrismIos::authenticate`) → `pkce::code_from_redirect` (exact scheme/host/path, no fragment, our `state`) → `exchange_code` with the PKCE verifier → keychain. The app also REGISTERS the `prism` scheme (for `prism://page/…` links), which changes nothing here: iOS hands a redirect that matches a running session's `callbackURLScheme` to that session, and if a `prism://auth/…` URL ever did arrive as an ordinary open, `links.rs` drops it silently and stores nothing. Label "Prism on iPhone". If the server was changed while the sheet was up, the new token is revoked (best effort) instead of stored. A password login works inside the sheet; the owner's magic link opens in Safari, so **the owner should set a password** (Settings → Account) or sign in once in Safari first. |
| Keychain | `secure_store.rs` | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, non-synchronizable. **No biometric access control on the item (deliberate):** a presence-bound item would need Face ID for every token read, including APNs re-registration at launch and a launch from a notification tap while the phone is locked; the lock is enforced in the UI instead (below). |
| App lock | Swift `AppLock`, `set_app_lock`, Settings → Account → Security | Off (default) · When Prism opens · After 5/15/60 min in background · Every time. `LAContext.deviceOwnerAuthentication` (Face ID/Touch ID with passcode fallback). The background timer uses `mach_continuous_time` (monotonic, counts sleep; setting the clock back can't skip the lock; a backwards/NaN reading locks) — pure rule in `LockPolicy.swift`, tested by `scripts/ios-policy-tests/run.sh` (also run by verify-client). The cover is its own window at alert level + 1 (above alerts and the sign-in sheet; only the system Face ID/passcode UI shows over it), goes up on resign-active (hides the app-switcher snapshot) and stays until unlocked. While locked the webview has no interaction and no focus, presented alerts, an open sign-in sheet and an open share sheet are dismissed, and `authenticate` / `confirm` / `verifyOwner` / `shareFile` refuse. Changing the setting while a lock is on asks for Face ID first. No device passcode = the lock can't be enforced (fails open, said in Settings). |
| Links behind the lock | `links.rs` + Swift `waitUnlocked` | The page keeps running behind the cover, so **nothing is handed to it while locked**. `LinkState` delivers only when `lock_ready` (the saved lock was applied at launch — `lib.rs` sets it after `configure_lock`) AND the Swift side answers `waitUnlocked` (`LockPolicy.mayDeliverLink`: no lock, or unlocked + app active + no background trip still waiting for its lock decision — a link that brings the app back reaches it BEFORE `didBecomeActive` decides). A link still expires 10 minutes after it arrived, also behind the lock. The same gate holds a tapped notification: `takeOpenedSession` answers nothing while locked and the page is pinged after the unlock. |
| Links with no server | `links::accept(…, None, …)` | First run / after "Sign out & change server": every link is refused, silently, and nothing is kept. macOS always has an origin (saved or built-in), so its validation is unchanged. |
| Push | Swift `PushRegistrar`, `apps/web/src/native/apnsPush.ts` | `PushClient` seam (Settings → Account → "Notify me…"): the permission prompt only follows the user turning that toggle on (never at launch or sign-in by itself). **Every signed-in account** may register (the routes take any user with the app's `pd_` device credential; a cookie → 403); the choice is remembered per account on the device (`prism:apns:<16-hex tag>` — no address in web storage). While it is on and iOS allows it, the hex token is POSTed to `/api/push/apns {token, environment}` with the device bearer on **every launch** (token refresh). Environment (`mobile_cmds::apns_environment`, unit-tested): App Store/TestFlight installs have NO embedded profile, so no profile = `production`; a profile saying `development` or the simulator = `sandbox`; an ad hoc build embeds a distribution profile = `production`. Each registration waits with its own 30 s timeout. "Send a test notification" → `/api/push/apns/test`. Turning it off → `DELETE /api/push/apns`; sign-out and reset delete the row too (the shell's `delete_apns`, and the server's `revokeDevice`). A tap (ids only: `sessionId` / `url=/agent/<id>`, or `notificationId` / `url=/inbox/<id>`) is pulled through `push_take_opened`, which answers the canonical client PATH built by `links::notification_path` (the same id rules as a link), and the page opens it as a tab through `appLinks.openAppLink`, cold or warm. |
| External links | `open_external` | Same validation; the confirmation is a `UIAlertController`; opens in Safari via the opener plugin. |
| Export | `export_note`, `save_export` (`native_cmds.rs` iOS arms) + Swift `shareFile` | No save panel on iOS. The shell writes the note / streams the archive (same `export_archive::download`: bearer to the configured origin only, no redirect, size caps) into `<app tmp>/prism-exports/<random>/<name>` (0700), presents `UIActivityViewController` (Save to Files, AirDrop; popover anchored for iPad) and **deletes the folder when the sheet closes**, whatever happened; leftovers are purged at launch. Swift shares only a `.zip`/`.md`/`.html` under that folder; the path never reaches JS. Result: the file's name when an activity completed, null when the sheet was dismissed (the dialog then offers "Save…" again — the job lives 15 minutes on the server). |
| WebView | Swift `load(webview:)` | `contentInsetAdjustmentBehavior=.never` (the web UI owns safe areas via `viewport-fit=cover`), no scroll-view bounce, no back/forward swipe, no link previews. Pinch zoom stays available; zoom-on-focus is avoided by the 16 px floor in `styles/touch.css` § "iOS zoom-on-focus" (`phone-zoom.spec.ts`). |

**IPC surface (iOS) — pinned separately from the desktop's.** `capabilities/mobile.json`
(platform iOS, window `main`), 15 commands: the six shared ones (`get_token`, `sign_in`,
`sign_out`, `get_server_origin`, `set_server_origin`, `open_external`), `export_note`,
`save_export` and `save_attachment` (all three end in the share sheet), and six iOS-only ones — `reset_server`,
`get_app_settings`, `set_app_lock`, `push_register`, `push_status`, `push_take_opened`
(`src/mobile_cmds.rs`; on desktop they return an error and no desktop capability grants them).
No quick capture and no desktop `notify` on iOS. The desktop list is unchanged: 9 main-window
commands + `quick_capture` (`capabilities/default.json` is desktop-only since this merge). The
Swift plugin (`src-tauri/plugins/prism-ios`, linked for iOS only) registers **no**
webview-callable command; only Rust calls it. Its single `evaluateJavaScript` is the fixed,
data-free `prism:native-push-opened` ping. `verify-client.mjs` §9–§10 pin all of this.

**Not in the first build (deferred).** QR pairing (needs the server pairing routes,
`one-download-setup.md` §5), share extension, `GET /api/version` skew check, quick
capture/widgets, a `UIKeyCommand` so ⌘N shows in the iPad ⌘-hold overlay, embeds from providers other than YouTube and Vimeo (owner decision c.7, 2026-10-08: the client
CSP frames `https://www.youtube-nocookie.com/embed/` and `https://player.vimeo.com/video/` only;
Spotify, Loom, Figma, Google and X stay "Open in …" cards in the apps — see "Embeds" below).

### Owner procedure: build and device pass

For a Mac with Xcode. Nothing here uploads anything; TestFlight is the LAST step and is not
part of the device pass. Work from the repository root unless a step says otherwise. Stop at
the first step that fails and fix it before going on.

**0. Prerequisites (once per machine).**
- Xcode 15.3 or newer with the iOS platform installed (`xcodebuild -version`; the ad hoc export
  method name `release-testing` needs 15.3 — on an older Xcode change it to `ad-hoc` in
  `gen/apple/ExportOptions.adhoc.plist`), command line tools selected (`xcode-select -p`).
- Rust iOS targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.
- `npm ci` at the repository root (the Tauri CLI comes from `apps/client`'s dev dependencies).
- Signing (already on the owner's Mac): the **Apple Distribution** identity in the login
  keychain (`security find-identity -v -p codesigning | grep "Apple Distribution"`), the App
  Store Connect API key `AuthKey_<KEY ID>.p8` in `~/.appstoreconnect/private_keys/` (the key id
  and issuer are the defaults in `ios-release.sh`; the `.p8` itself is never in the repository).
- App ID `com.benjaminlife.prism.client` in the developer portal with **Push Notifications**
  and **Associated Domains** enabled. Enabling a capability invalidates existing profiles:
  regenerate and download **"Prism Workspace App Store"** afterwards.
- For the device pass: register each test device's UDID (portal → Devices) and create an
  **Ad Hoc** profile for the App ID named exactly **"Prism Workspace Ad Hoc"** that includes
  them; download it (Xcode → Settings → Accounts → Download Manual Profiles, or double-click it).
- Server: APNs configured (`docs/push.md` § Owner setup: `APNS_KEY_PATH/KEY_ID/TEAM_ID`, boot
  banner `apns: ON`), and the association file reachable on the PUBLIC host:
  `curl -sI https://<host>/.well-known/apple-app-site-association` → `200`,
  `content-type: application/json`, no redirect; body names
  `83Y42N33H8.com.benjaminlife.prism.client`.

**1. Preflight (no Xcode involved).**
```bash
node apps/client/scripts/verify-client.mjs --build     # builds the native web bundle, then every invariant; must print "all checks passed"
(cd apps/client/src-tauri && cargo test --lib)         # host tests: links, origin/CSP, PKCE, export, settings, probe
bash apps/client/scripts/ios-policy-tests/run.sh       # the lock rules (Swift, on the Mac)
```

**2. iOS compile.** A debug simulator build compiles every `cfg(target_os = "ios")` line of
Rust and the whole Swift plugin (first passed 2026-10-08). Build from a checkout whose path has
no spaces. **Before every re-build, remove the previous output** — otherwise the compile succeeds
and Tauri then fails with `failed to rename app … Directory not empty`, leaving the OLD app in
place: `rm -rf src-tauri/gen/apple/build/arm64-sim src-tauri/gen/apple/build/prism-client_iOS.xcarchive`.
```bash
cd apps/client && CARGO_TARGET_DIR=$PWD/src-tauri/target npx tauri ios build --target aarch64-sim --debug --ci
```
If it fails, the likely places are the code written without a compiler: `links.rs`
(`app_unlocked`, iOS arm), `native_cmds.rs` (the two iOS arms of `export_note` / `save_export`),
`lib.rs` (the iOS block in `setup`), `plugins/prism-ios/src/lib.rs` (`wait_unlocked`,
`share_file`) and `PrismIosPlugin.swift` (`whenUnlocked`, `waitUnlocked`, `shareFile`, the
notification `didReceive`). Fix, re-run step 1, repeat.

**3. Simulator smoke (5 minutes; simulator results do not count for the checklist).**
```bash
xcrun simctl boot "iPhone 17 Pro"; open -a Simulator
xcrun simctl install booted apps/client/src-tauri/gen/apple/build/arm64-sim/Prism.app
xcrun simctl launch booted com.benjaminlife.prism.client
```
A local test server: `apps/server` with its own env file (`PORT`, `DB_PATH`,
`APP_ORIGIN=http://127.0.0.1:<port>`, fake vault from `scripts/e2e/fake-vault.mjs`) — never the
production server. Check: the first-run screen appears; `http://127.0.0.1:<port>` is accepted
(debug build) and `http://example.com` is not; sign-in sheet → signed in; `xcrun simctl openurl
booted "prism://page/<id>"` opens that page; with the lock on "Every time", background the app,
run the same `openurl`, and the page opens only AFTER the unlock (in the simulator: Features →
Face ID → Enrolled, then Matching Face).

**4. Associated Domains for THIS build (universal links).** Writes the server host into the
two entitlements files in the working tree — do not commit that change:
```bash
node apps/client/scripts/universal-links.mjs --ios --hosts <your server host>     # e.g. prism.example.com
git diff --stat apps/client/src-tauri/gen/apple/prism-client_iOS/                 # exactly the two .entitlements files
```

**5. Bump the build number** if a build with this number was ever installed or uploaded:
`bundle.iOS.bundleVersion` in `apps/client/src-tauri/tauri.ios.conf.json` (1, 2, 3…).

**6. Build the device-pass app (Release, production APNs, ad hoc — nothing is uploaded).** In
your own Terminal (codesign needs the login keychain; the first time click *Always Allow*):
```bash
apps/client/scripts/ios-release.sh -adhoc
```
It archives with `tauri ios build`, exports with the local Apple Distribution identity and the
"Prism Workspace Ad Hoc" profile, and prints what it made. **Read the summary before
installing:** `Authority=Apple Distribution`, team `83Y42N33H8`, the profile name and expiry,
entitlements with `aps-environment = production` AND
`com.apple.developer.associated-domains = applinks:<your host>`, `CFBundleVersion` = the number
from step 5, `ITSAppUsesNonExemptEncryption = false`, a Face ID usage string, **no**
`NSAppTransportSecurity`, URL schemes = exactly `prism`.

**7. Restore the working tree** (the host must not be committed):
```bash
git checkout -- apps/client/src-tauri/gen/apple/prism-client_iOS/prism-client_iOS.entitlements \
                apps/client/src-tauri/gen/apple/prism-client_iOS/prism-client_iOS.debug.entitlements
node apps/client/scripts/verify-client.mjs      # passes again
```

**8. Install on the test devices.**
```bash
xcrun devicectl list devices
xcrun devicectl device install app --device <device id> apps/client/src-tauri/gen/apple/build/release/adhoc/Prism.ipa
```
(or drag the `.ipa` onto the device in Finder). A device whose UDID is not in the Ad Hoc
profile refuses the install.

**9. Device pass.** Run `docs/roadmap/workspace-experience/PARITY-GAPS.md` §b.3 (Parts A–D for
the iPhone/iPad; record device, OS, build number, result per row), against the production
server with synthetic `_test` pages. The rows this merge adds or changes, and what to look for:

| Row | On the device | Expected |
|---|---|---|
| First run | Fresh install → launch. Type `not an address`, `http://<host>`, `https://<host>/page/x`, a host that does not exist, `example.com`, then your server (also without `https://`). | The first three are refused at once with a reason; the unknown host says it could not be reached; `example.com` "doesn't look like a Prism Server"; your server → the sign-in screen. Airplane mode → "Couldn't reach …", and the app is usable again once back online. |
| NP-NA-01 | Sign in (sheet), Settings → Account → Sign out, sign in again; then "Sign out & change server…": Cancel, then confirm. | Back in the app signed in; after sign-out the device is gone from "Signed-in devices" on the web; Cancel changes nothing; confirm → the first-run screen, and the old server's pages are not shown. |
| NP-NA-02 | Lock = "When Prism opens": kill, relaunch. Lock = "After 5 minutes": background 6 minutes. Lock = "Every time": app switcher, then return. Cancel the Face ID prompt. Try to change the lock setting. | Face ID (passcode fallback) each time; the switcher shows the cover, not the page; after Cancel the cover stays with "Unlock"; changing the setting asks for Face ID first. |
| Lock × links | Lock = "Every time". With the app in the background, tap an `https://<host>/page/<id>` link in Notes, and separately a `prism://page/<id>` link. Do the same with the app killed. Then tap a link, do NOT unlock for 11 minutes, unlock. | The app comes forward LOCKED; the page opens only after Face ID; nothing of the page is visible before it. The link left for 11 minutes does not open. |
| Lock × push | Lock on. Get a mention from the second account; tap the notification on the lock screen. | The app opens locked; after Face ID the Inbox opens at that item. |
| NP-NA-04 | Tap `https://<host>/page/<id>` in Messages and Mail; long-press it; tap a `…/collab/<id>?t=…` share link, a `/p/<slug>` link, an invite link. Sign out, tap a page link, sign in. Tap a page link for a page the account cannot view, and a link to another host. | Page links open in the app ("Open in Prism" on long-press); the share / published / invite links open in Safari; the link tapped while signed out opens after sign-in; an unviewable page shows "Document unavailable"; another host never opens in the app. |
| NP-NA-03 | Settings → Account → turn notifications on (first time: the iOS prompt appears HERE, not at launch). "Send a test notification". From the second account: mention the owner; start an agent turn and background the app. Then sign in as the MEMBER on the device, turn notifications on, and mention them. Turn the toggle off and repeat a mention. | The test arrives; a push for the mention and the finished turn (generic text); tapping opens the Inbox item / the agent session; the member gets their own pushes; after turning it off nothing arrives. On the server `apns_tokens` holds one row per device and loses it on sign-out. |
| NP-TX-03 | Page ⋯ → Export as Markdown. Page ⋯ → Export… with sub-pages. Workspace export (owner). Dismiss the sheet once without saving, then "Save…". Start a large export and lock the phone. | The share sheet opens with the `.md` / `.zip` (iPad: a centred popover); Save to Files stores it and the archive opens; dismissing reads "Not saved yet" and Save… brings the sheet back; no copy stays in the app (Settings → General → iPhone Storage → Prism does not grow by the archive's size after closing the sheet). |
| NP-MB-10 (iPad) | Hardware keyboard: ⌘N, ⌘K, ⌘\, ⌘/. | Each reaches the app. (⌘N is not listed in the ⌘-hold overlay — deferred.) |

Device-only facts no test here can show — confirm each once and note it in the hand-off:
that iOS hands the `prism://auth/callback` redirect to the sign-in sheet although the app also
registers the `prism` scheme (sign-in completing IS the proof); that a universal link reaches
the app at all; that the cover is up before the first frame after a cold start with a lock on;
that `UIActivityViewController`'s completion fires when the lock dismisses the sheet (no stuck
"Saving…" in the dialog).

**10. TestFlight — ONLY after full parity sign-off (owner rule).** Not part of the device
pass. When, and only when, Notion parity is signed off on main:
1. Repeat steps 1, 4, 5 (a NEW build number) on the release commit.
2. `apps/client/scripts/ios-release.sh` (no flag) → `gen/apple/build/release/export/Prism.ipa`,
   signed with the "Prism Workspace App Store" profile. Read the summary as in step 6 (an App
   Store build has no `get-task-allow` and `aps-environment = production`). Then step 7.
3. Upload:
   ```bash
   xcrun altool --upload-app --type ios --file apps/client/src-tauri/gen/apple/build/release/export/Prism.ipa \
     --apiKey <KEY ID> --apiIssuer <ISSUER ID>
   ```
   (the script prints the exact command; or drag the .ipa into Transporter). Processing takes
   5–30 min; you get an email.
4. **Export compliance**: the binary declares `ITSAppUsesNonExemptEncryption=false` (HTTPS/TLS
   only), so App Store Connect doesn't ask. If it ever does: "None of the algorithms mentioned
   above" / standard encryption exempt.
5. **TestFlight**: App Store Connect → Apps → Prism Workspace → TestFlight. Internal testing →
   "+" create a group (e.g. "Owners") → add testers (users of your App Store Connect team) → add
   the processed build to the group. Testers install the **TestFlight** app and accept the email
   invite. External testing needs a short Beta App Review.
6. TestFlight tokens are **production** APNs tokens (the server needs nothing new).

Why `ios-release.sh` has two steps: `tauri ios build` archives fine, but its own export uses
Xcode cloud signing, which the API key's role may not use ("Cloud signing permission error"), so
the script exports the archive itself with the local distribution certificate and a named profile
(`gen/apple/ExportOptions.plist` / `ExportOptions.adhoc.plist`, manual signing).
