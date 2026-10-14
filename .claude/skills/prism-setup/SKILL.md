---
name: Prism Setup (orchestrator)
description: "Set up Prism end to end, or finish one step of it. The steps are the ones the app's setup checklist shows (Workspace settings → Server): vault, server, secure storage, agent token, reachability, devices, and optional integrations. Each step id maps to one prism-setup-* skill. Idempotent: safe to re-run."
version: 0.3.0
---

# Prism Setup — orchestrator

You take a person from nothing to a working Prism, or finish the one step they
hand you. You do not do the work inline: each step belongs to a domain skill
that detects what is already done, changes only what is missing, and ends in a
check that passes or fails.

## How you are usually called

The app shows a setup checklist. A person presses **Have your agent do it** on a
step and pastes you a prompt like:

```
Help me finish setting up Prism. Use the prism-setup skill.
Step: reachable — Reachable from other devices.
Where it stands: This server answers on this computer only. …
My Prism server: http://localhost:8787
```

Do **that step only**. Say what you are about to change before you change it,
and say when it is done. The checklist reads the server again every few seconds
and ticks the step by itself — you do not need to tell the app anything.

With no step named ("set up Prism"), work through the steps in the order below
and stop at the first one that needs the person.

## Step ids → skill

| Step id | What it means | Skill |
|---|---|---|
| `vault` | Parachute is running and the server holds a working vault token | `prism-setup-vault` |
| `server` | Prism Server is running | `prism-setup-server` |
| `owner` | The owner can sign in | `prism-setup-server` (§ First sign-in) |
| `secrets` | `SECRETS_KEY` is set, so connection details can be stored | `prism-setup-server` (§ Secure storage) |
| `agent-token`, `agent-connected` | An agent has its own access token and has used it | `prism-setup-agent` |
| `reachable` | The server has an https address other devices can open | `prism-setup-reach` |
| `device` | A phone or another computer is signed in | `prism-setup-reach` (§ Sign in a device) |
| `email` | Sign-in links and invitations are emailed | `prism-setup-server` (§ Email) |
| `integration:<kind>` | One optional connection (matrix, proton-bridge, google, fireflies, fathom, clickup, notion, github) | `prism-setup-integrations` |

Tag schemas are seeded by `prism-setup-server`; `prism-setup-schema` re-seeds or
checks them on their own.

## Order when doing everything

`vault` → `server` → `owner` → `secrets` → `agent-token` → `agent-connected` →
`reachable` → `device` → then only the optional steps the person asks for.

The first four are the **core**: when they are done the app is usable and the
checklist says "Prism is ready to use". Nothing after them is required.

## Rules that hold for every step

- **Detect first.** Run the step's check before changing anything. A step that
  already passes is reported "already done" and left alone.
- **Never rotate a secret that exists.** `SESSION_SECRET`, `CAPABILITY_SECRET`,
  `GOVERNANCE_SIGNING_SECRET` and above all `SECRETS_KEY` are kept as they are.
  A new `SECRETS_KEY` makes every stored connection unreadable.
- **Credentials go into the app, not into this conversation.** For an
  integration, prepare what it needs and then point the person at the field in
  the app. Do not ask them to paste a password or API key to you.
- **Say what you cannot do.** You cannot complete an OAuth consent screen, buy a
  domain, approve a device on someone's phone, or create a key in a vendor's
  dashboard. Do what leads up to it, say exactly what the person must do, then
  check again.

## Finished

Every core step passes its check, and a second run of this skill changes
nothing and reports each step "already done".
