# Agent (MCP) access to a vault — member self-serve tokens

Any **member** of a vault can give their AI agent direct MCP access to that vault: the Parachute hub already serves a per-vault MCP endpoint publicly (via the `parachute expose` cloudflared tunnel), and the Prism server can mint a hub JWT scoped to exactly that one vault.

```
Agent (Claude Code / claude.ai / any MCP client)
   │  Authorization: Bearer <vault-scoped JWT>
   ▼
https://<MCP_PUBLIC_URL host>/vault/<name>/mcp     ← Parachute hub (public tunnel)
```

## The trust boundary (read this first)

A minted token grants **whole-vault read or write directly at the hub**, bypassing Prism's per-note grant gateway. That is exactly right for a vault *member* (they already hold vault-level trust) and exactly wrong for anyone else — so `/api/mcp/token` requires a signed-in account with role ≥ `member` **on the target vault**. Guests, capability links, and anonymous actors can never mint. Each token is scoped to a single vault (`vault:<name>:read|write`); it grants nothing anywhere else.

## Endpoints (`/api/mcp`, session-cookie authed)

| Route | Who | What |
|---|---|---|
| `GET /api/mcp` | anyone | The active vault's public MCP URL + whether you may mint |
| `POST /api/mcp/token` | member+ of the target vault | Mint. Body: `{ vaultId?, scope?: "read"\|"write" (default write), expiresInDays? (1–365, default 90), label? }`. Returns the token **once**, plus a paste-ready `.mcp.json` snippet and a `claude mcp add` command |
| `GET /api/mcp/tokens?vaultId=` | member+ | Audit list (jti/scope/expiry only — never token material). Members see their own; admin+ see all |
| `DELETE /api/mcp/tokens/:jti` | the minter, or admin+ | Revoke at the hub (`parachute auth revoke-token`; enforced within ~60s) |

Server config: `MCP_PUBLIC_URL` in `apps/server/.env` — the hub's public origin (e.g. `https://agent.omniharmonic.com`). The audit registry is the `mcp_tokens` table; tokens themselves are never stored.

## Example: a member sets up their agent

```bash
# 1. Log in (gets the session cookie)
curl -c jar.txt -X POST https://prism.example.com/auth/login \
  -H 'content-type: application/json' -d '{"email":"you@example.com","password":"…"}'

# 2. Mint (write scope, 90 days) — copy `mcpJson` into .mcp.json, or run `claudeCommand`
curl -b jar.txt -X POST https://prism.example.com/api/mcp/token \
  -H 'content-type: application/json' \
  -d '{"vaultId":"front-range-commons","label":"my laptop agent"}'
```

The response's `mcpJson` drops straight into a Claude Code project's `.mcp.json`; `claudeCommand` is the equivalent one-liner. For claude.ai custom connectors, use `url` with the `Authorization: Bearer …` header.

## Operations notes

- Minting shells out to `parachute auth mint-token` under the host operator token — it only works on the box that runs the hub (same posture as in-app vault create).
- Revocation propagates at the hub within ~60s (revocation-list cache TTL).
- The hub's own registry (`parachute-vault tokens list --vault <name>`) shows these tokens with identity `mcp:<email>` — cross-check against `GET /api/mcp/tokens`.
