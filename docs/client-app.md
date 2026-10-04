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
| Backend | ~100 Rust commands, sync services, `claude`/`gog`/`gh` subprocesses | 8 commands for the main window (`get_token`, `sign_in`, `sign_out`, `get_server_origin`, `set_server_origin`, `open_external`, `notify`, `export_note`) + `quick_capture` for the capture window |
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
- **401** on our token: `onUnauthorized()` → `sign_out {revoke:false}` (the token is dead
  anyway). The app shows the sign-in screen. It never auto-opens the browser.

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
`apiOrigin`, `getToken`, `onUnauthorized`, `signIn` and `onSignedOut` (the WP2.2
contract). It also defines `window.__PRISM_SHELL__` (`showServerSettings(grant)`,
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
`/.well-known/*`, `/p/*` (published sites are public web pages) and **any `/collab/<id>?t=…`**
capability link (the app acts as the signed-in account and would drop the token, and with it
the access the link carries — those stay in the browser). The sign-in flow opens
`/auth/device/authorize` in the SYSTEM browser and returns through a loopback redirect
(macOS) or `prism://auth/callback` (iOS, WP5): the association file excludes `/auth/*`
explicitly, and `links.rs` refuses everything under `prism://auth` (silently, and without
logging the URL — it can carry a code).

**Server.** `APPLE_APP_ID` = `<TeamID>.<bundle id>` (comma-separated for several apps);
unset = `83Y42N33H8.com.benjaminlife.prism.client`; set to an empty string → both paths
answer 404 (the host advertises no app). The file is public JSON (`application/json`, no
redirect, no auth, `Cache-Control: public, max-age=3600`), `applinks` only — no
`webcredentials`. Exclusions come first (Apple takes the first matching component). Both
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
the path and fires a payload-free `prism:open-link` event; the signed-in app takes it with
`takePendingLink()` and opens a tab (`openTab`), so access is the account's own — a page it
cannot view shows "Document unavailable". A refused link shows the shell toast "This link
can’t be opened in Prism." (not for `prism://auth/…`).

**Signed out / cold start.** The shell keeps ONE pending link (`LinkState`, newest wins) and
hands it over only when the main window's page has finished loading AND a device token
exists; it re-checks on every page load, so a link that arrived at the sign-in screen opens
after the sign-in reload. Undelivered after 10 minutes → dropped. A token the server then
rejects (401) lands on the sign-in screen with the link already handed over: it is lost
(dropped safely), not replayed.

**The `prism://` scheme** is registered by `src-tauri/Info.plist` (merged by the Tauri
bundler; `verify-client.mjs` pins it to exactly that one scheme).

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
- **iOS (after `feat/native-ios` is merged):** run `--ios` before `ios-release.sh`; enable
  Associated Domains on the App ID and regenerate the "Prism Workspace App Store" profile.
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

### Saving an export archive (design — NOT built)

**Today, in the Prism Client, a multi-page export finishes and nothing is saved.**
`ExportDialog` hands the ZIP to `saveBlob()` (an `<a download href="blob:…">` click). wry
attaches a WKDownloadDelegate only when the window has a download handler; this shell sets
none, so WKWebView's `shouldPerformDownload` navigation is answered `Cancel`
(`wry/src/wkwebview/navigation.rs`) — on macOS and on iOS alike. (A single page without
sub-pages or files is unaffected: it goes through `export_note`, text only.) Adding a
download handler is the wrong fix: it would let page script start downloads of arbitrary
URLs to a path the page influences.

Proposed, same shape as `export_note` (the page never supplies a path or a URL):

- **IPC** `save_export { jobId, suggestedName }` → `Option<String>` (the saved file's name),
  main window only (`require_label`), declared in `build.rs`, granted in
  `capabilities/default.json` (the main window then has 9 commands — update
  `verify-client.mjs`, this doc's table and CLAUDE.md).
- **Rust** builds the URL itself: `origin.join("/api/export/<jobId>/download")` with `jobId`
  matching the server's id shape exactly (reject anything else before any I/O); `GET` with
  `Authorization: Bearer <device token>` from `AppState` (the token never passes through
  this call's arguments), **redirects disabled** (`reqwest::redirect::Policy::none()`), a
  connect + idle timeout, `Content-Type` must be `application/zip`, and a hard size cap
  (the server's `EXPORT_MAX_BYTES`, 2 GB) enforced on the declared length AND while
  streaming. Bytes are streamed to disk in chunks — never buffered, never base64 over IPC.
- **macOS:** native save panel first (`rfd`, name from `export::sanitize_stem` + `.zip`);
  stream to `<chosen>.part` in the same folder, `fsync`, rename; delete the part on any
  failure or cancel.
- **iOS:** stream to `<app tmp>/exports/<random>/<sanitised name>.zip` (0600; the folder is
  emptied at launch and after the sheet closes), then present `UIActivityViewController`
  (Save to Files / AirDrop) from the Swift plugin, anchored for iPad. The path never
  reaches JS.
- **Page:** `ExportDialog` calls `__PRISM_SHELL__.saveExport(jobId, fileName)` when the
  shell offers it (instead of `transferApi.exportDownload` + `saveBlob`), shows
  "Saved <name>" / the error, and keeps the job until the save finished. The active vault
  needs no header: an export job is bound to the account and its id.
- **Tests:** Rust against a loopback fake (id shapes, a 302 is refused, wrong content type,
  declared and streamed overflow, cancel leaves no `.part`, the bearer goes only to the
  configured origin); a fixture spec for the dialog with a stub shell.
- Size: M for macOS, plus the Swift half once the iOS shell is on main. Until then the
  honest state is: **multi-page export does not save in the native shell; use the web app.**

## Security surface

- **CSP** is built at startup from the origin (`origin.rs` `build_csp`). The copy in
  `tauri.conf.json` is only the build-time placeholder for the default origin.
  - `connect-src 'self' ipc: http://ipc.localhost <origin> <wss-origin>`: the page can
    reach nothing else.
  - `img-src 'self' data: blob: <origin>`.
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
    on **Open** reaches the opener. On non-macOS platforms the dialog answers "no" until
    WP5 adds one.
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
- `dirs::config_dir()` is used for settings because the CSP must be known before the Tauri
  app exists. On iOS (WP5.1) this must move to the app's sandbox container.
- **L3: keychain hardening.** Blocked on Apple signing (D1). The item currently lives in the
  file-based login keychain with an app-ACL. With a Developer ID/team signature, move it to
  the data-protection keychain (`use_protected_keychain`) with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (plus a keychain-access-group
  entitlement).
- **L4: bundle the fonts.** Ship Inter/JetBrains Mono/Newsreader/DM Sans and Excalidraw's
  hand-drawn fonts in the native build. That would drop `https://fonts.googleapis.com`,
  `https://fonts.gstatic.com` and `https://esm.sh` from the CSP, leaving the server as the
  only remote origin.

## What WP5 (iOS) adds to this shell

- `tauri ios init` in `apps/client` (it creates `gen/apple`). Add the `iOS` platform to the
  capability; it is already listed.
- **WP5.2 sign-in**: an `ASWebAuthenticationSession` (small Swift plugin, or
  `tauri-plugin-deep-link` + `prism://auth/callback`) in the `#[cfg(mobile)]` arm of
  `signin.rs`, returning the redirect URL to `pkce::parse_callback_query`. Everything after
  that is shared. If the redirect is a universal link, register it in the server's
  `DEVICE_REDIRECT_URIS`.
- **Keychain**: `secure_store.rs` already compiles for iOS. Add
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and optional biometric access control
  (Face ID) there.
- **Settings path**: resolve the settings directory from the iOS app container (see
  Known limits). There is no window-geometry or menu code on mobile (`#[cfg(desktop)]`).
- APNs registration (WP5.3) as a separate plugin/command. It must be declared in `build.rs`
  and granted in the capability.
