# Which model does what in Prism

Prism's server sends work to AI models in a few places. One file decides which
model handles each job. You can switch any job between a model running on your
own hardware and a frontier model by editing that file. No code changes are needed.

- **The file:** `apps/server/config/models.json`. Start from
  `apps/server/config/models.example.json` (copy it, then edit the copy). To keep it
  somewhere else, set `PRISM_MODELS_CONFIG=/path/to/models.json` in `apps/server/.env`.
- **When it takes effect:** after `pm2 restart prism-server`.
- **No file = nothing changes.** Without `models.json`, Prism behaves exactly as it
  did before: Settings → AI models, the `SKILLS_*` variables and the `EMBED_*`
  variables in `apps/server/.env` keep deciding.
- **A mistake stops the server.** If the file has a typo, the server refuses to
  start and lists every problem in the log (`pm2 logs prism-server`). A typo never
  quietly moves a job to a different model.
- `models.json` is per machine (git-ignored), like `.env`.

## To change which model does X, edit this line

| Job | What it is in Prism | The line in `models.json` |
|---|---|---|
| **chat** | Agent chat (the conversations panel; it uses tools on your vault) | `"chat": ["claude:sonnet"]` |
| **drafting** | ⌘J inline edit, transforms, and page Summarize / Draft / Transform | `"drafting": { "use": ["local:qwen2.5-14b-instruct", "claude:sonnet"] }` |
| **triage** | Background tagging skills (`message-classify`, `clickup-task-triage`) | `"triage": { "use": ["local:google/gemma-4-12b-qat"], "fallback": "local-only" }` |
| **embeddings** | The semantic-search index | `"embeddings": ["ollama:nomic-embed-text"]` |
| summarization, extraction, proactive | Used by the agent repo and Hermes; the Prism server sends nothing to them yet | `"summarization": [...]` and so on |
| voice-stt, voice-tts | Reserved names. The server does not use them yet | — |

Each entry is written as `provider:model`. `provider` is a name from the
`"providers"` section, and `model` is that server's model id. The text before the
**first** colon is the provider, so `ollama:llama3.1:8b` means provider `ollama`
and model `llama3.1:8b`.

**Examples**

- *Send drafting to a frontier model:* `"drafting": ["openrouter:google/gemini-2.5-pro"]`.
  Any model OpenRouter lists works here.
- *Run the tagger on the workstation:* `"triage": ["workstation:qwen2.5-32b-instruct"]`.
- *Use the local model first, and Claude only if it is down:*
  `"drafting": { "use": ["local:qwen2.5-14b-instruct", "claude:sonnet"], "fallback": "any" }`.

## Providers: where a model runs

A provider has two parts: a **kind**, and where to reach it.

| Kind | What it is | Needs |
|---|---|---|
| `claude-cli` | The `claude` command on the server, signed in with its own login. It is the only kind that can run agent **chat** today. | `"model"`: `sonnet`, `opus` or `haiku` |
| `openai-compatible` | Any server that speaks the OpenAI `/v1` API: LM Studio, Ollama, vLLM, llama.cpp server, OpenRouter, OpenAI, or a frontier provider's compatible endpoint | `"base_url"`, plus `"api_key_env"` if it needs a key |

Typical `base_url` values:

| Server | `base_url` |
|---|---|
| LM Studio | `http://127.0.0.1:1234/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| vLLM | `http://<host>:8000/v1` |
| llama.cpp `llama-server` | `http://<host>:8080/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |

**API keys never go in this file.** Put the key in `apps/server/.env`, for example
`OPENROUTER_API_KEY=sk-…`. Then put the variable's *name* in the file:
`"api_key_env": "OPENROUTER_API_KEY"`. The server sends the key only to that
provider, as an `Authorization: Bearer` header. Logs, errors and the status page
show the variable's name and whether it is set, never the key itself.

**Other provider settings (all optional):**

- `"model"`: the model to use when a job names only the provider.
- `"local"`: `true` marks a server on hardware you control. It defaults to `true`
  for an address on this machine (`127.0.0.1` / `localhost`). For the workstation
  over Tailscale, set it yourself.
- `"memory_guard"`: before each call, check this machine's free memory and whether
  the model is already loaded. This is the protection the 16 GB Mac mini needs. It
  defaults to `true` for an address on this machine and `false` otherwise.
- `"timeout_ms"`: how long a drafting call may take (default 5 minutes). Triage keeps
  its own limit of 2 minutes per note.
- `"capabilities"`: limit what this provider is used for, as a list of
  `completion`, `structured` and `embeddings`.

## Fallbacks

The entries of a job are tried in order. When one fails (it is down, refuses,
times out, returns an error or gives an empty answer), Prism tries the next one.
**A fallback is never silent:**

- each handover is logged, for example
  `[providers] drafting: local:qwen… failed (unreachable …) → trying claude:sonnet`;
- the dispatch records `provider`, `model` and `fallbacks`;
- `GET /api/agent/runner` → `providers` shows the active config (keys redacted),
  the recent calls and the last fallback.

Each job can limit fallback with `"fallback"`:

- `"any"` (the default): try every entry.
- `"local-only"`: only fall back to providers marked `local`. Use this when keeping
  data on your own hardware matters more than getting an answer, as with the
  message tagger.
- `"none"`: use only the first entry.

`embeddings` never falls back. Vectors from two different models cannot share one
index, so it takes exactly one entry.

## How this fits with Settings → AI models

Settings → AI models (edit, chat, transform, generate) still works. A choice saved
there goes **first** for that action. The `drafting` line in the file then supplies
the fallbacks, within its `fallback` rule. In the settings, "local" means the
provider called `local` in the file, or else the first local `openai-compatible`
one. A skill note's own `provider` / `model` metadata also still wins for that
skill.

## Chat on other models (not built yet)

Agent chat is a multi-turn conversation in which the model calls tools on your
vault. Today only `claude-cli` can do that: it runs the Claude CLI's own tool loop
over the vault's MCP server. If `jobs.chat` starts with any other provider, a chat
is **refused** with a message that says what to change. It does not quietly switch
to Claude.

The planned way to run chat on other models is an `openai-compatible` agent loop:

1. **Tools.** List the MCP tools of the session's server (the vault, or Prism's own
   `/mcp`) through an MCP client. Offer the model only the tools the session's
   profile allows. These are the same allowlists as today (`agent-profiles.ts`).
2. **The loop.** Send `tools` in `/chat/completions`. Run each `tool_calls` entry
   through the MCP client with the per-turn credential, return a `tool` message,
   and repeat until the model answers in text. Limit the number of steps and the
   time a turn may take.
3. **Events.** Translate each step into Prism's existing event schema (`text_delta`,
   `text`, `tool_use`, `tool_result`, `note_touched`, `status`, `result`), so the
   chat UI, phone reconnect and transcript mirror need no change.
4. **Sessions.** Store each conversation's messages in SQLite, in place of the CLI's
   `~/.claude/projects/…jsonl` file and `--resume`. Archiving a session deletes them.
5. **Cost.** Count the token `usage` each response reports instead of
   `total_cost_usd`. Budgets then apply per provider.

The legacy desktop app already has a Rust version of steps 1–2
(`apps/desktop/src-tauri/src/clients/local_agent.rs`). It is a useful reference,
but it is not shared code.

## What is still Claude-specific, and the plan for each

| Piece | Where | Plan |
|---|---|---|
| The agent loop for chat and full-tool background skills | `agent-exec.ts`, `agent-sessions.ts` | The openai-compatible loop above. Until it exists, `chat` needs `claude-cli`, and agentic (non-structured) skills always run on `claude-cli`. |
| Parsing the stream (`system/init`, `stream_event`, `result`) | `agent-events.ts` `StreamNormalizer` | Stays inside the claude-cli backend. A new backend sends the same neutral events. |
| Session files and `--session-id` / `--resume` | `agent-sessions.ts` | A new backend stores the conversation in SQLite (step 4 above). |
| Cost (`total_cost_usd`, `--max-budget-usd`) | `agent-sessions.ts`, `agent-exec.ts` | Per-provider token pricing from `usage`, plus the existing session and daily budgets. |
| The billing label (`claude auth status`: subscription or API) | `agent-billing.ts` | Report it per provider. For API providers, cost is a real charge. |
| Failure classes read from the CLI's own wording | `agent-failure.ts` | Each backend maps its own errors to the same codes. |
| Model names `sonnet` / `opus` / `haiku` | `claude-cli` provider | These names belong to the claude-cli provider only. Other providers take any model id. |
| MCP tool names `mcp__<server>__<tool>` | `agent-profiles.ts` | The new loop maps the allowlist to the MCP server's plain tool names. |
| The server-side "agent" in a page action that has no tools | `profile: "text"` | Already provider-neutral: it goes through `drafting`. |
| Legacy desktop (`apps/desktop`) | Rust `ModelRouter` and `claude_args.rs` | Rollback only. It is not covered by `models.json` and will not be ported. |

## A local embedding setup (proposed, not applied)

Prism's semantic search (`/api/search/semantic`) uses Prism Server's own index.
Without an embedding model it falls back to an offline word-matching embedder. That
fallback runs, but it is not semantic. This is how to give the index a real local
embedding model with no cloud service. **It has not been applied to the production
server.**

1. Install the model on the machine that runs Prism Server:
   - **Ollama:** `ollama pull nomic-embed-text` (about 270 MB; it runs comfortably
     next to the 12B tagger).
   - **or LM Studio:** download `nomic-embed-text-v1.5` and load it as an embedding
     model.
2. Point Prism at it, either in `models.json`:
   ```json
   "providers": { "ollama": { "kind": "openai-compatible", "base_url": "http://127.0.0.1:11434/v1" } },
   "jobs": { "embeddings": ["ollama:nomic-embed-text"] }
   ```
   or, with no `models.json`, in `apps/server/.env`:
   ```
   EMBED_ENDPOINT=http://127.0.0.1:11434/v1
   EMBED_MODEL=nomic-embed-text
   ```
3. Run `pm2 restart prism-server`, then rebuild the index: Settings → Search index →
   Rebuild (or `POST /api/index/rebuild` as the owner). Changing the model always
   forces a re-index. Vectors from different models are never mixed.

Semantic search covers the primary vault only (see CLAUDE.md). The "semantic search
unavailable" message from Parachute itself comes from the **vault's** own setting,
which is separate. This setup makes Prism's search work. It does not change the
vault.

## Pointing jobs at the NVIDIA workstation

1. On the workstation, run an OpenAI-compatible server. For example:
   `vllm serve Qwen/Qwen2.5-32B-Instruct --port 8000 --api-key "$WORKSTATION_API_KEY"`,
   or Ollama with `OLLAMA_HOST=0.0.0.0`.
2. Join both machines to Tailscale. Use the workstation's Tailscale name
   (`http://workstation:8000/v1`), and with Tailscale ACLs allow only the Mac mini
   to reach that port.
3. Put `WORKSTATION_API_KEY=…` in `apps/server/.env` and add the `workstation`
   provider from the example file, with `"local": true`.
4. Point jobs at it, for example `"triage": ["workstation:qwen2.5-32b-instruct", "local:google/gemma-4-12b-qat"]`.
   Leave `memory_guard` off: the workstation's memory is not the mini's.

Model choices for each job on a 128 GB workstation are in `model-test-matrix.md`,
which will be written once the machine is benchmarked.
