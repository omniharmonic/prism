# Parachute embedded host mode: a feature request from Prism

Status: **request for the Parachute maintainers**, 2026-10-02. Written by the Prism team against
`@openparachute/hub` **0.7.19** and `@openparachute/vault` **0.7.9** (both AGPL-3.0, installed with
`bun add -g` under bun 1.3.14 on macOS arm64). Companion design: `docs/roadmap/one-download-setup.md`
(Prism's "one download" plan; this document expands its open question 4).

How to read the evidence: claims about Parachute's current behaviour cite the installed package
(`hub/src/…` = `~/.bun/install/global/node_modules/@openparachute/hub/src/…`, likewise `vault/src/…`,
`vault/core/src/…`, `scope-guard/dist/…`) or CLI `--help` output. Everything was gathered read-only: no
command that starts, stops, installs, exposes, mints or modifies anything was run, and no token, `.env`,
`operator.token`, `hub.db` or vault database contents were read. Statements marked **(inferred)** come
from reading code paths, not from running them. Where we could not tell, we say so.

---

## 1. Summary

**What Prism is.** Prism is a document/messaging/agent workspace built on a Parachute vault. Its server
(Node 22, `apps/server`) is the single trust boundary: it holds a vault JWT, enforces its own per-note
permissions for invited collaborators, ingests mail/calendar/chat into the vault, and serves a web PWA,
a macOS client and (soon) an iOS app. Today every install is hand-assembled: `bun`, `parachute init`, a
launchd unit Parachute writes, a hand-minted 1-year write token pasted into Prism's `.env`, pm2 for Prism.

**What we are building.** A single signed, notarized macOS app. A small supervisor inside the bundle
(`prism-host`, registered with `SMAppService` as one login item) starts and supervises, as foreground
children: the Parachute hub+vault, then the Prism server. Everything executable ships inside the app.
Secrets live in the Keychain and are passed to children through the environment or a file descriptor.
Only Prism's port is ever reachable from outside the Mac (via Tailscale or a Cloudflare tunnel that Prism
manages); the hub and vault stay on loopback. Updates are atomic app updates with a coordinated backup of
Prism's DB and Parachute's data, and a rollback that restores both together.

**What we need from Parachute** — an "embedded" mode in which a host app owns installation, process
lifecycle, exposure and upgrades:

| # | Ask | Priority |
|---|---|---|
| R1 | Embedded/supervised run mode: foreground, no self-install, no runtime `bun add`, no launchd units, no exposure, clean SIGTERM, readiness endpoint, meaningful exit codes | **P0** |
| R2 | Everything (config, data, logs, runtime state, module discovery) under one host-chosen root; no `~/.parachute`, `~/.bun`, `~/.cloudflared` or `~/Library/LaunchAgents` writes | **P0** |
| R3 | A self-contained, codesignable + notarizable distributable (pinned deps, no native code fetched or extracted at runtime), arm64 + x86_64 | **P0** |
| R4 | Non-interactive, idempotent bootstrap (admin, first vault, operator credential handed over a 0600 file or fd, never printed) | **P0** |
| R5 | Programmatic token management (mint scoped/ephemeral, revoke, list) with machine-readable output, without the host opening `hub.db` | **P0** |
| R6 | Loopback-only binds by default, a stable loopback issuer, and exposure features hard-off in embedded mode | **P0** |
| R7 | Version + migration contract (`--version --json`, refuse to open a newer on-disk schema, explicit `migrate --dry-run`) | **P0** (guard + version) / P1 (explicit migrate) |
| R8 | Secret-bearing files created 0600 in 0700 dirs (today `hub.db`, which holds the JWT signing key, is 0644) | **P0** |
| R9 | No outbound network at start or in steady state unless a feature is explicitly enabled | **P0** |
| R10 | License terms that let us ship Parachute inside a notarized, closed-distribution app | **P0** (legal) |
| R11 | Consistent online backup for hub + vaults, restorable together with Prism's DB | P1 |
| R12 | Logs to stdout/stderr (or a configured dir) with bounded size | P1 |
| R13 | Cheaper bulk reads: lean listing without per-note schema validation, for trusted callers | P1 |
| R14 | Keep multi-vault per hub, with non-interactive create/remove/list (JSON) | P1 |
| R15 | Configurable revocation latency (or push invalidation) | P2 |

A full P0 set lets Prism ship "download one app, it sets up everything" without a user-installed bun or
Parachute. Without it, our v1 host mode has to require a user-installed Parachute (we would support that
as "external Parachute" anyway, for existing installs like ours).

---

## 2. How Prism uses Parachute today (the compatibility surface)

Please treat this section as "things an embedded build must keep working". Details live in Prism's
`CLAUDE.md` ("Parachute MCP", "Version history", "Tree projection") and `apps/server/src/parachute.ts`.

### 2.1 Topology and credentials

- Hub on `127.0.0.1:1939`, vault on `127.0.0.1:1940`, Prism server on `127.0.0.1:8787`. Prism talks to
  the vault **directly on :1940** (`PARACHUTE_URL`, default `http://localhost:1940`), path-scoped
  `/vault/<name>/api/...`, with a hub-issued JWT (`Authorization: Bearer`). Pre-0.5 `pvt_*` tokens are
  not used.
- Several vaults per hub (our production hub has 9 under `vault/data/<name>/`). Prism's
  `PRISM_VAULTS` registry maps each to `{url, vault, token}`.
- Token scopes Prism uses:
  - `vault:<name>:write`, long-lived (minted with `--expires-in 31536000`), the server's main credential;
  - `vault:<name>:admin --ephemeral` (1 h), minted per run for tag-schema seeding and the nightly history
    compaction (`apps/server/src/mcp-token.ts` `mintEphemeralAdminToken`, `worker/history-compact.ts`);
  - `vault:<name>:read`, 3 h, minted per read-only agent turn with `--service agent-session:<id>` and
    revoked at turn end;
  - member MCP tokens (`--service mcp:<email>`), now frozen behind a flag.
- Minting/revoking is done by **shelling out**: `execFile("parachute", ["auth","mint-token",…])` and
  `["auth","revoke-token",<jti>]` (`apps/server/src/mcp-token.ts`). Prism parses the JWT from stdout and
  decodes the `jti` itself, because the CLI prints only the token.
- We rely on revocation being enforced within about 60 s (`scope-guard/dist/revocation-cache.js`
  `REVOCATION_CACHE_TTL_MS = 60_000`).

### 2.2 REST endpoints (vault)

- `GET /notes` with `tag`, `path_prefix`, `limit`, `offset`, `order_by=updated_at|created_at`,
  `include_content=false`, `include_metadata=<keys>`, `include_links`, `search`; flat array response.
  Prism depends on lists staying flat arrays and on additive-only changes (new fields, the
  `X-Parachute-Warnings` header) — the 0.6 → 0.7 upgrade honoured this.
- `GET/POST/PATCH/DELETE /notes/:id` with `if_updated_at` (409 on stale), `if_exists: "ignore"|"update"`,
  `tags: {add, remove}`, `links`, metadata merge.
- History: `GET /notes/:id/versions[?limit&offset]`, `GET /notes/:id/versions/:ix`,
  `POST /notes/:id/restore {if_updated_at}`, admin `POST /api/history/compact`.
- `GET /tags`, admin `PUT/DELETE /tags/:name` (tag schemas; 403 `insufficient_scope` with a write token),
  `GET /graph`, `GET /health`.
- The server's owner passthrough proxies arbitrary vault paths for the owner, so in practice any
  documented vault REST route is part of the surface.
- Error contract we map: 400/413/422 pass through with `reason`; 409 `error_type` (`conflict`,
  `path_conflict`, `ambiguous_path`); 413 `history_overflow` for updates to notes over 2,000,000 bytes
  while history is on (we roll Matrix threads over at 1 MB because of this).

### 2.3 Subscribe WebSocket

`ws://127.0.0.1:1940/vault/<name>/api/subscribe?include_content=false`, first message
`{"type":"auth","token":…}`, then a `snapshot` (accumulated frames), then `upsert` / `remove` frames.
Prism builds its whole file-tree projection and its client invalidation channel from this one socket per
vault (`apps/server/src/tree.ts`). The snapshot being a complete, lean listing is load-bearing: it
replaced a 16 MB full-vault REST list that stalled the vault.

### 2.4 MCP

`http://127.0.0.1:1940/vault/<name>/mcp`, used by Prism's hardened `claude -p` agent runs with explicit
tool allowlists: `query-notes, create-note, update-note, delete-note, list-tags, find-path, vault-info,
doctor, read-attachment, request-attachment-download`. We depend on the admin verbs
(`update-tag, delete-tag, rename-tag, merge-tags, prune-schema, manage-token`) staying hidden from
non-admin tokens, and on tool names staying stable.

### 2.5 Operational assumptions

- `vault.yaml` `history:` block (20-version floor, 100 ceiling, 180 days, 8 MiB per note), read at vault
  start. Indexable field types on 0.7: string, integer, boolean, reference, date.
- Backups: `scripts/backup-parachute.sh` snapshots hub DB, vault DBs and `prism-server.db` together
  (SQLite online backup → `journal_mode=DELETE` → `integrity_check`). They must be restored together:
  Prism's governance signature ledger and collaborative-doc snapshots refer to vault note ids and
  `updatedAt` values.
- Upgrades so far: a rehearsal on a copy (hub 0.7.1 → 0.7.19, vault 0.6.1 → 0.7.9) migrated hub schema
  13 → 24 and vaults 22 → 32 in about 4 s; downgrading the binary over a migrated DB was not safe; restore
  from backup was (`docs/roadmap/parachute-upgrade/PLAN.md` §1).

---

## 3. Requirements

Notation: "today" describes 0.7.19 / 0.7.9 as installed.

### R1 — Embedded (supervised) run mode — **P0**

**Requirement.** One documented command that runs hub + vault as foreground processes under a host
supervisor, with every self-management behaviour off: no package installation or upgrade, no unit files,
no exposure, no admin endpoints that do any of those.

**Today.**
- `parachute serve` is already close: "The hub IS the foreground process … an in-process supervisor that
  spawns every installed module as an attached child … runs until it gets a signal, then SIGTERMs its
  children and exits" (`parachute serve --help`). It does not run `bun add` on boot (we found install
  calls only in `hub/src/api-modules-ops.ts`, `commands/install.ts`, `commands/upgrade.ts`).
- But the running hub still exposes install/upgrade paths: `POST /api/hub/upgrade` runs the hub upgrade
  from the admin SPA (`parachute upgrade --help`; `hub/src/api-hub-upgrade.ts`), and module install/ops go
  through `hub/src/api-modules-ops.ts`.
- `parachute init` and `migrate --to-supervised` write `~/Library/LaunchAgents/computer.parachute.hub.plist`
  (observed on our machine: `ProgramArguments` = `/opt/homebrew/bin/bun …/hub/src/cli.ts serve`, `KeepAlive`,
  logs to `~/.parachute/hub/logs/hub.log`). `expose public --cloudflare` writes a second agent
  (`computer.parachute.cloudflared.<host>.plist` observed). `parachute-vault init` can register its own
  launchd/systemd daemon unless `--no-autostart` (`parachute-vault --help`; `vault/src/launchd.ts`,
  `vault/src/backup-launchd.ts`).
- The supervisor spawns modules by bare name on `PATH` (`startCmd: () => ["parachute-vault", "serve"]`,
  `hub/src/service-spec.ts:508`), with PATH enriched from `$HOME/.local/bin`, Homebrew and `$HOME/.bun/bin`;
  `PARACHUTE_EXTRA_PATH` is prepended (`hub/src/spawn-path.ts`).
- Crash budget: 3 restarts per 60 s, then `crashed` (`hub/src/supervisor.ts:347-352`); SIGTERM → SIGKILL
  after 5 s (`DEFAULT_KILL_TIMEOUT_MS`). The vault handles SIGINT/SIGTERM (`vault/src/server.ts:737-738`)
  and also polls a `stop.signal` sentinel file.
- Readiness: `GET /api/ready` on the hub returns `{ready, ready_modules, transient_modules,
  persistent_modules}` without auth (`hub/src/api-ready.ts`); the vault serves `GET /health`.
- Exit codes: documented for `status` and `doctor` (0/1). We could not determine `serve`'s exit codes for
  "port in use", "data dir unwritable", "schema newer than binary" or "config invalid" without running it.

**Proposed interface.**
```
parachute serve --embedded \
  --home "<root>"                     # see R2; or PARACHUTE_HOME
  --hub-port 1939 --vault-port 1940   # or PORT / services.json, but fixed and validated
  --bind 127.0.0.1                    # see R6
  --modules vault                     # explicit allowlist; nothing else is booted
  --log-format json|text              # see R12
  --supervise-modules=self|none       # 'none' = host spawns `parachute-vault serve --embedded` itself
```
or `PARACHUTE_EMBEDDED=1` with the same semantics. In embedded mode:
- `install`, `upgrade`, `uninstall`, `expose`, `migrate --to-supervised`, `init`'s unit writing, and the
  HTTP equivalents (`/api/hub/upgrade`, module install/uninstall in `/api/modules*`) refuse with a stable
  error (`{"error":"managed_by_host","host":"<name from PARACHUTE_EMBEDDED_HOST>"}`, CLI exit code 3).
- Modules are resolved from a host-provided payload path (R2/R3), never from `~/.bun` or `PATH` lookup.
- No launchd/systemd unit is ever written or bootstrapped (and no `launchctl` invocation at all).
- Optional: `--supervise-modules=none`, so the host can run hub and vault as sibling children with its own
  restart policy. Today a crash-looping vault becomes `crashed` inside the hub and the host only sees it
  through `/api/ready`; either model works for us if it is documented. We would like the hub's restart
  budget to be configurable (`--max-restarts`, `--restart-window-ms`) if the hub keeps supervising.

**Shutdown + readiness contract.**
- SIGTERM: stop accepting connections, finish or abort in-flight requests, checkpoint WAL, close DBs,
  stop children, exit 0, all within a documented bound (we propose 10 s; our supervisor SIGKILLs after
  10 s). SIGINT the same. SIGKILL is never required in normal operation.
- Readiness: `GET /api/ready` (hub) stays unauthenticated and loopback-served, and gains
  `{"version":…, "schema":{"hub":24,"vaults":{"default":32}}, "embedded":true}`. Vault `GET /health`
  reports 200 only once the DB is open and migrations are done.
- Exit codes (documented, stable): 0 clean shutdown; 2 usage/config error; 3 refused in embedded mode;
  4 port in use; 5 data dir missing/unwritable/locked by another process; 6 on-disk schema newer than this
  binary (R7); 7 migration failed (DB left unmodified); 1 anything else.

**Acceptance criteria.**
- With `--embedded`, `fs_usage`/`opensnoop` over a full start → ready → SIGTERM cycle shows no writes
  outside `<root>` and the OS temp dir, and no `launchctl`, `bun add`, `git`, `tailscale` or `cloudflared`
  process is spawned.
- `POST /api/hub/upgrade` and module install return the `managed_by_host` error; CLI `install`/`upgrade`/
  `expose` exit 3.
- SIGTERM to the hub exits 0 within 10 s with the vault child gone and both DBs' WAL checkpointed.
- Each exit code above reproduces from a test (port held, read-only root, newer schema fixture).

### R2 — One relocatable root for all state — **P0**

**Requirement.** A single root directory, chosen by the host (for us something like
`~/Library/Application Support/<Prism app>/Host/parachute/`; the exact name isn't final), holds every
file Parachute reads or writes: hub DB, vault DBs and `vault.yaml`, `services.json`, operator credential,
logs, run/pid files, `well-known/`, caches, and model/asset caches. No file is created elsewhere.

**Today.**
- `PARACHUTE_HOME` is honoured widely: `hub/src/config.ts` `configDir()`, `vault/src/config.ts`
  (`VAULT_HOME = <root>/vault`, `DATA_DIR`, `LOGS_DIR`, `config.yaml`, `.env`, `stop.signal`),
  `vault/src/services-manifest.ts`, mirror config/credentials, transcription paths.
- Not covered by it (from `grep homedir()` across `hub/src` and `vault/src`):
  - module and manifest discovery under `$BUN_INSTALL` / `~/.bun/install/global/node_modules`, used at
    runtime by the token-mint scope check (`hub/src/scope-registry.ts:115-121`) as well as by install
    tooling (`hub/src/install-source.ts:66`, `hub/src/bun-link.ts:30`, `hub/src/commands/upgrade.ts:288`);
  - `~/.cloudflared` (`hub/src/cloudflare/detect.ts:7`);
  - `~/Library/LaunchAgents/*.plist` (`vault/src/launchd.ts:17`, `vault/src/backup-launchd.ts:32`) and
    `~/.config/systemd/user` (`vault/src/systemd.ts:17`);
  - `~/.claude.json` / `./.mcp.json` written by `parachute-vault mcp-install` and opt-in `init` flags;
  - the vault daemon helpers fall back to `~/.bun/bin/bun` (`vault/src/daemon.ts:115`).
- `CONFIG_DIR` is evaluated at import time (`hub/src/commands/serve.ts:33-36` notes that the `env` param
  "cannot reroute them"), so the variable must be set before the process starts. That's fine for us.
- Where the embedding model cache lives when embeddings are enabled is not something we could tell
  (`@huggingface/transformers` default cache) **(inferred: inside the package dir or `~/.cache`)**.

**Proposed interface.** `PARACHUTE_HOME` stays the one knob; in embedded mode every other path derives
from it or from an explicit flag (`--payload <dir>` for read-only code, R3). Add `PARACHUTE_CACHE_DIR`
(default `<root>/cache`) for any downloaded model/asset, and refuse to start in embedded mode if
`PARACHUTE_HOME` is unset (no silent fallback to `~/.parachute`).

**Acceptance criteria.** Two embedded instances with different roots and ports run side by side on one
macOS user account without seeing each other. Deleting `<root>` returns the machine to its prior state
(apart from the OS temp dir). Nothing in `<payload>` is modified at runtime (we will mount it read-only in
CI to prove it).

### R3 — A self-contained, signable, notarizable distributable — **P0**

**Requirement.** An artifact per Parachute release that we can embed in `Contents/` of a hardened-runtime
app, sign with our Developer ID, and notarize, and that never needs the network or a package manager to
run.

**Today.**
- Install is `bun add -g @openparachute/<service>` from npm (`parachute install --help`). The hub's
  `bin` is TypeScript source (`"bin": {"parachute": "src/cli.ts"}`), run by whatever `bun` is on the
  machine; our plist pins `/opt/homebrew/bin/bun`.
- Dependencies use semver ranges (`hub/package.json`: `jose ^6.2.2`, `@node-rs/argon2 ^2.0.2`, …;
  `vault/package.json`: `@huggingface/transformers ^4.2.0`, `@modelcontextprotocol/sdk ^1.12.1`, …), so
  two installs of the same version can differ.
- Native code in the installed tree (darwin): `@node-rs/argon2-darwin-arm64/argon2.darwin-arm64.node`
  (hub, password hashing); `onnxruntime-node` (`onnxruntime_binding.node`, `libonnxruntime.1.30.0.dylib`,
  287 MB with Windows and Linux binaries included) and `sharp` + `libvips-cpp.8.18.7.dylib`, both pulled
  in by `@huggingface/transformers` for the optional embedding provider. `onnxruntime-node` relies on a
  postinstall step via `trustedDependencies` (`vault/package.json`;
  `vault/src/embedding/onnx-transformers.ts` header). Only the host arch's optional packages are present
  (`@node-rs/argon2-darwin-arm64`, `@img/sharp-darwin-arm64`).
- SQLite is `bun:sqlite` (built into bun), so no native SQLite addon.
- Runtime downloads of executable or model content exist behind features: whisper/parakeet transcription
  models from huggingface.co (`vault/src/transcription/models.ts`, `transcription/install.ts`), the
  embedding model on first `embed()` once embeddings are enabled (`vault/src/embedding/select.ts`; off by
  default).

**What we need.**
1. **Pinned, reproducible artifacts**: a release tarball per version with a lockfile and integrity
   hashes, and ideally a prebuilt `bun build --compile` single binary per arch (`parachute` covering hub +
   vault, or one binary each), published with SHA-256 sums we can verify in CI.
2. **No code written to disk and then executed.** If `--compile` embeds `.node` addons, bun extracts them
   to a temp dir before `dlopen` **(inferred from bun's documented behaviour; not tested by us)**. Under
   the hardened runtime, library validation would refuse a temp-extracted addon not signed by our Team ID,
   and we will not ship `com.apple.security.cs.disable-library-validation`. So native addons must load from
   a fixed path inside the payload (`<payload>/native/*.node`) that we sign in place.
3. **A minimal native set.** Argon2 is one addon; a pure-JS or WebCrypto fallback would remove it. The
   embedding stack (onnxruntime + sharp) should be a separate optional package so the base embedded
   payload has none of it; we would ship it only if we enable vault embeddings.
4. **Entitlements, documented.** We expect bun needs only `com.apple.security.cs.allow-jit`
   (JavaScriptCore JIT). Please confirm whether `allow-unsigned-executable-memory` is ever needed (JSC
   should not need it with `allow-jit`, but we would rather know). No network-server entitlement is
   needed outside the App Sandbox; we do not plan to sandbox the host app.
5. **Both architectures.** arm64 and x86_64 builds of every native piece, so we can ship a universal app
   (`lipo` the compiled binaries) or two per-arch downloads. macOS minimum: 13.
6. **Static assets inside the payload**: the hub and vault admin SPAs (`web/ui/dist`) and any font are
   served from disk; `hub/src/hub.ts` references `fonts.googleapis.com` / `fonts.gstatic.com`, which a
   loopback-only embedded hub should not load **(inferred: page-side, loaded by the operator's browser)**.

**Acceptance criteria.** `codesign --verify --deep --strict` and `spctl -a -vv` pass on a test app
containing the payload, signed with hardened runtime and only `allow-jit` on the bun/parachute binary;
`notarytool` accepts it; the app runs hub + vault on a fresh macOS 13+ VM with no network, no bun, no
Homebrew and no Xcode Command Line Tools, on both Apple Silicon and Intel.

### R4 — Non-interactive, idempotent bootstrap — **P0**

**Requirement.** One command the host runs on first launch (and safely on every launch) that creates the
hub admin and the named vault(s) and hands the operator credential to the host without it appearing in
argv, stdout, logs or a world-readable file.

**Today.**
- First-boot admin seed: `PARACHUTE_INITIAL_ADMIN_USERNAME/PASSWORD`, "boot-time idempotent — ignored once
  an admin exists" (`parachute serve --help`). Without them the hub enters wizard mode and prints a
  bootstrap token to its log (`hub/src/bootstrap-token.ts`).
- First vault: `parachute init --vault-name <name>` runs `parachute-vault create <name>` and tolerates
  "already exists" (`parachute init --help`). `parachute-vault create <name> --json [--mint --scope
  read|write]` emits `{name, token, paths, set_as_default}`; admin is not mintable from `create`
  (`parachute-vault --help`). The vault also auto-creates a default vault at boot unless
  `auto_create: false` is set in `config.yaml` (`vault/src/config.ts` `bootAutoCreateAllowed`).
- New vaults default to an internal git mirror ("backup on by default") unless `--no-mirror` or
  `default_mirror: off` (`parachute-vault --help`). That shells out to `git` (`vault/src/git-preflight.ts`).
  On a Mac without the Command Line Tools, `/usr/bin/git` is a stub that opens Apple's installer dialog
  **(inferred: standard macOS behaviour)**, which is not acceptable mid-setup.
- The operator credential is written to `<root>/operator.token` (mode 0600) by
  `parachute auth rotate-operator` and the `init` path (`hub/src/commands/auth.ts`,
  `hub/src/commands/init.ts:519-540`). Our `~/.parachute/operator.token` is 0600, as documented.
- `set-password --password <pw>` takes the password on argv (`parachute auth --help`), where other local
  users can see it in `ps`.

**Proposed interface.**
```
parachute bootstrap --embedded --home "<root>" \
  --admin-username owner --admin-password-fd 3 \
  --vault default [--vault other …] \
  --no-mirror --no-auto-create \
  --operator-token-out "<root>/operator.token"   # 0600, created O_EXCL|O_NOFOLLOW; or --operator-token-fd 4
  --json
```
Output (stdout, JSON only): `{"hub":{"created":bool,"schema":24},"vaults":[{"name":"default","created":
bool,"schema":32}],"operator":{"jti":"…","path":"…","created":bool}}`. Re-running with the same arguments
changes nothing and reports `created:false`. Secrets come in over fds/files (`--admin-password-file`,
`PARACHUTE_INITIAL_ADMIN_PASSWORD_FILE`) as well as env, never argv. In embedded mode, the wizard-mode
bootstrap token is never generated or printed; the hub refuses to start without an admin rather than
opening an unauthenticated `/admin/setup`.

**Acceptance criteria.** From an empty root with no network: one `bootstrap` call then `serve` gives a
ready hub, vault `default` (history per `vault.yaml` defaults), no mirror, no git invocation, an
`operator.token` at 0600, and no secret in stdout, stderr, the log or `ps`. A second `bootstrap` exits 0
with every `created:false`.

### R5 — Programmatic token management — **P0**

**Requirement.** The host (or Prism's server) can mint, list and revoke scoped tokens, including
ephemeral admin tokens, through a stable API with JSON output, without linking Parachute code or opening
`hub.db` itself.

**Today.**
- `parachute auth mint-token --scope … [--ephemeral | --expires-in <s>] [--service <name>]` opens
  `hub.db` directly in the CLI process, signs with the stored key, writes a registry row and prints only
  the JWT on stdout (`hub/src/commands/auth.ts` `runMintToken`, ~lines 1198-1441). No `--json`, no `jti`,
  no `exp` in the output. Default lifetime 90 days; `--ephemeral` 1 h.
- An HTTP route exists: `POST /api/auth/mint-token`, bearer-gated by capability attenuation
  (`parachute:host:auth`, `parachute:host:admin`, or same-vault `vault:<N>:admin`), writing the same
  `tokens` row (`hub/src/api-mint-token.ts` header). We have not seen it documented as stable.
- `parachute auth revoke-token <jti>` is idempotent and refuses the live operator token without
  `--break-glass` (`parachute auth --help`). There is also `hub/src/api-revoke-token.ts`.
- Revocation reaches the vault through `/.well-known/parachute-revocation.json` with a 60 s cache;
  the vault fails **closed** if its first fetch fails (`scope-guard/dist/revocation-cache.js`), so the vault
  depends on the hub being up before it can authenticate anything.

**Proposed interface.** Declare the HTTP routes stable, versioned and documented:
- `POST /api/auth/mint-token {scope[], ttl_seconds | ephemeral, service?, label?, aud?}` →
  `{token, jti, sub, scopes, exp, iat}`;
- `POST /api/auth/revoke-token {jti}` → `{jti, revoked_at, already_revoked}`;
- `GET /api/auth/tokens?service=&scope=&active=1` → rows without secrets (for cleanup: we once leaked
  ~3,600 unrevoked write tokens from a re-minting script).

Also add `--json` to the CLI (`{token,jti,exp,…}`) so the host's CLI fallback doesn't have to decode JWTs.
A `parachute:host:auth` operator credential, held by the host, is enough for our server's minting; we
would like a narrower `parachute:host:mint` scope that can mint and revoke only `vault:*:{read,write}` and
ephemeral `vault:*:admin`.

**Acceptance criteria.** Prism's server mints a 1 h `vault:default:admin`, a 3 h `vault:default:read`
with `service=agent-session:<id>` and a 1-year `vault:default:write`, revokes one, and sees a 401 for it at
the vault within the documented latency (R15). No Prism process opens `hub.db`.

### R6 — Bind addresses, issuer, no exposure — **P0**

**Requirement.** Hub and vault listen on loopback only unless the host explicitly says otherwise; the JWT
issuer is a stable loopback origin; nothing in embedded mode can expose the hub or vault publicly.

**Today.**
- The hub binds `PARACHUTE_BIND_HOST || "127.0.0.1"` (`hub/src/hub-server.ts:498`); generated units
  force `PARACHUTE_BIND_HOST=127.0.0.1` (`hub/src/managed-unit.ts:737`). The vault binds `VAULT_BIND` or
  `127.0.0.1` (`vault/src/bind.ts`). Good defaults.
- The issuer is derived from `PARACHUTE_HUB_ORIGIN`, else `expose-state.json`'s recorded public origin,
  else loopback (`hub/src/commands/serve.ts` ~lines 320-360; `parachute expose --help`, `--hub-origin`).
  So running `expose` changes the `iss` of newly minted tokens; the vault accepts a set via
  `PARACHUTE_HUB_ORIGINS` (`vault/src/hub-jwt.ts:110-118`).
- `parachute init` offers exposure interactively and defaults to Cloudflare on SSH sessions
  (`parachute init --help`).

**Proposed interface.** In embedded mode: `expose-state.json` is neither read nor written; the issuer is
exactly `PARACHUTE_HUB_ORIGIN` (we will pass `http://127.0.0.1:1939`); the `expose` command and any
tailscale/cloudflared detection are disabled; a non-loopback bind needs an explicit
`--bind <addr> --i-understand-non-loopback`.

**Acceptance criteria.** `lsof -iTCP -sTCP:LISTEN` shows hub and vault on 127.0.0.1 only. A token
minted before and after a simulated hostname change keeps the same `iss`. No `tailscale` or `cloudflared`
probe runs at boot (today serve enriches PATH so such probes can find them: `hub/src/commands/serve.ts:619`).

### R7 — Version and migration contract — **P0** (version + newer-schema guard), P1 (explicit migrate)

**Requirement.** The host can ask "what version is this binary, what schema does it write, what schema is
on disk" before starting it, and a binary never runs against data written by a newer version.

**Today.**
- `parachute --version` prints `0.7.19`; `parachute-vault --version` prints `0.7.9`. No JSON.
- Migrations run implicitly on open: vault `SCHEMA_VERSION = 32` with a `migrateToVNN` chain recorded in
  `schema_version` (`vault/core/src/schema.ts:10`, ~730-765); hub `migrate()` on every `openHubDb`
  (`hub/src/hub-db.ts` header). Forward-only.
- We found no check that refuses to open a DB whose recorded schema is newer than the binary's (a
  `grep` for newer/downgrade/refuse in `vault/core/src/schema.ts` and `hub/src/hub-db.ts` found none).
  Our rehearsal confirmed that downgrading the binary over a migrated DB is unsafe.
- `parachute migrate` is about archiving legacy root files and the detached → supervised cutover, not data
  migrations (`parachute migrate --help`).

**Proposed interface.**
- `parachute version --json` → `{"hub":"0.7.19","vault":"0.7.9","schemas":{"hub":24,"vault":32},
  "min_readable":{"hub":13,"vault":22},"api":{"rest":"…","mcp":"…","subscribe":"…"}}`.
- `parachute inspect --home <root> --json` (read-only; opens DBs `mode=ro`) →
  `{"hub_schema":24,"vaults":{"default":32,…},"needs_migration":bool,"newer_than_binary":bool}`.
- `parachute migrate-data --home <root> [--dry-run] --json`: applies pending migrations and reports
  each step; `--dry-run` runs them in a transaction on a temporary copy and reports duration and outcome.
  `serve --embedded --no-auto-migrate` refuses (exit 7) when migration is needed, so migration becomes an
  explicit step after the host's pre-update backup.
- Refuse to open a newer schema: exit 6 with `{"error":"schema_newer","on_disk":33,"binary":32}`.
- Semantic versioning with the on-disk format and the REST/MCP/subscribe wire contracts in the
  compatibility promise; a CHANGELOG section per release titled "On-disk and wire changes".
- Documented rollback path: restore a pre-migration backup with the previous binary (that is what we do).
  A down-migration is not required.

**Acceptance criteria.** Our compatibility suite (section 5) runs `inspect` on fixtures from every
supported prior version, `migrate-data --dry-run` reports without modifying them, and an old binary
pointed at a migrated fixture exits 6 without writing.

### R8 — File permissions for secret-bearing state — **P0**

**Requirement.** Every file holding a secret or private data is created 0600 inside 0700 directories,
whatever the umask.

**Today (observed modes only; contents not read).** `~/.parachute` is 0755. `hub.db` (and `-wal`/`-shm`)
are 0644; `hub.db` holds `signing_keys.private_key_pem`, the RSA key that signs every JWT
(`hub/src/hub-db.ts:44-52`, `hub/src/signing-keys.ts`), plus TOTP secrets (`hub-db.ts:348`). Vault
`data/<name>/vault.db` is 0644 in a 0755 dir. `operator.token` is 0600, and vault `config.yaml`/`.env`
are written 0600 (`vault/src/config.ts:1610-1613, 1711`), which is good. On a multi-user Mac, today's
defaults let any other local account read the signing key and every note.

**Acceptance criteria.** After bootstrap + a day of use, `find <root> -perm +044` returns nothing and
every directory is 0700. Existing installs are tightened on start (`chmod`), not only at creation.

### R9 — No network calls unless a feature asks for them — **P0**

**Requirement.** An embedded hub+vault makes no outbound connection at start or in steady state.
Anything that needs the network (embedding model download, transcription models, git mirror push, version
checks) is off by default in embedded mode and enabled by explicit config.

**Today.** We found no telemetry or analytics code (`grep` for telemetry/analytics/sentry/posthog). The
outbound paths we found are feature-gated: the npm registry dist-tags lookup for the module list
(`hub/src/api-modules.ts:419-425, 632`, 3 s timeout); Hugging Face model downloads (embeddings, opt-in;
transcription install); GitHub API for mirror setup (`vault/src/github-device-flow.ts`); an optional
external embedding API (`vault/src/embedding/external-api.ts`). JWKS and revocation fetches are local
(loopback by default, `vault/src/hub-jwt.ts:105-109`). We have not traced every path, so we would like the
guarantee to come from you rather than from our grep.

**Proposed interface.** `--offline` (implied by `--embedded`): every outbound fetch goes through one
guard that refuses non-loopback hosts unless the feature that needs it is enabled. Log one line per
refused attempt.

**Acceptance criteria.** With a firewall that drops all non-loopback traffic, a 24 h soak of hub + vault
under Prism's normal load logs no refused attempts and has no failures.

### R10 — Licence for bundling — **P0 (legal)**

All five packages are **AGPL-3.0** (`package.json` `license`, `hub/LICENSE`). We intend to ship
Parachute **unmodified** inside a notarized app distributed outside the App Store, with a link to the
exact corresponding source and the licence text in the app's About/Acknowledgements, and to run it only
on loopback behind Prism's own server. Questions for you (or your counsel):
1. Do you consider that compliant as-is (AGPL §6 conveyance with source; §13 for network interaction, given
   users reach Prism, not Parachute directly)?
2. If we need to patch Parachute before an upstream release, is publishing our patch set alongside the
   source link sufficient?
3. Would you offer a separate commercial/embedding exception if Prism's licence ends up incompatible?
   (Prism's own licence is not settled yet; the repository has no LICENSE file today.)
4. Do bundled third-party parts (onnxruntime, sharp/libvips, argon2) carry notices you already aggregate?

### R11 — Consistent online backup — P1

**Requirement.** A documented way to take a consistent snapshot of hub + all vaults while running (WAL
included), and to restore it next to Prism's own DB snapshot.

**Today.** `parachute-vault backup` snapshots vaults with `VACUUM INTO` ("safe against concurrent readers
and writers under WAL", `vault/src/backup.ts` header and `:190-206`), assembles a tarball, and has
retention and launchd scheduling (`vault/src/backup-launchd.ts`, which we would not use). We did not find
an equivalent for `hub.db`, nor an HTTP trigger. Our own script opens the SQLite files with the online
backup API, which bypasses your abstractions; we would rather call yours. The hub reopens or exits when its
DB inode changes underneath it (`hub/src/hub-db-liveness.ts`), which is good for restore-in-place but
should be part of the documented contract.

**Proposed interface.** `parachute snapshot --home <root> --out <dir> --json` (hub + every vault +
`vault.yaml`s + `services.json`, each DB via `VACUUM INTO` or the backup API, plus a manifest with schema
versions and SHA-256s), runnable while `serve` is up, and `parachute restore --home <root> --from <dir>`,
which requires `serve` to be stopped. Equivalent loopback HTTP endpoints authenticated by the operator
credential would let the supervisor do it without a second process.

**Acceptance criteria.** Snapshot under write load, restore into an empty root, `doctor` passes, every
token valid at snapshot time still validates, and the vault `updatedAt` values match those in the
snapshot.

### R12 — Logging — P1

**Requirement.** Logs go to stdout/stderr (the host captures and rotates them), or to a configurable dir
with size-bounded rotation. One structured format option.

**Today.** The supervisor multiplexes module output into the hub's stdout with `[<service>]` prefixes;
under launchd that becomes `~/.parachute/hub/logs/hub.log` (`parachute logs --help`). We found no
rotation for these streams. On our host: `hub.log` is about 1.5 GB, `vault/logs/vault.err` about 490 MB,
`vault.log` about 105 MB.

**Proposed interface.** `--log-format json|text`, `--log-level`, and in embedded mode nothing written to
`<root>/*/logs` unless `--log-dir` is given. Never log token values, passwords, bootstrap tokens or note
content at info level.

**Acceptance criteria.** With `--embedded`, all output arrives on stdout/stderr; no log file grows under
`<root>`; a log scan after the compatibility suite finds no JWT-shaped strings.

### R13 — Cheaper bulk reads — P1

**Requirement.** Trusted callers can list without paying for per-note schema validation, and can page
large listings predictably.

**Today.** Every `GET /notes` list computes `validation_status` for every returned note via
`store.validateNoteAgainstSchemas`, unconditionally (`vault/src/routes.ts` ~2170-2195). The vault is a
single process; on 2026-09-30 a few concurrent full-vault lists (about 16 MB, 14k notes) on a host already
swapping stalled the vault for minutes. We mitigated it on our side (request coalescing, a subscribe-fed
projection). `limit`/`offset`/`cursor` exist and are validated (`routes.ts` ~555, 1087-1178).

**Proposed interface.** `?include_validation=false` (or `validate=0`) honoured for tokens with
`vault:<name>:write` or higher, and skipped automatically when `include_metadata` excludes all schema'd
fields; a documented stable cursor order for `updated_at` (`updated_at_ms`, id) — v26 already added it.
Longer term: do request handling off the main thread for large lists, or bound the time a list may hold it.

**Acceptance criteria.** On a 15k-note vault, a lean list with validation off is at least 3× faster than
today and doesn't delay a concurrent single-note `GET` by more than 100 ms.

### R14 — Multi-vault per hub — P1

Keep it (we run 9). Embedded needs non-interactive `vault create|list|remove --json` that never prompts,
never mints unless asked, honours `--no-mirror`, and `remove` that goes through the hub's identity
cascade (it does today per `parachute --help`), plus per-vault `history:` config written at create time.

**Acceptance criteria.** Create three vaults, list them, remove one, all with JSON output and exit 0, and
the removed vault's tokens are refused within the revocation latency.

### R15 — Revocation latency — P2

**Requirement.** A knob for the vault's revocation cache TTL, or a push signal from hub to vault on
revoke.

**Today.** 60 s TTL, fail-open with last-good cache on later fetch failures, fail-closed on the first
(`scope-guard/dist/revocation-cache.js:10-36`). `createScopeGuard` accepts `ttlMs`, but the vault does not
pass one (`vault/src/hub-jwt.ts:110-118`), so it can't be configured today.

**Proposed interface.** `PARACHUTE_REVOCATION_TTL_MS` (floor 1 s), or a loopback hub → vault notification
that invalidates the cache immediately; either is fine.

**Acceptance criteria.** With TTL 5 s, a revoked token is refused within 6 s.

### Also useful (not blocking)

- A stable, documented `parachute-vault serve --embedded` that we could run as a sibling of the hub
  (R1 `--supervise-modules=none`) with `PARACHUTE_HUB_JWKS_ORIGIN` pointing at the hub.
- `doctor --json` (exists) with a stable schema, so our menu-bar health can show Parachute's own verdict.
- Per-vault expiry warnings in an admin API (we hit an expired registry token silently in September).

---

## 4. Open questions for the Parachute team

1. **Shape.** Do you prefer an `--embedded` flag on `serve`, a separate entry point, or a distinct build?
   Should the hub keep supervising the vault in embedded mode, or would you rather the host run both?
2. **Single binary.** Is `bun build --compile` viable for the hub + vault today (dynamic imports, the
   `bundle-serve.ts` shim, SPA assets, `bun:sqlite`)? If not, what is the blocker, and would a vendored
   tarball with a lockfile, plus a pinned bun, be a supported alternative?
3. **Native addons.** Can Argon2 move to a pure implementation (or WebCrypto/scrypt), and can the
   embedding stack (onnxruntime, sharp) become an optional package?
4. **Module discovery.** Is the scope registry's walk of `$BUN_INSTALL/install/global/node_modules`
   (`hub/src/scope-registry.ts`) required at runtime, or does the `installDir` stamped in `services.json`
   cover it? What should an embedded payload layout look like?
5. **Schema guard.** Is there already a newer-schema check we missed? If not, would you accept a PR?
6. **Issuer.** Is a fixed loopback `iss` safe with your OAuth/door contract when the hub is never exposed?
   Any plan that would require the hub to have a public origin for normal vault use?
7. **Operator credential.** Is a narrower minting scope (`parachute:host:mint`) acceptable in your scope
   model, and can the operator token be read from an fd/env instead of only `<root>/operator.token`?
8. **Wire stability.** Which of REST, MCP tool names, subscribe frames and `vault.yaml` keys do you consider
   public API today, and what deprecation window do you use?
9. **History limits.** Is the 2,000,000-byte update ceiling with history on (413 `history_overflow`)
   permanent, configurable, or going to rise?
10. **Release cadence + channels.** If we pin one version per Prism release, how long will you
    backport security fixes to a `latest` line? Is there a security contact and an advisory channel?
11. **Licence.** The four R10 questions.
12. **Release artifacts.** Would you publish per-arch release artifacts with checksums (and optionally a
    signature) on GitHub Releases, so our CI never pulls from npm at build time?

---

## 5. Proposed milestones and how Prism will test pre-releases

### Milestones

| M | Parachute deliverable | Unblocks in Prism |
|---|---|---|
| **M0** (now, no code) | Answers to section 4; licence position (R10) | Go/no-go on bundled mode vs "external Parachute only" for v1 |
| **M1** | R2 gaps closed + R8 permissions + R6 issuer pinning + R9 `--offline` + `serve --embedded` refusing install/upgrade/expose (R1 subset) | Prism's H1 spike can run hub + vault from a read-only payload under a hardened-runtime test app using the npm tarball and a pinned bun |
| **M2** | R4 `bootstrap` + R5 stable mint/revoke API with JSON + R7 `version --json` / `inspect` / newer-schema guard + R1 exit codes | Prism's setup wizard and token auto-rotation; the update flow's version gate |
| **M3** | R3 signed-friendly artifact (pinned tarball or compiled binary per arch, native addons at fixed paths, documented entitlements) | Notarized DMG with bundled Parachute (Prism H7) |
| **M4** | R11 snapshot/restore, R12 logging, R7 `migrate-data --dry-run`, R13 lean lists, R15 TTL knob | Coordinated backup + rollback (H6), log rotation by our supervisor, fewer vault stalls |

We can contribute PRs for any of these if you tell us which you'd accept and in what shape.

### Compatibility suite Prism will run against each pre-release

We will publish it in the Prism repo (`scripts/parachute-compat/`, to be written) so you can run it too.
It needs only a payload directory and a temp root, never touches `~/.parachute`, and refuses ports 1939,
1940 and 8787 (the same rule our existing sandbox scripts use).

1. **Packaging:** unpack the artifact, verify checksums, codesign it ad-hoc with the hardened runtime and
   `allow-jit` only, run on a read-only mount (R3); assert that no file outside the temp root changes (R2).
2. **Lifecycle:** `bootstrap --json` twice (idempotency); `serve --embedded`; `/api/ready` within 10 s;
   SIGTERM exits 0 within 10 s; each R1 exit code from its fixture; install/upgrade/expose refused.
3. **Security posture:** listeners loopback-only; file modes (R8); no outbound connections under a
   deny-all firewall (R9); no secrets in logs or `ps` (R4, R12).
4. **Tokens:** mint write / ephemeral admin / read-with-service via the HTTP API and the CLI `--json`;
   decode `iss`/`aud`/`exp`; revoke and measure refusal latency (R5, R15).
5. **Wire contract (section 2):** the REST calls Prism makes (list with every flag we use, CRUD with
   `if_updated_at`/`if_exists`, tags/links, history list/get/restore/compact, tag-schema PUT with an admin
   token and the 403 without one, 413 on a >2 MB update with history on), the subscribe socket
   (auth → snapshot → upsert/remove for writes made over REST), and MCP `tools/list` per token scope
   compared against Prism's allowlists.
6. **Prism end to end:** Prism's server test suite (`npm test`), `verify-gateway`, `verify-collab-share` and
   `verify-invite-flow` against the pre-release, as in our 0.7.9 rehearsal.
7. **Upgrade + rollback:** take fixtures produced by the previous supported release (and by our production
   versions), run `inspect`, `migrate-data --dry-run`, then migrate; check counts, tag schemas and token
   validity; point the old binary at the migrated data and expect exit 6; restore the pre-migration
   snapshot under the old binary and expect a clean boot (R7, R11).
8. **Load:** a 15k-note vault fixture; concurrent lean lists plus single-note reads; record the timings
   behind R13's acceptance numbers.

We'll report results on your issue tracker per pre-release tag, so a regression reaches you before a
`latest` promotion.

## Addendum (2026-10-03): deleting stored attachment files

Separate from embedded mode, found while building Prism's uploads on vault 0.7.9. Deleting a note cascades
its attachment rows, but the stored file under `/storage` stays on disk, and there is no API to remove a
stored file once its note is gone (the delete routes are addressed through the note). Prism therefore
records those files as orphans it cannot reclaim. Request: either delete the stored file when the last
attachment row that references it is removed, or expose an admin `DELETE /storage/<path>` (and a listing of
unreferenced stored files) so a host can reclaim the space. Acceptance: after deleting a note with an
attachment, the file is gone, or one admin call removes it and `doctor` reports no unreferenced files.
