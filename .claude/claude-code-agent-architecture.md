# Prism Agent Architecture — Claude Code CLI Integration

**Version:** 1.0 | **Date:** April 11, 2026

---

## Design Decision: Claude Code CLI, Not Anthropic API

Prism's AI agent uses **local Claude Code CLI** (`claude -p`) instead of direct Anthropic API calls. This mirrors the OmniHarmonic agent's architecture and provides significant advantages.

### Why Claude Code CLI?

1. **No API key management** — Claude Code handles authentication via its own billing/auth system
2. **Full tool ecosystem** — Claude Code has access to MCP servers, file tools, web search, and the entire plugin system
3. **Parachute MCP integration** — Claude can directly search, read, create, and traverse the knowledge graph via MCP tools
4. **Session continuity** — `--resume <session_id>` enables multi-turn conversations that remember prior context
5. **CLAUDE.md context** — Claude Code automatically reads project-level CLAUDE.md for agent persona and rules
6. **OmniHarmonic compatibility** — Same invocation pattern as the existing agent, enabling skill sharing

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                     PRISM (Tauri)                     │
│                                                       │
│  Frontend (React)           Rust Backend              │
│  ┌──────────────┐          ┌────────────────┐        │
│  │ InlinePrompt │──invoke──│ agent_edit     │        │
│  │ PanelChat    │──invoke──│ agent_chat     │        │
│  │ CommandBar   │──invoke──│ agent_transform │        │
│  │              │──invoke──│ agent_generate  │        │
│  └──────────────┘          └───────┬────────┘        │
│                                    │                  │
│                            ┌───────▼────────┐        │
│                            │  ClaudeClient   │        │
│                            │                 │        │
│                            │ claude -p       │        │
│                            │ --model sonnet  │        │
│                            │ --dangerously-  │        │
│                            │  skip-perms     │        │
│                            │ --output-format │        │
│                            │  json           │        │
│                            │ --resume <sid>  │        │
│                            └───────┬────────┘        │
└────────────────────────────────────┼─────────────────┘
                                     │
                          ┌──────────▼──────────┐
                          │   Claude Code CLI    │
                          │                      │
                          │ Reads: .mcp.json     │
                          │ Connects to:         │
                          │ ┌──────────────────┐ │
                          │ │ Parachute Vault   │ │
                          │ │ MCP Server        │ │
                          │ │                   │ │
                          │ │ • search-notes    │ │
                          │ │ • get-note        │ │
                          │ │ • create-note     │ │
                          │ │ • update-note     │ │
                          │ │ • list-tags       │ │
                          │ │ • describe-tag    │ │
                          │ │ • traverse-links  │ │
                          │ │ • semantic-search │ │
                          │ │ • find-path       │ │
                          │ │ • get-links       │ │
                          │ └──────────────────┘ │
                          └──────────────────────┘
```

### Invocation Pattern

```rust
// ClaudeClient spawns claude processes:
pub async fn run(&self, prompt: &str, model: &str, timeout: u64) -> Result<String> {
    // Runs: claude -p --model <model> --dangerously-skip-permissions "<prompt>"
    // CWD: Prism project root (where .mcp.json lives)
    // Env: Clean (CLAUDECODE stripped to avoid nested detection)
}

pub async fn run_conversational(&self, prompt: &str, model: &str, 
                                 session_id: Option<&str>, timeout: u64) -> Result<Response> {
    // Adds: --output-format json --resume <session_id>
    // Returns: { result, session_id, is_error }
}
```

### MCP Configuration

Prism's `.mcp.json` registers the Parachute Vault MCP server:

```json
{
  "mcpServers": {
    "parachute-vault": {
      "command": "bun",
      "args": ["<path>/parachute-vault/src/server.ts"]
    }
  }
}
```

This gives every Claude Code session spawned by Prism access to the full Parachute vault API via MCP tools.

### Agent Commands

| Command | Model | Timeout | Purpose |
|---------|-------|---------|---------|
| `agent_edit` | sonnet | 60s | Inline text replacement |
| `agent_chat` | sonnet | 120s | Conversational with session resumption |
| `agent_transform` | sonnet | 120s | Content type conversion |
| `agent_generate` | sonnet | 120s | New content creation |

### System Context (PRISM_CONTEXT)

Every prompt is prepended with context that tells Claude:
- It's embedded in Prism, Benjamin Life's universal interface
- It's part of the OmniHarmonic agent ecosystem
- It has access to Parachute Vault MCP tools (with a list of available operations)
- The vault contains projects, meetings, contacts, tasks, research, and writing

### Session Management

Conversational sessions are tracked per-context:
- Per-document: when chatting about a specific note, the session is keyed by `note_id`
- Global: when chatting without document context, uses a "global" session key
- Sessions persist across multiple messages via `--resume <session_id>`
- Sessions are stored in-memory in `AgentSessions` (Mutex<HashMap<String, String>>)

### Configuration Loading

At startup, Prism loads credentials from the OmniHarmonic agent's `.env`:

```
~/iCloud Drive (Archive)/Documents/cursor projects/omniharmonic_agent/.env
```

Keys loaded:
- `MATRIX_HOMESERVER`, `MATRIX_USER`, `MATRIX_ACCESS_TOKEN` — Matrix/messaging
- `NOTION_API_KEY` — Notion sync
- `GOOGLE_ACCOUNT_BENJAMIN`, `GOOGLE_ACCOUNT_AGENT` — Gmail/Calendar accounts

### Differences from OmniHarmonic Agent

| Aspect | OmniHarmonic Agent | Prism Agent |
|--------|-------------------|-------------|
| CWD | omniharmonic_agent/ | prism/ (for .mcp.json) |
| Trigger | Telegram bot, cron, CLI | UI actions (Cmd+J, Cmd+K, panel chat) |
| Output | Telegram messages | UI components (diff view, chat bubbles) |
| Session | Per Telegram chat | Per document or global |
| Model | sonnet (default), opus (complex) | sonnet (all operations) |

### Future: Sharing Skills Between Systems

Since both Prism and OmniHarmonic use Claude Code with access to the same vault, skills and agents can be shared:
- OmniHarmonic's `/briefing`, `/email`, `/tasks` skills could be invoked from Prism's command bar
- Prism's document editing capabilities could be exposed to the OmniHarmonic Telegram bot
- Both systems share the same Parachute vault as the canonical data source
