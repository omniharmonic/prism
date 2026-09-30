# Agent (MCP) access

There are two ways to give an AI agent access to a vault:

1. **Prism MCP** (`/mcp` on the Prism Server) — **the recommended path.** The agent acts as *your Prism
   account*: it sees and changes only what you can in Prism (per-note grants, private notes, caps), in
   one vault. Authenticated with a **Prism access token** (`pp_…`) you create in Settings → Account.
2. **Whole-vault hub tokens** (legacy, frozen) — a hub JWT straight at the Parachute vault's own MCP,
   bypassing every Prism permission. See [the legacy section](#legacy-member-whole-vault-hub-tokens).

---

## Prism MCP (`/mcp`)

```
Agent (Claude Code / Claude Desktop / any MCP client)
   │  Authorization: Bearer pp_…        (Prism access token)
   ▼
https://<APP_ORIGIN>/mcp                ← Prism Server: auth → actor → the gateway's permission code
   │  (server's own vault token — the agent's token is never forwarded)
   ▼
Parachute vault
```

The endpoint is **stateless Streamable HTTP** implementing the MCP 2026-07-28 revision (no `initialize`
handshake, no `Mcp-Session-Id`; `server/discover` is supported). 2025-era clients that still send
`initialize` are served by a stateless fallback, so current Claude Code / Claude Desktop work as-is.
Server: `@modelcontextprotocol/server` 2.x (`createMcpHandler`, one server instance per request).

### Connect an agent

1. In Prism: **Settings → Account → Agent access tokens → Create token**. Pick *Read only* or
   *Read & write* and an expiry (30 days – 1 year). The token is bound to the **vault you have open**.
2. Copy the token **now** — it is shown once. The panel also shows paste-ready config:

**Claude Code** (terminal):

```bash
claude mcp add --transport http prism https://prism.example.com/mcp \
  --header "Authorization: Bearer pp_…"
```

or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "prism": {
      "type": "http",
      "url": "https://prism.example.com/mcp",
      "headers": { "Authorization": "Bearer pp_…" }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`, via the `mcp-remote` bridge):

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://prism.example.com/mcp", "--header", "Authorization: Bearer pp_…"]
    }
  }
}
```

**Any other MCP client:** server URL `https://<APP_ORIGIN>/mcp`, header `Authorization: Bearer pp_…`.
claude.ai *custom connectors* need OAuth, which Prism MCP does not offer yet (see *Not yet* below).

Then ask the agent to call `prism_whoami` — it reports your account, role, vault, whether the token
is read-only, and a summary of your capabilities.

### Credentials the endpoint accepts

Bearer header only. **Session cookies are never accepted on `/mcp`** (no CSRF surface), and neither are
capability links or anonymous callers.

| Bearer | Acts as | Vault | Ceiling |
|---|---|---|---|
| `pp_…` Prism access token | its account — role + grants recomputed on every request | the token's bound vault (an `X-Prism-Vault` naming another → 403) | token scope: `read` ⇒ only read-only tools |
| `pd_…` native device token (WP2.1) | its account, exactly like a session | `X-Prism-Vault` (unknown id → 400) | none |
| owner's hub JWT (`aud=vault.<primary>`) | the server owner | primary only | write verb, else read-only |
| `COLLAB_TOKEN` | the server owner — **loopback only** (`TRUST_LOCAL`), inert over the tunnel | `X-Prism-Vault` | none |

**Why the owner's hub JWT, and why so narrowly.** Parachute's backed-surface kit accepts an operator's
vault token the same way (the hub has no per-surface audiences yet), and the owner already holds
whole-vault access at the vault — so it adds no power; it just lets the operator's existing agent
config reach Prism-only data. But a `vault.<primary>` token is *also* what members, member-minted
agents and tag-scoped workers hold, so the audience alone never makes a caller the owner: the token
must carry `vault:<primary>:admin`, or its `sub` must be listed in `MCP_OWNER_HUB_SUBS`. Member-minted
tokens (`sub` `mcp:<email>`, or registered in `mcp_tokens`) and `scoped_tags` tokens are refused. The
token is validated (scope-guard: signature, issuer, expiry, revocation, audience) and never forwarded.

A `pp_` token is recognised **only** by `/mcp`; it is not a credential for `/api`, `/acl` or `/auth`,
and it cannot create or manage tokens.

### Discovery + errors

- `401` responses carry `WWW-Authenticate: Bearer resource_metadata="<APP_ORIGIN>/.well-known/oauth-protected-resource/mcp"`
  (plus `error="invalid_token"` when a bad token was presented); `403` for a valid-but-insufficient hub
  token carries `error="insufficient_scope"`.
- `GET /.well-known/oauth-protected-resource/mcp` (and the bare `/.well-known/oauth-protected-resource`)
  serves the RFC 9728 metadata: `resource`, `bearer_methods_supported: ["header"]`,
  `resource_documentation`. **`authorization_servers` is omitted on purpose** — no authorization server
  mints tokens with a Prism audience yet, and advertising the hub would send OAuth clients through a flow
  whose tokens this endpoint refuses.
- A browser `Origin` other than `APP_ORIGIN` (or a native shell origin) → `403` (DNS-rebinding defense).
- Tool failures come back as MCP tool errors `{ "error": "<code>", "message": "…" }` with codes
  `forbidden | not_found | conflict | invalid_request | rate_limited | upstream_error | internal_error`.

### Limits + audit

- Per credential: `MCP_RATE_PER_MINUTE` (default 120) requests/minute → `429` + `Retry-After`.
- Per IP: after `MCP_AUTH_FAILURES_PER_10MIN` (default 20) failed authentications in 10 minutes the IP is
  refused (even with a good token) until the window resets.
- One log line per tool call: `[mcp] <via>:<credential id> <email> vault=<id> <tool> ok|error:<code> <ms>ms`
  — never arguments, results or token material.

### Token management API (`/auth/pats`)

Authenticated with a browser session or a native device token (never a PAT).

| Route | What |
|---|---|
| `GET /auth/pats` | your live tokens (id, prefix, vault, scope, label, created/last-used/expires — never the secret). The server owner may add `?all=1`. |
| `POST /auth/pats` | `Content-Type: application/json` required. Body `{ vaultId?, scope?: "read"\|"write" (default read), expiresInDays? (1–365, default 90), label? }`; `vaultId` defaults to `X-Prism-Vault`, then primary. Needs standing in the vault (member+ or any grant). Max 25 live tokens per account. Returns `201` with the token **once** plus `mcpJson`, `claudeCodeCommand`, `claudeDesktopJson`. |
| `DELETE /auth/pats/:id` | revoke yours (the server owner: any). Immediate — the next request is refused. |

Tokens are `pp_` + 32 random bytes; only the SHA-256 is stored (`mcp_pats` table). A token minted with a
device token dies when that device is revoked.

### Tools

WP6.1 ships the endpoint, auth and registry with one tool, `prism_whoami`. The core note tools,
collab-safe edits, comments, governance and sharing land in WP6.2–6.4
(`docs/roadmap/architecture-v2/WORKPLAN.md`). Every tool is defined with a required `access(principal,
args)` check and a required `readOnlyHint`; `tools/list` is filtered per caller, and a hidden tool answers
exactly like a nonexistent one.

### Not yet

- **OAuth / claude.ai connectors** — waits on hub per-surface audiences (or Prism as a hub module).
- **Mounting behind the hub** at `/surface/prism/api/mcp` — the router supports it (`mountPrismMcp(app, path)`), not wired.

---

## Legacy: member whole-vault hub tokens

> **Frozen (Architecture v2, WP0.3).** Minting is **off by default**: `POST /api/mcp/token`
> returns `403 {"error":"minting_disabled"}` unless the server sets `MEMBER_VAULT_TOKENS=true`.
> A whole-vault token bypasses every Prism permission (and, where governance integrity is not
> yet on, could write governance notes directly — see `docs/governance.md`). Use Prism MCP (above)
> instead. `GET /api/mcp` reports `mintEnabled: false` plus a `mintDisabledReason`; **listing and
> revoking existing tokens keep working**, so an owner should review `GET /api/mcp/tokens` and revoke
> what is no longer needed. These tokens are also refused as owner credentials on `/mcp`.

```
Agent  ──Authorization: Bearer <vault-scoped JWT>──▶  https://<MCP_PUBLIC_URL host>/vault/<name>/mcp  (Parachute hub)
```

A minted token grants **whole-vault read or write directly at the hub**, bypassing Prism's per-note
grant gateway — so `/api/mcp/token` requires a signed-in account with role ≥ `member` **on the target
vault**; guests, capability links and anonymous actors can never mint. Each token is scoped to a single
vault (`vault:<name>:read|write`).

| Route | Who | What |
|---|---|---|
| `GET /api/mcp` | anyone | The active vault's public MCP URL + whether you may mint |
| `POST /api/mcp/token` | member+ of the target vault, **and** `MEMBER_VAULT_TOKENS=true` (else 403 `minting_disabled`) | Mint. Body: `{ vaultId?, scope?: "read"\|"write" (default write), expiresInDays? (1–365, default 90), label? }`. Returns the token **once**, plus `.mcp.json` / `claude mcp add` snippets |
| `GET /api/mcp/tokens?vaultId=` | member+ | Audit list (jti/scope/expiry only). Members see their own; admin+ see all |
| `DELETE /api/mcp/tokens/:jti` | the minter, or admin+ | Revoke at the hub (`parachute auth revoke-token`; enforced within ~60s) |

Operations notes: minting shells out to `parachute auth mint-token` under the host operator token (it
only works on the box that runs the hub); `MCP_PUBLIC_URL` is the hub's public origin; the audit
registry is the `mcp_tokens` table (tokens themselves are never stored); the hub's own registry
(`parachute-vault tokens list --vault <name>`) shows these tokens with identity `mcp:<email>`.
