---
name: Prism Setup (orchestrator)
description: "Set up a complete Prism end to end — Parachute vault + token, Prism Server, tag schemas, desktop config, and chosen integrations (Matrix, Google, Notion, Anthropic, transcripts). Runs the per-domain prism-setup-* skills in dependency order and prints a final status table. Idempotent: safe to re-run."
version: 0.1.0
---

# Prism Setup — orchestrator

You guide a user from nothing to a fully working Prism. You do **not** do the
work inline — you run the per-domain skills in the right order, detect what's
already done, and report. Each domain skill is conversational, drives existing
machinery, writes a concrete config artifact, and ends in a pass/fail verify.

## When to use

A user says "set up Prism", "get me started", "configure my Prism", or runs
`/prism-setup`. Also use it to re-check an existing install (it's idempotent).

## The domains (hard dependency order)

1. **`prism-setup-vault`** — a running Parachute vault + a minted write token.
   Everything else needs this. (token → `PARACHUTE_TOKEN`)
2. **`prism-setup-server`** — `apps/server/.env` + secrets; build web; run the
   server. Needs the vault + token from step 1.
3. **`prism-setup-schema`** — seed the canonical tag schemas into the vault.
   Needs a reachable vault + token. (Often already done by step 2's script.)
4. **`prism-setup-desktop`** — write `prism-config.json` + render `.mcp.json`.
   Needs the token; independent of the server otherwise.
5. **`prism-setup-integrations`** — Matrix / Google / Anthropic / Notion /
   transcripts. Each is optional; only do the ones the user wants.

## Procedure

1. **Detect state first.** Before running a domain, check its verify (e.g. is
   `apps/server/.env` present and does the server answer on `:8787`? does
   `mcp__parachute-vault__vault-info` work?). Skip a domain whose verify already
   passes and report it "already configured".
2. **Ask which integrations** the user wants (step 5 is à la carte). Don't
   configure services they didn't ask for — background services are config-gated.
3. **Run the domains in order 1→5**, invoking each `prism-setup-*` skill.
4. **Print a final status table**: domain · state (configured / skipped /
   failed) · the verify result.

## Idempotency contract (must hold)

Running this orchestrator twice in a row is safe. The second run writes nothing
new and reports every domain "already configured / unchanged". Never rotate
secrets unless the user explicitly passes `--force` to `prism-setup-server`.

## Honest limitations (state these up front — don't pretend to solve)

- It cannot **install** Parachute, a Matrix homeserver, or the `gog`/`claude`
  CLIs — it instructs, then re-checks.
- OAuth/consent (Google) and dashboard key creation (Notion, Fathom, …) are
  human actions; the skill collects + verifies, it does not magic credentials.
- Federation (`PEER_SIGNING_KEY`, peer pairing) is off by default and only
  touched on explicit opt-in — see `docs/roadmap/handoff/FEDERATION-TWO-HUB-HANDOFF.md`.

## Final acceptance

The user reaches: vault reachable + authed · server up + owner can sign in ·
tag schemas seeded (idempotent) · `prism-config.json` + `.mcp.json` valid
(`vault-info` MCP works) · every chosen integration green in Settings → Service
Status. A second orchestrator run is a no-op.
