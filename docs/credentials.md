# Credentials

Every credential Prism uses, where it is stored, how to set it, and whether it is ever
shown. The rule: **anything a user is meant to configure can be set from a frontend, and
no frontend ever displays a stored credential.** The UI shows *configured / not
configured* and lets you replace or remove the value. Values travel one way: from the
form to the store.

The exception is **host bootstrap secrets**, the keys that make up the Prism Server's own
root of trust. Those can only be set on the host (`apps/server/.env`). The section
[Why host secrets are not editable from a browser](#why-host-secrets-are-not-editable-from-a-browser)
explains why.

## Surfaces

| Surface | Where credentials are entered | Transport |
|---|---|---|
| Web PWA (`apps/web`) | **Network → Server** (server owner): sync integrations and vault tokens | session cookie → `/api/integrations/*`, `/acl/*` |
| Prism Client (`apps/client`, the native build of `apps/web`) | Same **Network → Server** panel; nothing is gated on platform | `pd_…` device bearer → same routes (a device token is the same user actor) |
| Legacy desktop (`apps/desktop`) | **Settings → Services / Data Sources** for its own `prism-config.json`. **Network → Server** for the server's integrations, through the Rust `api_request` / `acl_request` proxy (COLLAB_TOKEN = owner) | Tauri `invoke` |

## The table

"Displayed" means: is the stored value ever returned to a client or rendered? Every row
must say **never**. One-time display of a token the user just minted is noted separately;
the user has to copy it once.

### Prism Server: sync-integration credentials (encrypted with `SECRETS_KEY`, per vault)

Stored with `putSecret(vault, owner, kind)` in SQLite, AES-encrypted. `GET
/api/integrations/<kind>` returns `{secretsAvailable, configured}` plus, for some kinds,
the **non-secret** scope fields listed below. Set them in **Network → Server → Sync
integrations**. A `PUT` replaces the whole credential and `DELETE` removes it. Admin+
for every kind except `proton-bridge`, which is **server-owner only**.

| Kind | Fields (secret in **bold**) | Echoed by GET (non-secret only) | Displayed |
|---|---|---|---|
| `matrix` | homeserver, **accessToken** | — | never |
| `fathom` | **apiKey** | — | never |
| `fireflies` | **apiKey** | — | never |
| `clickup` | **apiKey**, teamId, spaceIds, assignedOnly | teamId, spaceIds, assignedOnly | never |
| `github` | **token** | — | never |
| `notion` | **apiKey** | — | never |
| `google` | account (not a secret: the `gog` account name) | — | n/a |
| `proton-bridge` | username, **password**, certSha256, host, port, security | host, port, username, security, certSha256, `mode` | never |

`github` and `notion` also back the server's folder and database syncs (`docs/sync.md`).
Those configs are stored without any credential, the token is read at push time, and
requests go only to `api.github.com` / `api.notion.com`. A GitHub token for folder sync
needs Contents read/write on the target repositories.

`google` holds only the account name. Gmail, Calendar and Docs all read just
`{account}`. The OAuth tokens belong to the `gog` CLI and live in the **server host's**
macOS Keychain. They are created by running `gog` interactively in a GUI session on that
host, because that is a browser OAuth flow on the host. They can't be entered from a web
form, and Prism never sees them.

### Prism Server: vault tokens

| Credential | Stored | How to set | Displayed |
|---|---|---|---|
| Vault token of an **owner-added** vault (linked or created in the app) | SQLite `prism_vaults.token` | Link: **Network → Vaults → Link**. Rotate: **Network → Server → Vault access tokens → key icon** (`PUT /acl/vaults/:id/token`, server-owner only). The new token is probed against the vault (10 s timeout) before it is stored. **Rotation does not revoke the old token**: run `parachute auth revoke-token <jti>` on the hub afterwards (the vault enforces it within ~60 s). | never (only expiry date + status) |
| Vault token of an **env** vault (`PARACHUTE_TOKEN`, `PRISM_VAULTS`) | `.env` | Host only, then restart | never |

### Prism Server: host bootstrap secrets (`apps/server/.env`, host only)

| Variable | What it is | Displayed |
|---|---|---|
| `SESSION_SECRET` | signs session cookies | never |
| `CAPABILITY_SECRET` | signs capability (share) links | never |
| `SECRETS_KEY` | encrypts every integration credential above | never |
| `PARACHUTE_TOKEN` / `PRISM_VAULTS` | the server's whole-vault tokens | never (expiry only) |
| `PARACHUTE_ADMIN_TOKEN` | optional admin-scope override for seeders/compaction | never |
| `COLLAB_TOKEN` | owner bearer for the desktop + loopback collab | never |
| `GOVERNANCE_SIGNING_SECRET` | HMAC over governance notes | never |
| `PEER_SIGNING_KEY` | federation Ed25519 private key | never (public key only) |
| `VAPID_PRIVATE_KEY` (+ public) | Web Push signing | never (public key is served to browsers by design) |
| `RESEND_API_KEY` | outbound email (magic links, invites, alerts) | never (`emailConfigured` bool only) |
| `EMBED_API_KEY` | embedding endpoint key | never |

Set them by editing `.env` (`chmod 600`; `prism-setup.ts` generates the random ones), then
restart pm2 `prism-server`. `APP_ORIGIN` and `OWNER_EMAIL` are host-only too, though
they aren't secrets (see below).

**Network → Server → App settings** can edit exactly one key: `MAGIC_FROM`, the
`From:` header of sign-in and invite mail. It is kept because it can't redirect anything.
Mail still goes to the recipient through the operator's Resend account, and Resend only
sends from verified domains, so the worst a hostile change can do is make sends fail
until the host fixes it.

Every value goes through one central guard (`apps/server/src/env-edit.ts`
`isSafeEnvValue`): no CR, LF, NUL, U+2028/2029 or other control characters, and no
leading or trailing space. `MAGIC_FROM` must also match a strict
`addr@domain.tld` / `Name <addr@domain.tld>` pattern, which rules out quotes, `#` and `$`.
The line is replaced with a function replacer, so `$&` / `$'` in a value are literal, and
every duplicate `MAGIC_FROM=` line is rewritten. Tests (`test/env-edit.test.ts`) parse the
result with Node's own `util.parseEnv` and assert it holds exactly the intended keys.
(This closes a pre-existing hole: an unanchored `APP_ORIGIN` check let
`https://x\nOWNER_EMAIL=attacker@…` add lines that `node --env-file` honoured.)

### Accounts and agent access (Prism Server)

| Credential | Stored | How to set | Displayed |
|---|---|---|---|
| Account password | scrypt hash | `/accept-invite` (register), **Settings → Account → Change password** | never |
| Device token `pd_…` (Prism Client, iOS) | SHA-256 only | Created by the native sign-in flow; revoke in **Settings → Account → Signed-in devices** | never (it goes straight into the client's Keychain) |
| Prism PAT `pp_…` (Prism MCP) | SHA-256 only | **Settings → Account → Agent access tokens** | **once**, at creation |
| Member vault MCP JWT (`/api/mcp/token`, frozen by default) | hub JWT, listed by id | API only | **once**, at creation |
| Capability link | HMAC token in the URL | Share dialog | The link *is* the credential. Showing it is the feature: it is a bearer you hand to someone. Revoke in the same dialog. |

### Legacy desktop (`~/Library/Application Support/prism/prism-config.json`)

`get_full_config` returns `""` for every secret plus a `<key>_set` bool. It returns no
masked prefix or suffix. `update_config` **merges**: a non-empty value replaces the
stored one, a blank value keeps it, and `null` clears it (the trash icon). Unit tests:
`commands::config::tests` (`redacted_view_never_contains_a_secret_value_or_fragment`,
`merge_blank_keeps_value_replaces_null_clears`, `redact_then_merge_round_trip_never_loses_a_secret`).

| Key | How to set | Displayed |
|---|---|---|
| `parachute_api_key` | Settings → Services → Parachute | never |
| `matrix_access_token` | Settings → Services → Matrix | never |
| `anthropic_api_key` (+ Keychain `com.prism.anthropic` fallback) | Settings → Services → Claude. Removing it also deletes the Keychain item, so it doesn't come back on the next load. | never |
| `collab_token` (+ `collab_url`) | Settings → Services → Prism Server | never rendered (see below) |
| `notion_api_key` | Settings → Data Sources → Notion | never |
| `fathom_api_key`, `fireflies_api_key`, `readai_api_key`, `otter_api_key` | Settings → Data Sources | never |
| Registry vault tokens (`vaults[].token`) | Vault link / create (token minted by the CLI) | never (`VaultSummary` has no token) |
| GitHub | `gh auth login` on the host (Prism never stores a token) | n/a |
| Google | `gog` OAuth on the host (`google_account_*` are account names) | n/a |

**The one deliberate exception.** `get_collab_config` hands `collab_token` to the trusted
desktop webview. The Hocuspocus WebSocket is opened from JS, so the webview needs the
token to authenticate it. The token is never rendered, and it is the dedicated
`COLLAB_TOKEN`, never a vault token. Moving the socket into Rust would remove this
exception. It isn't worth doing for a shell that WP4.3 retires.

The `acl_request` / `api_request` proxies and collab config now read `collab_url` /
`collab_token` fresh from disk, so a value saved in Settings applies without a restart.
Background services (embedding index) still pick it up at the next launch.

The `/api` proxy (`api_path_allowed`) checks the path in two ways:
- **Characters:** the raw path may contain only `[A-Za-z0-9_/-]`. That rules out
  `.`, `%`, `\`, spaces, tab, CR and LF. The WHATWG URL parser drops tab and newline,
  so `/integrations/.\t./vaults` would otherwise resolve to `/api/vaults`.
- **Parse:** the path is then parsed with the same `url` crate reqwest uses, and the
  *resulting* path must equal the raw one and stay under `/api/integrations`.

**Config file integrity.**
- `AppConfig::load` is strict. An existing file that can't be read or parsed is an
  error; it never falls into the first-launch branch that writes defaults.
  `update_config` and `get_full_config` then fall back to the in-memory state.
- `save` is atomic: a 0600 temp file in the same directory, fsync, rename, then a
  directory fsync. If the file it replaces doesn't parse, `save` first keeps a copy
  as `prism-config.json.corrupt-<ts>`.

**Known limit (L1).** The desktop does not make you re-enter a secret when its
destination changes (`parachute_url`, `collab_url`, `matrix_homeserver`). Settings
saves one field at a time, so changing the URL keeps the stored token, and the next
call sends that token to the new URL. The desktop webview is trusted local code, so
this is accepted for now. The server-side Proton credential does enforce re-entry: its
password is required whenever host, port, security, username or pin changes.

### Prism Client (`apps/client`)

| Credential | Stored | How to set | Displayed |
|---|---|---|---|
| Device token `pd_…` | macOS Keychain (client's own item) | Sign-in (system browser + PKCE) | never |
| Server origin | `client-settings.json` (not a secret) | Prism → Server Settings… | n/a |

## Why host secrets are not editable from a browser

The host secrets are the server's root of trust. They sign sessions and share links,
encrypt every stored credential, hold whole-vault access, and deliver owner sign-in links.
If a browser could change them, then **a stolen owner session (one XSS, one unlocked
laptop) could rotate the server's root of trust**:

- re-key `SESSION_SECRET` / `CAPABILITY_SECRET` to mint its own sessions and links;
- point `PARACHUTE_TOKEN` at a vault it controls;
- swap `RESEND_API_KEY` for an account it owns.

The last one is why `RESEND_API_KEY` was **removed** from the editable `.env` allowlist
(`PUT /acl/server/config`). It used to be there. Every later magic link would then sit
in the attacker's Resend logs, so the attacker keeps owner access even after the stolen
session is revoked.

`APP_ORIGIN` was removed for the same reason, although it isn't a secret. It builds
every magic-link and invite URL, and it also sets the credentialed-CORS origin, the MCP
`Origin` allowlist and the cookie `secure` flag. A stolen session could point future
owner sign-in links at an origin it controls.

Host secrets and the values that route sign-in therefore require host access, the same
bar as the data they protect.

Integration credentials are different. They are scoped (one vault, one third-party
account) and encrypted under `SECRETS_KEY`. Replacing one can only redirect *that*
integration, so they are write-only in the UI.

## Proton Bridge: certificate pin and Detect

The `proton-bridge` credential pins Bridge's self-signed certificate by the SHA-256 of
its DER (`certSha256`). The worker checks the pin after the TLS handshake and **before**
LOGIN, so the password only ever goes to a listener presenting exactly that
certificate. A missing pin fails closed.

**Detect** (the button next to the fingerprint field) calls
`POST /api/integrations/proton-bridge/detect-cert {host?, port?, security?}`. The route
is server-owner only.

1. The host must be loopback (`127.0.0.1`, `::1`, `localhost`). Any other host is
   refused **before a socket opens**, so the probe can't reach the network. The port
   must be 1024–65535, so privileged local services (ssh, smtp, …) can't be probed.
2. **STARTTLS mode:** wait for the IMAP `* OK` greeting, send exactly `A1 STARTTLS`,
   complete the TLS handshake, read the peer certificate, close. **TLS mode:**
   handshake, read, close. Nothing else is sent: no CAPABILITY, no LOGIN or
   AUTHENTICATE, no LOGOUT. The stored credential is never loaded.
3. The fingerprint uses `certFingerprintOf`, the same helper the worker's pin check uses,
   so a detected value is a valid pin by construction. The route also returns the
   certificate's subject, issuer and validity.
4. 10 s timeout, one probe at a time (409 `busy`), 10 per minute server-wide (429).

**This is trust-on-first-use, made deliberate.** The fingerprint is whatever is listening
on that loopback port right now. Bridge's certificate is self-signed, so nothing else can
vouch for it. The UI therefore shows the subject, issuer, expiry and fingerprint, and
keeps **Save disabled until the owner ticks "I confirm this is my Proton Mail Bridge"**.
Typing or pasting a fingerprint by hand (for example from
`openssl s_client -starttls imap -connect 127.0.0.1:1143 </dev/null 2>/dev/null | openssl x509 -outform DER | shasum -a 256`)
needs no confirmation. The worker itself still never trusts anything it wasn't given
as a pin.

Tests (`apps/server/test/proton-ingest.test.ts`, "detect-cert"):
- They run against the real loopback TLS/STARTTLS stub IMAP server. The detected value
  equals the certificate's DER SHA-256, and that value then passes the login-path pin.
- The stub receives exactly `A1 STARTTLS\r\n` (STARTTLS mode) or nothing (TLS mode).
  It never sees LOGIN/AUTHENTICATE, the stored password or the account.
- Non-loopback hosts get 400 without connecting. A vault admin and anon get 403.
- A listener without STARTTLS fails cleanly, and a silent one times out.

Other Proton Bridge row behaviour:
- **Advanced** holds host (default `127.0.0.1`), port (default 1143) and security
  (`starttls` | `tls`).
- The password is required on every save. The server would refuse to reuse the stored
  one for a changed connection anyway.
- The header badge shows the server's ingest mode (`off` / `shadow` / `live`).
- **Sync now** while the ingest is off explains that `PROTON_SHADOW` or
  `PROTON_SYNC_ENABLED` must be set in `.env`.
