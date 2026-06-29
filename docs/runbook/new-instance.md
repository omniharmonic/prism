# Runbook — stand up a new Prism instance (and connect/federate it)

This is the operator path for getting *another* person onto Prism — a fresh
Parachute vault behind its own Prism Server, reachable on the web, optionally
**federated** with your vault. It's written to be followed top-to-bottom by
someone who has never deployed Prism. Everything here is real (the commands map
to scripts in `apps/server/scripts/`); nothing is aspirational.

> **Mental model.** One **hub** (Parachute, `@openparachute/hub`) serves many
> **vaults** by name at `/vault/<name>/api`. One **Prism Server** (`apps/server`)
> fronts one-or-more of those vaults as the single trust boundary for the web —
> it holds the vault token; browsers never do. A **node** is "a Prism Server +
> its vault(s)". Federation pairs two nodes and keeps chosen slices in sync.

---

## 0. Prerequisites

- Node 20+, a running Parachute hub (`parachute` CLI on PATH), and this repo.
- A domain or tunnel if the instance must be reachable from another machine
  (we use `cloudflared`; any HTTPS reverse proxy works). For same-LAN testing
  you can skip this and use `http://<host>:8787`.

---

## 1. Create the vault

Pick a name (lowercase, no spaces). **Use a fresh name** — recreating a removed
vault of the same name can ghost it until the hub restarts.

```bash
parachute vault create knowledge-commons          # creates the vault
parachute auth mint-token \
  --scope vault:knowledge-commons:write --ttl 365d # → prints a hub JWT
```

Copy that JWT — it's the vault token the Prism Server will hold. (Pre-0.5 `pvt_*`
tokens are rejected; this must be a hub-issued JWT.)

---

## 2. Configure the Prism Server

**Fast path — guided provisioner.** It generates the secrets, writes `.env`, and
seeds the vault's tag schemas idempotently:

```bash
cd apps/server
node --import tsx scripts/prism-setup.ts            # interactive (prompts for vault/token/owner)
node --import tsx scripts/prism-setup.ts --dry-run  # preview the .env without writing
```

Then skip to "Build the web PWA" below. If you'd rather write `.env` by hand,
create `apps/server/.env` (gitignored) with at least:

```bash
PARACHUTE_URL=http://localhost:1940      # the hub root (no /vault path)
PARACHUTE_VAULT=knowledge-commons        # the vault name from step 1
PARACHUTE_TOKEN=<the JWT from step 1>

OWNER_EMAIL=owner@example.com            # the bootstrap/owner identity
SESSION_SECRET=<openssl rand -hex 32>
CAPABILITY_SECRET=<openssl rand -hex 32>

APP_ORIGIN=https://commons.example.com   # public origin (or http://host:8787)
# WEB_ROOT defaults to ../web/dist        # the built PWA the server serves
# RESEND_API_KEY=...  MAGIC_FROM=...       # optional: real magic-link / invite email
# FEDERATION_ENABLED=true                  # only if this node will federate (step 6)
```

`assertConfig()` fails fast if a required secret is missing. With **no
`RESEND_API_KEY`**, magic-link/invite URLs are logged to the server console
(fine for dev; you copy the link by hand).

**Build the web PWA and start the server:**

```bash
npm run build -w @prism/web                       # → apps/web/dist
cd apps/server && npm run dev                      # foreground; or pm2 (see §7)
```

Verify the trust boundary before exposing it:

```bash
node --env-file=.env --import tsx scripts/verify-gateway.ts   # expect ALL PASS
```

---

## 3. Bootstrap the owner, then invite the test user

1. **Owner signs in** at `${APP_ORIGIN}` → "Email me a link" with `OWNER_EMAIL`.
   Magic-link is **owner-only** (bootstrap/recovery). With no Resend key, copy
   the link from the server log.
2. **Invite the other person** — open **Share** on any note (or the people
   surface) and add their email. That issues a single-use, 7-day invite; sharing
   by email auto-invites so the grant binds to a real account.
3. They open the invite link → set a name + password (`/accept-invite?token=`) →
   log in at `${APP_ORIGIN}` with email + password.

A signed-in non-owner with **no grants sees nothing** (empty notes, 403 on the
graph) — authentication never implies authorization. Share specific notes/tags
to give them access.

---

## 4. (Optional) Publish a read-only wiki

In the app, open **Network → Publish**, pick a tag/collection, press Publish.
You get a public `…/p/<slug>` URL (optionally password-gated). Future notes with
that tag are included automatically. No CLI, no redeploy.

---

## 5. (Optional) Front a second vault from the same server

One Prism Server can switch between several vaults (owner-only). Mint a token for
each extra vault (step 1) and set `PRISM_VAULTS` in `.env` to a JSON array:

```bash
PRISM_VAULTS='[
  {"id":"primary","label":"Knowledge Commons","url":"http://localhost:1940","vault":"knowledge-commons","token":"<jwt-1>"},
  {"id":"bioregional","label":"Bioregional Commons","url":"http://localhost:1940","vault":"bioregional","token":"<jwt-2>"}
]'
```

The **first** entry is the default (everything is byte-for-byte unchanged when
`PRISM_VAULTS` is unset). Restart the server. In the app, **Network → Vaults**
lists both; the owner clicks **Switch** to repoint the whole app at the other
vault (the choice rides `X-Prism-Vault` on every gateway call and persists).

> Phase-1 scope: sharing/publication/federation state is **per the vault that
> owns it** but not yet namespaced in one DB across vaults — run one vault as the
> "shared" one per server until the Phase-2 `vault_id` migration lands.

---

## 6. (Optional) Federate two nodes

Federation keeps a **space** (a slice of the vault, by tags/path) in two-way CRDT
sync between two paired nodes. Both nodes must set `FEDERATION_ENABLED=true` and
restart.

1. **Pair.** On node A: **Network → Federate → Invite a peer** → copy the pairing
   code + your server URL. On node B: **Join a peer** → paste the code, A's
   server URL, and A's collab URL (`wss://<A-origin>/collab`). Verify the
   fingerprint matches out-of-band.
2. **Define a space** on A: **New space** → title + include-tags → Create.
3. **Grant the peer** a level (view/comment/suggest/edit) on that space. A sends
   B a **mirror request**; B reviews it under **Network → Federate → Inbox** and
   accepts. Accepting materializes the space + a placeholder note per shared key
   on B — a peer never writes to B's vault without that explicit accept.
4. Edits to space notes now converge both ways. The per-space badge shows
   **Synced <ago>** once a peer has actually pulled.

To rehearse this on **one machine** without exposing anything, use the isolated
two-hub harness (separate vault, DB, and port 8788 — it never touches your live
server):

```bash
cd apps/server
FED_B_VAULT=fed-test bash scripts/two-hub-up.sh --bg     # Hub B → :8788, logs → prism-b.log
node --import tsx scripts/verify-two-hub.ts               # AC-1..AC-12 convergence checks
```

Use a **fresh** `FED_B_VAULT` each run; when killing a port use
`lsof -ti tcp:8788 -sTCP:LISTEN` so you don't kill an unrelated client socket.

---

## 7. Run it for real (process + tunnel)

```bash
# from apps/server — keep it alive across reboots (npm start = the configured entry)
pm2 start npm --name prism-commons -- start
pm2 save

# expose it (example: cloudflared)
cloudflared tunnel --url http://localhost:8787
```

**Restart the server process after ANY server-side change** — it compiles via
tsx on start but does **not** hot-reload. A stale server with an old `noteKind`
can persist a note through the wrong path and corrupt it.

---

## Checklist

- [ ] Vault created with a fresh name + write JWT minted
- [ ] `.env` complete; `verify-gateway.ts` → ALL PASS
- [ ] Web PWA built; server up; owner signed in
- [ ] Test user invited → registered → sees only what's shared
- [ ] (opt) Wiki published / second vault added / peer federated
- [ ] Process under pm2 + reachable origin
