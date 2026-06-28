# Onboarding & Setup

This is the end-to-end path to stand up Prism: a Parachute vault, the Prism Server
gateway, and your first sign-in to the web app. It targets the **operator** (the person
who runs the home server), who is almost always also the **owner** (the full-access
admin account).

For the runtime architecture, see [`CLAUDE.md`](../CLAUDE.md) → *Prism Server & Web
Sharing*. For publishing public Wikis see [`publishing.md`](./publishing.md); for
Parachute-to-Parachute federation see [`federation.md`](./federation.md).

---

## 1. Install and run Parachute

Prism never touches SQLite directly — it talks to a **Parachute vault** over HTTP
(default `http://localhost:1940`). Install Parachute and make sure the vault is reachable
before you run setup, because the setup script seeds tag schemas into it.

Mint a long-lived vault token for the server to use (Parachute 0.5.x issues hub JWTs;
the old `pvt_*` opaque tokens are rejected):

```bash
parachute auth mint-token --scope vault:default:write --expires-in 31536000
```

Copy the printed token — the setup script will ask for it as `PARACHUTE_TOKEN`.

---

## 2. Run `prism setup` (secrets + `.env` + tag seeding)

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

- **Public https origin** (`APP_ORIGIN`) — your tunnel hostname, e.g.
  `https://prism.example.com`.
- **Owner email** (`OWNER_EMAIL`) — the full-access admin; this is the only account that
  can use the magic-link sign-in.
- **Parachute URL / vault name** (`PARACHUTE_URL`, `PARACHUTE_VAULT`) — defaults
  `http://localhost:1940` / `default`.
- **Parachute vault token** (`PARACHUTE_TOKEN`) — the token from step 1 (required).
- **Resend API key** (`RESEND_API_KEY`, optional) — for emailed magic links / invites.
  With no key, links are logged to the server console (dev only).
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

## 3. (Optional) Install the `prism-setup` Claude plugin / skill

If you use Claude Code, the **Prism Setup** skill (`.claude/skills/prism-setup/`) drives
the same idempotent seed (and, only when asked, creates a starter dashboard + index
note). Install via `/plugin install` and invoke the skill; it reads vault config from
`apps/server/.env` and always recommends a `--dry-run` before applying. It edits
`tag-schemas.json` as the source of truth — never the vault directly.

---

## 4. Sign in to the web app

Auth is **invite-only with passwords** — there is no open self-signup.

1. **Owner bootstrap (magic link).** The owner (`OWNER_EMAIL`) requests a magic link at
   the sign-in screen. Magic-link sign-in is **owner-only**, gated at both
   `/auth/request` and `/auth/callback` — it is the bootstrap/recovery path, safe because
   the owner controls that inbox. If Resend isn't configured, the link is logged to the
   server console.
2. **Invite everyone else.** Once signed in, the owner issues an invite (single-use,
   hashed, 7-day). The recipient registers a password account at
   `/accept-invite?token=…` and then logs in with email + password at `/auth/login`.
   Sharing by email auto-invites, so a grant always binds to a real authenticated
   account, not a bare email address.

A signed-in **non-owner with no grants sees nothing**: empty `/api/notes`, 403 on notes
and the graph. Authentication never implies authorization.

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
