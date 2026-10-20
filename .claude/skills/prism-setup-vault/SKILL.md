---
name: Prism Setup — Vault
description: "The `vault` and `vault-token` steps of `prism setup`: get Parachute (the hub + vault Prism stores notes in) running, and give the Prism Server its long-lived vault write token. The token is minted by `prism token mint` straight into the install's .env (0600) and never shown; `prism token rotate` replaces it."
version: 0.3.0
---

# Prism Setup — Vault + vault token

Two steps of `prism setup` (see `prism-setup`). Run them with
`prism setup --json --from vault`; this page explains what they check and what to say.

## Step `vault` — Parachute is running

Parachute runs a hub on **:1939** (it issues tokens) and the vault on **:1940**. The step records
the `parachute` / `parachute-vault` commands it found as explicit paths (`PARACHUTE_BIN`,
`PARACHUTE_VAULT_BIN`) so the server never depends on `PATH`. Then, in this order:

- **Parachute already runs here** (its own launchd unit `computer.parachute.hub`, loaded or just
  installed, or a Parachute someone started) → **reused**, `done`; the detail says so. Prism starts
  no second hub and changes nothing of it. A unit that is installed but not answering →
  `needs-person` with the person's `launchctl kickstart` command.
- **Not installed** → `needs-person` with two `commands` (`who: "agent-with-consent"`): bun and
  stock Parachute at the pinned versions. Run them only after the person says yes, then
  `prism setup --json --from vault`. **Never run `parachute init`**: it installs Parachute's own
  launchd unit; Prism runs Parachute itself instead.
- **Installed, nothing running** → Prism runs it (**stock mode**, docs/host-bundle.md § Stock
  Parachute): it creates the vault (`parachute-vault create --no-mirror`), keeps the person's
  existing `~/.parachute` where it is (or uses a folder inside the Prism install when there is
  none), and then stops at `needs-person` with ONE command for the person
  (`PATH=… PARACHUTE_HOME=… parachute auth set-password`): they run it in Terminal exactly as
  given (the `PATH=` part is needed — on a fresh Mac bun's folder is not on PATH yet) and type the
  admin password there, twice, then answer `y` to "Create the first hub user named "owner"?" —
  never in this conversation. Then `--from vault` loads Prism's hub agent (it runs
  the vault too) and waits until both answer. Prism uses the default ports only (1939/1940).
- **Both Prism's hub agent and Parachute's own unit installed** → `failed` with the person's
  command to remove Parachute's unit (two hubs would fight). Ask which one they want to keep.
- **Another run holds the lock** (exit 4, `detail.lock`): another `prism setup` is running — wait
  for it; do not delete the lock file unless the person confirms no setup is running.
- **Embedded mode** (a bundle that carries the Parachute payload, `--parachute embedded`): the
  step runs the payload's own `parachute bootstrap --embedded --json` instead (idempotent). No
  bundle carries a payload yet (launch plan §3).

You cannot install system software silently. Say what bun and Parachute are, ask, then run.

## Step `vault-token` — the server's write token

Done when `.env` holds a `PARACHUTE_TOKEN` the vault accepts. Otherwise the step runs the same
code as **`prism token mint`**:

1. `parachute auth mint-token --scope vault:<name>:write --expires-in 31536000` (through the one
   Parachute spawner, `apps/server/src/parachute-cli.ts`);
2. a read against the vault with the new token;
3. the token written into `.env` (atomic, 0600; no other line changes);
4. the server restarted if it was running.

**The token never appears in a result, a log or this conversation**: the CLI reports only its
`jti`, expiry and scope. Do not run `parachute auth mint-token` yourself — its stdout is the
token.

### The token commands

| Command | What it does |
|---|---|
| `prism token status --json` | `{set, token: {jti, exp, scope, expiresInDays}, vault: accepted\|rejected\|unreachable, next?}` from the token's claims (read, not verified) and one read against the vault. Exit 4 = no token, refused or expired. |
| `prism token mint [--force] [--expires-in S]` | As above. A working token is left alone (`action: "unchanged"`) unless `--force`; a replaced one is revoked. |
| `prism token rotate` | Mint → check (the vault must answer) → swap into `.env` → restart → revoke the old jti. Parachute keeps accepting a revoked token for about 60 seconds (its revocation cache). |

Every one takes `--dry-run` (prints the commands, spawns nothing).

## When the vault refuses a new token

`prism token mint` exits 5 and revokes the token it just minted. The usual cause on stock
Parachute (0.7.x) is the **issuer bug**: `auth mint-token` takes the token's issuer from
`<PARACHUTE_HOME>/hub/run/hub.port`, which `parachute serve` never writes, so a hub on any port
but 1939 mints tokens its own vault rejects ("unexpected iss"). The message says so; with the
person's yes, write the hub's port (one line) into that file and run it again.

## Notes

- The token is a **hub JWT** (`vault:<name>:write`, one year). Pre-0.5 `pvt_*` tokens are refused
  by Parachute.
- Schema seeding needs `vault:<name>:admin`: the `schemas` step mints a one-hour `--ephemeral`
  admin token, uses it in memory and keeps it nowhere (`prism-setup-schema`).
- A checkout instead of a host install: the person mints the token and pastes it into
  `apps/server/.env` themselves (`docs/onboarding.md` § "By hand"); never take it in this chat.
