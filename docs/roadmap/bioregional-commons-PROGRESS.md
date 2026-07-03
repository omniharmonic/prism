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
| S3 | `/bioregion` browse + CSP-safe inline-SVG map + filters | ✅ e2e |
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

## Remaining
- **G5** — canonical vault / fork / GitHub rollback backbone. The two-hub mock
  now makes this buildable+verifiable here; next in line.
- **S2** — dedicated per-type renderers inside the *main* Prism app (types render
  as documents there today). The `/bioregion` surface already covers browse +
  map + detail; wiring a renderer into the Canvas/Registry is the remaining bit.

Everything else in both plans is built, committed, and verified (e2e or live
harness).
