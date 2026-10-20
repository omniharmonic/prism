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

### Connect your agent

1. In Prism: **Settings → Account → Connect your agent**. Pick the **vault** (only vaults you can access
   are offered), *Read only* or *Read & write*, and an expiry (30 days – 1 year; write ≤ 90 days), then
   **Create token**.
2. Copy the token **now** — it is shown once, held only in the page's memory (never `localStorage`) and
   discarded when you press *Done* or leave the panel. The panel also shows paste-ready config for
   Claude Code, Claude Desktop and any other MCP client (below), and a **Test connection** button that
   sends `tools/list` to `/mcp` with the new token and reports how many tools it exposes.

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
| owner's hub JWT (`aud=vault.<primary>`) — **opt-in, off by default** | the server owner | primary only | none (admin scope required) |
| `COLLAB_TOKEN` | the server owner — **loopback only** (`TRUST_LOCAL`), inert over the tunnel | `X-Prism-Vault` | none |

**The owner's hub JWT is opt-in, and narrow.** By default **hub JWTs are not accepted on `/mcp` at all**
(a 401, and the token is not even sent to the verifier). The operator enables it by setting
`MCP_OWNER_HUB_SUBS` to the hub account id(s) (`sub` claim, comma-separated) whose tokens may act as the
owner. Then a hub JWT is the owner **only if both** hold: it carries `vault:<primary>:admin`, **and** its
`sub` exactly matches an allowlisted value. Member-minted tokens (`sub` `mcp:<email>`, or registered in
`mcp_tokens`) and `scoped_tags` tokens are refused even if allowlisted. The token is validated
(scope-guard: signature, issuer, expiry, revocation, audience `vault.<primary>`) and never forwarded;
`prism_whoami` reports its real `exp`.

*Why offer it at all:* Parachute's backed-surface kit accepts an operator's vault token the same way (the
hub has no per-surface audiences yet), and the owner already holds whole-vault access at the vault, so it
lets the operator's existing agent config reach Prism-only data without a second secret.
*The risk you accept by enabling it:* the endpoint is reachable from the internet through the tunnel, so
a leaked admin hub token for an allowlisted subject becomes a full **owner** credential on Prism too —
grants, sharing and governance data, not just vault content — and hub revocation takes up to ~60 s to
bite. Prefer a Prism access token (revocable immediately, shorter-lived; owner/admin write tokens are
capped at 90 days), and enable the hub-JWT path only when you need it.

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
| `POST /auth/pats` | `Content-Type: application/json` required. Body `{ vaultId?, scope?: "read"\|"write" (default read), expiresInDays? (1–365, default 90; **owner/admin write tokens: at most 90**), label? }`; `vaultId` defaults to `X-Prism-Vault`, then primary. Needs standing in the vault (member+ or any grant). Max 25 live tokens per account. `/auth/pats` and `/auth/pats/:id` share a rate limit (30 / 10 min per IP). Returns `201` with the token **once** plus `mcpJson`, `claudeCodeCommand`, `claudeDesktopJson`. |
| `DELETE /auth/pats/:id` | revoke yours (the server owner: any). Immediate — the next request is refused. |

Tokens are `pp_` + 32 random bytes; only the SHA-256 is stored (`mcp_pats` table). A token minted with a
device token dies when that device is revoked.

### Tools

Every tool acts as YOUR Prism account: it runs the gateway's own route in-process, so per-note grants,
capabilities, anti-escalation and private-note rules apply exactly as in the web app. `tools/list` shows
only what your account could use at all (a viewer sees no write tools; a create-only drop-box holder sees
just `prism_create_note`; an account with no grants sees just `prism_whoami`); the per-note decision is
always the gateway's. A hidden tool answers exactly like a nonexistent one. Errors are uniform
`{error, message, detail?}` with `error` one of `forbidden`, `not_found`, `conflict`, `invalid_request`,
`rate_limited`, `upstream_error`.

| Tool | Scope | Needs | What it does |
|---|---|---|---|
| `prism_whoami` | read | any account | Your account, vault, auth method and capability summary |
| `prism_query_notes` | read | view | List/search notes you may see: `tag` (incl. child tags), `search`, `path_prefix`, `limit` ≤ 200 (default 50), `include_content` (default false; a 2,000-char preview). Newest first, lean rows with `_caps` |
| `prism_get_note` | read | view on the note | Content (≤ 100,000 chars, else `contentTruncated`), metadata, tags, path, `_caps`, and `collab: {kind, live}` (editor kind; whether a live collaborative session has it open) |
| `prism_semantic_search` | read | view | Embedding + full-text search, `limit` ≤ 50. **Primary vault only** — a credential bound to another vault gets an `invalid_request` pointing at `prism_query_notes` |
| `prism_list_tags` | read | view | Tags + counts you may see |
| `prism_list_versions` | read | view on the live note | Version history, newest first (no bodies, no provenance) |
| `prism_get_version` | read | view on the live note | One prior version's content + metadata |
| `prism_create_note` | write | `create` on the note's tags | `{content, path?, tags[], metadata?}`. A tagless note needs a whole-vault grant; the creator is stamped by the server |
| `prism_update_note` | write | `edit` (content/metadata), `organize` (path/tags) | `{id, if_updated_at, content?, metadata?, add_tags?, remove_tags?, path?}` |
| `prism_delete_note` | write (destructive) | creator with `edit`, or `delete` | Permanent delete |
| `prism_restore_version` | write | `edit` | `{id, version_ix, if_updated_at}`; refused if the version would change who can see the note |
| `prism_list_comments` | read | view | `{id, include_resolved?}` — a document note's comment threads (id, quote, resolved, `anchored`, comments with author/text/time) |
| `prism_add_comment` | write | **suggest** | `{id, text, quote}` starts a thread anchored on the first exact match of `quote` (within one paragraph); `{id, text, thread_id}` replies to an unresolved thread |
| `prism_resolve_comment` | write | **suggest** | `{id, thread_id, resolved?}` (default `true`; `false` reopens). Clears/restores the highlight for everyone |
| `prism_suggest_edit` | write | **suggest** | `{id, find, replace}` — a tracked change: the first match of `find` is marked for deletion and `replace` inserted after it, attributed to you; lands in the owner's review queue |
| `prism_sheet_read` | read | view | `{id, range?}` — A1 (`"B2"`, `"A1:C3"`; omit for the whole sheet, ≤ 10,000 cells). Live document when open, else the saved CSV |
| `prism_sheet_update` | write | `edit` | `{id, range, values[][], if_updated_at?}` — a single cell anchors `values`; a rectangle must match its shape. Cell-level; no commas/line breaks in cells |

**Comments and suggestions need suggest, via MCP too.** A comment is a write to the shared document (its
anchor is a mark in the body), and the collaboration socket is read-only below *edit* (suggest-level people
write comments and suggestions through `POST /api/collab/:id/commands`, which needs *suggest*) — so in the editor a
comment-level collaborator cannot comment (WP0.2). The MCP tools follow the same rule rather than letting an
agent do what its own account cannot: a comment-level account gets `forbidden`. Anyone who may comment may
resolve or reopen any thread (as in the editor). Comments and suggestions are attributed to your account's
name (or email) followed by "(agent)", and comments carry `agent: true`.

Resource template **`prism://note/{id}`** (read, needs view): a document-kind note as Markdown (collab's HTML
is converted), any other kind as its raw content; a second content block carries JSON metadata with
`_caps` and the collab kind. Not-viewable and nonexistent notes fail identically. Results are
`cacheScope: private`, `ttlMs: 0`.

**Concurrency contract.** `prism_update_note` and `prism_restore_version` REQUIRE `if_updated_at` — the
note's `updatedAt` from your latest `prism_get_note`. If the note changed since, you get `conflict` with
`detail.updatedAt` (the current timestamp, never the body): re-read, re-apply, retry. A `conflict` whose
`detail.reason` is `path_conflict` means something else: *a note already exists at that path* — pick another
path (retrying will not help).

**Live documents** (`collab.live` from `prism_get_note`: someone has the note open in the collaborative
editor). A content change from `prism_update_note` is not written over the vault copy; it is **merged into the
live document** through Yjs, under the transaction origin `mcp:<your email>`, and then saved by the normal
collab save path (people with the note open see it immediately):

1. `if_updated_at` must equal the note's current saved `updatedAt`, exactly as for a closed note. If someone's
   edits were saved since your read → `conflict`; re-read and retry.
2. The merge base is the saved version you read. Edits people typed *after* that and have not saved yet are
   **not** a conflict: only what you changed relative to the base is applied, so their edits survive — in the
   same paragraph or elsewhere — like two people editing at once. Spreadsheets change cell by cell (never a
   whole-table rewrite); canvases change only the elements you changed (upserted by id, with the Excalidraw
   `version` bumped) and drop elements you removed.
3. If the live document has not yet absorbed a very recent external change (so there is no saved base that
   matches your read), you get `conflict` with `detail: {live: true, retry: true}` — wait a few seconds,
   re-read, retry.

On a document being typed in continuously, saves land every few seconds, so a slow read→write cycle may keep
hitting (1). There, prefer the anchor-based tools — `prism_suggest_edit`, `prism_add_comment`,
`prism_sheet_update` — which need no `if_updated_at` (`prism_sheet_update` takes an optional one).
Restores (`prism_restore_version`) are still refused while a note is live. Metadata-, tag- and path-only
updates go straight through and never disturb unsaved typing. Notes nobody has open are written through the
normal gateway path (a Markdown note stays Markdown). Adding a comment or suggestion to a note that has never
been opened in the collaborative editor stores its body as the editor's HTML, the same as a first live open.

A read-only token is held to reads three times over: only read tools are listed, a write-scope tool is
refused at call time, and a tool's in-process calls into the gateway may only be `GET`/`HEAD` (plus an
explicit allowlist of read-only POST routes — empty today). Tools can only reach `/api/…` routes, with
any `.`/`..` path segment (raw or percent-encoded) refused. Note ids containing `/` are not addressable
(use the id, not the path).

### Governance, sharing, dashboards, prompts (WP6.4)

| Tool | Scope | Needs | What it does |
|---|---|---|---|
| `prism_governance_state` | read | standing (member, a grant, or a governance role) | Enabled/locked, roles + policies, YOUR powers/roles/grants, the role roster, open proposals |
| `prism_propose_change` | write | standing; view on the target | `{action: edit_note\|new_entry, target?, content, tags?, path?, rationale}` — opens a CONTENT proposal; changes nothing until eligible members vote. `rationale` is required and shown to voters (stored on the proposal, never on the note) |
| `prism_vote` | write | the policy's eligible role for that proposal's tags | `{proposal_id, vote: approve\|reject, reason?, apply?}`. After an approval, if the threshold is now met the change is applied (`outcome` = `pending` \| `applied` \| `approved_staged` \| `recorded`); `apply: false` only records. Refused for `amend_governance` proposals and closed proposals |
| `prism_withdraw_proposal` | write | you opened it | Proposer only (not even the owner, through MCP) |
| `prism_note_access` | read | `share` on the note (or admin) | Direct grants, tag grants that reach it, visibility/creator, share-link COUNT (never their URLs) |
| `prism_share` | write (`openWorldHint`) | `share` on the note/tag (or admin) | `{id \| tag, email, level \| caps}`. You can only hand out caps you hold; the recipient must ALREADY have an account — inviting new people is not available through MCP, for anyone |
| `prism_dashboard_query` | read | view | `{dashboard_id, widget_id?}` runs a saved `dashboard`-tagged note's widgets; or inline `{source, sort?, group_by?, aggregate?, fields?}`. Runs the client's own pure filter engine over ONLY the notes you may view; stat → number, chart/board → grouped counts, list → lean rows (≤ 100) |

**Never available through MCP:** publish/unpublish, members/invites, federation, workspace/server config,
governance constitution/role/policy edits (amendments), voting on or applying an amendment, publishing a
staged revision, minting tokens.

Resources: **`prism://governance/constitution`** (the constitution as Markdown, rendered from live state, no emails)
and **`prism://me`** (who this connection acts as plus your governance standing). Prompts (need standing):
**`review-open-proposals`** (walk the open content proposals with their proposed text, then `prism_vote`),
**`summarize-comments {id}`**, **`edit-shared-doc {id}`** (reads your `_caps` on the note and steers you to a direct
edit, a suggestion, a reviewed proposal, or read-only).

**Sharing transport.** Sharing lives under `/acl`, which tools can never reach in general. `prism_share` /
`prism_note_access` use one extra entry point whose allowlist is EXACTLY the five scoped-share routes
(`GET /acl/notes/:id`, `PUT|DELETE /acl/notes/:id/people[/:email]`, `PUT|DELETE /acl/tags/:tag/people[/:email]`); every other
`/acl` path is refused before dispatch. The acl router's own gate (admin, or `share` on that resource) and anti-escalation
(subset rule) still run — same handler as the web Share dialog.

### Not yet

- Governance/sharing/dashboards and collab-safe edits/comments are above (WP6.4, WP6.3); revoking a share, listing tag access and applying/publishing proposals stay web-only.
- **Accept/reject suggestions, canvas element tools, comment deletion** — later (owner review stays in the app).
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

---

## Migrating members off legacy whole-vault tokens (WP6.5)

Owner-only (server owner), in **Network → Server → Legacy agent tokens (whole-vault)** — the card appears only
while active legacy tokens exist. API (also owner-only, JSON-only, never returns a token):

| Route | What |
|---|---|
| `GET /api/mcp/legacy-tokens` | Active (unrevoked, unexpired) `mcp_tokens` across all vaults: who, vault, scope, created, expires — plus the last 50 audit rows |
| `POST /api/mcp/legacy-tokens/revoke` | Body `{ jtis?, notify?, dryRun? }`. **`dryRun` defaults to true** — it lists `affected` members/tokens and does nothing. `dryRun:false` revokes each token through the hub revoker (`parachute auth revoke-token`, ~60 s to enforce); `jtis` omitted = all active; `notify:true` emails each member once (Resend, or a console line without a key) after at least one of their tokens was revoked, pointing at *Settings → Account → Connect your agent* |

Idempotent (only unrevoked tokens are touched). A token whose hub revoke fails stays active and is retried
by the next call; its member is not emailed. A mail failure never undoes a revocation (reported in
`notifyFailed`). Every attempt is audited in `mcp_token_revocations` (actor, jti, member, vault, outcome,
notified) — never token material. Members who were emailed once are not emailed again by a repeat call.

### Runbook (overseer)

1. **Dry run.** As the server owner: `POST /api/mcp/legacy-tokens/revoke` with `{"notify":true}` (or open the
   card and press *Revoke all + notify*, which shows the same dry-run summary in its confirm dialog). Review
   `wouldRevoke` and `affected`.
2. **Owner approval.** Get the owner's explicit go-ahead on that list. Nothing runs automatically.
3. **Revoke all + notify.** `POST` `{"dryRun":false,"notify":true}`. Check `failed` is empty (re-run to retry),
   and `notified` lists every member.
4. **Verify.** `GET /api/mcp/legacy-tokens` returns `tokens: []`, and `GET /api/mcp/tokens?vaultId=<id>` shows every
   row with `revokedAt` set. Allow ~60 s for the hub cache. Optionally confirm in the hub
   (`parachute-vault tokens list --vault <name>`).
5. Leave `MEMBER_VAULT_TOKENS` unset so no new whole-vault token can be minted.
