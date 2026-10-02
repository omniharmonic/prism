# Graph-maintenance skills (drafts for the owner to install)

These skills keep Benjamin's personal knowledge graph linked without damaging
it. They are drafts: nothing here is installed or scheduled automatically.

## How the pieces fit

```
ingest + backfill job (Prism Server, deterministic)
   │  strong keys (email, Matrix id, Telegram, phone) → links, automatically
   │  anything it will not decide alone ───────────────┐
   ▼                                                    ▼
typed links in the vault                     identity review queue (SQLite)
   ▲                                                    │
   │  one CAS link per decision                         │  prism_people_review_* (Prism MCP)
   └──────────── agent JUDGEMENT (these skills) ◄──────┘
                    │
                    ├─ merge?  → prism_people_recommend_merge → owner approves in Prism → server merges
                    └─ a gap?  → prism_people_file_review     → owner decides in Prism
```

- **The server matches; agents judge.** Exact identity matching, tombstone
  repair, re-pointing and relationship normalization are the owner-run link
  job (`/api/admin/people/link`, `docs/roadmap/workspace-experience/BACKEND-STATUS-GRAPH.md`).
- **The queue is the interface.** Agents read a row, read its bounded context,
  and decide ONE row to ONE of its candidates (or leave it open).
- **Merges are the owner's.** Agents can only recommend; the merge route
  refuses an agent origin, and the MCP layer has no route to it.
- **One vocabulary.** Only the 11 canonical relationship names
  (`src/relationships.ts`); every skill lists them.

## The skills

| Skill | Where the draft is | Runs | Writes |
|---|---|---|---|
| `nightly-graph-weave` | `docs/skills/nightly-graph-weave/SKILL.md` | nightly, scheduled | review decisions, merge recommendations, a few explicit links, state + report notes |
| `nightly-clickup-reconcile` | `docs/skills/nightly-clickup-reconcile/SKILL.md` | nightly, scheduled | the `clickup-orphaned` tag, ClickUp field write-back (moved unchanged from the old weave) |
| `graph-navigator` | `docs/skills/graph-navigator/SKILL.md` | on demand | nothing (optionally files gaps to the queue) |
| `graph-gardener` | `docs/skills/graph-gardener/SKILL.md` | weekly, scheduled | report + state notes; proposals only |
| `reconcile` | `.claude/skills/reconcile/SKILL.md` (corrected in place) | in extraction pipelines | MATCH links; AMBIGUOUS → queue; duplicates → recommendations |
| `extract-entities` | `.claude/skills/extract-entities/SKILL.md` (corrected in place) | in extraction pipelines | nothing |
| `wikilinks` | `.claude/skills/wikilinks/SKILL.md` (corrected in place) | on demand | at most a `references` link the user asked for |

The three corrected skills lived in the repo (`.claude/skills/`), so they were
fixed there: real vault 0.7.9 tool names (`query-notes`, `update-note`,
`create-note`, `find-path`, `list-tags`, `vault-info` — not `read-notes`,
`get-note`, `search-notes`, `semantic-search`, `get-links`), `vault/people/`
paths, `limit` ≤ 25 with lean metadata, tombstone handling, the canonical
vocabulary, and no auto-merge (`reconcile` now outputs MATCH / CREATE /
AMBIGUOUS). `.claude/skills/resolve-wikilinks.md` still describes the legacy
desktop Tauri commands and was left as is; `wikilinks` supersedes it.

## Prism MCP tools these skills use

All are **server-owner only** (hidden from everyone else) and act on the
token's vault. Full reference: `BACKEND-STATUS-GRAPH.md` § "Agent tools".

| Tool | Scope | Read-only owner token | Read & write owner token | Hosted `prism-graph` | Hosted `prism-ro` / `prism-rw` / `prism-suggest` |
|---|---|---|---|---|---|
| `prism_people_review_queue` | read | yes | yes | yes | no |
| `prism_people_review_context` | read | yes | yes | yes | no |
| `prism_people_duplicates` | read | yes | yes | yes | no |
| `prism_people_link_status` | read | yes | yes | yes | no |
| `prism_people_review_decide` | write | — | yes | yes | no |
| `prism_people_recommend_merge` | write | — | yes | yes | no |
| `prism_people_file_review` | write | — | yes | yes | no |

**Credential advice.** Only the nightly weave's token needs Read & write —
give that token to that routine alone. `graph-navigator` and `graph-gardener`
should use a separate **Read only** token. Inside Prism's own agent chat the
tools exist only in the `prism-graph` profile (`AGENT_PRISM_PROFILES=true` +
`AGENT_GRAPH_PROFILE=true`); ordinary chat sessions never see them.

Daily caps (rolling 24 h), per credential and per account: decisions 200 /
400 (`PEOPLE_AGENT_DECISIONS_PER_DAY`, `PEOPLE_AGENT_ACCOUNT_DECISIONS_PER_DAY`),
filed rows 50 / 100 (`…_FILES_PER_DAY`), recommendations 50 / 100
(`…_RECOMMENDATIONS_PER_DAY`). All hosted agent turns of one account share one
per-credential bucket. Agent-filed rows have their own room in the queue
(`PEOPLE_QUEUE_MAX_AGENT_OPEN`, 100) and never take space from ingest rows.
Every agent decision is in the ledger the owner can read at
`GET /api/admin/people/agent/decisions` (kept `PEOPLE_AGENT_RETENTION_DAYS`,
180).

## Install (owner)

1. **Deploy the server change** (these tools ship with the branch; restart
   pm2 `prism-server` after the deploy, as always).
2. **Create the Prism token.** Prism → **Settings → Account → Connect your
   agent** → vault **primary** → **Read & write** → expiry (write tokens are at
   most 90 days — put a renewal reminder in the calendar) → **Create token**,
   copy it once, **Test connection** (it should list the `prism_people_*`
   tools; if it does not, the token's account is not the server owner).
   For `graph-navigator` and `graph-gardener` alone a **Read only** token is
   enough.
3. **Point the scheduled routine at Prism MCP.** In the scheduled task's MCP
   configuration add, next to the existing `parachute-vault` server:
   ```json
   { "mcpServers": { "prism": { "type": "http", "url": "https://<prism host>/mcp",
       "headers": { "Authorization": "Bearer pp_…" } } } }
   ```
   (Claude Desktop / Cowork: the `mcp-remote` form shown in the Connect panel.)
   The token is a secret: keep it in the MCP configuration only, never in a
   skill file or a vault note.
4. **Install the skills.**
   - `nightly-graph-weave`: create a new scheduled task (e.g.
     `~/Documents/Claude/Scheduled/nightly-graph-weave/SKILL.md`) with this
     file, at the old weave's time (04:00 America/Denver).
   - `nightly-clickup-reconcile`: a second scheduled task (e.g. 04:30), with
     the vault tools and the ClickUp connector.
   - `graph-gardener`: a weekly scheduled task (e.g. Sunday 05:00).
   - `graph-navigator`: copy to `~/.claude/skills/graph-navigator/SKILL.md`
     (or a project's `.claude/skills/`) so interactive sessions can use it.
   - The corrected `reconcile`, `extract-entities`, `wikilinks` are already in
     the repo's `.claude/skills/`; copy them wherever else those skills are
     installed.
5. **First run by hand.** Run `nightly-graph-weave` once interactively and read
   its report note (`vault/agent/reports/graph-weave/<date>`): every decision
   lists its row, source note, person and rationale. Spot-check five.
6. **Queue must have rows.** The backfill job fills the queue only when run
   with `"enqueue": true` (stage "The review queue" of the runbook in
   `BACKEND-STATUS-GRAPH.md`), and ingest adds rows only with
   `PEOPLE_QUEUE_ON_INGEST=true`. An empty queue makes Step 2 a no-op.

## Migrating from the current nightly task

The current task (`~/Documents/Claude/Scheduled/nightly-parachute-weave/`) is
told to auto-merge and may delete notes, invents relationship names, only looks
at ~24 hours, keeps no cursor, and reports self-estimated counts.

1. Keep its `SKILL.md` as a backup next to the existing
   `SKILL.md.bak-2026-09-30` (e.g. `SKILL.md.bak-2026-10-graph-weave`); do not
   delete it.
2. **Disable** the `nightly-parachute-weave` scheduled task (pause it in the
   scheduler) before enabling `nightly-graph-weave` — never run both; the old
   one would keep merging and writing non-canonical links.
3. Its Step 6 (ClickUp reconcile + write-back) now lives, unchanged, in
   `nightly-clickup-reconcile` — enable that task at the same time, or the
   ClickUp mirror stops being reconciled.
4. Its Step 4 ("surface broader patterns", the chief-of-staff observations) is
   **not** graph maintenance and is not in the new weave. If Benjamin still
   wants it nightly, keep it in the daily briefing routine (or a separate
   short task) — it needs no write access to the graph.
5. Earlier merges and invented relationship names from the old task are
   cleaned up by the server, not by agents: the link job's `tombstones`,
   `repoint` and `normalize` phases (dry run first), and `graph-gardener`
   reports any drift that keeps appearing.

## New vault conventions these skills introduce

- Tag `agent-state` on the two state notes (`vault/agent/graph-weave/state`,
  `vault/agent/graph-gardener/state`), created on first run.
- Report notes under `vault/agent/reports/graph-weave/` and
  `vault/agent/reports/graph-gardener/`, tag `report`.
