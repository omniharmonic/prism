# Bioregional Commons — Implementation Progress

Branch `claude/bioregional-commons-research-imkw2y`. Companion to the two plans
(`bioregional-commons-1-governance.md`, `bioregional-commons-2-graph.md`).

## How to try it

```bash
# From a worktree of this branch (keeps your main checkout / pm2 service untouched):
git worktree add ../prism-governance claude/bioregional-commons-research-imkw2y
cd ../prism-governance && npm install
./scripts/governance-sandbox.sh          # server :8899 + web :5180, own db, borrows .env
# optional: real content to explore
node scripts/seed-demo-commons.mjs        # (--clean to remove)
```

Open **http://localhost:5180/commons** → sign in (magic link prints in the
sandbox terminal) → walk **Bioregion** and **Governance**.

Automated browser proof (no vault needed):
```bash
E2E_FAKE_VAULT=1 PW_EXECUTABLE_PATH=/path/to/chromium ./scripts/e2e-governance.sh
```

## Status

### Plan 1 — Governance (backend + UI + e2e)
| Phase | What | State |
|---|---|---|
| G0 | Pure engine (`governance.ts`) + note schemas | ✅ 21 unit tests |
| G0b | Store seam (notes ⇄ structures) | ✅ 12 unit tests |
| G1 | Live routes + bootstrap-lock choke point | ✅ 9 route tests |
| G2 | Content review pipeline (propose → sign-off → live) | ✅ route tests |
| G3a | Observability (audit + roster) + withdraw | ✅ route tests |
| G4 | Approval ≠ publishing, revisions, rollback | ✅ route tests |
| UI | `/governance` surface (bootstrap, proposals, publish, history, audit) | ✅ e2e |

### Plan 2 — The bioregional graph
| Phase | What | State |
|---|---|---|
| S1 | 11-type ontology seeded into `tag-schemas.json` | ✅ |
| geo | GeoJSON utilities (bbox / validate / swap-detect) | ✅ 11 unit tests |
| hier | `parent_names` is-a tree (entity/place) + non-destructive seed | ✅ 3 seed tests |
| S3 | Geospatial surface — MapLibre vector map as the in-app **Map** tab (vault-wide, kind-filterable, click → open note) + draw Point/Line/Polygon → GeoJSON on a note | ✅ e2e |
| S4 | GBIF/Darwin Core + GeoJSON + USGS WBD importers + CLI | ✅ 6 unit + e2e |
| S5-lite | sense→respond detail (a threat → what it affects / responses) | ✅ e2e |

### E2E user flows (Playwright, real Chromium)
- **Governance**: magic-link sign-in → bootstrap (role/policy/member) → **Enable
  & lock** → owner's direct edit refused → amendment proposal → approve → apply →
  role live → content proposal → approve → **approval≠publishing** (staged) →
  publish → note in vault → audit. Plus stranger-gate.
- **Bioregion**: map draws creek/watershed/species-range/threat → type &
  sensing/responding lenses filter → threat detail shows what it **affects** →
  cross-surface nav. Plus stranger-gate.
- 4/4 specs pass. Server suite 251/252 (one pre-existing unrelated magic-link
  failure); web + e2e typechecks clean.

### Mock infrastructure (unblocked the "infra-blocked" items)
`scripts/two-hub-mock.sh` reconstructs the two-hub federation environment with
zero real infrastructure (two fake vaults behind two REAL Prism Servers) and runs
the existing `verify-two-hub.ts` harness: **11 PASS / 0 FAIL** in a headless
sandbox — pairing, mirror flow, live A⇄B CRDT convergence, revocation.
`--keep` leaves the stacks running for interactive work.

| Formerly blocked | State |
|---|---|
| G2b — suggest-mode durable capture + accept/reject that APPLIES | ✅ 10 unit tests + live Yjs client proof (`scripts/verify-suggestions.ts`, ALL PASS); also fixed a real attribution-loss bug in the shared suggestion marks |
| Two-hub federation convergence (handoff AC-1..11) | ✅ 11/0 via `two-hub-mock.sh` |

## Remaining (from the two plans)
Nothing. G5 (fork / ancestry / proposal-only merge) and S2 (per-type renderers
in the main app) both landed; the geospatial surface is now the in-app **Map**
tab (`MapRenderer`, sidebar → Map; `/map` and `/bioregion` are deep-link
aliases that boot the app into it). The branch was reconciled with `main`
(pure-integration merge, 4 keep-both conflicts, one `isOwner` → role-model
translation) and re-verified on the merged tree.

What is genuinely next is **operator/UX readiness**, not plan items — see the
readiness audit summary at the bottom of this file.

---

## Final evaluation (full battery, one sweep)

Both plans are implemented end to end. The complete verification battery, run
together on the final code:

| Suite | Result |
|---|---|
| Server unit + route suites (`npm test`) | **274 / 275** (the 1 failure is a pre-existing, unrelated magic-link env test) |
| Playwright e2e — governance + bioregion + import (5 specs, real Chromium) | **5 / 5** |
| Two-hub federation convergence (`two-hub-mock.sh` → `verify-two-hub.ts`) | **11 / 0** (+3 operator/in-proc skips) |
| Suggest-mode capture+apply live (`verify-suggestions.ts`) | **ALL PASS** |
| Concurrency + bulk stress (`stress-commons.mjs`) | **PASS** — 200-note bulk map import; 30 concurrent propose→vote→apply each landing exactly once; 10 fork→merge cycles; audit integrity |
| Typechecks — server, core, web, e2e | **clean** |
| Web production build | **succeeds** |

### Acceptance against the plans
- **Plan 1 (governance):** roles/trust, per-tag threshold policies with
  distinct-approver/quorum/window, the bootstrap lock (owner bound once enabled),
  the propose→sign-off→apply pipeline, approval≠publishing + revisions + rollback,
  fork/ancestry/proposal-only merge, audit, and suggest-mode capture+apply — all
  built, note-native, and verified. Governance surfaces both as a Network sub-tab
  (production) and the standalone `/governance` route (dev).
- **Plan 2 (graph):** the 11-type purpose-bound ontology + parent_names is-a tree,
  the GeoJSON convention + utils, the `/bioregion` map/browse with the
  sensing/responding cleavage and sense→respond detail, a dedicated main-app
  renderer, and importers (GBIF/Darwin Core, GeoJSON, USGS WBD) — built and
  verified.
- **Infra:** the whole federation substrate reproduced with zero real
  infrastructure (`two-hub-mock.sh`) so federation/collab items are buildable +
  verifiable in a headless sandbox.

Reproduce it all: `E2E_FAKE_VAULT=1 ./scripts/e2e-governance.sh`,
`./scripts/two-hub-mock.sh`, and (with `--keep`) `node scripts/stress-commons.mjs`
+ `HUB_ENV=.env.mock-a node --import tsx apps/server/scripts/verify-suggestions.ts`.

---

## Readiness audit (2026-09) — the gap to "clone a repo and stand up a commons"

Both plans are built and verified. A code-level audit of the *operator* path
found the engine strong and the product surface thin. This is the next sprint,
in priority order. None of it is plan work; all of it is what stands between the
engine and a non-technical group using it.

**Landmines (fix first — reachable by clicking):**
- ~~*Enable & lock* offers `(config default)` as the first amend policy, which
  synthesizes eligible role `admin`. If the group named their role otherwise,
  nobody can ever vote → governance can never be amended or disabled. Nothing
  validates that an eligible role + member exist before locking.~~
  **RESOLVED P0 (`db75c4a`).** `validateRatification` is a pre-flight on the
  enable transition: it refuses to lock a constitution whose amend policy
  doesn't resolve, whose eligible role doesn't exist, or that has fewer active
  eligible members than the amend threshold. The un-amendable-forever state is
  now unreachable through the API (`mutateGovernance` calls it before any
  `enabled:true` write lands).
- ~~The `disable` amendment template wipes `bootstrapOwner`; after a disable,
  nobody can ever re-bootstrap. Recovery is a curl from loopback only.~~
  **RESOLVED P0 (`db75c4a`).** `mergeConfig` always inherits `bootstrapOwner`
  when the incoming config omits it (and inherits `amendPolicy` too, while
  staying enabled) — a bare `{enabled:false}` can no longer blank the recovery
  root. The loopback-curl recovery path remains, for the case that predates a
  bootstrapOwner entirely.
- `APP_ORIGIN` defaults to `localhost:8787` — misconfigured, every invite link
  is dead. **Not addressed by this work** — still open.

**Provisioning / ingest correctness:**
- ~~`commons-init` and both importers have **no idempotency** — a re-run
  duplicates every role, policy, member, and note.~~ **Governance half RESOLVED
  P0 (`db75c4a`):** `add_role`/`add_policy`/`add_membership` are now upserts
  keyed by natural identity (role name; policy action+scopeType+scope;
  membership subject+role), so re-running `commons-init` against an existing
  constitution converges instead of duplicating it. **Note/import ingest
  duplication is untouched** — the importers still have no dedupe, so the
  documented dry-run → provision → re-run-with-`--enable` flow still duplicates
  ingested notes on the re-run.
- `commons-init` verify step 4 is vacuous: it queries `?tag=` on the owner
  passthrough, which ignores `tag`, so it passes if *any* note exists.
  **Untouched.**
- Importer opts (`--kind/--sensing/--name-prop`) are silently ignored for
  `gbif-species` and `wbd-watersheds`. Unknown `--source` crashes `commons-init`.
  **Untouched.**
- GBIF species import writes no geometry → those notes never appear on the Map.
  **Untouched.**
- Murmurations is documented as a working source but has no importer.
  **Untouched.**

**The missing product surface:**
- **No bioregion parameter anywhere** — no bbox / HUC / place picker. "Configure
  your bioregion" means hand-downloading GeoJSON and pointing `--file` at it.
  **Untouched** — out of scope for the governance charter.
- No ingest UI at any layer; CLI + JSON only. 3 of 11 documented sources exist.
  **Untouched.**
- ~~Tag-level grants (the "this working group edits #water" primitive) are
  curl-only — `PUT /acl/tags/:tag/people` has no client.~~ **Partially RESOLVED
  P1+P2 (`53886c7`, `fb4bed1`).** The route itself is no longer admin-curl-only:
  `PUT`/`DELETE .../people` on both notes and tags now accept an optional
  `caps` list, and a non-admin holding the `share` cap on that note/tag can call
  the route directly (subset-of-own-caps, existing-accounts-only). **Still no
  dedicated UI** — `ShareDialog` shows tag access read-only and can *publish* a
  tag publicly, but there is no client control that calls
  `PUT /acl/tags/:tag/people` to share a tag privately with one person. No
  group/team object either.
- ~~Governance roles grant **zero** editing rights — two disconnected permission
  systems with overlapping vocabulary and no bridge or explanation.~~
  **RESOLVED P2 (`fb4bed1`).** `governance-grants.ts` compiles active
  memberships × role `capabilities` into ordinary grant rows, reconciled after
  every mutation and on a 5-minute worker tick. `effectiveCaps`/`effectiveLevel`
  stay the only content guard; governance now gates content by writing grants
  for that guard to read, never as a second check. See CLAUDE.md "THE BRIDGE".
- ~~Nothing can be removed or revoked (member/role/policy) in UI *or* API.~~
  **RESOLVED P0+P3 (`db75c4a`, `5e8d7f8`).** API: `remove_role`/`remove_policy`/
  `remove_membership` (with cascade + the amend-policy protections) plus
  PATCH/DELETE fixup routes pre-lock. UI: role cards carry member chips with
  add/remove, and post-lock edits open a pre-filled amendment instead of
  silently failing.
- ~~Post-lock governance is a raw-JSON textarea; content proposals need a
  hand-typed note id; approval progress ("1 of 2") is never rendered.~~
  **RESOLVED P3 (`5e8d7f8`).** `BootstrapWizard` (3 templates), `RoleEditor` +
  `PolicyBuilder` (rules rendered as sentences, each slot a control), and
  `ProposalsPanel` (approvals/needed progress, quorum, window countdown, an
  edit_note diff view) replace the textarea; amendments still expose an
  Advanced raw-JSON disclosure for anything the structured form doesn't cover.
- Parachute is a separate install; `@openparachute/hub` is on npm (0.7.x vs the
  0.5.x we built against — compatibility unverified). **Untouched.**

**Recommended shape for a first public event:** one operator-run hosted
instance, pre-provisioned, attendees join by invite link. Self-serve clone is a
later milestone.

---

## 2026-09 Commons Charter — governance P0–P4

A second pass, on top of the readiness audit above: capability-based access
composable with the level ladder, a real bridge from constitution to content
grants, an honest powers list with delegated staffing, hardened lifecycle rails
(ratification pre-flight, protected bootstrap owner, mutable votes, auto-closing
windows, full CRUD with idempotent upserts), scoped non-admin sharing, and the
contributor wiki loop (propose-from-editor, review queue, voter notifications).
Branch `claude/governance-charter`. Architecture detail lives in CLAUDE.md's
"Bioregional Knowledge Commons" section; the operator/member guide is
`docs/governance.md`.

| Phase | Commit | What shipped | Tests |
|---|---|---|---|
| P0 | `db75c4a` | Full governance lifecycle (`update_role`/`remove_role`/`update_policy`/`remove_policy`/`remove_membership`), adds converted to upserts keyed by natural identity so re-provisioning converges. `validateRatification` pre-flights *Enable & lock* against the constitution's own amend policy (missing policy/role, or too few active eligible members, refuses the lock). `mergeConfig` protects `bootstrapOwner`/`amendPolicy` from a partial `set_config`. Proposing now requires standing (workspace member+, a governance role, or a grant in the vault). Votes are mutable while a proposal is open. Policy windows auto-close an expired open proposal on the next touch. Pre-lock PATCH/DELETE fixup routes reuse the same `mutateGovernance` choke point. | 564 |
| P1 | `53886c7` | The capability vocabulary: `CAPS` (`view/comment/suggest/edit/create/organize/delete/share`), `expandLevel`, `levelForCaps`, `effectiveCaps` in `permissions.ts`. Grants gain a nullable `caps` column (null = derive from level; every existing grant unaffected). The gateway's write checks split by specific capability (`create`, `edit`+`organize` on PATCH with anti-escalation, `delete`); collab and the ACL people endpoints gain caps awareness. | 601 |
| P2 | `fb4bed1` | **The bridge**: `governance-grants.ts` compiles enabled-constitution memberships × role capabilities into ordinary grant rows, reconciled after every mutation and every `GOVERNANCE_RECONCILE_MS` (default 5 min). POWERS trimmed to the honest enforced+declarative list (`review`/`arbitrate` cut, `certify_gardener` → `assign_roles`); delegated staffing lets an `assign_roles` holder staff the roles their role `assigns`, never one carrying `amend_governance`. Scoped share: a non-admin `share`-cap holder reaches exactly five people-grant ACL routes, subset-of-own-caps, existing accounts only. | 631 |
| P3 | `5e8d7f8` | The governance product surface: `BootstrapWizard` with three starting templates (Solo curator / Reviewed commons / Open commons), role cards with a grouped capability matrix, policies rendered as plain-language sentences (`packages/core/src/lib/governance/prose.ts`), proposal cards with approvals/quorum/window progress and a content diff, and `GET /api/governance/me` (first-person access summary). The `governance-config` note's body is regenerated as the human-readable constitution after every mutation. | 643 |
| P4 | `a3e8b71` | The wiki loop: the gateway annotates non-owner reads with `_caps`; `reviewMode` drives propose-from-editor for suggest-without-edit actors (`ReviewBanner`, submit → `edit_note` proposal, inline revision history); Canvas routes propose-only notes away from the live collab session; a review queue groups proposals by content vs. amendment; `notifyVoters` mails (or logs) the eligible voters when a proposal opens. | 659 |

End-to-end verification: `E2E_FAKE_VAULT=1 ./scripts/e2e-governance.sh` — **6/6**
across `governance.spec.ts` (bootstrap→lock→self-amend→governed content
change; a contributor proposes from the editor and a steward reviews it live —
invite with suggest caps → banner → submit → unchanged vault → steward sees
diff + 0-of-1 → approve → apply → content live; the stranger-gate),
`bioregion.spec.ts`, and `import.spec.ts`.
