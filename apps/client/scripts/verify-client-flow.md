# Prism Client: manual sign-in checklist (overseer)

The implementer could not complete a real sign-in (no server access). Run this against the
**sandbox** Prism Server (never :8787 prod or :1940 vault), or against production once that
is sanctioned. Record pass/fail per step.

## 0. Build

```bash
cd apps/client
# sandbox: point the build at it (or leave the default and use Server Settings in step 2)
PRISM_SERVER_ORIGIN=http://127.0.0.1:8899 npm run tauri build -- --bundles app
node ../../apps/client/scripts/verify-client.mjs      # all ✓
(cd src-tauri && cargo test)                          # all pass
```

Open `<CARGO_TARGET_DIR>/release/bundle/macos/Prism Client.app` straight from the build
directory. Do not copy it into /Applications yet.

- [ ] The app launches next to the legacy **Prism.app** (both can run at once).
- [ ] The title is "Prism", and the menu bar shows **Prism, Edit, View, Window**.

## 1. Signed-out state

- [ ] First launch shows **Sign in to Prism**. The Web Inspector (dev build only) Network tab shows no request to the server before sign-in, except Google Fonts.
- [ ] In the console, `window.__PRISM_HOST__.apiOrigin` is the expected origin, and `Object.isFrozen(window.__PRISM_HOST__)` is `true`.
- [ ] `window.__TAURI__` is `undefined`.

## 2. Server settings

- [ ] **Prism → Server Settings…** (Cmd-,) opens the dialog with the current origin.
- [ ] Try each of these. Each must show an inline error and must not restart the app:
  - `http://example.com`
  - `https://x.com/path`
  - `http://127.0.0.1:1940`
- [ ] In the console, `__TAURI_INTERNALS__.invoke("set_server_origin",{origin:"https://evil.example",grant:"x"})` is **rejected** with "Open Server settings from the Prism menu…".
- [ ] Saving a valid origin restarts the app, and the new origin persists across a quit and relaunch (check `client-settings.json`).

## 3. Sign-in (loopback PKCE)

- [ ] Click **Sign in**. The system default browser opens `/auth/device/authorize?...redirect_uri=http://127.0.0.1:<port>/callback...&code_challenge_method=S256&label=Prism Client on <host>`.
- [ ] Signed out in the browser: the web login appears, then the consent page. The consent page names **"Prism Client on <host>"** and "an app on this computer" (`127.0.0.1:<port>/callback`).
- [ ] **Approve**: the browser tab says "You're signed in". The app comes to the front, reloads, and shows the vault.
- [ ] **Keychain Access**: the item "Prism device token" exists, with service `com.benjaminlife.prism.client` and account = the origin. It is not in iCloud.
- [ ] No token appears in `localStorage`/`sessionStorage`/IndexedDB (check in the Web Inspector). `document.cookie` is empty.
- [ ] **Account → Devices** (server) lists the device, and the web UI marks it `current`.

## 4. Negative sign-in paths

- [ ] Click Sign in, then press **Deny**. The tab says "Sign-in cancelled", the app shows "Sign-in failed: sign-in was denied…" and stays on the sign-in screen.
- [ ] Click Sign in, close the tab, and click Sign in again. A fresh browser tab opens (the old attempt was cancelled), and completing it works.
- [ ] During an attempt, run `curl "http://127.0.0.1:<port>/callback?code=x&state=forged"`. It gets a 400, and the real approval still succeeds afterwards.
- [ ] `curl http://127.0.0.1:<port>/favicon.ico` gets a 404, and the flow continues.
- [ ] After a successful sign-in, `curl http://127.0.0.1:<port>/callback` is refused (the port is closed).

## 5. Signed-in use (WP4.1 acceptance)

- [ ] Browse notes, edit a document and see it saved (via the gateway).
- [ ] Collab: open a shared doc in a browser and in the client, and both see live edits (WSS to the same origin).
- [ ] Agent chat streams (fetch-based SSE).
- [ ] Clicking an external link in a note opens the **system browser**, and the app stays put.
- [ ] External images in notes do **not** load. This is a known limit (CSP img-src). A server-hosted attachment does load.
- [ ] Calendar dashboard shows no desktop-only affordances (`isDesktop` is false).
- [ ] `ps` shows no ingest, `claude`, `gog` or `parachute` child processes of Prism Client, and `/acl/workers` is unchanged.

## 6. Sign-out and revocation

- [ ] **Prism → Sign Out**: the app returns to the sign-in screen, the keychain item is gone, and Account → Devices on the server no longer lists the device.
- [ ] Sign in again, then use **Account → Sign out** in the web UI: same result.
- [ ] Sign in again, then **revoke the device from the browser** (Account → Devices). The next request in the client gets a 401, the app shows the sign-in screen, and the keychain item is deleted.

## 7. Window state

- [ ] Resize and move the window, then quit (Cmd-Q) and relaunch. The size and position are restored.
- [ ] Maximize, quit and relaunch: the window is still maximized.
- [ ] Edit `client-settings.json` to put the window at x=99999. On relaunch the window is centered on a visible screen.
