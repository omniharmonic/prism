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
- [ ] Saving a valid origin shows a **native** dialog, "Point Prism Client at <normalized origin>?", with Cancel as the default button.
- [ ] **Cancel**: nothing is saved, the in-page dialog closes, and a second Save needs the menu again (the grant is spent).
- [ ] **Change Server**: the app restarts, and the new origin persists across a quit and relaunch (check `client-settings.json`).

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
- [ ] During an attempt, hold idle connections (`for i in 1 2 3; do nc 127.0.0.1 <port> & done`), then approve in the browser. The sign-in completes immediately.
- [ ] After a successful sign-in, `curl http://127.0.0.1:<port>/callback` is refused (the port is closed).

## 5. Signed-in use (WP4.1 acceptance)

- [ ] Browse notes, edit a document and see it saved (via the gateway).
- [ ] Collab: open a shared doc in a browser and in the client, and both see live edits (WSS to the same origin).
- [ ] Agent chat streams (fetch-based SSE).
- [ ] Clicking an external link in a note shows a **native** "Open this link in your browser?" dialog with the URL. **Open** opens the system browser; **Cancel** does nothing. The app never navigates away.
- [ ] A `mailto:` link asks "Write an email?" before opening Mail.
- [ ] Navigation lock:
  - In the console, `location = "https://example.com/?t=x"` does nothing: no browser, no dialog, and the app stays.
  - `window.open("javascript:alert(1)")` does nothing.
  - `__TAURI_INTERNALS__.invoke("open_external",{url:"file:///etc/passwd"})` is rejected.
- [ ] A website note containing `<meta http-equiv="refresh" content="0;url=https://example.com">` opens nothing: no browser, no dialog.
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

## 8. Native extras (WP4.2)

Sign in first (§3). Use the sandbox server. Quit any other copy of the client before starting,
so the global shortcut isn't already taken.

### 8a. Menu-bar icon and quick capture

- [ ] A Prism icon appears in the menu bar with **Quick capture…, Open Prism, Sign out, Quit Prism**.
- [ ] **Quick capture…** opens a small always-on-top "Quick capture" window with a focused text box.
- [ ] Type text and press **Cmd-Enter** (or Save): the window closes, and the note appears in the app
      under `vault/capture/<today>/…` with the tag `capture`.
- [ ] **Esc** and **Cancel** close the window and create nothing.
- [ ] Empty Save shows "Type something to capture." and sends nothing.
- [ ] Signed out (tray **Sign out**, then capture): the window shows "You're signed out. Open Prism and sign in first." and nothing is created.
- [ ] Server unreachable (stop the sandbox server, or turn Wi-Fi off): the window shows "Couldn't reach the Prism server…" and keeps your text.
- [ ] In the capture window's Web Inspector (dev build) console: `__TAURI_INTERNALS__.invoke("get_token")` is **rejected** (not allowed), and
      `__TAURI_INTERNALS__.invoke("open_external",{url:"https://example.com"})` is rejected too. Only `quick_capture` works.
- [ ] In the capture window, `location = "https://example.com"` does nothing (navigation lock).
- [ ] **Open Prism** shows and focuses the main window. Closing the main window (red button, Cmd-W) hides it instead of quitting; the tray still works; clicking the Dock icon brings it back.
- [ ] Tray **Sign out** signs out exactly like **Prism → Sign Out** (§6): sign-in screen, keychain item gone, device revoked.
- [ ] **Quit Prism** (and Cmd-Q) exits the app completely, and the window position is saved.

### 8b. Global shortcut

- [ ] **Cmd-Shift-Space**, from any other app, opens the capture window.
- [ ] In `client-settings.json` set `"quickCaptureShortcut": "Alt+Shift+K"`, relaunch: the new shortcut works, and the old one doesn't.
- [ ] Set it to `""`: relaunch, and no shortcut opens the window (the tray still does).
- [ ] Set it to `"Space"` (no modifier) or `"nonsense"`: the app still launches, and the log shows "ignoring quickCaptureShortcut…".

### 8c. Notifications

- [ ] Start an agent chat turn, then switch to another app before it finishes. When the turn ends, a native notification "Prism agent finished" appears (generic text, no reply content).
- [ ] With the Prism window focused, a finishing turn shows **no** notification.
- [ ] Click the notification: Prism comes to the front and opens **Agent chat on that session** (no page reload, no navigation).
- [ ] Wait more than a minute after a notification, then refocus Prism by hand: it does **not** jump to the session.
- [ ] A turn that errors shows "Prism agent hit an error".
- [ ] In the console (main window): `__PRISM_SHELL__.notify("<b>hi</b>", "x".repeat(5000))` from another focused app shows plain "hi" with no HTML, and the body is cut at about 240 characters. Calling it twice in under 1.5 s shows only one.

### 8d. Export

- [ ] Open a document note. **File → Export Note as Markdown…** (Cmd-Shift-E) opens a native save panel pre-filled "<title>.md".
- [ ] Save to Desktop: the file contains Markdown (headings as `#`, lists as `-`), and a toast says "Exported <name>".
- [ ] **Export Note as HTML…** writes a standalone `.html`. Open it in a browser: it renders, and the page source has the `Content-Security-Policy` meta tag.
- [ ] Cancel in the panel: nothing is written, and no error is shown.
- [ ] With no note open (e.g. on Agent chat): a toast says "Open a note first, then export it."
- [ ] A title like `../../x` or `a/b` is pre-filled as a safe file name (no slashes).
- [ ] In the console, `__TAURI_INTERNALS__.invoke("export_note",{content:"x",suggestedName:"y",format:"md",path:"/tmp/evil"})` only opens the panel. The extra `path` is ignored, and nothing is written to `/tmp/evil`.

### 8e. Drag-drop

- [ ] Drop a `.md` file on the window: a note is created under `vault/imports/<today>/…`, opens, and renders as a document. A toast says "Created 1 note…".
- [ ] Drop a `.txt` file: it becomes a note with paragraphs preserved.
- [ ] Drop a `.png` or `.pdf`: a toast says "Attachments aren't supported yet (…)" and nothing is created or uploaded.
- [ ] Drop a `.md` file larger than 1 MB: skipped with "Too large (1 MB max per file)."
- [ ] Drop 12 small `.md` files: 10 notes are created and the rest are reported as skipped.
- [ ] Drop a folder: "Folders aren't supported."
- [ ] Drop a mix (`.md` + `.png`): the `.md` becomes a note, and the `.png` is reported.
- [ ] Signed out: dropping files creates nothing.
- [ ] Network tab (dev build): no upload of binary files at any point.
