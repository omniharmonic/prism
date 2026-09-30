# Parachute upgrade plan — hub 0.7.1 → 0.7.19, vault 0.6.1 → 0.7.9

Status: **researched + rehearsed; Prism compatibility + history UX built (branch `claude/parachute-0.7.9-upgrade`).** 2026-09-30. Decision: history ENABLED on every vault (incl. `default`) — made safe by Matrix thread rollover + nightly compaction.
Evidence: `research/` (vault, hub, ecosystem, Prism footprint, sandbox rehearsal) — kept local-only (gitignored), since it quotes private vault contents. Baseline backup:
`~/parachute-backups/20260930T195002Z-pre-upgrade-baseline` (823 MB, every db `integrity_check=ok`).

## 1. What we're crossing

Running since 2026-06-12: hub **0.7.1**, vault **0.6.1**. Latest (2026-09-22): hub **0.7.19**, vault **0.7.9**.
481 upstream commits, no 0.8 in sight — a good window.

A full rehearsal (sandbox hub+vault on :19939/:19940 against a copy of the backup, a second
prism-server pointed at it) established:

| | Result |
|---|---|
| Migrations | hub.db schema 13→24; all 9 vaults 22→32 in **~4 s total** (incl. FTS rebuild of 13,886 notes). Counts, tag schemas identical; vault `doctor` 0 errors. |
| Tokens | Every existing production JWT validates on 0.7.9. Signing keys / JWKS unchanged. |
| REST shapes | Lists stay flat arrays, graph stays `{nodes,edges}`. All changes **additive** (new fields, `X-Parachute-Warnings` header). Desktop Rust client safe (no `deny_unknown_fields`). |
| Prism | `npm test` 677/677; `verify-gateway` 30/30; `verify-collab-share` 58/58; `verify-invite-flow` pass. |
| Search | Literal-by-default: multi-word questions go **0 → 50 results** (fixes RAG's sparse leg); punctuation no longer errors. |
| Rollback | Restore-from-backup under 0.6.1 boots clean. Downgrading the binary on a migrated db is **not** safe (see §5). |

## 2. What breaks unless we fix it first (all verified in the rehearsal)

| # | Break | Impact | Fix (must be backward-compatible with 0.6.1 so it ships *before* the upgrade) |
|---|---|---|---|
| B1 | **Note history is on by default; updates to a note > 2 MB → 413 `history_overflow`** | the largest Matrix thread (2.16 MB) stops receiving messages the instant 0.7.9 boots; the next (1.55 MB) follows soon | Decide history per vault (§4). Make `matrix.ts` surface 413 loudly and **roll a thread over** (archive older lines into `<path>/archive/<n>`) once it passes ~1 MB. |
| B2 | **History snapshots accumulate between vault restarts** (compaction runs only at open or via admin `POST /api/history/compact`) | 50 appends to a 1.2 MB note = +46.5 MB (→3.6 MB after compaction) | Keep history off for the ingest-heavy `default` vault at cutover; if later enabled, add a nightly compact job. |
| B3 | **Tag-schema writes need `vault:<name>:admin`** (REST `PUT/DELETE /tags` → 403; MCP `update-tag`/`delete-tag` vanish for write tokens) | `seedTagSchemas`, `prism-setup-schema`, `commons-init`, desktop `schema_seed.rs`, `omniharmonic_agent/scripts/apply_tag_schemas.py`, in-app schema editing | Optional `PARACHUTE_ADMIN_TOKEN` (short-lived, minted per run) for seeding; treat 403 as "operator step needed", not a crash. |
| B4 | **Indexed `number`/`array` fields rejected** (400 `invalid_indexed_field`) | `tag-schemas.json` marks `bbox` (array) and `gbifTaxonKey` (number) indexed → seeding those tags fails | Drop `indexed` on both (or `gbifTaxonKey` → `integer`). Make the Rust seeder strip non-indexable `indexed` like the TS one. |
| B5 | **Enum fields no longer default-fill with the first value** | Any UI assuming a schema'd field is always present | Add explicit `default:` to enums in `tag-schemas.json` where a default is wanted; handle absent fields. |
| B6 | **Wrong-typed indexed field on write → 422**, nothing written | Silent ingest loss if a writer sends e.g. numeric `priority` | Audited: governance, ClickUp, bioregion data all write strings today ✓. Make vault 422s visible in worker logs. |
| B7 | **`mint-token --sub` now becomes a label; `sub` = operator** (hub #872) | Member MCP tokens attributed to the owner | `apps/server/src/mcp-token.ts`: `--sub` → `--service` (verified keeps `sub = mcp:<email>`). |
| B8 | Two verify scripts ignore `--env-file` and hit **live** :8787 | Cutover runbook could mutate prod | Fix `scripts/verify-suggestions.ts`, `verify-crdt-conflict.ts` to honor `config.port`. |

Non-issues (checked): no `#`-prefixed tags exist; every indexed value in every vault is already text (the v24
in-place type coercion is a no-op); no vault triggers/webhooks configured; no caller uses `limit=-1` or the
removed `date_from/date_to`; hub still binds loopback (plist pins `PARACHUTE_BIND_HOST=127.0.0.1`).

## 3. Live problems found along the way (independent of the upgrade)

- **`front-range-commons` registry token expired 2026-09-26** — folder sync into that vault has been failing.
  `spiritofthefrontrange` expires **2026-10-11**; `front-range-bioregion` 2026-12-03; Claude Code's
  `parachute-vault-default` MCP token 2026-11-11. → re-mint now; add expiry warnings to `/api/health` + the
  Network panel.
- Graph fetch `limit=10000` silently truncates the 13.9k-note `default` vault (0.7.9 now flags it).
- Desktop wikilink resolver only scans the first 2,000 notes; desktop agent prompts + three repo skills name MCP
  tools that don't exist (`search-notes`, `get-note`, …).
- ~3,600 unrevoked `vault:default:write` tokens from `omniharmonic_agent` re-minting on every 401.
- CLAUDE.md: "vault #404 REST tag-scope gap" is wrong (tag scope *is* enforced on REST; #404 was a test gap).

## 4. Decisions (made 2026-09-30)

1. **History ENABLED on every vault, including `default`**, with a first-class history UX in Prism (browse, diff,
   restore). Made safe by: Matrix thread rollover (threads stay ≤ ~1 MB, verified lossless on the real data), the
   collab no-op-write guard (no phantom versions), and a nightly slice-bounded compaction job.
2. **Minimize downtime; seconds are acceptable.** Hub and vault are upgraded as separate steps.
3. **Full holistic upgrade** — Prism compat + history UX ship first (works on both stacks), then hub, then vault.

## 5. Execution

**Principles.** Upgrade hub and vault **separately** (never `parachute upgrade` with no argument — it restarts
the vault twice and bumps everything). Pin exact versions. Back up with writers paused, immediately before each
step. Rollback = **restore the backup**, never run 0.6.1 on a migrated db (its writes leave `updated_at_ms`
stale → cursor sync/date filters silently skip those notes; repair if ever needed:
`UPDATE notes SET updated_at_ms = NULL` with the vault stopped).

### Phase 1 — Prism compatibility PR (ships first, works on both versions)
B1 (413 visibility + rollover), B3, B4, B5, B7, B8; re-mint expiring registry tokens; token-expiry warnings;
CLAUDE.md corrections; version-history UX. Deploy (`pm2 restart prism-server`); **confirm the rollover sweep has
trimmed every thread under 1 MB on the old vault before Phase 3** (after 0.7.9 a >2 MB thread can't be trimmed).

### Phase 2 — Hub 0.7.1 → 0.7.19 (seconds of hub downtime; vault restarts with it)
```bash
scripts/backup-parachute.sh pre-hub                    # verify "all integrity checks ok"
curl -s 127.0.0.1:1939/.well-known/jwks.json | shasum  # record
# pause token minters: pm2 stop prism-server is NOT needed; just don't mint during the step
bun add -g @openparachute/hub@0.7.19 && launchctl kickstart -k gui/$(id -u)/computer.parachute.hub
```
Verify: `/health`; `sqlite3 ~/.parachute/hub.db 'select max(version) from schema_version'` = 24; JWKS hash
unchanged; existing token → 200 on `/vault/default/api/notes?limit=1`; fresh `mint-token --service` token works;
`https://agent.omniharmonic.com` answers; `parachute doctor`; plist still has `PARACHUTE_BIND_HOST=127.0.0.1`.
Rollback: `bun add -g @openparachute/hub@0.7.1` + kickstart (keep the migrated hub.db — changes are additive; or
restore `pre-hub` hub.db, losing tokens minted since).

### Phase 3 — Vault 0.6.1 → 0.7.9 (~10 s vault downtime)
1. History uses the vault defaults (enabled) — no `vault.yaml` change needed. Re-check no note > 1.9 MB exists.
2. Pause writers: `pm2 stop prism-server`; stop `omniharmonic_agent` launchd jobs for the window.
3. `scripts/backup-parachute.sh pre-vault` — writers paused, so rollback loses nothing.
4. `parachute upgrade vault` (pinned to 0.7.9) — or `bun add -g @openparachute/vault@0.7.9` + hub kickstart.
5. Verify: every vault `schema_version` 32 and note count = manifest; vault `doctor` (MCP, read) clean;
   `python3 docs/roadmap/parachute-upgrade/rehearsal-tools/probe_reads.py` (GET-only); a PATCH to a `_test` note.
6. `pm2 start prism-server`; restart agent jobs; run `verify-gateway`, `verify-collab-share`,
   `front-range-bioregion/scripts/verify.mjs`.
7. Watch 24 h: pm2 logs for 413/422/403, Matrix `lastMessageAt` advancing on the biggest rooms, db file sizes.
Rollback: stop hub → `bun add -g @openparachute/vault@0.6.1` → copy `pre-vault` `vault.db` files back (delete
`-wal`/`-shm`) → start. Matrix gap-fill + hourly reconcile back-fill anything missed.

### Phase 4 — Other consumers
`omniharmonic_agent`: `apply_tag_schemas.py` needs an admin token; reap stale tokens. Desktop: rebuild with the
seeder fix. Re-run `prism-setup-schema` with an admin token to confirm idempotency on 0.7.9.

## 6. Phase 5 — using what 0.7.9 / 0.7.19 give us (each its own PR, in value order)

| Adopt | Why | Effort |
|---|---|---|
| **Version history panel** (list/compare/restore via the VaultClient seam; restore needs `if_updated_at`) | Free undo for every note; natural fit for governed commons | S–M |
| **Per-ingester tag-scoped tokens** (Matrix → `message-thread`, ClickUp → `task`, transcripts, …) replacing the year-long whole-vault god-token | A compromised worker can no longer touch the whole vault; vault attribution (`created_via`) becomes truthful | M |
| **`if_exists` upserts** in ingesters | Removes query-then-create races and the duplicate-note failure class | S |
| **Live subscribe (`/api/subscribe` WS)** for collab external-edit detection + cache invalidation | Replaces load-time `updatedAt` comparison — the root of the re-seed/double-row collab bugs | M |
| **Member MCP tokens carry `scoped_tags`** mirroring the member's Prism grants | Today they bypass Prism ACLs entirely | S–M |
| `state_transition` compare-and-set for task status; `aggregate` counts for dashboard stat widgets; `doctor` in the Server panel | Correctness + cheaper dashboards + ops visibility | S each |
| Evaluate vault semantic search (`embeddings_enabled`, can point at the local embedder) vs Prism's RAG | Might retire `rag/*` + the Rust indexer; mind the 16 GB host | M (eval) |

**Strategic, decide later** (from `research/ecosystem.md`): Parachute's backed-surface contract was modelled on
Prism and asks it to (a) log the owner in via hub OAuth instead of a standing god-token passthrough, (b) make
vault *members* hub users (`user_vaults`) while Prism keeps its own auth for the audience plane (link holders,
commenters, public wiki), and (c) register as a hub module (retiring pm2 + hand-run cloudflared). Prism's
renderers, type-aware collab, governance, publishing, integrations and federation have no upstream equivalent —
keep investing there.
