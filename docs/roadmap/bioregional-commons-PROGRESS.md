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
| S3 | `/bioregion` browse + CSP-safe inline-SVG map + filters | ✅ e2e |
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

## Deferred (not blocking the walkthrough)
- **G2b** — auto-intercept live *suggest*-level collab (Yjs) edits into
  proposals. The HTTP propose→sign-off→publish pipeline already covers the flow;
  this wires the live editor into it. Touches the collab path — sequenced later.
- **G5** — canonical vault / fork / GitHub rollback backbone. Federation-heavy;
  needs a second live hub to exercise.
- **S2** — dedicated per-type renderers (types currently render as documents).
- **S4** — external importers (GBIF / USGS / Murmurations). Need live network +
  vault; the schema + geo utils they target are done.
- **parent_names** hierarchy — pending a seed enhancement (the seed pushes only
  description+fields today); `entity_kind` is the working is-a axis meanwhile.
