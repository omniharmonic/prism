# Clean-VM proof of the v1 host bundle — 2026-10-20

Launch plan § Phase 3, "Clean-VM run", **machine part only**. An agent stood in for the person,
and every action ran over ssh inside a disposable VM. Nothing was installed or loaded on the
laptop, and the production Mini was not touched.

## Result

| Step | macOS 15.7.7 (Sequoia) | macOS 14 (Sonoma) |
|---|---|---|
| 1. doctor → install → `prism setup` (stock Parachute, admin via `expect`) | **pass** after 3 fixes (first run failed at `vault`, then `schemas`) | not run (disk, below) |
| 2. Headless owner sign-in, password, first page written and read back (Prism + vault + SQLite) | **pass** | not run |
| 3. Reboot → launchd brings hub, vault and server back; page still there | **pass** (server healthy ≈ 25 s after kernel boot) | not run |
| 4. Update 0.9.0 → 0.9.1 (`--allow-unsigned`); broken 0.9.2 → auto-rollback (exit 7); downgrade to 0.9.0 refused (exit 6) | **pass** | not run |
| 5. backup → uninstall (keeps data) → reinstall + setup → data intact → `uninstall --delete-data --yes` | **pass** (one doc gap: reinstall needs `prism setup`) | not run |

Two VMs were used, both cloned from the same Cirrus image:

- **Run 1** used the bundle as it is on `launch/v1` (commit `02f9006f`). It found the bugs.
- **Run 2** was a fresh clone running the fixed bundle (`0882f0dc`). It went through steps 1–5
  end to end with no workaround.

## Environment

- Host: Apple M2 Max laptop, 32 GB RAM. Tart 2.41.1.
  - The Homebrew formula `cirruslabs/cli/tart` no longer installs: "`depends_on :macos` with
    `depends_on macos:` is disabled".
  - Tart was installed instead from the signed GitHub release (`tart.tar.gz`, sha256 checked
    against the published checksums, team id 9M2P8L4D89), unpacked into
    `~/.local/opt/tart`. The project now redirects to `openai/tart`.
- Image: `ghcr.io/cirruslabs/macos-sequoia-base:latest`.
  - Download: 22.6 GB compressed; 33 GB on disk; 50 GB virtual disk.
  - Pull time: 41 min (one network drop, retried by Tart).
- VM: 4 vCPU, 8 GB RAM, `tart run --no-graphics`, ssh `admin@192.168.64.4` with `sshpass`.
  - `scp` needs `-O` (legacy protocol) on this image.
  - The image has no Homebrew, Node or bun. `expect` and `python3` (CLT) are present.
  - Auto-login gives a `gui/501` launchd domain over ssh.
- Bundle: `npm ci && npm run build:host` in the worktree.
  - `prism-host-0.9.0-darwin-arm64.tar.gz`: 72.1 MB compressed, 270.1 MB unpacked.
  - Build time: 2 min 39 s cold, 1 min 24 s warm.
  - Warning: "minisign.pub is missing" (no release key committed yet).
- Update bundles: the build was restamped the way `packaging/host/smoke.ts` does it. The bundle
  was unpacked, the folder renamed, `version` set in `build-info.json` and `app/package.json`,
  then re-tarred with `COPYFILE_DISABLE=1` and given a fresh `SHA256SUMS`.
  - **0.9.1**: the build, restamped (80.7 MB).
  - **0.9.2**: the build, restamped, with `app/apps/server/src/index.ts` replaced by
    `console.error(…); process.exit(1)` — a server that dies at start.
  - `launch/v1`'s version (0.9.0) was not changed.

## Run 2 (fixed bundle), commands and output (trimmed)

All of this ran in the VM. PATH was the VM's default (`/usr/bin:/bin:/usr/sbin:/sbin`), and no
shell profile was edited.

### 1. From nothing to a running server (19:34:50 → 19:35:26 UTC, 36 s including bun + Parachute downloads)

```
$ tar -xzf v090/prism-host-0.9.0-darwin-arm64.tar.gz
$ ./prism-host-0.9.0-darwin-arm64/bin/prism doctor --json      → code 0 (macOS 15.7.7, Apple silicon, port 8787 free, 18.9 GB free)
$ ./prism-host-0.9.0-darwin-arm64/bin/prism install --owner-email owner@vm-proof.test --no-signin --json
  → code 0, health "waiting for PARACHUTE_TOKEN", plist written + bootstrapped (server agent exits 0: no token yet)
$ prism setup --json --no-signin                                 → exit 12
  vault needs-person: "no Parachute here…"
    CMD agent-with-consent: curl -fsSL https://bun.sh/install | bash
    CMD agent-with-consent: ~/.bun/bin/bun add -g @openparachute/hub@0.7.19 @openparachute/vault@0.7.9
$ (both commands; consent assumed in the disposable VM)          → exit 0, exit 0   (bun 1.4.3; "Blocked 2 postinstalls": onnxruntime-node, protobufjs — harmless here)
$ prism setup --json --no-signin --from vault                    → exit 12
  vault needs-person, changed [vault-created, parachute-file-modes, PARACHUTE_BIN, PARACHUTE_VAULT_BIN, PARACHUTE_HOME, parachute-mode:stock]
    CMD person: PATH=/Users/admin/.bun/bin:"$PATH" PARACHUTE_HOME='…/Prism/Host/parachute' /Users/admin/.bun/bin/parachute auth set-password
$ (that command, typed by expect into zsh -f with the default PATH)
  Password for "owner": / Confirm password: / Create the first hub user named "owner"? [Y/n] y
  Created hub user "owner" … Wrote operator token … (mode 0600).  EXIT 0
$ prism setup --json --no-signin --from vault                    → exit 0
  vault done (hub agent), secrets done, vault-token done (minted vault:default:write into .env),
  schemas done: "53 added, 0 updated, 1 unchanged; 13 field declarations left out because another
  tag declares the same name with another type: entity.confidence (number; concept has string), …"
  server done (started; 0.9.0 answers), owner/mac-client/device/reachable needs-person, integrations skipped
$ prism setup --json --no-signin --from vault                    → exit 0, every step changed [] (idempotent)
```

### 2. Owner sign-in (headless) and the first page

```
$ prism signin --print            → exit 0; stderr warns the link is a credential; link = http://localhost:8787/auth/local/signin?token=<redacted>
$ curl -c jar <link>              → 302 → /set-password?next=%2Fsetup
$ curl <link> again               → 302 → /?login=local-expired        (single use)
$ curl -b jar /auth/me            → {"authenticated":true,"email":"owner@vm-proof.test","isOwner":true,"role":"owner","hasPassword":false}
$ curl -b jar -H 'Origin: http://localhost:8787' -H 'Content-Type: application/json' \
       -X POST /auth/set-password -d '{"password":"…","name":"VM Owner"}'   → {"ok":true}
  (second call → 409 password_exists; POST /auth/login with the password → {"ok":true}, /auth/me hasPassword true)
$ prism setup --json --from owner → owner done ("the owner has a password")
$ curl -b jar … -X POST /api/notes -d '{"path":"VM proof/First page","content":"# First page\n\nWritten on the clean VM.","tags":["vm-proof"]}'
  → 201 id 01M5DCZF58P7G64G27KCVC6RVN
$ GET /api/notes/<id> (session)   → same id, path, tags, content
$ GET http://127.0.0.1:1940/vault/default/api/notes/<id> (the .env token, read inside the VM, never printed) → same
$ sqlite3 …/parachute/vault/data/default/vault.db "select id,path from notes where id=…" → 01M5DCZF58P7G64G27KCVC6RVN|VM proof/First page
```

### 3. Reboot

```
$ sudo shutdown -r now
kernel boot 19:35:37 · prism agents (node supervisors) 19:35:46 · parachute serve + parachute-vault serve 19:35:58
· server node 19:36:00 · host-signin.key written 19:36:02 (≈ 25 s after kernel boot)
$ prism status --json  → code 0, hub + server running, live, vault true, version 0.9.0
$ curl /health         → {"ok":true,"vault":true}
page read back via Prism (the session cookie survived), via the vault, and in SQLite: identical.
```

### 4. Update, rollback, downgrade

| Command | Exit | Time | Evidence |
|---|---|---|---|
| `prism update v091.tar.gz` | **5** `verify_failed` | 1 s | "this install ships no release key … refusing (--allow-unsigned, development builds only)" |
| `prism update v091.tar.gz --allow-unsigned` | **0** `updated` | 7 s | warning "the signature was not checked"; backup `pre-update-0-9-1`; `current → 0.9.1`; `/api/version` 0.9.1; `DATA_VERSION` 0.9.1; page intact |
| `prism update v092.tar.gz --allow-unsigned` (server exits at start) | **7** `rolled_back` | 141 s | "0.9.2 did not become healthy: the server did not answer /health?live=1"; "rolled back: current → 0.9.1"; `/api/version` 0.9.1, vault true; launchd restarted the broken server 12 times in the 120 s window; page intact |
| `prism update v090.tar.gz --allow-unsigned` | **6** `refused` | 4 s | "0.9.0 is older than data last used by 0.9.1; refusing a downgrade over newer data (use --force)" |
| `prism update v091.tar.gz --allow-unsigned` again | **0** `unchanged` | 3 s | "0.9.1 is already installed" |

There is no release key yet (`packaging/host/release/minisign.pub` is not committed), so every
update needs `--allow-unsigned`. That is exactly what the docs say.

### 5. Backup, uninstall, reinstall, delete

```
$ prism backup --label vm-proof   → 0; prism-server.db 1.3 MB, hub.db 0.2 MB, vault.db 0.5 MB, each integrity "ok"; 1.9 MB per backup folder
$ prism uninstall                 → 0; removed 2 plists, app/, bin/, state.json; kept config, data, logs, backups, parachute; nothing listening
$ ./prism-host-0.9.0…/bin/prism install --owner-email …  (run 1)  → 6 "the data … was last used by a newer Prism (0.9.1); refusing"
$ ./prism-host-0.9.1…/bin/prism install --owner-email … --no-signin → 0, but status 11: parachute "external", no hub agent, vault unreachable
$ prism setup --json --no-signin  → 0; vault re-adopted stock ("hub-agent"), everything else unchanged; status 0, vault true
page read back via Prism (password login), the vault and SQLite: intact
$ prism uninstall --delete-data   → 9 (needs --yes)
$ prism uninstall --delete-data --yes → 0; removed both plists and the prefix; 0 Prism/Parachute processes, 0 launch agents left
```

(The parent folder `~/Library/Application Support/Prism/` stays behind, empty.)

## Bugs found and fixed (branch `launch/vm-proof`)

1. **`2faa6737` — Parachute CLI calls exited 127 (`env: bun: No such file or directory`).**
   - Where: `parachute-vault create` in the `vault` step, and `auth mint-token` for the
     schema seed.
   - Cause: the stock CLIs are `#!/usr/bin/env bun` scripts. The agent's shell had no
     `~/.bun/bin` on PATH.
   - Fix: `withBinDirOnPath` (`apps/server/src/parachute-cli.ts`) puts an explicit binary's
     folder first on the child's PATH.
   - Tests: a bun-style fake run from a PATH without its folder, plus the unit cases.
2. **`92ad4d69` — the person's `auth set-password` command failed exactly as pasted.**
   - Cause: on a new Mac account, bun's installer does not add `~/.bun/bin` to PATH. There is no
     `~/.zshrc`, so it only prints "Manually add the directory to ~/.zshrc".
   - Fix: `setPasswordCommand` now emits `PATH=<bin dir>:"$PATH" PARACHUTE_HOME=… … auth set-password`.
   - Test: the command is run by `zsh -f` with `PATH=/usr/bin:/bin` against a fake bun-script CLI
     in a folder whose name has a space.
3. **`0882f0dc` — `schemas` failed on every fresh install (422 `tag_field_conflict`).**
   - Cause: vault 0.7.9 requires every tag that declares a field to agree on its type and its
     `indexed` flag, and refuses the whole PUT otherwise. Prism's canonical
     `tag-schemas.json` disagrees with itself:
     - type: `confidence` (string label on concept/person/org/project vs number on 11
       bioregional tags), `species` (array vs string), `published` (date vs boolean);
     - index flag: `status`, `subject`, `proposal`, `at`.
   - Production never hit this, because its schemas were seeded before 0.7.9.
   - Fix (`seed-tag-schemas.ts`), deterministic: the vault's existing declarations win, then the
     earlier tag in the file.
     - A differing `indexed` flag adopts the declared flag (5 cases).
     - A differing type leaves that one declaration out (13 cases), reported as `conflicts`.
     - Fields a tag already has in the vault are never touched.
   - `prism setup`'s detail names the left-out fields, and a second run reads `done`.
   - Tests (`seed-field-conflicts.test.ts`): the canonical file seeded into a fake vault that
     enforces the 0.7.9 rule, the vault's own declarations winning, and a person's own clashing
     tag left untouched.
   - Not done (needs an owner decision): making `tag-schemas.json` itself consistent, e.g.
     renaming the bioregional numeric `confidence`. Until then those notes keep the key without a
     declared type.

Each fix was proven by run 2. With the rebuilt bundle on a fresh VM, the same flow ran clean
with the VM's default PATH.

Suites:

- `cd apps/server && npm test`: 3,495 pass, 0 fail, 1 skipped (3,496 tests).
- `npm run check`: exit 0.
- Targeted: host-setup, host-parachute-stock, parachute-cli, seed-*, vaults: 98/0 before the
  third fix, then seed 11/0.

## Doc gaps (now written into `docs/host-bundle.md` and the `prism-setup-vault` skill)

- **`auth set-password` asks three things, not two.** It asks for the password twice, then
  `Create the first hub user named "owner"? [Y/n]`. The setup step's `next` sentence now says so.
- **bun's installer does not put `~/.bun/bin` on PATH on a fresh account** (see fix 2).
- **Reinstalling after `prism uninstall` needs `prism setup`.** `state.json` held
  `"parachute": "stock"` and is removed. `install` alone therefore starts the server in external
  mode with no hub agent (status 11, vault unreachable) until the `vault` step re-adopts stock
  Parachute. Documented on the `uninstall` row. A possible code follow-up: `install` could infer
  stock mode from the kept `.env`.
- **After a rollback, the failed version's tree stays in `app/`** (three trees, not two), and
  `prism status` reports it as `previous`. A rollback takes the whole health wait (≈ 140 s).
- **The `schemas` step leaves 13 field declarations out on a fresh vault** (fix 3).

## Gaps noted, not changed

- **Headless owner password.** The sign-in redirect goes to the web page `/set-password`. Without
  a browser, the route is `POST /auth/set-password` (session cookie, `Origin` = the local origin,
  JSON). Only the browser flow is documented, which is right for people.
- **Mac Client link.** The `mac-client` step's link (`github.com/omniharmonic/prism/releases/latest`)
  answers, but the repository has **no releases** yet (the GitHub API lists 0). A person following
  it today finds nothing.
- **Backups.** `prism backup` lists three databases. The checklist's "first page synced" is shown
  by the API read-back here, not by a client.

## Disk

- Laptop free space: 168 GB at the start; 127 GB at the end.
- Used by this run:
  - Tart image: 33 GB, now deleted, see below.
  - VM clones (APFS clones): a few GB each, both deleted.
  - Worktree with `node_modules`: 1.0 GB.
  - Node build cache (`~/Library/Caches/prism-host-build`): 314 MB.
  - Tart itself: 97 MB.
- The 80 GB floor held throughout.
- **macOS 14 was not run.**
  - Sonoma needs another ≈ 31 GB on disk (22.6 GB download), which would leave ≈ 96 GB free,
    under the 120 GB required.
  - To make room I deleted the macOS 15 base image. But Time Machine's hourly local snapshots
    taken during the run still hold its blocks, so the space did not come back (free stayed at
    127 GB).
  - It returns when those snapshots expire (≈ 24 h). I did not delete the snapshots: they are the
    person's backups.
  - So neither base image is cached now. Re-running needs a fresh pull (≈ 40 min).
- Both VM clones (`vmproof15`, `vmproof15b`) were deleted, and `tart list` is empty.

## What remains unproven

- **A person following the agent.** Here a script stood in. Unproven: a real person reading the
  `next` sentences, saying yes to the bun install, and typing the password into Terminal; and
  the agent (the `prism-setup` skill in Claude) choosing the commands from the events instead of
  a fixed script.
- **GUI steps.**
  - `prism signin` opening the browser (`--no-signin`/`--print` were used; one run-1 install did
    report `opened: true` through `osascript`, unseen).
  - The `/set-password` and `/setup` pages, the checklist ticking by itself, the PWA in a
    browser.
- **Prism Client and phone.** Mac Client install and sign-in, device pairing, `prism reach`
  (no Tailscale in the VM), push.
- **macOS 14 (Sonoma).** Not run (disk, above).
- **Signed updates.** No release key exists, so only `--allow-unsigned` was exercised; a minisign
  signature that verifies has not been tested end to end in a VM.
- **The signed, notarized bundle.** This bundle was unsigned. The hardened runtime (`allow-jit`
  only) and Gatekeeper behaviour on a clean Mac are still only covered by the release job, which
  has not run.
- **Long-running behaviour.** Watchdog restarts after hours, log rotation at 10 MB, token expiry
  and rotation (`prism token rotate`) under launchd.
