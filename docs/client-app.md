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
and committed). Identity: bundle id `com.benjaminlife.prism.client` (the registered App ID; the
keychain item is per device, so nothing is shared with the Mac), home-screen name **Prism**
(`tauri.ios.conf.json` `productName` + `Info.ios.plist`), App Store name **Prism Workspace**
(set only in App Store Connect), version `0.1.0` build `1`, deployment target **iOS 16.0**
(ASWebAuthenticationSession and LocalAuthentication need 13; 16 is Tauri 2's practical floor
for this WebKit/ES feature set). `Info.ios.plist` (merged by Tauri at build time):
`ITSAppUsesNonExemptEncryption=false`, `NSFaceIDUsageDescription`, and **no ATS key**: Release
has ATS fully on. Debug builds get `NSAllowsLocalNetworking` from a Debug-only build phase
(`project.yml` "Debug-only ATS loopback exception") for a loopback test server, and
`origin.rs` refuses `http://` on iOS release builds (`ALLOW_HTTP_LOOPBACK`). Entitlements:
Release `prism-client_iOS.entitlements` = `aps-environment=production`, Debug
`prism-client_iOS.debug.entitlements` = `development` (per-config `CODE_SIGN_ENTITLEMENTS`).
No associated domains, no URL types. Privacy manifest `prism-client_iOS/PrivacyInfo.xcprivacy`
(no tracking, no collected data; required-reason APIs: file timestamp `C617.1`, system boot
time `35F9.1`; UserDefaults is not used). Icons: full-bleed opaque render of `PrismAppIcon`
(`scripts/build-ios-icon.ts`).

**`gen/apple` is generated, then customised — keep the customisations.** `tauri ios init`
rewrites `gen/apple` from Tauri's template (project.yml, Info.plist, entitlements, icons,
ExportOptions). Prefer NOT re-running it. If you must (a Tauri upgrade that needs a new
template):
1. Commit first, run `npx tauri ios init --ci`, then `git diff apps/client/src-tauri/gen/apple`.
2. Restore from git: the two entitlements files, `PrivacyInfo.xcprivacy`, `ExportOptions.plist`,
   the AppIcon PNGs, and in `project.yml` the `configs:` block (per-config
   `CODE_SIGN_ENTITLEMENTS`) and the `postBuildScripts` "Debug-only ATS loopback exception".
3. Regenerate the Xcode project with **no build outputs present** (otherwise xcodegen adds
   `Externals/*/libapp.a` as resources and the build fails with "Multiple commands produce
   libapp.a"): `cd apps/client/src-tauri/gen/apple && mv Externals /tmp/ext && mkdir Externals
   && xcodegen generate --spec project.yml && rmdir Externals && mv /tmp/ext Externals`.
4. `node apps/client/scripts/verify-client.mjs` must pass (it checks every item above).
Info.plist keys never need re-applying: Tauri merges `src-tauri/Info.ios.plist` on every build.

| Piece | Where | Notes |
|---|---|---|
| First run "Enter your server" | `apps/web/src/native/ServerSetupScreen.tsx` → `set_server_origin` | No built-in server. The shell parses (https; http on loopback only in debug builds; the host must be LDH labels after IDNA, IPv4 or [IPv6], so nothing like `*`, `;`, `'`, `,` can reach the CSP), probes `GET /health` (must answer `{ok:boolean}`, 200 or 503), saves, and applies **in place**: iOS can't restart itself, so `window.rs` rewrites every page's CSP (`origin::retarget_csp`) and injects `<meta name="prism-server-origin">` into `<head>` through `on_web_resource_request`; host.js's `apiOrigin` getter reads it from `document.head` (no build-time fallback on iOS). `get_token` takes the page's origin and returns nothing unless it is exactly the current server. Every server change reloads the page from Rust, also after a partial failure. Unconfigured CSP = no remote origin at all. Only allowed while no server is set. |
| Change server | Settings → Account → Server, `reset_server` | Native `UIAlertController` → `DELETE /api/push/apns` + revoke (in parallel, 8 s overall timeout) + forget token → server cleared → reload into the first-run screen (each step runs even if an earlier one failed). |
| Sign-in | `signin.rs` iOS arm | `ASWebAuthenticationSession`, `prefersEphemeralWebBrowserSession=false` (shares Safari cookies), redirect `prism://auth/callback` (server default `DEVICE_REDIRECT_URIS`; no `Info.plist` URL type, the session takes the callback itself), callback checked by `pkce::code_from_redirect` (exact scheme/host/path + state), same PKCE + `exchange_code` + keychain as desktop. Label "Prism on iPhone". If the server was changed while the sheet was up, the new token is revoked (best effort) instead of stored. A password login works inside the sheet; the owner's magic link opens in Safari, so **the owner should set a password** (Settings → Account) or sign in once in Safari first. |
| Keychain | `secure_store.rs` | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, non-synchronizable. **No biometric access control on the item (deliberate):** a presence-bound item would need Face ID for every token read, including APNs re-registration at launch and a launch from a notification tap while the phone is locked; the lock is enforced in the UI instead (below). |
| App lock | Swift `AppLock`, `set_app_lock`, Settings → Account → Security | Off (default) · When Prism opens · After 5/15/60 min in background · Every time. `LAContext.deviceOwnerAuthentication` (Face ID/Touch ID with passcode fallback). The background timer uses `mach_continuous_time` (monotonic, counts sleep; setting the clock back can't skip the lock; a backwards/NaN reading locks) — pure rule in `LockPolicy.swift`, tested by `scripts/ios-policy-tests/run.sh` (also run by verify-client). The cover is its own window at alert level + 1 (above alerts and the sign-in sheet; only the system Face ID/passcode UI shows over it), goes up on resign-active (hides the app-switcher snapshot) and stays until unlocked. While locked the webview has no interaction and no focus, presented alerts and an open sign-in sheet are dismissed, and `authenticate` / `confirm` / `verifyOwner` refuse. Changing the setting while a lock is on asks for Face ID first. No device passcode = the lock can't be enforced (fails open, said in Settings). |
| Push | Swift `PushRegistrar`, `apps/web/src/native/apnsPush.ts` | `PushClient` seam (Settings → Account → "Notify me…"): the permission prompt only follows the user turning that toggle on (server owner only; never at launch or sign-in by itself). While it is on and iOS allows it, the hex token is POSTed to `/api/push/apns {token, environment}` with the device bearer on **every launch**. Environment (`mobile_cmds::apns_environment`, unit-tested): App Store/TestFlight installs have NO embedded profile, so no profile = `production`; only the simulator or a profile saying `development` = `sandbox`. Each registration waits with its own 30 s timeout. "Send a test notification" → `/api/push/apns/test`. Sign-out/reset deletes the row. A tap (ids only, `sessionId` / `url=/agent/<id>`, validated) is pulled through `push_take_opened` and dispatched as `prism:open-agent-session` (the existing deep-link seam), cold or warm. |
| Links | `open_external` | Same validation; the confirmation is a `UIAlertController`; opens in Safari via the opener plugin. |
| WebView | Swift `load(webview:)` | `contentInsetAdjustmentBehavior=.never` (the web UI owns safe areas via `viewport-fit=cover`), no scroll-view bounce, no back/forward swipe, no link previews. Pinch zoom stays available; zoom-on-focus is avoided by the 16px input rule. |

**IPC surface (iOS).** `capabilities/mobile.json` (platform iOS, window `main`): the six shared
commands (`get_token`, `sign_in`, `sign_out`, `get_server_origin`, `set_server_origin`,
`open_external`) + `reset_server`, `get_app_settings`, `set_app_lock`, `push_register`,
`push_status`, `push_take_opened` (`src/mobile_cmds.rs`; on desktop they return an error and no
desktop capability grants them). No quick capture/notify/export on iOS. The Swift plugin
(`src-tauri/plugins/prism-ios`, linked for iOS only) registers **no** webview-callable command;
only Rust calls it. Its single `evaluateJavaScript` is the fixed, data-free
`prism:native-push-opened` ping. `verify-client.mjs` §9 pins all of this.

**Not in the first TestFlight build (deferred).** QR pairing (needs the server pairing routes,
`one-download-setup.md` §5), share extension, universal-link redirect (needs Associated Domains +
an AASA file on the server), `GET /api/version` skew check, quick capture/widgets.

### Simulator

```bash
cd apps/client && CARGO_TARGET_DIR=$PWD/src-tauri/target npx tauri ios build --target aarch64-sim --debug --ci
xcrun simctl boot "iPhone 17 Pro"; open -a Simulator
xcrun simctl install booted src-tauri/gen/apple/build/arm64-sim/Prism.app
xcrun simctl launch booted com.benjaminlife.prism.client
```
A local test server: `apps/server` with its own env file (`PORT`, `DB_PATH`, `APP_ORIGIN=http://127.0.0.1:<port>`,
fake vault from `scripts/e2e/fake-vault.mjs`) — never the production server. Enter
`http://127.0.0.1:<port>` on the first-run screen (or write it into the app container's
`client-settings.json` as `serverOrigin`).

### Build, sign, upload (TestFlight)

**Owner rule: no TestFlight build until Notion parity.** Until then only simulator debug
builds are made; the steps below are the runbook for when that changes.

Prerequisites (one time, done): App ID `com.benjaminlife.prism.client` with Push Notifications;
App Store Connect app "Prism Workspace"; the **Apple Distribution** identity in the login
keychain; App Store Connect API key `AB84HRLBUA` (issuer `7c2856fc-0bdf-4d41-b95d-a2ffab2ba726`)
at `~/.appstoreconnect/private_keys/AuthKey_AB84HRLBUA.p8`; provisioning profile **"Prism
Workspace App Store"** (IOS_APP_STORE, expires 2027-10-03, created through the API; installed
in `~/Library/Developer/Xcode/UserData/Provisioning Profiles`). On another Mac download it in
Xcode → Settings → Accounts, or from the developer portal.

1. **Bump the build number** for every upload (App Store Connect refuses a reused one):
   `bundle.iOS.bundleVersion` in `apps/client/src-tauri/tauri.ios.conf.json` (1, 2, 3…; also
   checked by verify-client). Bump `version` in `tauri.conf.json` (and `Cargo.toml`) only for a
   user-visible release; the build number restarts at 1 per version if you like.
2. **In your own Terminal** (codesign needs the login keychain; the first time click *Always
   Allow* on "codesign wants to access key"): `apps/client/scripts/ios-release.sh`. It runs
   `tauri ios build --export-method app-store-connect` with `APPLE_API_KEY`/`APPLE_API_ISSUER`/
   `APPLE_API_KEY_PATH` (Tauri passes them to xcodebuild as `-allowProvisioningUpdates
   -authenticationKeyPath … -authenticationKeyID … -authenticationKeyIssuerID …`), keeps the
   archive (Tauri's own export fails: the key's role can't use cloud signing), and exports it with
   `xcodebuild -exportArchive -exportOptionsPlist apps/client/src-tauri/gen/apple/ExportOptions.plist`
   (manual signing: Apple Distribution + the profile above). It prints the signing summary,
   profile name/expiry, entitlements (`aps-environment = production`) and the upload command.
3. **Upload** → `apps/client/src-tauri/gen/apple/build/release/export/Prism.ipa`:
   ```bash
   xcrun altool --upload-app --type ios --file apps/client/src-tauri/gen/apple/build/release/export/Prism.ipa \
     --apiKey AB84HRLBUA --apiIssuer 7c2856fc-0bdf-4d41-b95d-a2ffab2ba726
   ```
   (or drag the .ipa into Transporter). Processing takes 5–30 min; you get an email.
4. **Export compliance**: the binary declares `ITSAppUsesNonExemptEncryption=false` (HTTPS/TLS
   only), so App Store Connect doesn't ask. If it ever does: "None of the algorithms mentioned
   above" / standard encryption exempt.
5. **TestFlight**: App Store Connect → Apps → Prism Workspace → TestFlight. Internal testing →
   "+" create a group (e.g. "Owners") → add testers (they must be users of your App Store
   Connect team: Users and Access → "+" → role Developer/Marketing etc.) → add the processed build
   to the group. Testers install the **TestFlight** app from the App Store and accept the email
   invite (or open the public link if you create one for external testing, which needs a short
   Beta App Review). Each new build appears in TestFlight automatically for that group.
6. **Server side for push**: APNs must be configured on the server (`docs/push.md` § APNs:
   `APNS_KEY_PATH/KEY_ID/TEAM_ID`, topic = the bundle id). TestFlight tokens are production.
