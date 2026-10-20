# Onboarding & Setup

This is the end-to-end path to stand up Prism: a Parachute vault, the Prism Server
gateway, and your first sign-in to the web app. It targets the **operator** (the person
who runs the home server), who is almost always also the **owner** (the full-access
admin account).

For the runtime architecture, see [`CLAUDE.md`](../CLAUDE.md) → *Prism Server & Web
Sharing*. For publishing public Wikis see [`publishing.md`](./publishing.md); for
Parachute-to-Parachute federation see [`federation.md`](./federation.md).

There are two paths. **Have your agent do it** (a host install on a Mac) is the one for
everyone; **By hand** (a checkout of this repository) is for developing Prism itself.

---

## Have your agent do it (recommended)

Download the host bundle (`prism-host-<version>-darwin-arm64.tar.gz`), unpack it, and ask
Claude Code (or another agent with this repository's skills) to "set up Prism". The
`prism-setup` skill drives one command:

```bash
./prism-host-*/bin/prism setup --dry-run --json     # what it would do; changes nothing
./prism-host-*/bin/prism setup --json               # do it
prism setup --json --from <step>                    # resume after doing what a step asked
```

`prism setup` is one resumable run. Every step checks before it acts, so it is safe to stop at
any point and to run again; a second run changes nothing. The steps, in order:

1. `machine` — this Mac can host Prism (macOS 14+, Apple silicon, the port free, disk).
2. `install` — the host bundle goes to `~/Library/Application Support/Prism/Host` and runs as a
   launchd user agent. The first time it asks for the owner's email (your sign-in name).
3. `vault` — Parachute is running. If it is not installed, the agent asks you, then installs bun
   and Parachute with your yes; Prism then runs Parachute under its own launchd agent (an existing
   Parachute install is reused as it is). You run one command yourself in Terminal,
   `parachute auth set-password` (it asks for an admin password, which the agent never sees).
4. `secrets` — the server's secrets are generated into its `.env` (0600). An existing
   `SECRETS_KEY` is never replaced.
5. `vault-token` — the server's vault token is minted by `prism token mint` **straight into the
   `.env`**. It is never shown, so it never lands in the conversation. `prism token rotate`
   replaces it later; `prism token status` says when it expires.
6. `schemas` — Prism's tag schemas are seeded into the vault (additive, never destructive).
7. `server` — the server starts.
8. `owner` — a one-time sign-in link opens in your browser on this Mac (no email needed); you
   sign in and set a password.
9. `mac-client` — install Prism Client for Mac and enter the server's address.
10. `device` — sign a phone in (the checklist shows how).
11. `reachable` — an https address your phone can open, with Tailscale (`prism reach`).
12. `integrations` — optional: mail, calendar, messages, transcripts. Entered in the app, never
    in the chat.

From step 8 on, the run reads the same checklist the app shows (Workspace settings → Server),
under the same step ids, so the agent and the app always agree. Each step that needs you says
exactly what to do; the agent asks you only there. Commands, the JSON events and exit codes:
[`host-bundle.md` § Setup run](host-bundle.md#setup-run-prism-setup).

---

## By hand (a checkout)

From a clone of this repository, run by you in a terminal. Never paste a token into a chat with
an agent: type it where the setup script asks for it.

## 1. Install and run Parachute

Prism never touches SQLite directly — it talks to a **Parachute vault** over HTTP
(default `http://localhost:1940`). Install Parachute and make sure the vault is reachable
before you run setup, because the setup script seeds tag schemas into it.

Mint a long-lived vault token for the server to use (Parachute 0.5.x issues hub JWTs;
the old `pvt_*` opaque tokens are rejected):

```bash
parachute auth mint-token --scope vault:default:write --expires-in 31536000
```

The command prints the token: copy it into the setup script's prompt below
(`PARACHUTE_TOKEN`). A host install never shows it — `prism token mint` writes it into the
`.env` itself.

---

## 2. Run `prism-setup.ts` (secrets + `.env` + tag seeding)

From `apps/server`, run the one-shot provisioner. It generates the server secrets,
writes `apps/server/.env` (chmod 600), and idempotently seeds the canonical tag schemas
into the vault:

```bash
cd apps/server
node --import tsx scripts/prism-setup.ts            # interactive
node --import tsx scripts/prism-setup.ts --dry-run  # preview the .env + dry-run the seed (no writes)
node --import tsx scripts/prism-setup.ts --force    # overwrite an existing .env (rotates secrets)
```

It prompts for:

- **Address** (`APP_ORIGIN`) — default `http://localhost:8787`; change it later when you set
  up remote access (§ 5).
- **Owner email** (`OWNER_EMAIL`) — the full-access admin; this is the only account that
  can use the magic-link sign-in.
- **Parachute URL / vault name** (`PARACHUTE_URL`, `PARACHUTE_VAULT`) — defaults
  `http://localhost:1940` / `default`.
- **Parachute vault token** (`PARACHUTE_TOKEN`) — the token from step 1 (required).
- **Resend API key** (`RESEND_API_KEY`, optional) — for emailed invitations and the
  owner's emailed recovery link. Not needed to sign in: the owner uses `prism signin`
  (§ 4), and an invitation is a link the owner can copy from the app.
- **Magic-link From address** (`MAGIC_FROM`) — defaults to `Prism <login@<apex-domain>>`.

It auto-generates `SESSION_SECRET`, `CAPABILITY_SECRET`, and `COLLAB_TOKEN`, and writes
`PORT=8787`, `DB_PATH=./prism-server.db`, and `WEB_ROOT=../web/dist`.

### Tag seeding (idempotent, never destructive)

After writing `.env`, setup runs `seedTagSchemas()`
(`apps/server/scripts/lib/seed-tag-schemas.ts`). The single source of truth is
`packages/core/src/lib/schemas/tag-schemas.json`; only each tag's **description** and
**fields** are pushed to the vault (the `contentType`/`precedence` keys are Prism-side
renderer concerns and are not seeded). The safety contract:

| Vault state | Action |
|---|---|
| tag absent | create with description + fields |
| tag present, missing a field the JSON declares | **add** that field only |
| tag present, empty description | fill the description |
| existing field def / non-empty description | **never** overwritten |
| already complete | unchanged (no write) |

Because it is additive-only, you can re-run setup (or just the seed) any time you add
tags/fields to `tag-schemas.json`. Always `--dry-run` first.

> If the vault is unreachable when you run setup, the secrets/`.env` are still written;
> the script tells you to re-run the seed once the vault is up.

### Point the desktop app at the server (optional)

Setup prints the next step: add `collab_url` (`ws://localhost:8787/collab`) and the
generated `collab_token` to the desktop config
(macOS: `~/Library/Application Support/prism/prism-config.json`) so the desktop app's
edits sync through the server and it can drive sharing.

Then build and start:

```bash
npm run build -w @prism/web
cd apps/server && npm start
```

---

## 3. (Optional) The `prism-setup` skills on a checkout

The **Prism Setup** skills (`.claude/skills/prism-setup*/`) are written for the host
install's `prism setup` (above). On a checkout they still explain each step by its id
(`prism-setup-schema` re-seeds with `npm run seed`, `prism-setup-server` covers this
`.env`), and the setup checklist's "Have your agent do it" prompts name the same ids.
`tag-schemas.json` stays the source of truth — never the vault directly.

---

## 4. Sign in to the web app

Auth is **invite-only with passwords** — there is no open self-signup.

1. **Owner bootstrap: a local sign-in link, no email needed.** On the server's own
   computer, run `prism signin` (host install) or `npm run signin -w @prism/server` (a
   checkout, with the server running). It opens a **one-time link** in the default browser:
   single use, valid 10 minutes, signs in `OWNER_EMAIL` and nobody else, and is accepted
   only on a direct loopback connection — never through the tunnel, Tailscale or the LAN.
   The browser lands on the setup checklist (Workspace settings → Server); an owner with no
   password is asked to set one first (a phone or another computer signs in with it).
   - *How the CLI proves it is on this computer:* at every start the server writes a fresh
     random **host key** to `host-signin.key` beside its database (0600, in its 0700 data
     folder; `HOST_KEY_FILE` to move it). `POST /auth/local/link` mints a link only for a
     loopback connection (the socket's own address), with no proxy header, a loopback
     `Host` on the server's port, no browser headers (`Origin`, `Sec-Fetch-Site`, cookies),
     and `Authorization: Bearer <host key>`. Only the link token's SHA-256 is stored; a new
     link retires the previous one; both mint and use are rate-limited and audited
     (`auth.local-link`, `auth.local-signin`, ids only). `GET /auth/local/signin?token=…`
     spends it (loopback only, the same checks) and sets the ordinary owner session.
   - The link is a credential for its 10 minutes: never paste it into a chat.
     `prism signin --print` prints it instead of opening it, for a headless Mac only.
   - **Magic link (optional recovery).** With Resend configured, the owner can still
     request an emailed link at the sign-in screen. It is **owner-only**, gated at both
     `/auth/request` and `/auth/callback`. Without Resend the link is logged to the server
     console (dev only) — `prism signin` is the way in.
2. **Invite everyone else.** Once signed in, the owner issues an invite (single-use,
   hashed, 7-day). The recipient registers a password account at
   `/accept-invite?token=…` and then logs in with email + password at `/auth/login`.
   Sharing by email auto-invites, so a grant always binds to a real authenticated
   account, not a bare email address.

A signed-in **non-owner with no grants sees nothing**: empty `/api/notes`, 403 on notes
and the graph. Authentication never implies authorization.

### Pair your phone (QR code)

Once the server has an https address (the checklist's "Reachable from other devices"
step), the checklist's **"An app is signed in"** step offers **Pair a phone**:

1. Install Prism on the iPhone or iPad. Don't type anything in it.
2. On the Mac, press **Pair a phone**. A QR code appears; it works once, for 5 minutes.
3. Point the phone's **Camera** at it and tap the Prism banner. Prism asks
   "Pair with this Prism Server?" and names the address — tap **Pair** only if it is yours.
4. The phone shows a 4-digit code. Type it on the Mac and press **Approve**.

The phone is now signed in, like any other device: it is listed (and can be removed) under
Settings → Account → Signed-in devices. Once one device is signed in, a second phone must be
approved from that device (the Prism app), not from a browser. Details:
[`native-auth.md` § Pairing](native-auth.md#pairing-a-phone-with-a-qr-code-decision-d-g).

### Viewer-skip behavior (web skips the desktop wizard)

The first-run **onboarding wizard** in `@prism/core` (`App.tsx`, gated by the
`skipOnboarding` prop) is **Tauri-only** — its steps call `invoke()`, which doesn't exist
in the browser. So the web shell (`apps/web/src/main.tsx`) **skips the wizard by default
for everyone** — capability viewers, invited non-owners, and even the owner (web setup is
the desktop/CLI's job). Concretely, `main.tsx` sets `isViewer = true` and passes
`skipOnboarding={isViewer}` to `<App>`.

The one exception is the env flag **`VITE_WEB_OWNER_ONBOARDING`**: build the web app with
`VITE_WEB_OWNER_ONBOARDING=true` and a genuine **owner** session will see the onboarding
flow (`isViewer = !(allowOwnerOnboarding && me.isOwner)`). This is reserved for a future
web-native owner flow; leave it unset for normal deployments.

---

## 5. Reach it from your phone (`prism reach`)

The server answers on its own computer first (`http://localhost:8787`). A phone needs an
https address. With a host install, Tailscale is the default (private; no domain, nothing on
the router):

```bash
prism reach status              # is Tailscale installed, signed in, HTTPS certificates on?
prism reach tailscale --dry-run # the exact commands
prism reach tailscale           # serve Prism's port on https://<machine>.<tailnet>.ts.net,
                                # set APP_ORIGIN to it, restart, check it from this Mac
prism reach funnel --yes        # opt-in: the same address on the public internet
prism reach off                 # undo: nothing served, APP_ORIGIN back to localhost
```

Installing Tailscale (on the Mac and the phone, same account) and signing in are yours to
do; `prism reach status` says what is missing. Only Prism's port is served — never the
vault or the hub. Then open the address on the phone and sign in with your password: the
checklist's **reachable** step ticks when that request from another device arrives (the
check from the Mac itself only proves the name, certificate and proxy). What is checked
and what it proves: [host-bundle.md § Reachability](host-bundle.md#reachability-prism-reach).
A Cloudflare tunnel on your own domain also works (set `APP_ORIGIN` to it; the step ticks on
the first request through the tunnel).
