---
name: Prism Setup (driver)
description: "Set up Prism end to end, or finish one step of it, by driving `prism setup` — one resumable, idempotent run that reports a JSON event per step (done / skipped / needs-person / failed). The step ids are the ones the app's setup checklist shows (Workspace settings → Server). Each step id maps to one prism-setup-* skill. Safe to re-run."
version: 0.4.0
---

# Prism Setup — driving `prism setup`

You take a person from nothing to a working Prism, or finish the one step they hand you. You do
not do the work by hand: the host CLI does it. **`prism setup` is the whole setup** — every step
checks before it acts, so running it again is always safe, and it never needs secrets from you.

Your job: run it, read its events, say each `next` to the person in your own words, do what they
agree to, and run it again from where it stopped.

## The loop

1. Find the CLI. A host install has `~/Library/Application Support/Prism/Host/bin/prism`.
   Before the install, use the unpacked bundle's `./prism-host-*/bin/prism`.
2. Preview once: `prism setup --dry-run --json`. Nothing is written, spawned or opened.
3. Run: `prism setup --json` (add `--owner-email <email>` when the install step asks for it).
4. Read stdout: **one JSON line per step**, then one final object.
   - Step line: `{"event":"step","id","title","state","detail","next","changed","commands","skill","blocking"}`.
   - Final object: `{"ok","command":"setup","code","steps","complete","stoppedAt","resumeFrom","pending","next"}`.
5. Act on each state:
   - `done`: say nothing, or one line if something `changed`.
   - `skipped`: nothing to do (a dry run, or an optional step).
   - `needs-person`: say its `next` to the person and wait for them. If the step carries
     `commands`, a `who: "agent-with-consent"` command is one you may run **after the person says
     yes**. A `who: "person"` command is theirs to run in Terminal; never run it for them.
   - `failed`: say its `next`, fix what it names (or ask), then resume.
6. Resume: `prism setup --json --from <resumeFrom>`. Repeat until `complete` is true and
   `pending` holds only steps the person has chosen to leave for later.

Exit codes: 0 = the run finished (person steps may still be pending); 12 = it stopped at a step
only the person can do; 4 / 5 / 1 = a step failed (its `next` says why). All codes are in
`docs/host-bundle.md`.

## The steps, in order

| Step id | What it checks / does | Who | Details |
|---|---|---|---|
| `machine` | macOS 14+, Apple silicon, not root, the server port free, 2 GB free disk (`prism doctor`) | CLI | `prism-setup-server` |
| `install` | The host bundle is installed (`prism install`, launchd agent written, not started). Needs `--owner-email` the first time. | CLI; the person says which email | `prism-setup-server` |
| `vault` | Parachute answers (Parachute's own unit is reused) or Prism runs stock Parachute under its own hub agent; records the Parachute binaries as explicit paths. If Parachute is missing, it gives the install commands. | the agent with consent, then the person (`parachute auth set-password`, in Terminal) | `prism-setup-vault` |
| `secrets` | `SECRETS_KEY` and the other server secrets are in `.env` (adds only what is missing, never replaces one) | CLI | `prism-setup-server` |
| `vault-token` | The server holds a vault write token the vault accepts; mints one straight into `.env` (`prism token mint`) | CLI | `prism-setup-vault` |
| `schemas` | The vault has Prism's tag schemas; seeds what is missing with a short-lived admin token | CLI | `prism-setup-schema` |
| `server` | Prism Server runs and answers its version (`prism start`) | CLI | `prism-setup-server` |
| `owner` | The owner has signed in and set a password. Opens a one-time sign-in link in the browser on this Mac. | the person | `prism-setup-server` |
| `mac-client` | Prism Client is in Applications | the person downloads it | `prism-setup-reach` |
| `device` | A phone or another computer is signed in (a phone: **Pair a phone** on the checklist, scan the QR with the iPhone Camera) | the person | `prism-setup-reach` |
| `reachable` | The server has an https address another device has opened (`prism reach`) | the agent with consent, then the person on the phone | `prism-setup-reach` |
| `integrations` | Optional connections. Only the person's choice; skippable. | the person, in the app | `prism-setup-integrations` |

The steps from `owner` on are the **server's own checklist** (Workspace settings → Server): the
CLI reads it, so the run and the app always agree. The checklist also has `agent-token` and
`agent-connected` (an agent's own access token: `prism-setup-agent`) and `email` (optional emailed
sign-in links and invitations: `prism-setup-server` § Email); `prism setup` lists connected
`integration:<kind>` steps and `email` under `integrations`.

## How you are often called

The app's checklist has **Have your agent do it** on each step. It hands you a prompt like:

```
Help me finish setting up Prism. Use the prism-setup skill.
Step: reachable — Reachable from other devices.
Where it stands: This server answers on this computer only. …
My Prism server: http://localhost:8787
```

Run `prism setup --json --from <that step>` and handle **that step only**. Say what you are
about to change before you change it. The checklist re-reads the server every few seconds and
ticks the step by itself. For `agent-token` / `agent-connected` (not a `prism setup` step), use
`prism-setup-agent`.

## Rules that hold for every step

- **Never paste a secret, a sign-in link or a token into this conversation**, and never print one
  into the transcript. `prism setup` and `prism token` never show one: tokens go straight into the
  install's `.env` (0600). If a command would print a secret, do not run it.
- **Never ask the person for a password or API key.** The vault admin password is typed by the
  person into `parachute auth set-password` in Terminal; integration credentials go into the app.
- **Ask before installing anything** (bun, Parachute, Tailscale) and before anything public
  (`prism reach funnel`). Say what it is and why.
- **Never rotate a secret that exists.** `prism setup` only adds missing keys. A new `SECRETS_KEY`
  would make every stored connection unreadable.
- **A packaged install is run with `prism`**: `prism status --json`, `prism restart`, `prism logs`
  — never npm or pm2 (`docs/host-bundle.md`).
- **Say what you cannot do**: an OAuth consent screen, buying a domain, approving a device on the
  person's phone, creating a key in a vendor's dashboard, typing their password. Do what leads up
  to it, say exactly what the person must do, then run `prism setup --from <step>` again.

## A checkout instead of a host install

Developing from a clone of this repository (no `prism` command): follow `docs/onboarding.md`
§ "By hand" — `prism-setup.ts`, `npm run seed`, `npm run dev`, `npm run signin -w @prism/server`.
The step ids and checks are the same.

## Finished

`prism setup --json` ends with `complete: true`, and the only `pending` steps are ones the person
chose to leave. A second run reports every step `done` (or `skipped`) with nothing `changed`.
