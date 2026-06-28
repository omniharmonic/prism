# Roadmap Handoff — for a local agent with a live environment

These documents hand off the remaining roadmap work to a Claude Code agent that
**has what the authoring environment lacked**: a running Parachute vault + hub,
the desktop app, and a browser. Each doc is self-contained and separates
**CONFIGURE** (run/verify existing code) from **BUILD** (write new code/tests).

## Read in this order

1. **[TESTING-HANDOFF.md](./TESTING-HANDOFF.md)** — bring up the stack and run
   the full test suite (automated Layer A + live Layer B), then harden it
   (generalize `verify-gateway.ts`, add Playwright e2e, wire CI). Start here:
   it establishes the running environment the other two docs assume.
2. **[FEDERATION-TWO-HUB-HANDOFF.md](./FEDERATION-TWO-HUB-HANDOFF.md)** — stand
   up a *second* hub + Prism Server, build the three glue pieces, then prove a
   live edit converges hub→hub.
3. **[PLUGIN-SETUP-HANDOFF.md](./PLUGIN-SETUP-HANDOFF.md)** — build the
   comprehensive Claude plugin that sets up *every* part of Prism (vault,
   server, desktop, Matrix, Google/auth, and every integration).

## Headline findings (verified against the tree, not just claimed)

> **Update (branch `claude/roadmap-test-coverage`):** two of the findings below
> have been **addressed in-repo** — the `prism-setup` skill family now exists and
> `verify-gateway.ts` is generalized. They're kept here (struck through) for
> provenance, with ✅ pointers to what shipped. The federation client-routing gap
> is unchanged and remains the main BUILD work.

- ✅ **DONE — the `prism-setup` skill now exists** (a family of six:
  `prism-setup` orchestrator + `-vault`, `-server`, `-schema`, `-desktop`,
  `-integrations`, under `.claude/skills/`). ~~The `prism-setup` Claude skill
  does not exist.~~ Also shipped: `.mcp.json` renderer (`scripts/render-mcp.ts`
  + `lib/render-mcp.ts`, wired into `prism-setup.ts`), root `npm run setup`, and
  `npm run seed` / `render:mcp`. **Still BUILD for the local agent:** an
  automated desktop `prism-config.json` writer, the optional `validate_config`
  auth/MCP check (G6), and exposing `seedTagSchemas` as a Tauri command (G8) —
  see PLUGIN-SETUP-HANDOFF §1.3/§4 (status banner at top of that doc).
- **`prism-setup.ts` provisions the server `.env`, tag seeding, and now renders
  `.mcp.json`** — but still nothing for the vault itself, the desktop config, or
  any integration (those are the new skills' job, mostly still to be run/verified
  against a live vault).
- **Federation transport is built but never reaches the client.** The peer
  identity, pairing, and the Hocuspocus bridge all exist, but `syncSpaces()` is
  **never called** (no peer-URL registry) and both clients connect to `/collab`
  by `noteId`, not `space_note_key` — so a hub's own edits never enter the
  federated Y.Doc. These two gaps (plus a live convergence harness) are the
  blocking BUILD work — see FEDERATION-TWO-HUB-HANDOFF §0 and §3. **(unchanged)**
- ✅ **DONE — `verify-gateway.ts` no longer hardcodes note IDs.** ~~It hardcodes
  the owner's note IDs (lines 13–15).~~ The gateway section now self-provisions
  throwaway `_secgate` notes via `vault.createNote` and tears them down, matching
  the publishing section — it runs against any vault. See TESTING-HANDOFF §4.1.

## What is already done (so you don't redo it)

- The roadmap code is merged to `main` (`e541f77`): onboarding viewer-skip,
  publishing (Wiki + password gate), and the gated federation primitives.
- Automated coverage is green and runs **without a vault**: typechecks, web
  build, `cargo check`, `check:sw`, and `apps/server` `npm test` →
  **149/149** (incl. the in-process `publish.test.ts` + `federation.test.ts`
  added on branch `claude/roadmap-test-coverage`).
- On that same branch: the **`prism-setup` skill family** (6 skills), the
  **`.mcp.json` renderer** (`render-mcp.ts` + lib, wired into `prism-setup.ts`),
  root **`npm run setup`** + `npm run seed`/`render:mcp`, and a **generalized
  `verify-gateway.ts`** (self-provisioning, no hardcoded IDs). The renderer is
  unit-verified; the skills + generalized gateway need a live-vault run to
  fully validate.
- The broader testing strategy and live runbook are in
  [`../TESTING.md`](../TESTING.md); progress tracking in
  [`../PROGRESS.md`](../PROGRESS.md).
