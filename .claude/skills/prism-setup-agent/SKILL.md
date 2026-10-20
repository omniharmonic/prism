---
name: Prism Setup — Agent access
description: "Give an AI agent its own access to a Prism workspace: an agent access token for the Prism MCP endpoint (/mcp), scoped read or write, revocable, and respecting Prism's permissions. Covers the checklist steps agent-token and agent-connected."
version: 0.3.0
---

# Prism Setup — Agent access

An agent reaches Prism through the **Prism MCP endpoint** at `<server>/mcp`,
with an **agent access token** (`pp_…`). The token belongs to one person, can be
read-only or read-write, shows in their list of tokens with when it was last
used, and can be revoked there. The agent sees only what that person can see.

These are checklist steps, not `prism setup` steps: creating the token needs
the person's sign-in, so it happens in the app after the run.

Do **not** give an agent the vault's own token or point it at the Parachute
vault directly. That bypasses Prism's permissions and its edit history.

## Step `agent-token` — create the token

The token is created by the person, in the app, because creating one needs
their sign-in:

1. Open **Settings → Account → Agent access tokens** ("Connect your agent").
2. Choose read-only unless the agent should edit, name it after the agent, and
   create it.
3. The app shows the token **once**, with a ready-made block for Claude Code,
   Claude Desktop and a generic HTTP client.

You cannot create it for them. Tell them where to click and wait.

## Step `agent-connected` — use it

1. The person copies the block the app shows for their client and adds it to
   that client's MCP configuration themselves (for Claude Code: `claude mcp add
   --transport http prism <server>/mcp --header "Authorization: Bearer <token>"`,
   run in their own terminal). The token must not pass through this
   conversation: do not ask them to paste it to you.
2. Restart or reload the client so it picks the server up.
3. Call any read tool once (for example, list recent pages).
4. In the app, **Test connection** on that token turns green, and the checklist
   step ticks: the server has seen the token used.

## Check

- The client lists the Prism MCP server and a read tool returns pages.
- The token's row in the app shows a "last used" time.
- A request with no token, or with a revoked one, is refused (401).

## Limits

- A read-only token cannot write; ask for a new read-write token rather than
  working around it.
- The server must be reachable from where the agent runs. An agent on the same
  computer can use `http://localhost:8787`; one elsewhere needs the https
  address from `prism-setup-reach`.
