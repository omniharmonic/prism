# Handoff — omniharmonic agent ↔ Prism ↔ Parachute 0.5.x

**Date:** 2026-06-02 · **Author:** Prism cleanup pass · **Audience:** the omniharmonic agent (separate repo) and whoever maintains its skills.

You (the omniharmonic agent) and Prism both read and write the **same Parachute vault** (`default`, `http://localhost:1940`). Prism just completed a large cleanup that (a) migrated the vault onto Parachute **0.5.x**, (b) fixed pervasive metadata drift, and (c) canonicalized the person graph. This document tells you what changed, what conventions to follow so we don't fight each other, and **the specific flaws in your own skills** that will misbehave against the current vault.

> TL;DR — your skills (`classify`, `extract-entities`, `reconcile`, `schema-bridge`, `wikilinks`) call **dead Parachute tool names** and will silently fail or no-op. Section 1 is the migration table. Section 4 is your flaws. Section 5 is the runbook.

---

## 1. Parachute 0.5.x API migration (your tool calls are out of date)

The MCP surface was renamed/reduced. Your skills reference the **old OPAL/pre-0.5 names**. Map every call:

| Your skill calls (DEAD) | 0.5.x replacement | Notes |
|---|---|---|
| `mcp__parachute-vault__get-vault-description` | `vault-info` | Returns name, description, tags-with-schemas, indexed fields. `vault-info { include_stats: true }` for counts. |
| `read-notes` | `query-notes` | `query-notes { tag, include_content:false, limit, sort, exclude_tags }`. Same NoteIndex shape. |
| `search-notes` | `query-notes { search: "…" }` | Full-text. Add `tag` to scope. |
| `get-note` | `query-notes { id: "<id-or-path>" }` | `include_content` defaults true for single-note. Add `include_links:true` for edges. |
| `get-links` | `query-notes { id, include_links:true }` | Links come back on the note as `links[]` (each `{sourceId,targetId,relationship,…}`). There is no standalone links endpoint. |
| `create-link` | `update-note { id:<src>, links:{ add:[{target,relationship}] }, force:true }` | Mutations route through PATCH on the note. |
| `delete-link` | `update-note { id:<src>, links:{ remove:[{target,relationship}] } }` | Removing a wikilink-type link also strips `[[brackets]]` from content. |
| `batch-tag` / `batch-untag` | `update-note { notes:[ {id, tags:{add|remove:[…]}}, … ] }` | Batch = pass a `notes` array to one `update-note` call. |
| `list-tag-schemas` | `list-tags { include_schema:true }` | Per-tag: `list-tags { tag:"person" }`. |
| `semantic-search` | **NO EQUIVALENT** | 0.5.x has **no embeddings/semantic search**. Use `query-notes { search }` (full-text) + `query-notes { near:{ note_id, depth } }` (graph neighborhood) + your own reasoning. See §4 reconcile. |
| `find-path` | `find-path` | Unchanged. |

**Current full surface (9 tools):** `query-notes`, `create-note`, `update-note`, `delete-note`, `list-tags`, `update-tag`, `delete-tag`, `find-path`, `vault-info`. (The hub/claude.ai variant also exposes `prune-schema`, `manage-token`.)

### REST contract (for scripts/cron, not MCP sessions)
- Base: `http://localhost:1940/vault/default/api/...` (vault-scoped; the old unscoped `/api` was removed).
- Auth: `Authorization: Bearer <hub JWT>` — scope `vault:default:read|write`, minted via `parachute auth mint-token --scope vault:default:write --ephemeral`. The pre-0.5 `pvt_*` opaque tokens are **rejected (401)**.
- **Mutations PATCH `/notes/:id`** and **require `if_updated_at` (the last-read `updatedAt`) or `force:true`** — else `428`. Background/scripted writers use `force:true`.
- **PATCH metadata MERGES** (per-key) — it does not replace. You cannot delete a key by omitting it; set it explicitly or use a replace path.
- `query-notes` list calls **cap/​paginate** — pass `offset` to page, or use the `cursor` param for "since last checked" loops. **Do not assume `limit:200 sort:desc` sees everything** (see §4).

---

## 2. New data conventions (adopt these when you write)

The vault now has **authoritative tag schemas** (`list-tags { include_schema:true }`). Write the **declared** field names; undeclared camelCase siblings are drift.

| Type | Write these fields | Do NOT write (legacy/drift) |
|---|---|---|
| `task` | `status` ∈ {todo,in-progress,blocked,done,cancelled}; `due` (date); `assigned`; `priority` ∈ {critical,high,medium,low} (**indexed**); `completed`; `context` | `status:"pending"`, `deadline`, `requester` (migrated away) |
| `transcript` | `source` (meetily/fathom/whisper/manual), `source_id`, `date`, `duration_minutes`, `synced_at` | `sourceId`, `fathomUrl` |
| `meeting` | `date`, `attendees[]`, `projects[]`, `source`, `status` ∈ {raw,cleaned,processed}, `recording_id`, `fathom_url`; calendar lifecycle → `event_status` | putting Google `confirmed`/`cancelled` in `status` |
| `person` | `channels.email[]`, `name`, plus EA fields you own (below) | — |

Other conventions:
- **Tasks are idempotent** — before creating, `query-notes { tag:"task", search:"<key phrase>" }`; update an existing open task instead of duplicating.
- **`task.priority` is the only indexed scalar.** `due`/`date` are `date`-typed and **cannot be indexed** (engine indexes string/int/bool only) — date-range queries full-scan; that's expected. If perf matters, store a derived integer (e.g. `due_epoch`) and index that.
- **Tags are the type system**, not `metadata.type` (which is legacy-but-tolerated).

---

## 3. Prism ↔ omniharmonic division of labor

Both processes write the vault. Stay in your lanes:

**Prism (Rust services + scheduler) owns:**
- **Ingestion** → raw notes: `email` (Gmail), `meeting` (Google Calendar), `transcript` (Fathom/Meetily), `message-thread` (Matrix), and *raw* `person` notes for attendees/senders (now with a non-human-email guard).
- **transcript↔meeting linking** (`has-transcript` / `transcriptNoteId`).
- **The skill scheduler** — dispatches `message-triage`, `meeting-processor`, `daily-briefing`, `intelligence-scan`, `task-lifecycle`, `deduplication`, `tag-refinement` as `claude -p` runs (prompts shipped from `skill_scheduler.rs::DEFAULT_SKILLS`).

**You (omniharmonic agent) own:**
- **The EA / relationship layer** on `person` notes: `ea_managed:true`, `priority_weight`, `cadence_baseline_days`, `interaction_score_90d`, `relationship_status`, `last_meaningful_contact`, `healed_from_tombstone`.
- **Canonicalization** (your `reconcile` skill) and the OPAL extract/classify pipeline (`/oparachute-process`).
- **Schema bridging** (OPAL resource_types/dimensions ↔ Parachute tag_schemas).

**The contract that keeps us from fighting:**
- **Person merges are TOMBSTONES, never deletes.** The secondary note: content → `# (merged)\n\nThis note has been merged into [[<canonical path>]] on <date>…`; metadata `status:"merged_into_canonical"`, `merged_into:"<canonical path>"`, `merged_at:<iso>`; **keep the `person` tag**; transfer its links to the canonical; union `channels.email`. Your resolver already excludes `status:"merged_into_canonical"` — keep doing that, and **prefer the `ea_managed:true` note as canonical**.
- **Don't recreate people Prism declassified.** Notes tagged `non-human` (bots, noreply@, role accounts) are intentionally NOT people. Don't re-add the `person` tag.
- As of this cleanup there are **83 tombstones, ~3986 live people, 0 exact-duplicate clusters.** 6 borderline fuzzy pairs await your judgment in `vault/agent/dedup/fuzzy-review-2026-06-02`.

---

## 4. Correcting your skills (flaws relative to tending the graph)

Concrete fixes per skill, beyond the §1 tool rename:

**`reconcile` (`.claude/skills/reconcile/SKILL.md`)**
1. Phase 0/1 use `read-notes limit:200` → only sees the newest 200 of ~4k people. **Paginate** (`offset`) or use `cursor`; for dedup you need the whole set.
2. Phase 3 "semantic match" calls `semantic-search` which **no longer exists**. Replace with `query-notes { search }` over name/alias + `near` neighborhood overlap + reasoning. Lower the auto-merge bar accordingly and lean on REVIEW.
3. Merge step says "create-link/delete-link/batch-tag" (dead) and "secondary becomes an alias". **Implement the tombstone convention from §3 via `update-note`** (content rewrite + metadata + `links:{add}` onto canonical). Never `delete-note` a person.
4. Add the **non-human-email filter** before proposing a person at all (see extract).

**`extract-entities` (`.claude/skills/extract-entities/SKILL.md`)** — *this is an active sprawl source.*
1. `get-vault-description` → `vault-info`; `read-notes` → `query-notes` (paginate).
2. **Filter automated/role addresses** before emitting a `person` entity: skip `noreply@`, `notifications@`, `mailer-daemon`, and role locals (`support`, `billing`, `hello`, `info`, `team`, `help`, `sales`, `contact`, `newsletter`, `updates`, `alerts`) and bot handles (`*bot`). Prism mirrors this in `person_linker::is_nonhuman_email` — match it.
3. Emit the **declared** schema field names (§2), not invented ones.

**`classify`** — logic is fine; it makes no vault calls. No change needed.

**`schema-bridge`** — when translating OPAL→Parachute, target `update-tag { tag, fields:{ <name>:{ type, enum?, indexed? } } }`. Remember: only `string`/`integer`/`boolean` can be `indexed:true`, and **all tags declaring a shared field name must agree on type+indexed** (global constraint).

**`wikilinks` / `resolve-wikilinks`** — verify against the `update-note` link API; removing a wikilink-type link also strips `[[brackets]]` from content (intended).

**`/oparachute-process` command** — update its tool references to match the above so the pipeline doesn't no-op mid-run.

---

## 5. Operational runbook

**Prism cleanup artifacts (this repo):**
- `scripts/migrate-vault-vocab.py` — task/transcript vocab migration (dry-run default; `--apply` needs `PARACHUTE_TOKEN`). Idempotent.
- `scripts/dedup-people.py` — deterministic person dedup. Modes: (default) analyze; `--apply` tombstone-merge exact clusters; `--junk`/`--apply-junk` declassify non-human; `--emit-fuzzy FILE`; `--apply-fuzzy FILE --min-conf` apply swarm verdicts.
- Both hit the REST API with a `PARACHUTE_TOKEN` (vault:default:write JWT).

**Redeploy Prism (when skill prompts or Rust writers change):**
1. `npm run tauri build`
2. `osascript -e 'quit app "Prism"'` → `ditto target/release/bundle/macos/Prism.app /Applications/Prism.app` → `open /Applications/Prism.app`
3. `ensure_default_skills` runs ~20s after launch and reconciles the `DEFAULT_SKILLS` prompt bodies into the vault. **A built-but-not-reinstalled binary is the #1 "fix didn't take" trap** (the cleanup found the live app lagging a commit by 55 min).

**Verification checks:**
- Prompts reconciled: `query-notes { tag:"agent-skill" }` → `updatedAt` bumped, message-triage says `status="todo"`.
- Migration idempotent: re-run `migrate-vault-vocab.py` (dry) → all-zero deltas.
- Dedup state: `dedup-people.py --show 0` → `SAFE clusters: 0`.
- Skill health: read latest `vault/agent/dispatches/<date>/<skill>-*` `agent-output` notes.

---

## 6. Appendix — pointers
- Prism conventions & architecture: `CLAUDE.md` (this repo).
- Shipped skill prompts: `src-tauri/src/services/skill_scheduler.rs` (`DEFAULT_SKILLS`).
- Person creation + non-human guard: `src-tauri/src/services/person_linker.rs`.
- Sync writers (declared field names): `transcript_sync.rs`, `calendar_sync.rs`.
- Cleanup commits on `main`: `0304a05` (writers + migration), `2664f5c` (task-lifecycle/idempotency/sprawl), `73c49cb`/`cae5ccb`/`a9f3418` (dedup).
- Held fuzzy pairs for your judgment: `vault/agent/dedup/fuzzy-review-2026-06-02`.
