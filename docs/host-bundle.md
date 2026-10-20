# The host bundle and the `prism` CLI

**Status:** v1 Phase 1 (docs/distribution/LAUNCH-PLAN.md § Phase 1). Built and smoke-tested on an
Apple-silicon Mac. A tag-triggered CI release job exists ([Release](#release)) with Developer ID
signing, notarization and a signed `SHA256SUMS` that run once their secrets are set — it has not
run on GitHub yet. No Parachute payload yet: Prism runs agent-installed **stock Parachute** under
its own hub agent instead ([Stock Parachute](#stock-parachute-the-fallback)).

The host bundle is how Prism Server gets onto a person's Mac for v1: one tarball,
`prism-host-<version>-darwin-arm64.tar.gz`, with everything the server needs to run, and a
`prism` command that installs it, runs it under launchd, backs it up, updates it with a
rollback, and removes it. The agent (the `prism-setup` skills) drives the CLI — the whole
first-run setup is one command, [`prism setup`](#setup-run-prism-setup); nobody needs
Node, npm, pm2 or a checkout of this repository.

## Build

On an Apple-silicon Mac, from the repository root, with `npm ci` done:

```bash
npm run build:host                         # → packaging/host/out/
npm run build:host -- --skip-web-build     # reuse apps/web/dist + dist-native
npm run build:host -- --allow-dirty        # build uncommitted files (commit id gets -dirty)
npm run build:host -- --out DIR --cache DIR --keep-work
node --import tsx packaging/host/smoke.ts packaging/host/out/prism-host-<v>-darwin-arm64.tar.gz
```

Output: `prism-host-<version>-darwin-arm64.tar.gz` and `SHA256SUMS` (`<hex>  <file>`).

What the build does (`packaging/host/build.ts`):

1. Takes the version from the **repository root `package.json`** (the one version number — see
   [Version](#version)).
2. Downloads the pinned Node runtime (`packaging/host/node.json`: Node 22 LTS) from nodejs.org
   and checks it three ways: `SHASUMS256.txt` must carry a good OpenPGP signature
   (`SHASUMS256.txt.sig`) by one of the **pinned Node.js release keys**, it must list the tarball's
   SHA-256, and that SHA-256 must equal the one pinned in `node.json`. Then it caches the runtime
   (`~/Library/Caches/prism-host-build/`). The keys are vendored in
   `packaging/host/node-release-keys/` (the active releasers' keys from
   [nodejs/release-keys](https://github.com/nodejs/release-keys) at the commit in `SOURCE.json`,
   which also pins their primary fingerprints); `build/node-signature.ts` imports only those into a
   throwaway GnuPG home, never fetches a key, and refuses a key file whose fingerprint is not
   pinned. Without `gpg` the build **fails in CI** (`CI=true` or `PRISM_REQUIRE_NODE_SIGNATURE=1`)
   and warns on a laptop (the two hash checks still apply). A new releaser signing a future Node
   release makes the build fail ("not a pinned Node.js release key"): add their `keys/<FPR>.asc`,
   the fingerprint, and the new commit to `SOURCE.json`.
3. Builds the web app twice: `apps/web/dist` (the PWA the server serves) and `dist-native`
   (what the Prism Client bundles).
4. Copies the tracked source of the server and `@prism/core`, then runs
   `npm ci --omit=dev --workspace @prism/server --workspace @prism/core --include-workspace-root`
   **with the bundled Node**, so native modules (better-sqlite3) are built for it, from the
   lockfile's integrity hashes.
5. Prunes `node_modules` to what the server can reach: esbuild walks the server's import graph
   (the entry, the conversion worker, `prism-setup.ts`, `governance-sign-existing.ts`), and the
   lockfile gives the closure of those packages, resolved the way Node resolves them
   (`packaging/host/build/prune.ts`). About 610 MB → 130 MB. The build refuses to finish if
   pruning changed what resolves.
6. Checks every `.node` file is arm64, bundles the CLI (`libexec/prism.mjs`), copies the launchd
   templates, the Parachute slot, `LICENSE.md`, `NOTICE.md`, writes `THIRD-PARTY-LICENSES.md`
   from the shipped `node_modules` + Node's own licence, and `build-info.json`.
7. Runs the bundled `bin/prism version` and loads better-sqlite3 with the bundled Node, then
   writes the tarball (no macOS metadata, owner 0:0) and `SHA256SUMS`.

Network is used at **build time only** (nodejs.org, the npm registry). Nothing in the bundle
downloads anything when it is installed or run.

**The server runs from TypeScript through tsx**, exactly as production runs it today, not from
a prebuilt JavaScript bundle. Reason: the conversion worker threads register tsx themselves and
import `.ts` files (`src/transfer/worker-boot.mjs`), and the server imports `@prism/core`'s
TypeScript (the editor schema and more). A prebuilt bundle would be a second, untested way of
running the server. Cost: the first start compiles (≈3 s on an M-series Mac); tsx caches the
result in the OS temp folder. `tsx` is therefore a runtime dependency of `@prism/server`.

## What is in the bundle

```
prism-host-<version>-darwin-arm64/
├── bin/prism                  sh shim: runs libexec/prism.mjs on runtime/node (follows symlinks)
├── libexec/prism.mjs          the CLI (packaging/host/cli, bundled by esbuild)
├── runtime/node/              Node 22 LTS: bin/node, LICENSE, README.md (no npm, no headers)
├── app/                       the server, in the monorepo layout
│   ├── package.json           the root package.json — the version /api/version reports
│   ├── package-lock.json
│   ├── apps/server/           src/, scripts/, config/ (no tests, no .env, no .db)
│   ├── apps/web/dist/         the PWA the server serves (WEB_ROOT)
│   ├── apps/web/dist-native/  the native web build (for the Prism Client)
│   ├── packages/core/         @prism/core (TypeScript; the server imports it)
│   └── node_modules/          production modules, pruned; @prism/core is a symlink
├── share/launchd/             server/hub/vault.plist.in + identity.json (the label prefix)
├── parachute/                 the Parachute payload slot — EMPTY in this bundle (README.md)
├── build-info.json            version, commit, build time, Node version + sha256, paths
├── LICENSE.md  NOTICE.md
└── THIRD-PARTY-LICENSES.md    every shipped package: name, version, licence, licence text
```

Native code in the bundle (signed by the release job, [Release](#release)):
`runtime/node/bin/node`, `app/node_modules/better-sqlite3/build/Release/better_sqlite3.node`,
`app/node_modules/tsx/node_modules/@esbuild/darwin-arm64/bin/esbuild` (tsx's compiler), its
install-time copy `app/node_modules/tsx/node_modules/esbuild/bin/esbuild`, and
`app/node_modules/fsevents/fsevents.node` (an optional dependency of tsx). The release job does not
rely on this list: `packaging/host/release/macho.ts` finds every Mach-O file by its magic number.

Not in the bundle: `@hocuspocus/provider` (federation's client, imported only when
`FEDERATION_ENABLED=true` — federation is out of scope for v1), the web UI's own dependencies,
tests, fixtures, any `.env` or database.

## Where an install lives

One root (decision D-C). Default prefix: **`~/Library/Application Support/Prism/Host`**
(`--prefix` to choose another; it must be an absolute folder of its own — never `/`, the home
folder, a system folder or `~/.parachute`).

```
<prefix>/                      0700
├── .prism-host                marker: "this folder is a Prism host install"
├── state.json                 versions installed, current/previous, history (no secret)
├── app/                       0700
│   ├── <version>/             one unpacked bundle per version (the newest two are kept)
│   └── current -> <version>   switched atomically by install/update/rollback
├── bin/prism -> ../app/current/bin/prism
├── config/                    0700 — the server's working directory
│   └── .env                   0600 — every secret; the only place they are written
├── data/                      0700
│   ├── prism-server.db        (+ -wal/-shm, media-cache/)
│   ├── agent-cwd/             the agent runner's empty working folder
│   └── DATA_VERSION           highest version that has run healthy against this data
├── logs/                      0700 — server.log (+ .1 … .5), server.launchd.log
├── backups/                   0700 — <UTC stamp>-<label>/ with MANIFEST.json
└── parachute/                 0700 — PARACHUTE_HOME when Prism owns Parachute: embedded mode, or
                               stock mode for a person with no Parachute data yet
```

Outside the prefix: only the launchd plists, in `~/Library/LaunchAgents/`.

`prism install` writes `config/.env` with the same helpers `prism-setup.ts` uses
(`apps/server/scripts/lib/env-file.ts`): fresh `SESSION_SECRET`, `CAPABILITY_SECRET`,
`COLLAB_TOKEN`, `GOVERNANCE_SIGNING_SECRET`, `SECRETS_KEY`; `OWNER_EMAIL`, `PORT`, `APP_ORIGIN`
(`http://localhost:<port>`), `PARACHUTE_URL`/`PARACHUTE_VAULT`, `DB_PATH`, `AGENT_CWD`. On a
re-run the file keeps every value it has; only missing keys are added and only the keys named
on the command line are replaced (the vault token, the Parachute paths). **An existing
`SECRETS_KEY` or `GOVERNANCE_SIGNING_SECRET` is never replaced.** The vault token is read from a
file (`--parachute-token-file`), never from the command line — or, usually, minted straight into
`.env` by [`prism token mint`](#the-vault-token-prism-token). `PARACHUTE_BIN`,
`PARACHUTE_VAULT_BIN` and `PARACHUTE_HOME` are passed through to the server when given
(`--parachute-bin` …); with `--parachute embedded`, `PARACHUTE_HOME` is `<prefix>/parachute`.
App paths (`WEB_ROOT`) are not in `.env`: the supervisor sets them from the bundle that is
running, so an update changes them.

## launchd

Prism-owned **user** agents in the GUI domain (`gui/<uid>`), one reverse-DNS prefix kept in
`packaging/host/launchd/identity.json` (the publisher's prefix; that file is in
`scripts/public-snapshot/allow.txt`):

| Label | Runs | Status |
|---|---|---|
| `<prefix>.server` | `<prefix>/bin/prism run server` | used |
| `<prefix>.hub` | `<prefix>/bin/prism run hub` | stock mode: runs the stock `parachute serve` ([Stock Parachute](#stock-parachute-the-fallback)); embedded mode: the payload (refused until it ships) |
| `<prefix>.vault` | `<prefix>/bin/prism run vault` | embedded mode only (placeholder). **Not written in stock mode**: the hub's own supervisor runs the vault there |

Every plist: `RunAtLoad`, `KeepAlive = { SuccessfulExit: false }` (a crash is restarted, a
deliberate stop is not), `ThrottleInterval` 10 s, `ExitTimeOut` 20 s, `Umask` 077,
`WorkingDirectory`, `StandardOutPath`/`StandardErrorPath` = `logs/<name>.launchd.log`, and only
two environment variables: `PRISM_HOME` and `PATH`. **A plist never holds a secret**; the
supervisor hands `config/.env` to Node with `--env-file`. Plists are 0644 (launchd refuses
writable ones) and are rewritten by `install`, `start` and `update`.

**Ordering.** launchd has no dependencies between jobs, so `prism run server` keeps the order
itself: when Prism runs Parachute (embedded **or stock** mode) it waits (≤ 120 s) for the hub's
`GET /api/ready` and the vault's `/health`, and exits **75** when they are not ready, so launchd
starts it again after `ThrottleInterval`. In external mode (a Parachute that Parachute's own unit,
or a person, runs) it waits ≤ 30 s for the vault's `/health` and then starts anyway (the server
answers 503 on `/health` until the vault is up). `stop` stops the server before Parachute.

**The supervisor** (`prism run server`, `packaging/host/cli/supervisor.ts`):
refuses to start without `PARACHUTE_TOKEN` or `OWNER_EMAIL` (exit 0 under launchd so it is not
restarted in a loop; 78 in the foreground); starts
`node --env-file=<prefix>/config/.env --import <tsx loader> app/apps/server/src/index.ts` with the
working directory `config/` (the server's "edit .env" route writes `./.env`) and an
**allowlisted environment**: only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TZ` and
`TMPDIR` are inherited (from launchd or, with `--foreground`, from your shell), minus any key the
`.env` sets, plus `WEB_ROOT` / `PRISM_HOME` / `PRISM_MODELS_CONFIG`, which the CLI sets. `node
--env-file` never overrides a variable that is already set, so a shell's `PARACHUTE_TOKEN`,
`APP_ORIGIN`, `NODE_OPTIONS` or `DYLD_*` would otherwise win over the `.env`; writes the
server's output to `logs/server.log`, rotated at 10 MB, 5 files kept; probes
`/health?live=1` every 2 s until the first healthy answer (then records `DATA_VERSION`) and
every 30 s after that; after a 120 s boot grace, **three missed probes in a row → SIGTERM,
SIGKILL after 15 s → exit 1 → launchd restarts it**; forwards SIGTERM/SIGINT, **waits for the
server's graceful shutdown** (below; SIGKILL only after 15 s, under launchd's `ExitTimeOut` of
20 s) and exits 0. The server runs in a process group of its own, so a Ctrl-C in a terminal reaches
it once, through the supervisor (twice would mean "exit now"). pm2 is not used.

## Stopping (graceful shutdown)

The server handles SIGTERM and SIGINT itself (`apps/server/src/shutdown.ts`). On the first signal,
in this order:

1. **Stop accepting.** The listener closes and idle keep-alive sockets are dropped; a request that
   still arrives on an open socket is answered `503 {"error":"shutting_down"}` + `Retry-After: 5`.
   New collab sockets and new `/api/events` streams are refused.
2. **Stop background work.** The worker tick (ingest, skills, indexes), notifications, nudges, the
   collab reconciler / unsaved sweep / access checks. Running `claude` agent children get SIGTERM;
   their turns are left as they are, and the next start's boot sweep marks them `interrupted` (and
   revokes their per-turn tokens) — as after a crash, said truthfully.
3. **Store every open collaborative document** — the only step that can lose typing. Open sockets
   are made read-only first (anything typed from then on stays in that browser and syncs after the
   restart), then each loaded document is stored through Hocuspocus's save mutex (a store already
   running finishes first). A store whose vault write fails keeps its state in SQLite
   (`collab_unsaved`), as always.
4. **Close clients**: SSE event streams end, collab sockets are closed with code 1012 (the editors
   reconnect to the restarted server), every remaining HTTP socket is closed.
5. **Stop the conversion worker threads.**
6. **Checkpoint the SQLite WAL** (`wal_checkpoint(TRUNCATE)`) and close the database.
7. Exit **0**.

One deadline covers all of it: **`SHUTDOWN_DEADLINE_MS`** (`.env`, default **8000**). When it passes,
or on a **second signal**, the server exits at once — **1** when a document store was still running
(each such document is named in `server.log`), **0** when nothing was abandoned; the database is
still checkpointed and closed on that path. The supervisor writes the server's exit code to the log
when it is not 0. Keep the deadline under 15 s (the supervisor's SIGKILL).

## Commands

All commands take `--prefix DIR`, `--json` (one JSON object on stdout: `{ok, command, code, …}`)
and `--dry-run` (report what would change, change nothing; read-only `launchctl print` still
runs). Every command is safe to run twice.

| Command | What it does |
|---|---|
| `prism setup [--from STEP] [--owner-email E] [--no-signin] [--port N] [--parachute-bin P] [--no-launchd] [--dry-run] [--json]` | The whole setup as one resumable, idempotent run (the `prism-setup` skill drives it). See [Setup run](#setup-run-prism-setup). |
| `prism token mint\|rotate\|status [--force] [--expires-in S]` | The server's Parachute vault write token, minted by the Parachute CLI **straight into `.env`** and never shown. See [The vault token](#the-vault-token-prism-token). |
| `prism doctor [--port N]` | Machine check: macOS, Apple silicon (also under Rosetta), macOS ≥ 14, not root, the server port free, ≥ 2 GB free disk. |
| `prism install --owner-email E [--port N] [--app-origin URL] [--parachute external\|stock\|none\|embedded] [--parachute-url URL] [--parachute-vault NAME] [--parachute-hub-origin URL] [--parachute-token-file F] [--parachute-bin P] [--parachute-vault-bin P] [--parachute-home DIR] [--no-launchd] [--no-start] [--no-signin] [--skip-checks] [--force]` | Doctor → folders (0700) → copy this bundle to `app/<version>` → `current` → `bin/prism` → `.env` (0600) → `state.json` → plist → `launchctl bootout` + `bootstrap` → wait for health (when a vault token is set) → **`prism signin`** (opens the owner's one-time sign-in link in the browser; `--no-signin` skips it). The result carries `signin: {opened, expiresAt}` or `{next: "prism signin", why}` — never a link. `--no-launchd` writes no plist and runs no launchctl (tests, or running it yourself). Refuses a different version over an install (use `update`). **Over kept data** (a prefix with a `.env` but no `state.json`, i.e. after `prism uninstall`) and without an explicit `--parachute`, install first runs `prism setup`'s own `vault` step (the same code), so stock Parachute's hub agent comes back — or a Parachute that runs is reused — before the server starts; the result carries `parachute: {step: "vault", state, detail, changed, next?, commands?}`. Exit codes: **0** = running and the vault answers; **11** = running but the server cannot reach the vault (`next: "prism setup --from vault"`, with the vault step's own `next`/`commands` when it needs the person); **11** with `next: "prism logs --lines 50"` = the server did not become healthy. |
| `prism signin [--print]` | Sign in as the owner without email: asks the running server (over loopback, proving host control with the host key the server wrote to `data/host-signin.key`) for a **one-time link** — single use, 10 minutes, `OWNER_EMAIL` only, usable only from this Mac — and opens it in the default browser (handed to `osascript` on stdin, never on a command line). Nothing secret is printed; `--json` gives `{opened, expiresAt}`. `--print` writes the link to stdout instead (headless Macs only; a warning on stderr: the link is a credential until used or expired). Exit 10 = server not running, 4 = refused / rate-limited / no host key. See [Owner sign-in](#owner-sign-in). |
| `prism reach status\|tailscale\|funnel\|off [--yes]` | Make the server reachable from the person's phone with Tailscale, and check it. See [Reachability](#reachability-prism-reach). `status` changes nothing in Tailscale; `funnel` needs `--yes` (public internet); exit 4 carries a `next` step for the person (install / sign in to Tailscale, turn on HTTPS certificates) or a conflict on port 443 it will not overwrite. |
| `prism status` | launchd state (pid, state, last exit), `/health?live=1`, `/health` (vault reachable), `/api/version`, versions, whether the vault token is set. |
| `prism start` / `prism restart [--timeout S] [--no-wait]` | `bootstrap` if not loaded, else `kickstart` (`-k` for restart); then wait for health. |
| `prism stop` | `launchctl bootout` of the agents (server first). They start again at the next login; `uninstall` removes them. |
| `prism logs [--lines N] [--follow] [--file server\|launchd\|hub\|hub-launchd]` | Last N lines across the rotated files; `--follow` follows rotation. `hub` = stock Parachute's output (`logs/hub.log`). |
| `prism backup [--label L] [--keep N] [--parachute-home DIR]` | Online SQLite backup (the `.backup` API, then made a single file and `integrity_check`ed) of `prism-server.db`, and — when Prism owns Parachute, or `--parachute-home` names it — `hub.db` and every `vault/data/*/vault.db` together; plus `.env`, `state.json`, `DATA_VERSION`, `vault.yaml`. Folder 0700, `MANIFEST.json` with sizes, SHA-256 and integrity. Retention (only after a verified backup): newest 5 (`--keep`), plus any label containing `keep` or `baseline`. |
| `prism update <tarball> [--sums FILE] [--sig FILE] [--force] [--timeout S] [--allow-unsigned]` | See [Update and rollback](#update-and-rollback). |
| `prism uninstall [--delete-data --yes]` | `bootout` + remove the plists, `app/`, `bin/`, `state.json`. **Keeps `config/`, `data/`, `logs/`, `backups/`, `parachute/`.** To put it back: `prism install` from a bundle. `state.json` (which said "stock") is gone, so install runs setup's `vault` step itself and restores Prism's hub agent before the server (exit 0, vault reachable); if Parachute cannot be brought back (its CLI was removed, say), install ends **11** with `next: "prism setup --from vault"` and the step's own instructions. Then `prism setup` as usual for anything else. An older bundle than the data's `DATA_VERSION` is refused (6). `--delete-data` removes the whole prefix and needs `--yes`; a folder without the `.prism-host` marker is never removed. |
| `prism run server\|hub\|vault [--foreground]` | What the launchd agents run. `--foreground`: output to the terminal, no log files. In stock mode `run hub` runs `parachute serve` (`--dry-run` prints the command and the file modes it would tighten) and `run vault` exits 0 (the hub runs the vault). |
| `prism version` | The bundle's `build-info.json`. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done, or nothing to do. |
| 1 | Unexpected failure (the message says what). Also: the pre-update backup failed — nothing changed. |
| 2 | Bad command line. |
| 3 | No host install at this prefix. |
| 4 | A precondition failed: unsupported machine, port in use, wrong command for this state (e.g. `install` of another version, `start` of a `--no-launchd` install, `--parachute stock` beside Parachute's own unit), or another `prism` command holds the lock (or another `prism setup` holds the run lock). |
| 5 | A checksum or integrity check failed (tarball SHA-256, bundle platform, backup integrity). Nothing was changed. |
| 6 | Refused by the version gate: a downgrade over newer data. `--force` overrides. |
| 7 | The new version did not become healthy; the previous one was restored and is healthy. |
| 8 | The new version failed **and** the rollback did not become healthy. Needs a person. |
| 9 | A destructive step needs `--yes`. Nothing was changed. |
| 10 | Installed, but the server is not running. |
| 11 | Running but not healthy: the vault is unreachable, or another version answers. |
| 12 | `prism setup` stopped at a step only the person can do; its `next` says what. Resume with `--from <step>`. |
| 75 | `prism run`: Parachute is not ready yet — launchd tries again. |
| 78 | `prism run --foreground`: the configuration cannot start a server (no vault token / owner). |

## Setup run (`prism setup`)

One run takes a Mac from an unpacked bundle to a working Prism (launch plan Phase 2, "One
resumable skill run"; `packaging/host/cli/setup.ts`). Every step **checks before it acts**: a step
that is already done changes nothing, so the run is safe to stop anywhere and to repeat. There is
no saved run state — each step reads the machine afresh — so `--from <step>` only says where to
start.

Step ids are `RUN_STEPS` in `apps/server/src/setup-steps.ts`. Where the server's checklist
(`GET /acl/setup`) has the same step, the id is the same; from `owner` on, the run **reads the
checklist** (`POST /auth/local/setup`, the host-key gate of `/auth/local/link`), so the run and the
app never disagree.

| Step id | Blocking | Checks | Does when needed |
|---|---|---|---|
| `machine` | yes | `prism doctor` | — (`failed`, exit 4) |
| `install` | yes | a host install at the prefix | `prism install --no-start --no-signin` (needs `--owner-email` the first time, else `needs-person`) |
| `vault` | yes | Parachute's own launchd unit; the vault at `PARACHUTE_URL`; the `parachute` / `parachute-vault` commands (`.env`, `PATH`, `~/.bun/bin`) | Parachute's own unit, or a Parachute someone else runs → **reused** (paths recorded as explicit `PARACHUTE_BIN` / `PARACHUTE_VAULT_BIN`, nothing else touched). Nothing runs → **stock mode** ([Stock Parachute](#stock-parachute-the-fallback)): vault created, the person creates the admin, Prism's hub agent. Embedded payload: its `parachute bootstrap --embedded --json`. Stock Parachute missing: `needs-person` with the install commands (bun; `bun add -g @openparachute/hub@0.7.19 @openparachute/vault@0.7.9` — the agent, with the person's yes). **The CLI never installs Parachute itself, and never runs `parachute init`.** |
| `secrets` | yes | every generated secret in `.env` | adds the missing ones; never replaces `SECRETS_KEY` or any other existing value |
| `vault-token` | yes | `PARACHUTE_TOKEN` is set and the vault accepts it | `prism token mint` |
| `schemas` | yes | a dry run of the tag-schema seed finds nothing to add | an `--ephemeral` `vault:<name>:admin` token (memory only), then the seed (additive). Vault 0.7.9 requires every tag that declares a field to agree on its type and `indexed` flag (else 422 `tag_field_conflict` for the whole tag); Prism's own schemas disagree on a few (`confidence`, `species`, `published`, …), so the seed keeps the vault's (or the earlier tag's) `indexed` flag and leaves a type-clashing declaration out — the step's detail names them (13 on a fresh vault). Notes may still carry those keys. |
| `server` | yes | `/health?live=1` + the bundle's version; `.env` unchanged in this run | `prism start` / `restart`; without launchd → `needs-person` (`prism run server`) |
| `owner` | no | checklist `owner` (a password exists) | opens a one-time sign-in link in the browser (`prism signin`; `--no-signin` to skip) |
| `mac-client` | no | `Prism Client.app` in `/Applications` or `~/Applications` | — (`next`: the download link, `PRISM_CLIENT_DOWNLOAD_URL` overrides the default) |
| `device` | no | checklist `device` | — (`next`: install Prism on the phone, follow the checklist's device step) |
| `reachable` | no | checklist `reachable` | — (`next` from `prism reach status`) |
| `integrations` | no | the checklist's `integration:*` and `email` | — (`skipped` when none: optional) |

**One run at a time (the run lock).** `prism setup` first takes `<prefix>/.setup.lock`: a JSON file
`{pid, startedAt, command}` (0600), created atomically (written to a temp file, then hard-linked
into place). Held by a live process → the run is refused before any step, exit **4**, and `--json`
carries `detail.lock` = `{path, held: true, pid, startedAt, command}`; the message says to delete
the file if no such run is going on (a pid reused by an unrelated process reads as alive — the one
residual). Left by a process that is gone, or unreadable → taken over; the result's `lock.tookOver`
names the old holder. Released when the run ends (also when a step throws) and on process exit; a
crash leaves it stale, which the next run takes over. The result carries `lock: {state:
"held-by-this-run", path, pid, startedAt}`. A **dry run takes no lock** and reports `lock.state` =
`free` · `held` (with the holder) · `stale`. A first run creates the install folder for the lock and
removes it again if it wrote nothing else there. The lock is separate from `<prefix>/.lock`, which
each changing command (`install`, `update`, `backup`, `reach`) takes for its own duration.

States: `done` · `skipped` (a dry run, nothing to do, optional) · `needs-person` · `failed`. A
blocking step that is not done stops the run (exit 12 for `needs-person`, the step's own code for
`failed`); the non-blocking steps after the server runs are reported together and the run ends 0.
`--dry-run` reports every step and writes, spawns and opens nothing.

With `--json`, stdout carries **one JSON line per finished step**, then the final object:

```
{"event":"step","id":"vault","title":"…","blocking":true,"skill":"prism-setup-vault","state":"needs-person","detail":"…","next":"…","changed":[],"commands":[{"who":"agent-with-consent","run":"…"},{"who":"person","run":"…"}]}
{"ok":false,"command":"setup","code":12,"dryRun":false,"steps":[…],"complete":false,"stoppedAt":"vault","resumeFrom":"vault","pending":["vault"],"next":"…","prefix":"…","stepIds":[…]}
```

`next` is one sentence for the agent to say. `changed` names what the step changed (env key names,
`started`, tag names) — never a value. No event carries a token, a link or a key.

## The vault token (`prism token`)

The server's long-lived Parachute token (`vault:<name>:write`, one year) is minted by the
Parachute CLI and **written straight into `config/.env`** — it is never printed, logged, returned
or passed on a command line (`packaging/host/cli/token.ts`). Every Parachute call goes through
`apps/server/src/parachute-cli.ts` (explicit binary from `.env` `PARACHUTE_BIN`, else `PATH`;
`PARACHUTE_HOME`; an env allowlist; a timeout).

| Command | Contract |
|---|---|
| `prism token status` | Reads the token's claims (not verified) and asks the vault once (`GET …/vault/<name>/api/tags`). `{set, token: {jti, exp, scope, expiresInDays}, vault: accepted\|rejected\|unreachable, fine, next?}`. Exit 0 = set, accepted (or the vault did not answer), not expired; 4 otherwise. `next` says rotate when fewer than 30 days are left. |
| `prism token mint [--force] [--expires-in S]` | `parachute auth mint-token --scope vault:<name>:write --expires-in 31536000` (+ `--json` with `PARACHUTE_CLI_JSON=true`) → one read against the vault with the new token → `PARACHUTE_TOKEN` replaced in `.env` (atomic, 0600, every other line byte for byte) → the server restarted when it is running (launchd; without launchd the result says to restart it). A working token is left alone (`action: "unchanged"`) unless `--force`; a token it replaces is revoked. A token the vault refuses is **revoked again and never written** (exit 5); a vault that does not answer → written with a warning. |
| `prism token rotate` | Mint → check (the vault **must** answer, else nothing changes, exit 4) → swap → restart → `parachute auth revoke-token <old jti>`. Not revoked when the server did not come back healthy (exit 11, said). **Parachute keeps accepting a revoked token for about 60 seconds** (its revocation cache), so the old one works that long after `rotate` returns. |

Results carry only `jti`, `exp`, `scope` (and the vault's verdict). `--dry-run` prints the
commands and spawns nothing. `prism setup`'s `schemas` step mints a one-hour `--ephemeral`
`vault:<name>:admin` token the same way (`PARACHUTE_ADMIN_TOKEN` in the environment wins), keeps
it in memory for the seed and writes it nowhere.

**Stock Parachute's issuer bug** (launch plan §3.6): `auth mint-token` takes the issuer from
`<PARACHUTE_HOME>/hub/run/hub.port`, which `parachute serve` never writes, so a hub on any port but
1939 mints tokens its own vault rejects. Prism's stock mode always runs the hub on **1939** (and the
vault on its default **1940**), where the default issuer is right, so the bug does not bite there.
A Parachute on other ports (external mode) can hit it: `prism token mint` then exits 5 and says so;
the fix is to write the hub's port into that file (the CLI does not touch Parachute's files itself).

## Stock Parachute (the fallback)

Launch plan §3.4: until Parachute's embedded mode ships, v1 runs **agent-installed stock
Parachute** (hub 0.7.19 + vault 0.7.9) under a **Prism-owned launchd agent**. Code:
`packaging/host/cli/parachute-stock.ts`, the `vault` step in `cli/setup.ts`. Measured from the
installed packages:

- **No `parachute init`.** The plan said `parachute init --no-autostart`; stock `parachute init`
  has no such flag and *always* installs Parachute's own launchd unit (`computer.parachute.hub`,
  `installAndStartHubUnit`), then opens its setup wizard. `--no-autostart` exists only on
  `parachute-vault init` (it skips the vault's standalone unit). So Prism does the pieces itself:
  `parachute-vault create <vault> --no-mirror --json` (registers the vault in `services.json`, no
  unit, no git) and the person's `parachute auth set-password` (creates the admin "owner" and
  `operator.token`, offline, straight into `hub.db`; interactive, so the password is typed in
  Terminal and never reaches the agent or argv).
- **One agent, the hub.** `parachute serve` is Parachute's foreground hub *and* supervisor: it
  starts every module in `services.json`, the vault included. A second vault process would race the
  hub's child for :1940 (Parachute's issue #580), so in stock mode Prism writes **only**
  `<prefix>.hub`; the vault is the hub's child, as Parachute designs it. `prism run vault` exits 0
  and says so. (When the hub stops, it stops its children.)
- **What `prism run hub` starts** (`stockHubCommand`, pinned by tests): `<PARACHUTE_BIN> serve`,
  cwd = `PARACHUTE_HOME`, env = `HOME USER LOGNAME LANG TMPDIR TZ LC_*` from its own environment +
  `PATH` (the CLI's folder, bun's, the agent PATH) + `BUN_INSTALL` + `PARACHUTE_HOME` +
  **`PARACHUTE_BIND_HOST=127.0.0.1`** (stock `serve` binds every interface without it) +
  **`PORT=1939`** — the same env Parachute's own unit uses, minus the unit. No secret, no
  `PARACHUTE_HUB_ORIGIN` (Parachute's unit omits it too). Output → `logs/hub.log` (10 MB × 5);
  SIGTERM/SIGINT are forwarded, SIGKILL after 15 s; a crash (or an unexpected exit 0) is a failed
  exit, so launchd restarts it after 10 s. It **refuses** (exit 0, no restart loop) without
  `PARACHUTE_BIN` / `PARACHUTE_HOME` in `.env`, and while Parachute's own `computer.parachute.hub`
  is loaded. The vault binds loopback by default (`VAULT_BIND` unset).
- **Ports: the defaults only**, 1939 (hub) and 1940 (vault). The setup step adopts stock mode only
  when `PARACHUTE_URL` is `http://127.0.0.1:1940`; on any other address it asks the person to start
  their Parachute there instead.

**Which `PARACHUTE_HOME`** (decision, `chooseParachuteHome`): one already configured (`.env`, or
`--parachute-home`) wins; else, when `~/.parachute` holds Parachute data (`hub.db`,
`operator.token`, `services.json` or `vault/`), **that folder, where it is — a person's existing
data is never moved or copied**; else `<prefix>/parachute`, inside the Prism install (backed up
with it, kept by `uninstall`, removed by `uninstall --delete-data`). `prism backup` includes the
stock home in either case.

**Existing installs are left alone.** Before anything, the step looks for Parachute's own units
(`computer.parachute.hub` / `.vault`: a plist in `~/Library/LaunchAgents`, loaded or not, or a
loaded job — read-only `launchctl print`). Found → **reused** as external: Prism records the CLI
paths and installs no hub of its own, changes no file mode, creates no vault; the step's detail
says so ("Parachute's own launchd unit … runs it; Prism reuses it and installs no hub of its
own"). A Parachute that answers on :1940 or :1939 without a unit (someone runs it by hand) is
reused the same way. A plist that is installed but not running is still Parachute's: the person
restarts it (`launchctl kickstart -k gui/<uid>/computer.parachute.hub`). If Parachute's own unit
appears **beside** Prism's hub agent, the step fails (two hubs would fight over :1939) and names
the person's command to remove one. `prism install --parachute stock` refuses the same way.

**The vault step in stock mode**, each part checked first, so a re-run changes nothing:
1. home chosen (above), created 0700 if it does not exist;
2. `parachute-vault create <vault> --no-mirror --json` when `vault/data/<vault>/` is missing;
3. file modes tightened (below);
4. `PARACHUTE_BIN`, `PARACHUTE_VAULT_BIN`, `PARACHUTE_HOME` written into `.env`, `"parachute":
   "stock"` into `state.json`;
5. no `operator.token` → `needs-person`: the person runs
   `PATH=<bun's folder>:"$PATH" PARACHUTE_HOME=<home> <parachute> auth set-password` in Terminal
   (it asks for the password twice, then `Create the first hub user named "owner"? [Y/n]` — they
   answer y); then `--from vault`. The `PATH=` part is there because the stock CLI is a bun script
   and on a fresh Mac account bun's installer does **not** put `~/.bun/bin` on PATH (it only edits
   an existing `~/.zshrc`, which a new account does not have; clean-VM run 2026-10-20). For the
   same reason every Parachute call Prism makes puts the binary's own folder first on the child's
   PATH (`withBinDirOnPath`, `parachute-cli.ts`);
6. Prism's hub agent written and loaded (without launchd: the person runs
   `prism run hub --foreground`), then a wait for the hub's `/api/ready` and the vault's `/health`.
   The server agent waits for them too (Ordering, above).

**File modes** (`tightenParachuteModes`, at every `prism run hub` start and in the setup step):
only paths stock Parachute is known to create, under `PARACHUTE_HOME`, lose group/other access
(`mode & ~077`; never widened, symlinks not followed, a path owned by another user or missing is
skipped). Folders (→ 0700): the home itself, `hub/`, `hub/run/`, `hub/logs/`, `vault/`,
`vault/data/`, every `vault/data/<name>/`, `vault/logs/`, `well-known/`. Files (→ 0600):
`hub.db`, `hub.db-wal`, `hub.db-shm`, `operator.token`, `vault/config.yaml`, `vault/.env`,
`hub/run/hub.port`, every `vault/data/<name>/vault.db{,-wal,-shm}`, and the `*.log` files in
`hub/logs/` and `vault/logs/`. Nothing else is looked at: not `services.json`, `hub-instance.json`,
`well-known/*`, `vault.yaml`, `mirror-config.yaml`, mirrors or attachments. Files the hub creates
while Prism runs it are private anyway (the plist's `Umask 077`; SQLite gives `-wal`/`-shm` the
database file's mode). A home reused under Parachute's own unit is never changed.

**Setup flow for the agent:** `vault` → `needs-person` (install commands) → the agent installs bun +
Parachute with the person's yes → `--from vault` → vault created → `needs-person`
(`auth set-password`, the person, Terminal) → `--from vault` → hub agent → `done` → `vault-token`
(`prism token mint`, with the same `PARACHUTE_HOME`) → … The person-facing flow is the same as with
embedded mode, except the one Terminal step for the admin password.

**Not done / residual:** the hub's own self-upgrade and module-install routes stay available to
Parachute's admin (stock has no `managed_by_host` refusal, E1); `parachute serve` still logs to
`hub/logs/` besides stdout; a Parachute `upgrade` the person runs by hand changes the version
under Prism. `PRISM_PARACHUTE_UNIT_PREFIX` moves the labels the detection looks for (tests and
the smoke run only).

## Owner sign-in

The installer never prints a secret; the owner's first sign-in is `prism signin`
(launch plan Phase 2; the smallest form of decision D-E's host-control path). Server side:
`apps/server/src/auth/local-signin.ts` + `routes/local-signin.ts`; client side:
`apps/server/scripts/lib/local-signin-client.ts` (shared with a checkout's
`npm run signin -w @prism/server`).

- **Host proof.** At every start the server writes 32 random bytes to
  `data/host-signin.key` (beside `DB_PATH`; `HOST_KEY_FILE` to move it), 0600, atomically,
  and refuses (local sign-in off, said in the log) when the folder is writable by others or
  belongs to another user. The key is replaced at every start, is never in `.env` (so no
  config route ever sees it) and is never sent to a browser. Reading it requires the
  install's own files — the same boundary as `.env` and the database. The CLI refuses a key
  file others can read.
- **`POST /auth/local/link`** (`Authorization: Bearer <host key>`, `Content-Type:
  application/json`, body `{}`) → `201 {url, expiresAt, expiresInSeconds: 600, email,
  localOrigin, appOrigin, appOriginIsLocal}`. Refused unless the TCP peer is loopback (the
  socket's address, not a header), no proxy header is present (`Forwarded`, `Via`,
  `X-Forwarded-*`, `X-Real-IP`, `CF-*`, `Tailscale-*`…), and the `Host` is
  `localhost` / `127.0.0.1` / `[::1]` on the server's own port → `404`; a browser
  (`Origin`, `Sec-Fetch-Site` or a cookie present) → `403`; a missing or wrong key → `401`
  (10 failures in 10 minutes lock minting for the window → `429`); 10 links per 10 minutes;
  no host key → `503`. The request names nobody: the link always signs in `OWNER_EMAIL`.
  A new link retires the previous unused one. Only the token's SHA-256 is stored
  (`local_signin_links`).
- **`GET /auth/local/signin?token=…`** — the same loopback checks (`404` otherwise, and the
  link is not touched), `Sec-Fetch-Site: cross-site` refused, 30 per 10 minutes. Spends the
  link atomically, checks it was minted for the current `OWNER_EMAIL`, sets the ordinary
  owner session cookie (not `Secure`: the local origin is plain http), then redirects: a
  native sign-in waiting in this browser → `/auth/device/continue` (as after a magic link);
  no password yet → `/set-password?next=/setup`; setup unfinished → `/setup` (Workspace
  settings → Server, the checklist); else `/`. An expired or used link →
  `/?login=local-expired`.
- **The link's origin** is `APP_ORIGIN` when that is this machine's own http address, else
  `http://localhost:<PORT>` (the session is then for that local address; for daily use the
  owner signs in at `APP_ORIGIN` with the password). Setup works there in full: the one
  origin rule (`apps/server/src/auth/origin.ts`) accepts the server's own
  `http://localhost|127.0.0.1|[::1]:<PORT>` as a request `Origin` beside `APP_ORIGIN` and
  `NATIVE_ORIGINS` — only for a request that passes the same loopback checks as the link
  (socket peer, no proxy header, loopback `Host` on this port) and names the origin it was
  sent to — so CSRF-guarded writes (notification settings, account changes, exports and imports, uploads, live actions) from the local
  address are accepted even when `APP_ORIGIN` is a Tailscale or Cloudflare https name. Any
  other localhost port, and anything that came through a proxy, is still refused. Cookies set
  on such a request are not `Secure` (they would be dropped on plain-http localhost).
- **`POST /auth/local/setup`** — the same gate as `/auth/local/link`, body `{}`: the setup
  checklist (`{ready, steps}`, exactly `GET /acl/setup`'s answer — ids, booleans, sentences, never a
  secret) for `prism setup`. A successful read is not audited; refusals are (`auth.local-setup`).
- **Audit:** `action_audit` rows `auth.local-link` and `auth.local-signin` with the link id
  only (never the token or the key).
- Not stopped (stated, as in the design's §8): any process running as the install's user
  can read the key, as it can read `.env` and the database.

## Reachability (`prism reach`)

Launch plan Phase 2 "Reachability", decision 3 (D-F): private Tailscale `serve` by default, Funnel
opt-in. Code: `packaging/host/cli/reach.ts` (CLI), `apps/server/src/reach.ts` +
`routes/local-reach.ts` (server). **Only Prism's port is ever served** — never the hub (1939) or
the vault (1940). Nothing is installed and nobody is signed in to Tailscale for the person: a
missing app, a logged-out client, MagicDNS or HTTPS certificates off, or Funnel not allowed by the
tailnet policy each come back as exit 4 with one `next` sentence for the agent to pass on.

**Tailscale CLI targeted: 1.52 and later** (the serve/funnel syntax that changed in 1.52; an older
client is refused with "update Tailscale"). Checked against 1.102.2. The CLI is the Mac app's
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`, else `tailscale` on `PATH`
(`PRISM_TAILSCALE_BIN` overrides). Read-only calls: `tailscale status --json` (state, the
machine's MagicDNS name `Self.DNSName`, its addresses `Self.TailscaleIPs`, `CertDomains`, the
`funnel` capability) and `tailscale serve status --json`. The changes, exactly:

| Move | Commands |
|---|---|
| `tailscale` (nothing served) | `tailscale serve --bg --https=443 http://127.0.0.1:<PORT>` |
| `funnel --yes` (nothing served) | `tailscale funnel --bg --https=443 http://127.0.0.1:<PORT>` |
| private ⇄ public | the current one's `… --https=443 off`, then the other's `--bg` command |
| `off` | `tailscale serve --https=443 off` (or `tailscale funnel --https=443 off`, then the serve form if a handler is left) |
| already as asked | nothing |

"Ours" = exactly one handler at `/` on `<name>:443` proxying to this server's port. Anything else
on 443 for that name is someone else's and is never changed (`tailscale`/`funnel` refuse with exit
4; `off` leaves it). After the commands the serve status is read again and must show the wanted
state. Then **only `APP_ORIGIN`** in `config/.env` is set to `https://<name>` (every other line kept
byte for byte; a public non-Tailscale `APP_ORIGIN` such as a tunnel address is replaced only with
`--yes`), the server is restarted (`kickstart -k` of the server agent; Parachute keeps running) and
waited for. `off` sets `APP_ORIGIN` back to `http://localhost:<PORT>` only when it is a `*.ts.net`
address. `--dry-run` prints the exact commands and changes nothing. Every subcommand is safe to
run twice.

**Sign-in and cookies on the tailnet origin.** Unchanged behaviour, checked: with an https
`APP_ORIGIN` the session cookie is `Secure` and HSTS is sent; `TRUST_LOCAL` defaults off;
same-origin requests need no CORS. The owner signs in at `https://<name>` with the password
(test: "on the tailnet origin the owner signs in…"). `prism signin` still signs in at
`http://localhost:<PORT>` (a non-Secure cookie for that local origin only); writes from that local
page are held to the origin rule `launch/one-origin-rule` is centralising, so daily use is the
https address.

### Verification: what "reachable" means

The server cannot know that a phone can open it. It CAN see where each request that arrives
through the proxy came from: tailscaled (on this Mac, connecting from loopback) sets
`X-Forwarded-For` to the client's tailnet address, `X-Forwarded-Host` to the name it was asked
for, `X-Forwarded-Proto: https`, and `Tailscale-Funnel-Request: ?1` for a request from the
internet through Funnel (it strips client-sent copies of that header); cloudflared sets
`CF-Connecting-IP`. So, for a request on a **loopback socket** whose forwarded host is
`APP_ORIGIN`'s, the server notes the first time it sees:

| Request | Kind | Proves |
|---|---|---|
| `X-Forwarded-For` = this Mac's own tailnet address | `self` | the name resolves on this Mac, the certificate is valid, the proxy forwards to **this** server |
| `X-Forwarded-For` = another tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48) | outside, `tailnet` | another device in the tailnet opened the address |
| `Tailscale-Funnel-Request: ?1` | outside, `funnel` | the internet reached it through Funnel |
| `CF-Connecting-IP` | outside, `cloudflare` | the request crossed Cloudflare's edge (even one from this Mac went over the public internet) |

This Mac's own addresses come from the CLI: `prism reach` posts
`{origin, mode, selfAddresses}` to **`POST /auth/local/reach`** — the same gate as
`/auth/local/link` (direct loopback socket, no proxy header, loopback `Host` on the server's port,
no browser headers, JSON, `Authorization: Bearer <host key>`; one shared proof-failure rate limit;
audited `auth.local-reach`, no client address). The origin must equal the running server's
`APP_ORIGIN` (`409 origin_mismatch` = the server was not restarted). `{origin: null}` clears it
(`off`), `{}` reads. Without that record a tailnet request is not judged at all (it could be this
Mac). Stored in `settings` `reach:v1`: the expectation and, per origin, the first `self` /
outside time — never a client's address. A new `prism reach` run clears `self` for that origin, so
it is earned again.

The CLI's check is a **hairpin**: `prism reach` GETs `https://<name>/health?live=1` from this Mac
(retried while Tailscale fetches the first certificate), then reads back what the server saw.
`verification.ok` = an answer came AND the server saw it arrive through Tailscale (`throughProxy`).
It does **not** prove another device can get in (tailnet membership, access rules, the phone
being signed in), and under Funnel it does not exercise the public path at all — on this Mac the
name resolves inside the tailnet. The result says so (`proves`, `doesNotProve`).

The checklist's **`reachable`** step is done only when `APP_ORIGIN` passes `reachableOrigin` (https,
not loopback, not a placeholder) AND an outside request was seen for **that exact origin**. With
only the self-check it says "Prism answers at … through Tailscale on this computer. Open that
address on your phone…". A local process running as the install's user could forge the headers —
the same boundary as `.env` and the database; a LAN client cannot (the socket must be loopback).

## Update and rollback

`prism update <tarball>` (`packaging/host/cli/update.ts`):

1. **Verify the signature, then the checksum.** `SHA256SUMS.minisig` (beside `SHA256SUMS`, or
   `--sig`) must verify against the release public key **shipped in the running bundle**
   (`share/minisign.pub`, copied by the build from `packaging/host/release/minisign.pub`), with
   `node:crypto` only (`cli/minisign.ts`: prehashed `ED` signatures — Ed25519 over BLAKE2b-512 of
   the file, what `minisign -S` writes — plus the global signature over the trusted comment; the
   legacy non-prehashed `Ed` form is refused). Then the tarball's SHA-256 must match its line in
   that same, verified `SHA256SUMS`. Refused (5): no key in the bundle, no signature, a signature
   that does not verify, no checksum, a mismatch. **Until the owner commits
   `packaging/host/release/minisign.pub`, builds carry no key and `prism update` refuses (fail
   closed).** `--allow-unsigned` (development builds only) accepts a missing key or signature,
   or a `--sha256` hash, and the result carries a `warnings` entry saying so; a signature that is
   present and does NOT verify is refused even then.
2. **Unpack** into `app/.incoming-*` (`tar -t` first: exactly one `prism-host-*` folder; macOS
   `tar` refuses absolute and `..` paths) and read its `build-info.json`; another platform →
   refused (5).
3. **Version gate.** Same version → no-op (0). Older than the installed version **or** than
   `DATA_VERSION` → refused (6) unless `--force`. The server's migrations are additive and have
   no down-migrations, so an older server over data a newer one has used is not supported.
4. **Back up** (`pre-update-<version>`). A failed backup stops here; nothing has changed.
5. **Place** the bundle at `app/<version>` and **switch** `current` (atomic symlink rename).
6. **Restart** the agents (`kickstart -k`, or `bootstrap`) and **wait for health**: live **and**
   `/api/version` answering the new version (≤ 120 s, `--timeout`). Each round of the wait also
   reads the server agent with `launchctl print` (read-only): when its process has **exited twice**
   (a pid seen running is gone or replaced — launchd keeps restarting a server that dies at start)
   or the agent is no longer loaded, the wait ends at once instead of after the full timeout
   (the clean-VM rollback took ≈ 140 s; now about two `ThrottleInterval`s, ≈ 20 s). One exit is not
   enough, so the instance `kickstart -k` replaced never ends it. A process that keeps running
   but does not answer yet still gets the full wait.
7. Healthy → record, `DATA_VERSION` = the new version, keep the new and the previous app trees.
   Not healthy (or the restart failed) → switch `current` back, restart, wait: healthy → **7**,
   not healthy → **8**.
   After a rollback the failed version is **never `previous`**: `previous` stays the healthy
   version that was previous before the update (or none), and `prism status` reports the failure
   as `lastFailedUpdate {version, at, reason, treeKept, status: "failed"}` (cleared by the next
   healthy update). After a healthy rollback (7) the failed `app/<version>` tree is **removed** —
   it holds no data (that is in `data/`), the tarball it came from is still where it was, and
   keeping it made `app/` hold three trees with the wrong one named as the way back. After 8
   nothing is removed (`treeKept: true`), so a person can look at it; the next healthy update
   prunes it. The current and the healthy previous trees are never removed (a forced downgrade
   to the previous version that fails keeps that tree).

`DATA_VERSION` moves only after a version answered healthy (here, or the supervisor's first
healthy probe), so a rollback is never counted as "newer data". The data itself is not rolled
back: the previous version runs over whatever the new one migrated (additive), and the
pre-update backup is there if that is not enough. An install made with `--no-launchd` is only
switched (`swapped_unmanaged`): restart it yourself.

## Version

**One number for server, web, clients and bundle: the repository root `package.json`
`version`.** `GET /api/version` reports it (`apps/server/src/app.ts` imports the root
`package.json`; the bundle keeps the monorepo layout so the same path holds there), the build
names the tarball after it, and `build-info.json` carries it. It is `0.1.0` today; setting the
v1 number (and keeping the workspace `package.json` versions, the Tauri and iOS versions in
step) is the owner's call (launch plan Phase 1, "Version policy").

## Not yet

- **No Parachute payload.** The `parachute/` slot is empty, `build-info.json`
  `parachute.bundled` is false, and `--parachute embedded` is refused. The vault plist template is
  for when it lands (launch plan §3, E1–E10). Until then: stock Parachute under Prism's hub agent
  (`stock`), or a Parachute run by Parachute's own unit (`external`).
- **The release job has not run on GitHub**, and no signing secret is set yet: everything in
  [Release](#release) is scripted and linted, not yet proven on a runner (see "Not verified" there).
- **No release key is committed yet** (`packaging/host/release/minisign.pub`): until it is, every
  build refuses `prism update` without `--allow-unsigned` (see [Update and rollback](#update-and-rollback)).
  The smoke test updates with `--allow-unsigned` and checks that the update is refused without it.
- The Mac's `claude`, `gog` and similar tools are found through the agent's `PATH`
  (`~/.local/bin`, `~/.bun/bin`, Homebrew, `/usr/local/bin`, system).

## Release

`.github/workflows/release.yml`, on a tag **`prism-host-v<version>`** (it must equal the root
`package.json` version, else the job fails) or by hand (`workflow_dispatch`; a draft release only
when `draft_release` is ticked, otherwise a workflow artifact). Runner: `macos-14` (Apple silicon).

| Step | What it proves |
|---|---|
| `npm ci`, `npm run check`, server tests | the same gates as CI, on the commit being released |
| `npm run build:host` | the bundle builds; Node's `SHASUMS256.txt` signature is **required** (gpg installed by the job if missing) |
| sign (`release/sign-bundle.sh`) | every Mach-O signed with the Developer ID, hardened runtime, secure timestamp; `codesign --verify --strict`, team id and the runtime flag checked per file; the **signed** runtime runs `release/selftest.mjs` (V8 JIT, WebAssembly, the better-sqlite3 add-on, esbuild) and `bin/prism version`; the tarball is re-packed and its `SHA256SUMS` line replaced |
| smoke (`packaging/host/smoke.ts`) | the tarball that will be published installs, runs, backs up, updates, refuses a downgrade, stops gracefully and uninstalls (no launchd) |
| notarize (`release/notarize.sh`) | Apple's notary service accepts a zip of the signed bundle (`notarytool submit --wait`; the log is printed otherwise) |
| sign `SHA256SUMS` (`release/sign-sums.sh`) | `SHA256SUMS.minisig`, verified against the committed public key in the same step |
| draft release | `prism-host-<v>-darwin-arm64.tar.gz`, `SHA256SUMS`, `SHA256SUMS.minisig` (when signed), `THIRD-PARTY-LICENSES.md` uploaded to a **draft** — a person publishes it |

Signing, notarization and the `SHA256SUMS` signature each run **only when their secrets exist**;
without them the job still builds, smoke-tests and drafts the release, says "NOT signed" in the notes
and the run summary, and prints what would have been signed. Secrets (repository → Settings →
Secrets and variables → Actions):

| Secret | What |
|---|---|
| `APPLE_DEVELOPER_ID_P12` | base64 of a `.p12` holding the **Developer ID Application** certificate + private key (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | the `.p12`'s export password |
| `APPLE_TEAM_ID` | the 10-character team id; the identity is chosen by it and every signature is checked against it (not stored in the repository) |
| `APPLE_NOTARY_API_KEY` | an App Store Connect API key (`AuthKey_<id>.p8`, role Developer), its text or its base64 |
| `APPLE_NOTARY_API_KEY_ID` | that key's id |
| `APPLE_NOTARY_API_ISSUER_ID` | the issuer id (App Store Connect → Users and Access → Integrations) |
| `MINISIGN_SECRET_KEY` | the minisign secret key file's contents, made **without** a password (`minisign -G -W -p minisign.pub -s minisign.key`) — CI has no terminal; the GitHub secret store protects it |

Notarization runs only together with signing. The identity lives in a temporary keychain for the
run and is deleted at the end; secrets reach steps only through `env`, are written to `0600` files
under the runner's temp folder when a tool needs a file, and those files are removed.

**Entitlements.** The bundled Node is re-signed with our Developer ID (so it carries our team id)
and exactly one entitlement, `com.apple.security.cs.allow-jit`
(`packaging/host/release/entitlements/node.plist`): V8 compiles JavaScript and WebAssembly to machine
code at run time into `MAP_JIT` memory, which the hardened runtime refuses without it. Node's own signed build carries six
(`tools/osx-entitlements.plist`: also `allow-unsigned-executable-memory`,
`disable-executable-page-protection`, `allow-dyld-environment-variables`,
`disable-library-validation`, `get-task-allow`); we leave those out on purpose: every add-on in the
bundle is signed with **our** team id, so **library validation stays on** and admits them while
refusing any other native code; no `DYLD_*` injection; no debugger attach. The other Mach-O files
(add-ons, esbuild) get the hardened runtime and no entitlements. Proof is the signed-runtime
self-test and the smoke test above, both before anything is uploaded. If a future Node needs more
(the self-test would fail with a code-signing crash), add `allow-unsigned-executable-memory` first —
it is the next-narrowest of Node's list — and note why here.

**`SHA256SUMS` signature: minisign.** Ed25519, a one-line public key, no keyring or web of trust to
manage, the same tool the Prism Client's Tauri updater uses (one key family to look after), and its
signatures can be checked with `node:crypto` alone — so `prism update` can verify them later with no
extra tool. (GPG: heavy, and the keys would have to be distributed; Sigstore keyless: no key to
keep, but verification needs `cosign` and Sigstore's online services.) The private key is only in
the `MINISIGN_SECRET_KEY` secret; **the public key is committed as
`packaging/host/release/minisign.pub`** (the owner generates the pair and commits the `.pub`; the
signing step fails while it is missing). The trusted comment names the version and commit. Verify:

```bash
minisign -Vm SHA256SUMS -p minisign.pub      # then
shasum -a 256 -c SHA256SUMS
```

A notarized tarball cannot be stapled (only app bundles, dmg and pkg can): Gatekeeper fetches the
ticket online the first time it assesses one of the binaries. The CLI unpacks with `tar`, which sets
no quarantine attribute, so Gatekeeper normally does not assess them at all; the signature still
binds every binary to the team, and library validation holds at run time either way.

Local checks (no signing): `actionlint .github/workflows/release.yml`,
`shellcheck packaging/host/release/*.sh`, and
`packaging/host/release/sign-bundle.sh packaging/host/out/<tarball> --list` (what would be signed).

**Not verified until the job runs on a real tag:** the keychain import and identity lookup,
`codesign` with a real Developer ID and the timestamp server, the self-test under the hardened
runtime with only `allow-jit`, `notarytool` acceptance, `minisign` on the runner, `gh release
create --draft`, and the runner's timings.

## Tests

- `apps/server/test/host-bundle.test.ts` (in `npm test`): plist generation (escaping, labels,
  no secret, `plutil -lint`), the version gate, every branch of the update/rollback state machine
  with injected effects, prefix and permission rules, the `.env` rules, the lock, backups (a real
  WAL database, retention), `node_modules` pruning, doctor, the supervisor's command, readiness
  wait (fake clock), watchdog and log rotation, and `install`/`uninstall` against a scratch prefix
  with an injected `launchctl`.
- `apps/server/test/shutdown.test.ts`: the shutdown order, a loaded document with unsaved changes
  stored on SIGTERM, the deadline bounding a store whose vault write never answers (exit 1, the
  document named), a second signal (no clock: the deadline is a fake timer the test fires).
- `apps/server/test/host-node-signature.test.ts`: the gpg status judge, the pinned keys, and (where
  gpg is installed) the real v22.23.3 sums + signature verifying, a tampered sums file and an
  unpinned key refused. `host-release.test.ts`: Mach-O detection, the entitlements, the workflow's
  wiring (and that no secret appears outside an `env` mapping).
- `apps/server/test/local-signin.test.ts` (the routes: loopback only, proxies and rebinding
  refused, host proof, browsers refused, single use, expiry by an injected clock, owner only,
  hash-only storage, audit, rate limits, the key file) and `apps/server/test/host-signin.test.ts`
  (`prism signin` against a fake server, and end to end against the real app);
  `apps/web/e2e-fixtures/local-signin.spec.ts` (set-password → `/setup`, `/setup` → the
  checklist, which re-reads by itself).
- `apps/server/test/host-reach.test.ts`: `prism reach` against a **fake `tailscale` executable**
  (run through the CLI's real runner; keeps a serve config + argv log in a scratch folder) —
  status fixtures (not installed, not running, logged out, too old, logged in), the exact argv per
  move, conflicts never overwritten, `--dry-run`, Funnel's `--yes`, the `.env` rewrite (APP_ORIGIN
  only), end to end against the real app (serve → restart → hairpin check → a phone's request ticks
  the step → `off`); the route (loopback + host key only, origin must be APP_ORIGIN); the request
  classifier; the checklist step; password sign-in on the tailnet origin.
- `apps/server/test/host-setup.test.ts`: the step runner as a state machine (order, blocking
  stop → exit 12, person steps reported together, failures, `--from`, dry run, idempotency); the
  shared step ids (the checklist emits exactly `CHECKLIST_STEP_IDS`, run steps reuse them, the
  checklist UI and the `prism-setup` skill name every one); `prism token` against a **fake
  `parachute` shell script** (argv logged, prepared tokens) — the token only in `.env` (0600, other
  lines unchanged), never in a result or on stdout, a refused token revoked and not written, rotate
  revoking the old jti, an unreachable vault changing nothing; the real setup steps against a
  scratch install with an injected vault and server (Parachute missing → the commands, a full run
  then a second run that changes nothing, missing secrets added without replacing `SECRETS_KEY`,
  the checklist-driven person steps, the sign-in link opened and never reported, a dry run, the
  embedded bootstrap); `POST /auth/local/setup` and its gate.
- `packaging/host/smoke.ts`: a built tarball, end to end in a scratch folder — checksum, unpack,
  doctor, a launchd `--dry-run`, `install --no-launchd`, the bundled server in the foreground on a
  free high port against a fake vault + hub (never :1939/:1940/:8787), `/health?live=1`,
  `/health`, `/api/version`, the web app, `status`, `DATA_VERSION`, an online backup, a graceful
  stop (the server's own shutdown ran, no SIGKILL), a real
  update to a re-stamped next version, the downgrade refusal, a checksum mismatch, and both
  uninstalls; also `prism token status` (set, accepted by the fake vault, the token never on
  stdout) and `prism setup --dry-run` on the scratch install (every step reported, nothing written
  or spawned, a fake `parachute` on `PARACHUTE_BIN`, the run lock reported free and not taken);
  stock mode as dry runs only (Parachute's labels moved with `PRISM_PARACHUTE_UNIT_PREFIX`):
  `install --parachute stock --dry-run` (hub + server agents, no vault agent, nothing loaded),
  `prism run hub --dry-run` on a `--no-launchd` stock scratch install (`parachute serve`, loopback,
  port 1939, the hub.db it would tighten, nothing spawned), `prism run vault` (exit 0). It never
  loads a launchd agent and never starts Parachute.
- `apps/server/test/host-parachute-stock.test.ts`: the stock hub plist and command (env, no
  secret), the home choice, Parachute's own units detected (plist only, loaded only, none), the
  mode tightening on a scratch tree (listed paths only, symlinks, dry run, idempotent), the setup
  vault step against fake `parachute` / `parachute-vault` scripts and an injected `launchctl`
  (vault created → the person's set-password → hub agent → re-run changes nothing; existing data
  used in place; Parachute's own unit reused, loaded or not; a foreign Parachute reused; both units
  → failed; dry run; no launchd), `install --parachute stock`, `prism run hub|vault`, and the run
  lock (held, stale after a real exited process, unreadable, released after a run and after a
  throwing step, refused before any step, dry run).
