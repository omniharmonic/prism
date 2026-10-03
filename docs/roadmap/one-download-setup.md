# One-download setup: the Prism app hosts the server

Status: **design proposal**, 2026-10-02. Nothing here is built yet. Scope: macOS host mode, phone pairing, and the iOS pieces they touch.

Owner's goal: *"Download one app, have it help set up the server on the desktop, and then link the mobile app to your server."*

Decisions already made by the owner:
- The macOS app is signed with Developer ID, notarized, shipped directly and auto-updated.
- The iOS app is "Prism", shipped through TestFlight first, with bundle ids in the `com.benjaminlife.prism.*` family.
- Face ID on iOS is configurable.
- Prism stays invite-only and multi-user, and the server stays the single trust boundary that holds vault credentials.

## Decisions at a glance

| # | Decision | Recommendation |
|---|---|---|
| D-A | Shape of "the app hosts the server" | **One app, `Prism.app`** (today's Prism Client plus an optional **Host mode**). A small signed Rust supervisor, `prism-host`, ships inside the bundle and is registered as a **launchd user agent through `SMAppService`**. It is not pm2 and not a second app. |
| D-B | How the server and Parachute get onto the Mac | **Bundle them.** Pinned Node and bun runtimes, a prebuilt server bundle, the web `dist`, and a pinned Parachute payload, all inside the notarized app. Nothing executable is downloaded at first run. |
| D-C | Where data lives | `~/Library/Application Support/Prism/Host/` for new installs. An adopted install keeps its data where it is. |
| D-D | Secrets | Host bootstrap secrets live in the **data-protection Keychain**, team-scoped access group. They are injected into the server's env at spawn and are never in a file. An encrypted **Recovery Kit** is the backup path. |
| D-E | Owner bootstrap without email | A **host-control Unix socket** (0600, never TCP), used only by the Prism app on the host Mac. It mints the Mac's own device token and sets the owner's first password. Magic link stays owner-only. Invites stay the only way in for everyone else. |
| D-F | Reachability default | **Tailscale.** Private `tailscale serve` by default; one toggle turns on Funnel for collaborators without Tailscale. Cloudflare Tunnel on your own domain is the "advanced" path, and it is today's production setup. LAN-only is for testing. The hub and vault are **never** exposed. |
| D-G | Phone pairing | **QR → one-time pairing code → approve on the Mac.** It is a reversed device-authorization grant that ends in the *same* `pd_` device token as PKCE. "Enter server address" + PKCE in `ASWebAuthenticationSession` remains the fallback and the collaborator path. |
| D-H | iOS redirect | `prism://auth/callback` captured by `ASWebAuthenticationSession`. Universal links can't work for arbitrary self-hosted domains (see §6). |
| D-I | APNs for self-hosters | The owner's server sends APNs directly. Other people's servers need a **ids-only push relay** run by the publisher, because the `.p8` key is the publisher's secret. This is phase 2. |
| D-J | Updates | Tauri updater with **minisign-signed artifacts on GitHub Releases**. The bundled server updates *with* the app, atomically, behind a pre-update backup and a health-check rollback. |
| D-K | Owner migration | **Adopt first** (monitor only, zero risk), **then Managed** (the app replaces pm2 for `prism-server`, with the same DB, same vault and same tunnel). Parachute stays on its own launchd unit for the owner. |
| D-L | First TestFlight | It **does not wait for host mode**: an iOS shell, "Enter server" + PKCE to `prism.omniharmonic.com`, Keychain and Face ID. Zero server changes. |

---

## 0. Today's stack (what this builds on)

- **Server.**
  - `apps/server` is a Node 22 + Hono + better-sqlite3 home-server, started with `node --env-file=.env --import tsx src/index.ts` (`apps/server/package.json`).
  - It binds `127.0.0.1` by default (`config.ts` `bindHost`).
  - It fails fast without `PARACHUTE_TOKEN`, `SESSION_SECRET` or `OWNER_EMAIL` (`config.ts` `assertConfig`).
  - Schema migrations are additive and run in place at boot (`db.ts`), so there are **no down-migrations**.
  - It serves the PWA from `WEB_ROOT`.
  - In production it runs under pm2 `prism-server`, exposed by pm2 `prism-tunnel` (cloudflared) at `https://prism.omniharmonic.com`.
- **Setup.**
  - `apps/server/scripts/prism-setup.ts` (and the older `bootstrap.sh`) generate `SESSION_SECRET`, `CAPABILITY_SECRET`, `COLLAB_TOKEN` and `GOVERNANCE_SIGNING_SECRET` and write a 0600 `.env`.
  - The owner has to mint and **paste** the vault JWT by hand (`parachute auth mint-token --scope vault:default:write --expires-in 31536000`).
  - Setup seeds tag schemas with an ephemeral admin token (`tryMintEphemeralAdminToken` → `execFile("parachute", …)` in `src/mcp-token.ts`, so it depends on `PATH`).
  - Not covered by setup: `SECRETS_KEY`, VAPID keys, any APNs key.
  - Docs: `docs/onboarding.md`, `docs/runbook/new-instance.md`. The validated fresh-instance run is `docs/runbook/fresh-instance-e2e-2026-06.md` ("Resend is optional — read the magic link from the console").
- **Auth.**
  - The owner signs in by magic link, and only the owner can. Everyone else needs an invite, then a password.
  - Native clients sign in through RFC 8252 + PKCE device tokens (`pd_…`, SHA-256 at rest, 90-day sliding expiry, 365-day cap), via `/auth/device/*` (`docs/native-auth.md`, `src/auth/device.ts`, `src/routes/device.ts`).
  - `DEVICE_REDIRECT_URIS` defaults to `prism://auth/callback`. `NATIVE_ORIGINS` defaults to `tauri://localhost,http://tauri.localhost`.
  - The loopback "owner token" path is gated by `TRUST_LOCAL` plus a forwarding-header heuristic (`src/auth/local.ts`). It is weak by its own admission.
- **Prism Client.**
  - `apps/client` (`com.benjaminlife.prism.client`, product name "Prism Client") has 8 IPC commands, PKCE over a loopback redirect, and a Keychain token (`secure_store.rs`, still in the file-based keychain until L3).
  - It reads its origin from `client-settings.json`, and the CSP is built from that origin at startup (`origin.rs`).
  - The iOS arm is stubbed: `#[cfg(mobile)]` in `signin.rs`. The WP5 notes are in `docs/client-app.md` § "What WP5 adds".
- **Push.** Web Push only today, to the server owner, with ids-only payloads (`docs/push.md`). APNs is WP5.3 (`docs/roadmap/architecture-v2/WORKPLAN.md`).
- **Parachute 0.7.19.**
  - It is a bun TypeScript CLI (`~/.bun/bin/parachute → @openparachute/hub/src/cli.ts`).
  - `parachute serve` runs the hub on :1939 *plus an in-process supervisor* that spawns modules (vault on :1940) and crash-restarts them. `parachute init` normally wraps it in its own launchd unit.
  - `serve` honours `PORT`, `PARACHUTE_HOME`, `PARACHUTE_HUB_ORIGIN` and `PARACHUTE_INITIAL_ADMIN_USERNAME/PASSWORD`.
  - `install`/`upgrade` run `bun add -g` from npm at runtime.
  - `expose tailnet` is "supported"; `expose public` is "exploratory" (from `parachute --help`, `serve --help`, `expose --help`, `install --help`).
- **Host-local dependencies the server shells out to.**
  - `claude` (agent runner, hardened, env allowlist, empty cwd `~/.prism/agent-cwd`).
  - `gog` (Google OAuth in the login keychain, so it works only in a GUI session).
  - LM Studio (:1234).
  - Proton Mail Bridge (loopback IMAP/SMTP, pinned cert).
  - Matrix + mautrix bridges in colima/docker (pm2 `bridge-watchdog`).
- **Backups.** `scripts/backup-parachute.sh` makes online SQLite backups of the hub, vault and `prism-server.db` together. That matters: `governance_sig_ledger` makes the server DB part of governance trust.

---

## 1. Personas and journeys

### (a) Owner migrating the Mac mini

The mini already runs pm2 `prism-server` + `prism-tunnel`, a launchd-managed Parachute hub, LM Studio, Proton Bridge, colima bridges, and Prism Client.

1. **Download** `Prism.dmg` → drag to Applications. The app replaces "Prism Client" (same bundle id, so the Keychain token and settings carry over; see §2.8).
2. **Launch.** The app detects an existing client config, so it opens normally, signed in. It also detects a live server on :8787 and a hub on :1939, and shows a banner: *"This Mac is running a Prism Server that Prism isn't managing. [Monitor it] [Not now]."*
3. **Monitor (Adopt).** The app asks for the repo `apps/server` folder (an Open panel, read-only), reads `.env` *keys* (values are never displayed) and `/health`, and shows status in the menu-bar extra: server, hub, vault, tunnel, ingest health (`/acl/workers`). It changes nothing.
4. **Link your phone.** Settings → Account → Signed-in devices → **Link a phone** shows a QR (§5). The owner scans it with the iPhone app and approves on the Mac.
5. **Later — Take over (Managed)**, a deliberate step following the §7 runbook:
   1. *Back up* (one click).
   2. *Import secrets to Keychain*.
   3. *Stop pm2 prism-server* (the app shows the exact command, or runs `pm2 stop prism-server` after confirmation).
   4. *Start managed server*.
   5. *Health check*.
   6. *Done*, with a 24-hour "roll back to pm2" button.

### (b) New technical-ish user, one Mac + one iPhone

1. **DMG → Applications → Launch.** Welcome screen with two cards: **"Set up Prism on this Mac"** (Host) and **"Connect to an existing Prism"** (Client).
2. **Host → Requirements check.** macOS ≥ 13, ≥ 8 GB free disk, a warning if this is a laptop ("your phone can only reach Prism while this Mac is awake").
3. **Name and owner.** Workspace name, your name, your email. The email is your identity and recovery address; nothing is sent.
4. **Create a password.** This becomes the owner's password (§3.3), so the phone and browsers can sign in without email.
5. **Installing.** A progress list: *Starting Parachute → Creating your vault → Securing it (vault token) → Starting Prism Server → Seeding note types → Signing this Mac in*. Each item is a supervised step with retry. Typical time is under a minute; there are no downloads.
6. **Allow in background.** The macOS Login Items prompt ("Prism wants to run in the background") is explained beforehand: *"so Prism keeps running when you close the window."*
7. **Save your Recovery Kit.** An encrypted file (secrets + instructions) plus a passphrase that is shown once. The user can "Save to Files…" or skip with a hard warning.
8. **Reach it from your phone** (§4):
   - *Private (Tailscale)*: recommended. If the Tailscale app is missing, the app opens its download page; once Tailscale is signed in, Prism configures `serve` and shows `https://<mac>.<tailnet>.ts.net`.
   - *Public on your domain (Cloudflare)*: advanced, with a browser login handoff.
   - *Only on this Wi-Fi*: testing.
9. **Link your iPhone.** A QR code; the phone app scans it, the Mac shows *"Approve 'Sam's iPhone'? Check code 4 7 1 9"* → Approve, and the phone is in. Done screen: "Prism is running · Phone linked · [Invite someone] [Add integrations later]".
10. **Integrations (any time)** under Network → Server: Matrix, Google, Proton Bridge, ClickUp, transcripts, local models, Claude. These are skippable cards (§3.5).

### (c) Invited collaborator who never runs a server

1. Receives an invite link (`https://<server>/accept-invite?token=…`, by email when Resend is configured, otherwise pasted into a DM).
2. **On a phone:**
   1. Safari opens the accept page: set name + password.
   2. The success page shows **"Get the Prism app"** (TestFlight/App Store link) and **"Open in Prism"** (`prism://connect?server=<origin>`).
   3. In the app, the server is prefilled → **Sign in** → an `ASWebAuthenticationSession` sheet where the session cookie from Safari usually means a single "Approve" tap → done.
3. **On a Mac:** DMG → **Connect to an existing Prism** → paste the invite link or server address → system-browser PKCE (loopback) → done. They never see host mode.
4. **Phone from their Mac:** Settings → Account → Link a phone. The same QR flow works for any signed-in user, not only the owner.

---

## 2. Architecture: one app, two roles

### 2.1 Roles

- **Client role (always).** Today's Prism Client: the native web build, a device token, one server origin.
- **Host role (optional, per Mac).** `prism-host`, a Rust binary in `Contents/MacOS/prism-host`, is registered via `SMAppService.agent(plistName: "com.benjaminlife.prism.host.plist")` from `Contents/Library/LaunchAgents/`. It supervises up to three children:
  - `parachute serve` (bun), only in bundled-Parachute mode;
  - `prism-server` (node);
  - `cloudflared`, only in Cloudflare mode. Tailscale is the user's own app.

  The UI app talks to the supervisor over a private Unix socket and is not needed for anything to keep running.

**Why a supervisor and not three launchd agents.**
- Ordering: vault healthy → server.
- One place for coordinated maintenance: backup = stop server → snapshot → start; update = backup → swap → health → rollback.
- Shared health for the UI.
- One background-item entry for the user to approve.

**Why not pm2.** It is an npm global install that is not notarized, and it is a second process manager with its own resurrection state. Recreating pm2's `save`/startup semantics is less work than shipping it safely.

**Why not a separate "Prism Host" app.** Two downloads defeat the goal. Two update channels can skew. `SMAppService` already gives a bundled helper its own lifecycle independent of the UI.

**Considered and rejected for now: run Prism Server as a Parachute module** under Parachute's own supervisor. It is attractive because there would be one supervisor, but it ties Prism releases to Parachute's module/registry model and `bun add -g` install path, and Parachute's crash budget and logs aren't ours to tune. Revisit if Parachute grows an "external module" contract.

**LaunchAgent, not LaunchDaemon.**
- `claude` login, `gog` OAuth, Proton Bridge and LM Studio are all per-user and GUI-session.
- The CLAUDE.md gotcha "gog works under pm2 but not ssh" is exactly this.
- Consequence: the host needs that user logged in. A Mac mini host should use automatic login, or accept one login after each reboot. With FileVault, that is unavoidable, and it is the same as today's pm2.

### 2.2 How the runtime gets onto the Mac

| Option | Pros | Cons |
|---|---|---|
| **Bundle everything (chosen)** | Notarized end to end; works offline; the version set is tested together; the update is one atomic artifact | ~150–200 MB app; we re-sign third-party runtimes; Parachute needs an "embedded" mode |
| Download on first run (`curl bun.sh`, `bun add -g`, `npm i`) | Small DMG | Executables outside notarization and our signature; npm supply chain at install time on every user's Mac; version drift; fails offline. Rejected. |
| Adopt only (the user installs Node/bun/Parachute) | Zero packaging | That is today's runbook, not "one download". Kept **only** as the owner's adopt mode. |

Bundle contents (`Contents/Resources/host/`):
- `node`: official Node 22 LTS darwin-arm64 + x64 (universal), checksums verified against the signed `SHASUMS256`.
- `server/`: an esbuild bundle of `apps/server/src` into `server.mjs`, so `tsx` no longer compiles at runtime (startup gets faster, with no TS toolchain in production). Plus `node_modules` holding *only* the native addons (`better-sqlite3`), a `scripts/` bundle (`governance-sign-existing`, seed), and `web/` (`apps/web/dist`).
- `parachute/`: the `bun` binary + a vendored, lockfile-pinned global install of `@openparachute/hub` and `@openparachute/vault` at the versions this Prism release was tested with.
- `bin/parachute`: a shim that runs `bun …/cli.ts` with `PARACHUTE_HOME` set. It goes first on the server's `PATH`, and a new `PARACHUTE_CLI` override replaces the bare `execFile("parachute")` in `mcp-token.ts`.
- `cloudflared`: pinned and re-signed. It is only spawned in Cloudflare mode.

**Upstream ask (Parachute, blocks bundled mode).** An embedded/offline mode:
- modules resolved from a read-only payload path;
- `install`/`upgrade` refuse ("managed by Prism");
- no self-installed launchd unit;
- no writes into the package directory.

`serve` already has the env knobs (`PORT`, `PARACHUTE_HOME`, initial-admin seed). The WP-H1 spike verifies the rest.

### 2.3 Processes, ports, logs, sleep

- **Ports.** Hub 1939, vault 1940 (Parachute's canonical range), server 8787. All bind `127.0.0.1`. If a port is taken by a foreign process, setup stops with *"something else is using 8787"*; it never picks a random port silently, because the tunnel config and `APP_ORIGIN` depend on it.
- **Supervision.**
  - Exponential restart backoff (1 s → 60 s).
  - A crash-loop breaker: 5 crashes in 5 minutes → stop, notify, and mark the item red.
  - Children get `SIGTERM`, then `SIGKILL` after 10 s.
  - The server's env is built by the supervisor:
    - from the Keychain: secrets;
    - from `host.json`: non-secret config;
    - a fixed `PATH` (bundled bin, `~/.local/bin`, Homebrew, `/usr/bin`, `/bin`), because launchd's default `PATH` would hide `claude` and `gog`;
    - `TRUST_LOCAL=false`.
- **Logs.** `~/Library/Logs/Prism/{host,server,parachute,tunnel}.log`, rotated by the supervisor (10 MB × 5). **Export diagnostics** zips them through the server's existing scrubber patterns. Logs never go to the vault.
- **Sleep.**
  - While hosting, `prism-host` holds `kIOPMAssertPreventUserIdleSystemSleep` (the user can turn this off).
  - A closed MacBook lid still sleeps, so the wizard says plainly that a laptop host is "reachable while open".
  - The phone shows *"Your Prism host is offline — last seen 14:02"*, and the read-through cache keeps opened notes readable.
- **Health UI.** A menu-bar extra (works with the UI window closed) with one row each for Server / Parachute / Tunnel / Ingest, green/amber/red, backed by `GET /health`, the hub's `/health` and `/acl/workers`. Red rows offer a fix: restart, open log, re-authenticate tunnel.

### 2.4 Data layout (new installs)

```
~/Library/Application Support/Prism/Host/        0700
  host.json            non-secret config: ports, mode, APP_ORIGIN, reach mode, versions
  server/prism-server.db (+ -wal/-shm), media-cache/
  parachute/           PARACHUTE_HOME: hub.db, services.json, vaults/, operator.token (0600)
  agent-cwd/           AGENT_CWD (empty, 0700; the claude CLI keeps its own state in ~/.claude)
  backups/<UTC>-<label>/   coordinated snapshots (encrypted, see 2.5)
  rollback/            previous app version's host payload + pre-update DB snapshot
  run/control.sock     host-control socket (0600)
~/Library/Logs/Prism/
Keychain (data-protection, access group <TEAM>.com.benjaminlife.prism): secrets
```

### 2.5 Backups

- **Coordinated snapshot.** Pause the server (stop, ≤ 10 s), take online SQLite backups of `prism-server.db`, the hub DB and the vault DBs (the same method as `scripts/backup-parachute.sh`: `.backup`, then `journal_mode=DELETE`, then `integrity_check`), restart, and write a manifest with versions and sha256s.
- The server and vault are always snapshotted **together**, because the governance ledger and collab snapshots must match the vault.
- **Schedule:** daily at 03:30 local + before every update + manual. Keep 7 daily and 4 weekly.
- **Encryption:** every snapshot is encrypted (AES-256-GCM) with a key derived from the Recovery Kit, so a backup copied to iCloud Drive or an external disk leaks nothing on its own. An optional second destination folder holds copies.
- **Restore:** the app's *Restore from backup…* stops the host, swaps the data dir aside (never deletes it), restores, and starts.

### 2.6 Upgrades, migrations, version pinning, rollback

- The server and Parachute versions are **pinned per Prism release**. Parachute moves only when a Prism release has been tested against it, including vault-side data migrations (the 0.7.9 history change is the cautionary tale).
- Update sequence (`prism-host` drives it):
  1. verify the artifact (minisign + codesign);
  2. coordinated backup;
  3. stop children;
  4. copy the current host payload and DB snapshot to `rollback/`;
  5. install the new app bundle;
  6. relaunch the agent;
  7. the server runs its additive migrations at boot;
  8. health gate: `/health` ok, hub+vault ok, one authenticated self-request through the host socket, all within 120 s.
- **On failure:** restore the previous bundle *and* the pre-update DB/vault snapshot. Because migrations are forward-only, rolling back the binary alone is unsafe. Writes made after the update are lost, so the rollback window is the health gate plus a manual "Roll back" for 24 h, which warns about lost writes.
- **Version skew.** Add `GET /api/version` → `{server, apiLevel, minClientApiLevel}`. Clients on a lower `apiLevel` show "Update Prism"; a client that is too new for a server shows "Your Prism host needs an update". The phone (TestFlight) and a self-hosted server will drift, so this is required.

### 2.7 Uninstall

*Settings → Host → Remove Prism Host…*:
1. Offers a final encrypted backup.
2. Stops and unregisters the agent (`SMAppService.unregister`).
3. Optionally removes the Cloudflare tunnel and DNS route (Tailscale `serve` is reset).
4. Deletes the data dir only after a typed confirmation, then deletes the Keychain items.

Dragging the app to the Trash leaves the data. macOS then shows a dead background item, which the docs explain how to clear.

### 2.8 Identity, signing, notarization

- **macOS.** Product name **"Prism"** from the release that ships host mode. The bundle id stays **`com.benjaminlife.prism.client`**, so the Keychain token and settings survive the rename (`docs/client-app.md` already planned this "once the legacy app is gone").
  - The legacy `Prism.app` (`com.benjaminlife.prism`) must be archived first, because two bundles named Prism.app collide in /Applications. The WP4.3 runbook already archives it.
  - The launchd label is `com.benjaminlife.prism.host`.
  - **iOS:** `com.benjaminlife.prism.ios`.
  - Keychain access group: `<TEAM>.com.benjaminlife.prism`.
- **Hardened runtime + notarization.** Every Mach-O is signed with our Developer ID with a secure timestamp: `node`, `bun`, `cloudflared`, `prism-host`, and every `.node` addon. Notarization rejects unsigned nested code.
  - **Entitlements, per binary, minimal:**
    - `node` and `bun` need `com.apple.security.cs.allow-jit` (V8 and JavaScriptCore JIT). Add `allow-unsigned-executable-memory` only if the H1 spike proves it necessary.
    - **Never `disable-library-validation`.** Instead, sign `better-sqlite3.node` with our Team ID so library validation passes.
    - The UI app keeps today's entitlements plus `keychain-access-groups`. For a Developer ID app this needs an **embedded Developer ID provisioning profile** (owner action).
- **DMG.** Tauri's DMG step currently fails locally (deploy-topology memory). CI builds `.app` then `hdiutil`, notarizes and staples the DMG.
- `minimumSystemVersion` goes from 11.0 to **13.0** (`SMAppService`). Client-only use could stay at 11 through a feature check, but that isn't worth the matrix.

### 2.9 Auto-update

- Tauri updater (`tauri-plugin-updater`), with artifacts and `latest.json` on **GitHub Releases** (if the source repo is private, a separate public `prism-releases` repo or an R2 bucket; see the open questions). Ed25519 (minisign) signatures are checked against the public key compiled into the app, *in addition to* Apple codesign/notarization.
- **The self-hosted server can't be its own update source:**
  1. It is circular. The thing being repaired is what would serve the repair; a broken server can't deliver its fix.
  2. Trust. Every collaborator's client talks to *someone's* server; if servers served client binaries, compromising any one host would push code to every client that connects to it.
  3. Many servers. A client linked to two servers would have two "authorities".
  4. iOS can only update through TestFlight/App Store anyway.

  A server-side "update available" banner is fine as *information* (via `/api/version`), never as a source of binaries.
- The UI app checks on launch and every 6 h. `prism-host` checks daily on its own (a host Mac rarely has the UI open) and either notifies or, with "Install updates automatically (03:00)", runs the §2.6 sequence.

---

## 3. Secrets and the setup wizard

### 3.1 What gets generated, and where it lives

| Secret | Generated by | Stored | Notes |
|---|---|---|---|
| `SESSION_SECRET`, `CAPABILITY_SECRET` | wizard (48 B) | Keychain | Rotating logs everyone out / kills links. Not offered in the UI. |
| `SECRETS_KEY` | wizard (32 B) | Keychain | **New: setup generates it** (today it's manual). Without it, integration credentials can't be stored, so Network → Server integrations don't work. |
| `GOVERNANCE_SIGNING_SECRET` | wizard | Keychain | Signing from day one, matching `prism-setup.ts`. Never rotated by the app. |
| `PARACHUTE_TOKEN` | minted by the host via the bundled CLI (`vault:<v>:write`, 1 y) | Keychain | **Auto-rotated** 30 days before expiry: mint → store → restart → `revoke-token <old jti>`. |
| Hub admin password | wizard | Keychain | Seeded via `PARACHUTE_INITIAL_ADMIN_*` on first boot. The hub admin UI stays loopback-only. |
| `VAPID_*` | wizard | Keychain (private), `host.json` (public) | Web Push works out of the box. |
| `HOST_CONTROL_TOKEN` | wizard | Keychain | For the control socket (§3.3). |
| APNs `.p8`, `APNS_KEY_ID`, `APNS_TEAM_ID` | **owner only** (publisher) | Keychain on the owner's host | Never part of a generic install; see §6.4. |
| `COLLAB_TOKEN` | **not generated** in host mode | — | Legacy-desktop-only loopback owner path; leaving it unset shrinks the surface. |
| `RESEND_API_KEY` | optional, later | Keychain | Email is optional (§3.3). |

**Why the Keychain and not a 0600 `.env`.** Honestly, a same-user process can read either a file or a child's environment, so the Keychain is not a defence against same-uid malware (which can read the vault SQLite anyway). What it buys:
- secrets stay out of Time Machine, iCloud Drive and `~/dev` copies, and out of the repo tree that today sits next to `.env`;
- items are `ThisDeviceOnly` and non-synchronizable;
- the access group ties them to our Team ID, so they survive updates without prompts.

The supervisor reads them and passes them in the child env. The server keeps its env allowlist for `claude`, so no secret reaches agents. `host.json` holds only non-secret config. The Recovery Kit (an scrypt-wrapped JSON of all secrets + `host.json`) is the only portable copy and the only way to move to a new Mac without losing integration credentials (they are encrypted under `SECRETS_KEY`) and governance trust.

### 3.2 Vault + token (bundled Parachute)

The supervisor:
1. Starts `parachute serve` with `PARACHUTE_HOME=…/Host/parachute` and the admin seed.
2. Creates the vault `default`.
3. Mints the write token with the operator token.
4. Stores it.

The admin token for schema seeding is minted ephemerally (1 h) exactly as `seedTagSchemas` does today, through the `PARACHUTE_CLI` override. The **hub and vault are never exposed**; Prism MCP (`/mcp`) replaces any need for remote vault access.

### 3.3 Owner bootstrap without email: the host-control socket

Today the first owner sign-in needs a magic link (Resend or reading the server console). The design:

- In host mode the server additionally listens on a **Unix domain socket** `run/control.sock` (0600, owned by the user). It is not a TCP port, so the tunnel, Tailscale and the LAN can never reach it, whatever headers they add.
- Routes under `/host/*` exist **only** on that listener. They require `Authorization: Bearer <HOST_CONTROL_TOKEN>`.
  - `POST /host/owner/password {password}`: sets the **owner's first password**. Refused if one is already set unless a `{current}` password is given. This mirrors the device-token rule that a first password needs a trusted context.
  - `POST /host/owner/device {label}`: mints a `pd_` device token for **this Mac's Prism app** and returns it directly to the app (the Keychain store is the same as after PKCE). It appears in Signed-in devices as "This Mac (host)".
  - `GET /host/status`, `POST /host/backup`, `POST /host/maintenance {on}`: for the supervisor.
- **Invariants kept.**
  - The magic link stays owner-only and still works when Resend is configured, as the recovery path.
  - Non-owners still only arrive through invites, which are sent from the app (copy link) or by Resend.
  - The socket can only act for `OWNER_EMAIL`. It can never create accounts or invites.
- `TRUST_LOCAL=false` in host mode, so the header-heuristic loopback path is *off*. The socket replaces it with a real boundary.
- **Recovery** when the owner forgets the password: the host app → *Reset owner password* (control socket, after macOS user authentication with `LAContext` `.deviceOwnerAuthentication`). Physical access to the host Mac is the recovery factor, the same as the console link today.

### 3.4 Tag schemas

The seed runs automatically and idempotently (`seedTagSchemas`, additive-only) at setup and after every update. That fixes the "re-run the seed when tag-schemas.json grows" chore.

### 3.5 Integrations: later, skippable, existing routes

The wizard ends with a checklist. Every item uses the **existing write-only credential routes** (`PUT /api/integrations/<kind>`, `docs/credentials.md`) from the normal Network → Server UI. The host role adds only *detection* and *hand-off*:

| Integration | App can automate | Must hand off |
|---|---|---|
| Claude (`claude` CLI) | Detect binary + `claude auth status` (as `agent-billing.ts` does) | Install + `claude login` (Terminal one-liner, copyable) |
| LM Studio | Detect :1234, list models (`/api/agent/models`) | Install, download a model; memory warning on 16 GB machines |
| Google (`gog`) | Detect, list accounts, store the `google` credential | `gog auth` in Terminal (keychain OAuth; must be the GUI user) |
| Proton Mail Bridge | `detect-cert` + explicit pin confirmation (existing) | Install Bridge, sign in, copy the Bridge password |
| ClickUp / Fireflies / Fathom / GitHub / Notion | Store the key; test call | Create the key on the vendor's site |
| Matrix (+ bridges) | Store homeserver + token | Running Synapse/mautrix (docker) stays an expert setup outside host mode |
| Email delivery (Resend) | Store the key (Keychain); `MAGIC_FROM` via the existing `EDITABLE_ENV` guard | Domain verification at Resend |

Ingest flags (`PROTON_SYNC_ENABLED`, `CALENDAR_SYNC_ENABLED`, …) become host toggles that write `host.json` and restart the server. Shadow-first defaults are preserved; calendar `DELETE_MODE` can never be set to `delete` from the UI.

### 3.6 Where the wizard runs (security-relevant)

Host IPC (create secrets, start the server, read the control token) must **not** be reachable from the main window. The main window renders vault content, and the client docs already state that XSS there equals token theft.

So the wizard and the Host settings live in a **separate `host` window**:
- it loads a separate bundled page (`host.html`, built with the same design tokens);
- it has its own capability (`allow-host-*`), like the quick-capture window has today;
- it never renders vault content;
- its own CSP has `connect-src 'self' ipc:` only.

The main window gets no host commands. The UI is built by the frontend stream (Codex) on the existing Blue Sky tokens (`docs/roadmap/workspace-experience/DESIGN.md`), and backend/native provide the IPC contract.

---

## 4. Reachability from the phone

| Mode | Phone needs | Collaborators | TLS | Verdict |
|---|---|---|---|---|
| **Tailscale serve (private)** | Tailscale app, signed in | Must join or share the tailnet | Auto `*.ts.net` cert | **Default** for solo use; nothing public |
| **Tailscale Funnel** | Nothing | Just works | Auto, TLS ends on the Mac | **One toggle** when inviting people; no domain needed |
| **Cloudflare named tunnel** | Nothing | Just works | Cloudflare edge | **Advanced**: needs a domain on Cloudflare; today's production setup |
| Parachute `expose` | — | — | — | Not used: it exposes the **hub**, and Prism must expose only `:8787` |
| LAN only (`http://mac.local`) | Same Wi-Fi | Same Wi-Fi | None (needs `NSAllowsLocalNetworking`, iOS local-network prompt, non-`secure` cookies) | Testing only; not offered for iOS v1 |

**Why Tailscale is the default.** No domain purchase, nothing public until you choose, the phone works away from home, the setup steps are automatable (`tailscale serve --bg 8787`, `tailscale status --json` via the CLI inside Tailscale.app), and Parachute itself treats tailnet as its supported shape.

**Rules.**
- `APP_ORIGIN` is set by the chosen mode: the `ts.net` FQDN or your Cloudflare hostname.
- Changing the mode later warns that existing share links, publication URLs and paired devices point at the old origin. Device tokens survive, but the phone must "Change server address".
- CORS needs no change: `tauri://localhost` is already in `NATIVE_ORIGINS`.
- The Mac's own app uses `http://127.0.0.1:8787` while hosting (no hairpin through the tunnel; works offline). That is safe because `TRUST_LOCAL=false`: loopback grants nothing, and the device token authenticates.
- The server stays bound to 127.0.0.1 in every mode. `BIND_HOST=0.0.0.0` is used only in LAN mode.
- **Health:** the host checks its public origin every 5 minutes (`GET <APP_ORIGIN>/health` through the real path) and shows "Reachable from the internet / tailnet: yes / no (reason)".

---

## 5. Pairing the phone

### 5.1 Flow (owner or any signed-in user)

```
Mac (signed in, pd_ or session)        Server                                iPhone
POST /auth/pair/start ───────────────▶ pairing{id, codeHash, email, exp 5m}
◀── {pairingId, code, qr} ──
show QR: prism://pair?v=1&s=<origin>&c=<code>
                                                                   scan → verifier, challenge
                                       ◀── POST /auth/pair/claim {code, code_challenge, label, platform}
                                       status=claimed, checkCode=4 digits ──▶ {claimId, checkCode, interval}
GET /auth/pair/:id (long-poll) ◀── claimed: label "Sam's iPhone", checkCode 4719
"Approve Sam's iPhone? Check code 4719"   (phone shows the same 4719)
POST /auth/pair/:id/approve ─────────▶ status=approved
                                       ◀── POST /auth/pair/token {claimId, code_verifier}
                                       mint pd_ via device.ts ──────────────▶ {access_token: pd_…, device_id}
```

This is a reversed RFC 8628 device grant. The phone gets the **same `pd_` token** as PKCE (same table, lifetimes, revocation and Signed-in devices row, `paired_via: "qr"`).

### 5.2 Endpoints (new, under `/auth/*`, already in the SW denylist)

| Route | Auth | Behaviour |
|---|---|---|
| `POST /auth/pair/start` | session (+CSRF) or `pd_` | Creates a pairing for the *caller's* account: 128-bit code, SHA-256 stored, TTL 5 min, ≤ 3 open per user. Returns `{pairingId, code, expiresAt, qrPayload}`. |
| `POST /auth/pair/claim` | none | `{code, code_challenge (S256), label ≤ 80, platform}`. The first valid claim moves the pairing to `claimed` and returns `{claimId, checkCode, interval}`. **A second claim of the same code moves it to `contested` and voids it**; the Mac shows "Someone else used this code — start again". Rate limit: 10 per 10 min per IP + global; wrong codes count. |
| `GET /auth/pair/:id` | creator | Status (`pending/claimed/contested/approved/denied/expired`), claimed label, platform, checkCode, claim IP country (if known). Long-poll ≤ 25 s. |
| `POST /auth/pair/:id/approve` / `deny` | creator (+CSRF) | Only from `claimed`. |
| `POST /auth/pair/token` | none (PKCE) | `{claimId, code_verifier}` → `authorization_pending` / `slow_down` / `access_denied` / `expired_token`, or `{access_token, token_type, expires_in, device_id}` with `Cache-Control: no-store`. Single use; a replay revokes the minted token (same rule as device codes). |

### 5.3 Threat model

- **QR contents.** The server origin and the one-time code only. **Never** a token, session, email, vault name or anything that grants access by itself.
- **Shoulder-surfing / photographed QR.** An attacker who claims first is shown on the Mac by label, and the user's own phone gets "already used". If both claim, the pairing is `contested` and dies. Nothing completes without an explicit Approve on an already-authenticated device, and the 4-digit check code lets the user match the right phone.
- **Replay.** Codes are single-claim, the token step is single-use and PKCE-bound, and the TTL is 5 minutes.
- **Brute force.** A 128-bit code plus rate limits.
- **Phishing the approver.** The Mac UI shows the device label as a claim ("A device calling itself…"), the same wording as the consent page.
- **Scope.** A pairing can only mint a device for the account that started it. An admin cannot pair a phone into someone else's account.

### 5.4 Collaborators, several servers, revocation

- **Collaborators** pair from their own Mac/web session the same way, or use "Enter server address" → PKCE. The invite link can also start sign-in directly. `/auth/device/authorize` accepts an optional `invite=<token>`; when signed out, it parks the request and routes to `/accept-invite?token=…&next=/auth/device/continue` (`postLoginTarget` already honours exactly that path). So *accept invite → register → approve* is one browser-sheet flow.
- **Multiple servers** on iOS: a server list. Each server has its own Keychain item (account = origin, already the design) and its own read cache key. Switching reloads the webview, because the CSP is per origin.
- **Revocation:** Settings → Account → Signed-in devices (existing), plus "Sign out all other devices". A password change already revokes other devices. Revoking a device deletes its APNs registrations (§6.4).

---

## 6. iOS specifics

### 6.1 First run

**Welcome** → three choices: **Scan pairing code** (camera; QR → §5), **Enter server address** (validates `https://`, fetches `/health` and `/api/version`, then PKCE), **I have an invite link** (paste/open → §5.4). Then the Face ID prompt (§6.3) and notifications permission (only if the account is a server owner, since push is owner-only today). Then the app.

### 6.2 Sign-in redirect

The redirect is `ASWebAuthenticationSession` with `callbackURLScheme: "prism"` and `redirect_uri=prism://auth/callback` (already the server default). It lives in the `#[cfg(mobile)]` arm of `signin.rs` and reuses `pkce.rs`/`auth.rs` unchanged.

**Universal links are not viable** for self-hosting: the app's associated-domains entitlement is fixed at build time, and each user's server domain is unknown. `ASWebAuthenticationSession` delivers the callback to the *calling* session, not through LaunchServices, which neutralizes the scheme-hijack concern `native-auth.md` lists. Use the non-ephemeral session, so a recent Safari sign-in (for example, right after accepting an invite) means one tap.

### 6.3 Configurable Face ID

- **Settings → Security → Lock Prism with Face ID:** Off · On launch · **After 5 min in background** (default for server owners) · After 15 / 60 min · Every time. Plus a toggle **"Allow passcode fallback"** (default on).
- **Mechanism.**
  - Lock on: the device token's Keychain item is re-written with `SecAccessControl(kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence)`, or `.biometryCurrentSet` when fallback is off. A new enrolled face then invalidates it, which forces a re-pair; that is documented.
  - Lock off: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
  - Unlock = an `LAContext` evaluation that also releases the item. Changing the setting requires a successful evaluation first.
- **What it protects.**
  - The token, and so all server access.
  - The UI: a privacy shield view covers the webview when backgrounded, so the app-switcher snapshot shows nothing.
  - The app sets `com.apple.developer.default-data-protection = NSFileProtectionComplete`, so the WKWebView read cache and outbox are unreadable while the phone is locked.
- **What it doesn't protect:** the read cache while the phone is unlocked and the app is open, or a person who knows the passcode when fallback is on.
- **Sensitive actions** (live email/Matrix sends, a read-write agent turn) always re-prompt, whatever the setting. This is a client-side guard. Server-verifiable step-up (Secure-Enclave-bound tokens, DPoP-style) is future work.

### 6.4 APNs

- `POST /api/push/apns {deviceToken, environment: "production"|"sandbox", bundleId}`, authenticated with `pd_`. It is stored with `device_id`, cascades on device revoke, and `DELETE` removes it.
- TestFlight builds use **production** APNs.
- The payload is ids-only plus generic text (the existing privacy rule). A tap deep-links to `/agent/<sessionId>` through the existing `deeplink.ts` seam.
- The **owner's** server holds the publisher's `.p8` key (Keychain) and sends directly over HTTP/2.
- **Everyone else's server cannot**, because the key is the app publisher's secret. Phase 2 is a tiny **Prism Push Relay**:
  - a Cloudflare Worker holding the `.p8`;
  - servers register with an Ed25519 key generated at setup;
  - per-server rate limits;
  - it receives only `{apnsToken, opaque ids, generic category}`.

  Until the relay exists, persona (b) gets push only through the installed-PWA Web Push path.

---

## 7. Migrating the owner's existing setup

**Principles.**
- Never run two Prism Servers against the same DB/vault: workers would double-ingest.
- Back up before every step.
- Every step is reversible.
- Parachute stays exactly as installed (`~/.parachute`, its own launchd unit, upgraded with `parachute upgrade`). Host mode supports **external Parachute** (URL + token) as a first-class configuration, not only the bundled one.

**Steps (overseer + owner):**
1. **Adopt (monitor).** No process changes (§1a).
2. **Prepare.** Build the host release from the *same commit pm2 currently runs*, so the schema is identical and pm2 stays a valid rollback target. Run `scripts/backup-parachute.sh pre-host`.
3. **Import.** The app reads `apps/server/.env`:
   - secrets → Keychain;
   - non-secrets → `host.json`;
   - absolute `DB_PATH` → the existing `apps/server/prism-server.db`, **left in place**;
   - `AGENT_CWD` → kept at `~/.prism/agent-cwd` (moving it orphans `--resume` sessions);
   - `TRUST_LOCAL` → false; `COLLAB_TOKEN` → dropped (no legacy desktop remains after WP4.3; verify with `check-client-no-vault-token.sh`).

   It prints a diff of the effective config: keys only, never values.
4. **Cut over** (≈ 30 s blip):
   1. `pm2 stop prism-server`;
   2. start the managed server on :8787 (`prism-tunnel` keeps proxying to the same port);
   3. health gate;
   4. watch `/acl/workers` for one full ingest cycle.
5. **Soak 24 h, then** `pm2 delete prism-server && pm2 save`.
6. **Tunnel (optional, later).** Move cloudflared from pm2 to the supervisor, reusing the existing tunnel credentials JSON. Leave `bridge-watchdog` and colima on pm2; they are out of host mode's scope.
7. **Data move (optional, much later).** *Move data into Prism's folder* = a coordinated backup → restore into `Host/`.

**Rollback** (any time during the soak): `prism-host stop` (app → Host → Stop), then `pm2 start prism-server`. That works because the schema hasn't diverged. After the soak, rollback means restoring the pre-host backup if the managed server has applied newer migrations.

---

## 8. Security review of the design

**Local attack surface.**
- Loopback ports (1939/1940/8787) are reachable by *other macOS users* on the same machine. Each requires real credentials: hub admin password, vault JWT, Prism auth. `TRUST_LOCAL=false` removes the header-heuristic owner path.
- The control socket is 0600 inside a 0700 dir, plus a bearer: other users can't connect at all.
- Same-user processes can read everything (DB, Keychain items the user can approve, process env). That is unchanged from today and out of scope, so it is stated, not hidden.
- The CLAUDE.md "live actions" threat-model note still applies: a host-local process can act as "human".

**Keychain across updates.** Data-protection keychain + team access group means items are bound to Team ID entitlements, not to a binary hash, so updates don't prompt. A re-signed binary from a different team can't read them. This also closes client-app.md L3.

**Agent runner under the new layout.**
- `AGENT_CWD` must stay empty, 0700, and outside the data dir's writable subtrees that hold DB/backups. `agent-cwd/` is a sibling, and the runner's non-empty refusal still applies.
- The `claude` env allowlist is unchanged, so supervisor-injected secrets don't reach agents.
- The fixed `PATH` comes from the supervisor, not the user's shell.
- Agents can't read Keychain items: there are no built-in tools, and Keychain access requires our signed binary.

**Update channel integrity.**
- Two independent signatures (Apple notarization + minisign).
- The minisign private key is kept **offline** (owner's password manager + an offline backup). CI gets it only through a protected GitHub environment with required approval.
- Key loss means shipping a final update signed by the old key that carries the new public key; if the old key is lost outright, users must reinstall. That is documented, and it is why custody matters.
- HTTPS-only update URLs.
- Downgrades are refused (version must increase).

**Supply chain.**
- Node and bun are pinned with sha256s verified against the upstream signed checksums.
- Parachute packages are pinned by exact version + lockfile integrity, and vendored at build time (the npm registry isn't hit on users' Macs).
- `npm ci` from the lockfile; an SBOM (CycloneDX) is attached to each release.
- cloudflared is pinned and re-signed.
- Builds run in CI on GitHub-hosted macOS runners from a tagged commit; signing happens there, or on the owner's Mac for the first releases.

**Pairing.** See §5.3. The QR is worthless without an approval on an already-trusted device.

**What an attacker gets with the phone.**
- Locked phone: nothing. Keychain items are `ThisDeviceOnly`, and the file protection is Complete.
- Unlocked phone, Face ID lock on: the passcode (if fallback is enabled).
- Unlocked phone, lock off: everything that account can do until revoked. For the **owner**, that is the full vault passthrough plus agents and (if enabled) live actions. Hence the owner default "After 5 min" and the always-prompt for sensitive actions.
- Mitigation: revoke from any other device or from the host Mac's Signed-in devices. Tokens die after 90 idle days.

**Exposure.** Only `:8787` is ever exposed. The hub admin UI and the vault stay loopback. The SSRF-guarded media proxy, rate limits and the auth stack are unchanged.

---

## 9. Phased plan

Lanes: **B** = backend (`apps/server`), **N** = native (Tauri/Rust/Swift), **F** = frontend (Codex; wizard and host screens on the existing tokens), **O** = owner (Apple portal and decisions). Effort is in engineering days.

### Phase T — first TestFlight (does NOT wait for host mode)

| WP | Lane | Work | Accept | Effort |
|---|---|---|---|---|
| T0 | O | Apple: Developer Program active; App ID `com.benjaminlife.prism.ios`; App Store Connect app record + **API key** (for CI upload); Xcode on the build Mac | `tauri ios init` builds; an archive uploads | owner ½ |
| T1 | N | iOS target (WP5.0/5.1): settings in the app container, safe areas, keyboard | Simulator runs against a sandbox server | 3 |
| T2 | N | Sign-in (WP5.2): `ASWebAuthenticationSession` in `signin.rs` mobile arm; Keychain with access control; **Face ID setting** (§6.3); "Enter server" screen prefilled `https://prism.omniharmonic.com` | Device shows in Signed-in devices; revoke signs the phone out; lock modes behave | 4 |
| T3 | O | Owner sets a **password** (browser session → Account) so in-app sign-in needs no magic link | Password login works in the sheet | 0 |
| T4 | N+O | Signing + upload; internal TestFlight testers | Installed from TestFlight on the owner's iPhone | 1 |

**Server changes for Phase T: none.** `prism://auth/callback` and `tauri://localhost` are already defaults. **This is the minimal slice.**

### Phase P — pairing, push, version

| WP | Lane | Work | Accept | Effort |
|---|---|---|---|---|
| P1 | B | `/auth/pair/*` (§5.2) + tests (contested, replay, rate limits, scope); `GET /api/version` | Server test suite (via `npm test` only) green | 3 |
| P2 | F | "Link a phone" sheet (QR + approve with check code) in Account → Signed-in devices; version banners | Fixture journeys | 2 |
| P3 | N | iOS scanner + claim/poll/token; "I have an invite link"; `invite=` on authorize (B, ½ d) | Scan → approve → in, < 30 s | 2.5 |
| P4 | B+N+O | APNs (WP5.3): `.p8` in the owner host's Keychain, `/api/push/apns`, HTTP/2 sender beside Web Push, deep link; **owner creates the APNs key** | Lock phone, agent turn ends, tap opens the session | 4 |

### Phase H — host mode

| WP | Lane | Work | Accept | Effort |
|---|---|---|---|---|
| H1 | N+B | **Spike**: bundled node + bun + Parachute payload under hardened runtime; entitlements; Parachute embedded-mode gaps (report upstream); esbuild server bundle; `PARACHUTE_CLI` | A notarized test app boots hub+vault+server from read-only Resources | 4 |
| H2 | N | `prism-host` supervisor + `SMAppService` agent + logs + sleep assertion + menu-bar health | Kill -9 any child → restarts; crash-loop breaker trips | 5 |
| H3 | B | Host-control socket + `/host/*` (§3.3), `TRUST_LOCAL=false` host profile, token auto-rotation hook | Owner password + Mac device minted with no email; socket unreachable over TCP (test) | 3 |
| H4 | N+F | Setup wizard (separate `host` window + capability), secrets → Keychain, vault create/mint, schema seed, Recovery Kit | Persona (b) from DMG to signed-in Mac in < 5 min, offline | 6 |
| H5 | N | Reachability: Tailscale serve/Funnel automation, Cloudflare tunnel login handoff, public reachability probe | Phone reaches the host over tailnet and Funnel | 4 |
| H6 | N | Backups (coordinated, encrypted), restore, update sequence with health-gate rollback, uninstall | A forced bad update auto-rolls back with data intact | 5 |
| H7 | N+O | Release pipeline: CI build, sign, notarize, staple DMG, minisign, `latest.json`; Developer ID cert + Developer ID provisioning profile (keychain group) | Fresh Mac installs from the DMG with no Gatekeeper warning; the app updates itself | 3 |
| H8 | N+B | Adopt + Managed migration (§7), import of `.env`, external-Parachute mode | Owner's mini runs managed for 24 h with green `/acl/workers`; rollback rehearsed | 3 |
| H9 | B | Push relay (phase 2, §6.4) | A second server delivers APNs through the relay | 4 |

**Order and blockers.** T0 (owner) unblocks everything native on iOS. P1 is independent and can start now. H1 gates H2–H8, and its Parachute embedded-mode findings may need an upstream release. H8 needs H2+H3+H6. Host mode does not block any TestFlight build.

**Owner actions, collected.**
1. Confirm Apple Developer enrollment and Team ID.
2. Developer ID Application certificate.
3. App IDs (iOS; the macOS client id, registered for the provisioning profile).
4. A Developer ID provisioning profile with the keychain-access-groups entitlement.
5. App Store Connect app record and API key.
6. APNs auth key (`.p8`).
7. notarytool credentials.
8. Generate and store the minisign key pair.
9. Set an owner password.
10. Decide the release host (open question 2).

---

## 10. Open questions for the owner

1. **App Store name.** App Store Connect requires a globally unique app *name* even for TestFlight, and "Prism" is almost certainly taken. OK to register e.g. "Prism Workspace" (or "Prism — Notes & Agents") while the home-screen name (`CFBundleDisplayName`) stays **Prism**?
2. **Release host.** Is the source repo public? The updater needs unauthenticated downloads. If it's private: a public `prism-releases` repo (recommended), or a Cloudflare R2 bucket?
3. **Push for other people's servers.** Will you operate a small ids-only push relay (a Cloudflare Worker holding the APNs key) so self-hosters get notifications, or should non-owner servers stay Web-Push-only for now?
4. **Parachute embedded mode.** Can Parachute ship an offline/read-only "embedded" mode (no `bun add`, no self-installed launchd unit) on a short timeline? If not, bundled host mode slips, and v1 host mode would require a user-installed Parachute.
5. **Default reachability.** Is Tailscale-first acceptable as the default for new users, given that collaborators then need Funnel turned on? Or should the default be Cloudflare with a domain (which needs a domain purchase)?
