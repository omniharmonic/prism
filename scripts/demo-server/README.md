# App Review demo server (guideline 2.1)

A small Prism Server with made-up sample content and one reviewer account, so App Review can
sign in to the iPhone/iPad app (launch plan decision 7: a **separate macOS user on the Mini**,
running the host bundle, sample data only). Everything here is run by the **owner, on the demo
host, as the demo user**. Nothing in this folder is run against production, and nothing here
touches the production user's files, ports, launchd agents or tunnel.

| File | What it is |
|---|---|
| `demo.env.example` | the settings (ports, prefix, host name, accounts) — copy to `~/demo.env` |
| `install.sh [--dry-run]` | sets up the demo's own Parachute + `prism install` + token + start; idempotent |
| `reset.sh [--dry-run]` | wipe every note, reset the server's database, reseed, print a new reviewer password |
| `seed.mjs` / `seed-lib.mjs` / `content.mjs` | the seed (sample pages + reviewer) over the demo server's HTTP API |
| `parachute.plist.in` | the demo Parachute's launchd agent (rendered by `install.sh`) |
| `cloudflared.yml.template` | the demo's Cloudflare tunnel (template only) |
| `reviewer-notes.template.md` | the App Review notes text (no secrets) |

## Design

**Isolation from production.**
- **Another macOS user** (`prism-demo`, a *Standard* account — the scripts refuse an admin and
  refuse to run as anyone else). macOS keeps the production user's home (`0700`), Keychain and
  `gui/<uid>` launchd domain out of its reach; it never has the production vault token, hub admin,
  APNs key or tunnel credentials.
- **Its own ports**, all on `127.0.0.1`: Prism Server **18787**, Parachute hub **18939**, vault
  **18940**. Production's **1939 / 1940 / 8787** are refused by every script and by the seed
  (also when the demo's own `config/.env` names one).
- **Its own data**: install prefix `~/PrismDemo/Host`, Parachute home `~/PrismDemo/parachute`
  (never `~/.parachute`, never the default production prefix), its own vault `demo`.
- **Its own public name** (`demo.<your domain>`) through **its own tunnel**, run by the demo user.
- **Sample data only** (`content.mjs`, fictional; `apps/server/test/demo-server.test.ts` checks it
  and the whole folder against the public-snapshot personal-data patterns). No ingest, no agent,
  no push, no mail is configured on the demo server.

**Which Parachute, and why not `prism setup`.** Prism's stock fallback runs Parachute only on the
default ports (hub 1939, vault 1940 — `docs/host-bundle.md`, "Stock Parachute"), which production
uses; and `prism setup`'s vault step would find production's Parachute answering on `:1940` and
*reuse* it. So the kit **never runs `prism setup`**. It runs the same stock Parachute
(`@openparachute/hub@0.7.19`, `@openparachute/vault@0.7.9`, installed for the demo user) under its
own launchd agent with `PARACHUTE_HOME=~/PrismDemo/parachute`, `PORT=18939`, the vault's port in
`vault/config.yaml`, and loopback binding — then `prism install --parachute external` points the demo
server at it. **The issuer bug** (stock `auth mint-token` takes the issuer from
`<PARACHUTE_HOME>/hub/run/hub.port`, which `parachute serve` never writes, so a hub on a non-default
port mints tokens its own vault rejects) is handled the way the Parachute compatibility suite does:
`install.sh` writes `hub/run/hub.port` = `18939` **before** any token is minted, and rotates the
operator token once if it names another issuer.

**How the seed signs in.** Like `prism signin`: the host key the demo server keeps in its own data
folder (readable only by the demo user) buys a one-time owner link on loopback, spent on loopback.
`TRUST_LOCAL` stays off; no token is copied anywhere.

**The reviewer account** is a workspace **member** with edit access to the demo vault — not the
owner and not an admin — so App Review can try **Settings → Account → Delete account**
(guideline 5.1.1(v); the server owner cannot delete itself). `reset.sh` brings it back.

## Owner run steps (on the Mini)

1. **Create the user** (System Settings → Users & Groups → Add User): *Standard*, name
   `prism-demo`. Log in to it once in the GUI (Fast User Switching), so it has a login session —
   launchd user agents run only while the user is logged in. Keep it logged in (or enable
   automatic login for it only if the Mini's own policy allows that).
2. **As `prism-demo`** (its own Terminal in its GUI session — not `sudo -u`, launchd needs the
   user's own `gui/<uid>` domain):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ~/.bun/bin/bun add -g @openparachute/hub@0.7.19 @openparachute/vault@0.7.9
   mkdir -p ~/prism-host && tar -xzf prism-host-<version>-darwin-arm64.tar.gz -C ~/prism-host --strip-components=1
   cp -R <copy of this folder> ~/demo-kit          # scripts/demo-server from the release commit
   cp ~/demo-kit/demo.env.example ~/demo.env && chmod 600 ~/demo.env   # set DEMO_HOST
   bash ~/demo-kit/install.sh --dry-run            # read the plan
   bash ~/demo-kit/install.sh                      # stops once for the admin password:
   PARACHUTE_HOME=~/PrismDemo/parachute PARACHUTE_HUB_PORT=18939 ~/.bun/bin/parachute auth set-password
   bash ~/demo-kit/install.sh                      # again: hub agent, prism install, token, start
   ```
   The admin password is the demo Parachute's own (keep it in the owner's password manager); it
   is never production's.
3. **Tunnel**: `brew install cloudflared` if missing, then follow `cloudflared.yml.template`
   (a tunnel of its own, DNS `demo.<your domain>` → `http://127.0.0.1:18787`). Check from outside:
   `curl -s https://demo.<your domain>/health?live=1` → `{"ok":true,"live":true}`.
4. **Seed + reviewer**: `bash ~/demo-kit/reset.sh` (in a terminal). It prints the reviewer's email
   and a new password **once** — put them straight into App Store Connect → App Review Information
   → Sign-in required. Then paste `reviewer-notes.template.md` (with `<DEMO_HOST>` filled in) into
   the notes.
5. **Before each submission and after each review**: `bash ~/demo-kit/reset.sh` again and update
   the password in App Store Connect.
6. **Check it the way App Review will**: install the TestFlight build on a device, enter
   `https://demo.<your domain>`, sign in with the reviewer account, open the Welcome page.

`prism status --prefix ~/PrismDemo/Host`, `prism logs --prefix ~/PrismDemo/Host`,
`~/PrismDemo/parachute/logs/demo-parachute.log` for diagnosis. To remove it all: `prism uninstall
--prefix ~/PrismDemo/Host --delete-data --yes`, `launchctl bootout gui/$(id -u)/local.prism-demo.parachute`,
delete the plist and `~/PrismDemo`, then the user.

## What App Review sees

The app's first-run screen ("Enter your server") → `https://demo.<your domain>` → "Sign in to
Prism" → the server's sign-in page in a system sheet (email + password) → "Allow an app to sign in
as you?" → Approve → the workspace: a Welcome page with things to try, a "Launch plan" database
(table + board, four tasks), "A living workspace" (rich text, to-dos, a quote, code), two people,
two initiatives (another database) and meeting notes — all fictional. They can edit, comment,
create pages, search, see history and delete the account. They do not get the agent (server
owner only), integrations, or push notifications (none configured on the demo server).

## Not verified

None of this has been run on the Mini or as a second macOS user: the scripts were tested with
`--dry-run`, shellcheck, and the seed against the real server code over the in-memory fake vault
(`apps/server/test/demo-server.test.ts`). Unverified until the owner's first run: stock
Parachute 0.7.x honouring `vault/config.yaml`'s port under the hub supervisor (the compat suite
relies on the same), `auth set-password` writing an operator token with the right issuer once
`hub.port` exists (the script rotates it otherwise), launchd agents of a second logged-in user on
the Mini, and the tunnel.
