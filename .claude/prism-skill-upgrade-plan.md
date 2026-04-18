# Prism Skill Upgrade Plan

## Problem

Prism's default skill prompts are generic ("classify importance", "extract action items"). The OmniHarmonic agent had domain-encoded heuristics with specific scoring algorithms, escalation thresholds, and Benjamin-aware logic that produced significantly higher quality output. This plan ports that intelligence into Prism's skill system.

## Architecture

Prism skills are Parachute vault notes tagged `agent-skill`. The scheduler reads them and dispatches Claude Code CLI with the note content as the prompt. Claude gets MCP access to the Parachute vault but NO filesystem access.

**Three layers of context reach the agent:**

1. **Vault description** — sent once per MCP session as server instructions. Teaches Claude who Benjamin is, what the projects are, and how to use this vault. ALL skills inherit this automatically.
2. **Tag schemas** — define expected metadata fields per tag. Claude sees these when querying tagged notes.
3. **Skill prompt** — the specific task instructions with algorithms, thresholds, and output format.

## Implementation Steps

### Step 1: Set the vault description

The vault description is the single highest-leverage change. It gives every skill persistent domain context without bloating individual prompts.

**How to apply:** Use the Parachute MCP tool `update-vault-description` or the REST API:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $PARACHUTE_API_KEY" \
  -H "Content-Type: application/json" \
  "http://127.0.0.1:1940/api/vault-info" \
  -d '{"description": "<vault description text>"}'
```

See `vault-description.md` in this directory for the full text.

### Step 2: Create/update tag schemas

Tag schemas teach Claude what metadata fields each tag expects. Apply via MCP `update-tag` or REST API.

See `tag-schemas.md` in this directory for all schemas.

### Step 3: Update skill notes in the vault

Replace the default skill prompts with the upgraded versions. Each skill is a Parachute note at a known path with the `agent-skill` tag.

For each skill:
1. Find the existing note (query by tag `agent-skill` + metadata `skillName`)
2. Update the note content with the new prompt
3. Update metadata (`enabled: true` when ready)

The upgraded prompts are in:
- `skill-message-triage.md`
- `skill-meeting-processor.md`
- `skill-daily-briefing.md`
- `skill-intelligence-scan.md`

### Step 4: Enable skills

Set `enabled: true` in each skill's metadata. Monitor the first few runs by checking `vault/agent/dispatches/` for output quality.

## File Index

| File | Purpose |
|------|---------|
| `vault-description.md` | Vault description text (domain context for all skills) |
| `tag-schemas.md` | Tag schema definitions for key tags |
| `skill-message-triage.md` | Upgraded message triage skill prompt |
| `skill-meeting-processor.md` | Upgraded meeting processor skill prompt |
| `skill-daily-briefing.md` | Upgraded daily briefing skill prompt |
| `skill-intelligence-scan.md` | Upgraded intelligence scan skill prompt |

## Verification

After applying:
1. Check vault description: `curl -H "Auth..." http://127.0.0.1:1940/api/vault-info`
2. Check tag schemas: query `list-tag-schemas` via MCP
3. Trigger each skill manually by setting `lastRun` to yesterday
4. Review output notes at `vault/agent/briefings/`, `vault/agent/insights/`
5. Check task notes created at `vault/tasks/active/`
6. Verify person notes are enriched, not duplicated
