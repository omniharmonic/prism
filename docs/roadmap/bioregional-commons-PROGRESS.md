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
- *Enable & lock* offers `(config default)` as the first amend policy, which
  synthesizes eligible role `admin`. If the group named their role otherwise,
  nobody can ever vote → governance can never be amended or disabled. Nothing
  validates that an eligible role + member exist before locking.
- The `disable` amendment template wipes `bootstrapOwner`; after a disable,
  nobody can ever re-bootstrap. Recovery is a curl from loopback only.
- `APP_ORIGIN` defaults to `localhost:8787` — misconfigured, every invite link
  is dead.

**Provisioning / ingest correctness:**
- `commons-init` and both importers have **no idempotency** — a re-run
  duplicates every role, policy, member, and note. The documented production
  flow (dry-run → provision → re-run with `--enable`) triggers exactly this.
- `commons-init` verify step 4 is vacuous: it queries `?tag=` on the owner
  passthrough, which ignores `tag`, so it passes if *any* note exists.
- Importer opts (`--kind/--sensing/--name-prop`) are silently ignored for
  `gbif-species` and `wbd-watersheds`. Unknown `--source` crashes `commons-init`.
- GBIF species import writes no geometry → those notes never appear on the Map.
- Murmurations is documented as a working source but has no importer.

**The missing product surface:**
- **No bioregion parameter anywhere** — no bbox / HUC / place picker. "Configure
  your bioregion" means hand-downloading GeoJSON and pointing `--file` at it.
- No ingest UI at any layer; CLI + JSON only. 3 of 11 documented sources exist.
- Tag-level grants (the "this working group edits #water" primitive) are
  curl-only — `PUT /acl/tags/:tag/people` has no client. No group/team object.
- Governance roles grant **zero** editing rights — two disconnected permission
  systems with overlapping vocabulary and no bridge or explanation.
- Nothing can be removed or revoked (member/role/policy) in UI *or* API.
- Post-lock governance is a raw-JSON textarea; content proposals need a
  hand-typed note id; approval progress ("1 of 2") is never rendered.
- Parachute is a separate install; `@openparachute/hub` is on npm (0.7.x vs the
  0.5.x we built against — compatibility unverified).

**Recommended shape for a first public event:** one operator-run hosted
instance, pre-provisioned, attendees join by invite link. Self-serve clone is a
later milestone.
