# Prism Claude Code Plugin

Packages Prism's Parachute-vault skills as an installable [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins)
and wires the Parachute vault MCP server.

## Contents

- **Data skills** (`.claude/skills/`): `classify`, `extract-entities`,
  `reconcile`, `schema-bridge`, `wikilinks`.
- **Setup skills** (`.claude/skills/`): `prism-setup` (orchestrator) +
  `prism-setup-vault`, `prism-setup-server`, `prism-setup-schema`,
  `prism-setup-agent`, `prism-setup-reach`, `prism-setup-integrations` — set up
  a Prism step by step. The steps are the ones the app's setup checklist shows
  (Workspace settings → Server); each step's "Have your agent do it" prompt
  names the step id the orchestrator maps to a skill.
- **MCP server**: `parachute-vault` — the vault-scoped HTTP MCP at
  `${PARACHUTE_URL}/vault/${PARACHUTE_VAULT}/mcp`, Bearer-authed with the
  hub-issued JWT (`${PARACHUTE_TOKEN}`).

## Environment

The MCP server entry in `plugin.json` expands these variables at install time:

| Variable | Meaning | Example |
|---|---|---|
| `PARACHUTE_URL` | Parachute server root | `http://127.0.0.1:1940` |
| `PARACHUTE_VAULT` | Vault name (scoped path segment) | `default` |
| `PARACHUTE_TOKEN` | Hub-issued JWT (`vault:<name>:write`) | `eyJ...` |

These mirror the placeholders in the repo-root `.mcp.json.template`; `prism setup`
renders that template into the gitignored `.mcp.json` for non-plugin (project-local)
MCP access.

## Schema notes (verified against the Claude Code plugin reference)

Per [plugins-reference](https://code.claude.com/docs/en/plugins-reference.md):

- `name` is the only required field; `version`/`description`/`author` are optional
  metadata. `author` is an **object** (`{ name, email?, url? }`).
- `skills` is a list of **directories** to scan for `<name>/SKILL.md`
  subdirectories — NOT a list of individual skill paths. We point it at this
  repo's `./.claude/skills/`. (Canonical plugin layout puts skills in a
  root-level `skills/`; the custom-path form is supported and avoids relocating
  this repo's existing skills.)
- `mcpServers` may be an inline object (used here) or a path to an external
  `.mcp.json`. `${VAR}` environment-variable expansion (incl. `${PARACHUTE_*}`)
  is supported at load time.

Validate before publishing with `claude plugin validate .`. For secrets like
`PARACHUTE_TOKEN`, consider a `user_config` prompt instead of a bare env var.
