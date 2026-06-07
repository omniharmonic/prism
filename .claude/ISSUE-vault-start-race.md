# `parachute start vault` double-spawns → orphaned, untracked vault process (EADDRINUSE race)

**Component:** `@openparachute/vault`
**Versions:** vault `0.5.1` (latest on npm), hub `0.6.2`, bun `1.2.17`, macOS arm64 (Darwin 25.4.0)
**Severity:** Medium — vault ends up healthy and serving, but the supervisor cannot track or manage it, so `stop`/`restart` silently fail to control the running process.

## Summary

`parachute start vault` (and therefore `parachute start` / `parachute restart vault`) spawns the vault HTTP server **twice** in rapid succession. One child binds port 1940 successfully; the second child dies immediately with `EADDRINUSE`. The supervisor records the PID of the **child that crashed**, so:

- `~/.parachute/vault/run/<vault>.pid` ends up empty/stale — no PID for the live process.
- The CLI prints `✗ vault failed to start: port 1940 is already in use`, even on a clean start where 1940 was confirmed free immediately beforehand.
- The actual server keeps running as an **orphan** the supervisor doesn't know about.

## Impact

Because the live process is untracked:

- `parachute status` shows the vault as `inactive` (PID-based) — or `active` via health probe but with an **empty PID column**, depending on timing.
- `parachute stop vault` reports `vault wasn't running (cleaned stale pid file)` while the orphan keeps holding port 1940. Lifecycle commands cannot stop or restart the real process.
- The only way to clear it is manually: `lsof -ti:1940 | xargs kill`.

## Reproduction

On macOS (bun 1.2.17), with vault 0.5.1 installed via `bun add -g`:

```bash
# 1. Ensure port is free
lsof -ti:1940 | xargs kill 2>/dev/null; sleep 1
lsof -nP -iTCP:1940 -sTCP:LISTEN   # → empty (confirmed free)

# 2. Start the vault as a single targeted service
parachute start vault
# → ✗ vault failed to start: port 1940 is already in use.
#   ...but a vault IS now listening on 1940 (the orphaned winner).

# 3. Confirm the live listener is untracked
lsof -nP -iTCP:1940 -sTCP:LISTEN   # → one bun process, listening
ls -la ~/.parachute/vault/run/     # → empty: no <vault>.pid file
parachute status                   # → vault PID column shows "-"
```

## Log evidence

`~/.parachute/vault/logs/vault.log` shows the two boots back-to-back on consecutive lines — one binds, the next throws:

```
Parachute Vault server listening on http://127.0.0.1:1940
error: Failed to start server. Is port 1940 in use?
 syscall: "listen",
   errno: 0,
    code: "EADDRINUSE"
      at .../@openparachute/vault/src/server.ts:338:20   (const server = Bun.serve({ ... }))
Bun v1.2.17 (macOS arm64)
```

This pattern (`listening` immediately followed by `EADDRINUSE`) repeats on every start/restart attempt in the log.

## Suspected cause

Something in the vault start path invokes `Bun.serve` / the server entrypoint twice for a single `parachute start vault`. Candidates worth checking:

- The start wrapper spawning the detached child more than once (e.g. a retry or a duplicated spawn), or
- `server.ts` importing/initializing in a way that runs the `Bun.serve({...})` block twice, or
- A self-register / mirror-manager step (the logs show `[self-register] already registered parachute-vault` and a `[mirror] vault "default" manager construction failed` warning near the `Bun.serve` call at `server.ts:338`) re-entering the serve path.

The PID the supervisor writes to `run/<vault>.pid` corresponds to the child that loses the race, which is why the run dir ends up without a usable PID.

## Side observation (maybe unrelated)

Earlier boots in the same log bind `http://0.0.0.0:1940` while recent ones bind `http://127.0.0.1:1940`. Flagging in case the bind-address handling is related to the double-init path.

## Workaround

```bash
lsof -ti:1940 | xargs kill          # clear the orphan
parachute start vault               # one healthy listener remains (still untracked)
```

The vault is fully functional once running (health 200, authenticated REST/MCP 200) — the bug is purely in process supervision/tracking, not in serving.
