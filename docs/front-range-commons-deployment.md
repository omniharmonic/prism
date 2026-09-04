# Front Range Bioregional Knowledge Commons — applied deployment notes

Branch `commons/front-range-bioregion` isolates every Prism change bespoke to the
Front Range commons pilot. Main is never touched by this work.

## The deployment (2026-09-04)
- Vault: `front-range-bioregion` on the local Parachute hub (0.7.1), created via CLI,
  registered in the live prism-server vault registry (mode=link), readable through the
  gateway with `X-Prism-Vault: front-range-bioregion`.
- Commons home (research, ingest scripts, data, provenance): `~/dev/front-range-bioregion/`
  (its own git repo; see PLAN.md and docs/CONVENTIONS.md there).
- The live pm2 server keeps running main; the vault wiring is registry data, not code.

## Bespoke changes on this branch
1. **tag-schemas.json**: `sensitivity` enum (public|generalized|restricted|governed) on
   entity/ecological-entity/species/place/watershed/herbal-use/signal/event;
   `last_verified` on organization/resource; `confusable_with` on species.
   The sensitivity gate is applied at ingest for the pilot; gateway/map enforcement is
   future work.
2. **seed-tag-schemas.ts**: Parachute 0.7.x shim — `indexed: true` on a non-string
   field 500s at index build (AFTER the schema row is written, so the broken schema
   then re-trips on every echo-back PUT). Only string fields keep `indexed`.

## Parachute 0.7.1 API findings (verified against the live hub)
- `PATCH /notes/:id` requires `if_updated_at` (last-seen `updatedAt`) or `force: true` (428 otherwise).
- `add_tags` on PATCH is a no-op; tags must be set at create.
- Wikilinks create graph edges only as `[[<path>]]` / `[[<path>|label]]`; bare titles don't resolve.
- On create the vault default-fills ALL schema'd fields (enum → first value) — write enums explicitly.
- `parachute-vault create --mint` no longer emits the token in `--json` output the way
  `vault-provision.ts` expects → in-app vault CREATE fails ("returned no token"); LINK works.
  (Vault gets created anyway; the error is only about the token.) Not fixed here — flagged.

## Known deferred items for this pilot
- `/api/governance` binds the primary vault only — vault-aware governance is the first
  real feature for this branch (the pilot's governance bootstrap waits on it).
- Publishing (`/p/:slug`) is also primary-vault-bound (see workspace-model memory).
