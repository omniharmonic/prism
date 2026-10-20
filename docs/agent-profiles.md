# Agent profiles, budgets and cost labels (WP3.4)

Operator reference for the server agent runner (`/api/agent/*`, owner-only).

## Profiles

| Profile | Server | Tools | Notes |
|---|---|---|---|
| `vault-ro` (UI default) | parachute-vault | `query-notes list-tags find-path vault-info doctor` | also runs on a per-turn READ-scoped hub token |
| `vault-rw` | parachute-vault | read tools + `create-note update-note delete-note read-attachment request-attachment-download` | |
| `skill` | parachute-vault | `vault-rw` minus `delete-note` | background skills (`SKILLS_ENABLED`); server-internal, not a session choice |
| `prism-ro` | Prism `/mcp` | the read-scope `prism_*` tools | needs `AGENT_PRISM_PROFILES=true` |
| `prism-rw` | Prism `/mcp` | read tools + create/update note, restore version, comments, suggested edits, sheet update | needs `AGENT_PRISM_PROFILES=true`; no delete, share or governance actions |
| `prism-graph` | Prism `/mcp` | read tools + the `prism_people_*` graph-maintenance tools (review queue, duplicates, merge recommendations, filing gaps) + create/update note | needs `AGENT_PRISM_PROFILES=true` AND `AGENT_GRAPH_PROFILE=true`; the ONLY profile with the people tools (they expose raw identity keys and change who records belong to); no delete, share, restore or governance actions. Switching such a session's permission mode turns it into an ordinary prism profile without them. |

Every allowlist is explicit and enforced twice: `--allowedTools` plus
`--permission-mode dontAsk` (the CLI still *lists* write tools under a read-only profile; calling one returns a
denied `tool_result`).

### prism-* credentials

Each prism-* turn gets its own Prism personal access token (`pp_…`), minted when the process is spawned:

- bound to the session owner's account and vault, scope `read` (prism-ro) or `write` (prism-rw), lifetime at most 3 h;
- written only into the 0600 per-run MCP config (`http://127.0.0.1:<PORT>/mcp`); never in argv, logs or events;
- revoked when the turn ends (done, error, cancel, rollback) and swept at server boot if a crash left one live;
- hidden from Settings -> Account -> Agent access tokens and not counted toward the per-account token cap.

Because the PAT is the owner's own actor, Prism's per-note grants, private-note rule and caps still apply to whatever
the agent does.

## Interactive model routing (parity A)

Settings → AI models (server owner) sets, per interactive skill (`edit`, `chat`, `transform`,
`generate`), either Claude (`sonnet` / `opus` / `haiku` → the runner's `--model`) or a **local**
model on the server's LM Studio (`SKILLS_LOCAL_BASE_URL`). It applies only to the read-only
one-shot dispatch the client's inline AI uses (`POST /api/agent/dispatch {profile:"vault-ro",
skill}`). A local route is one plain completion (no tools) behind the skills' memory admission
guard and the shared one-local-run slot; if the guard refuses, the run fails — it never falls
back to Claude. **Agent chat sessions (any profile above) always run on Claude.** Routes:
`GET /api/agent/models`, `GET|PUT /api/agent/routing`, `POST /api/agent/routing/test`
(details in CLAUDE.md, "Interactive model routing").

## Budgets (server config; shown read-only in the UI)

| Env | Default | Meaning |
|---|---|---|
| `AGENT_MAX_BUDGET_USD` | 1.00 | `--max-budget-usd` per `claude` process/turn (0 = off) |
| `AGENT_SESSION_BUDGET_USD` | 10 | cumulative per session; new turns get 409 `budget_exceeded` |
| `AGENT_DAILY_BUDGET_USD` | 25 | per user since local midnight; new turns get 409 `daily_budget_exceeded` (0 = off) |
| `AGENT_PRISM_PROFILES` | off | enables `prism-ro` / `prism-rw` |
| `AGENT_GRAPH_PROFILE` | off | with `AGENT_PRISM_PROFILES`, also offers `prism-graph` |

The daily total comes from the `agent_cost_log` ledger, so archiving sessions does not reset it. A turn already
running is not interrupted by the daily cap.

## Cost labels

The runner uses the `claude` CLI login on the host. On a claude.ai subscription the reported cost is an
API-equivalent estimate (it counts against subscription usage and is not billed), so the UI shows
`≈$0.02 API-equiv.` with a tooltip. With an API-key login the figure is a real charge and is shown as `$0.02`.
`GET /api/agent/runner` and `GET /api/agent/limits` report `billing: "subscription" | "api" | "unknown"`, detected by
`claude auth status` at boot and hourly.
