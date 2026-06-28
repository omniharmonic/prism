---
name: Prism Setup — Schema
description: "Idempotently seed the canonical Prism tag schemas into the Parachute vault from packages/core/src/lib/schemas/tag-schemas.json. Additive-only: never overwrites existing field definitions or non-empty descriptions. Verifies idempotency (a second run reports zero created/updated)."
version: 0.1.0
---

# Prism Setup — Seed tag schemas

Seed the canonical tag schemas so Prism's renderers and dashboards work. The
source of truth is `packages/core/src/lib/schemas/tag-schemas.json`; seeding is
**idempotent and additive-only** (adds missing tags/fields, fills an empty
description — never overwrites an existing field def or non-empty description;
see the safety contract in `apps/server/scripts/lib/seed-tag-schemas.ts`).

## When to use

Step 3 of `prism-setup`. Note: if `prism-setup-server` ran the full
`prism-setup.ts`, schemas are **already seeded** — in that case just **verify**.

## Steps

- **Standalone (re)seed** — does NOT rewrite `.env`:
  ```bash
  cd apps/server
  npm run seed -- --dry-run     # preview the plan, no writes
  npm run seed                  # apply (reads PARACHUTE_* from .env)
  ```
  (`npm run seed` → `scripts/seed.ts`, which calls `seedTagSchemas()` with
  `PARACHUTE_URL` / `PARACHUTE_VAULT` / `PARACHUTE_TOKEN` from the environment.)

## Config artifact

Vault tag schemas (server-side data, not a file). Source:
`packages/core/src/lib/schemas/tag-schemas.json`.

## Verify (pass / fail)

- **Idempotency (the key proof):** run `npm run seed` **twice**. The second run
  must report `created:0 updated:0 unchanged:<N>` where `<N>` is the entry count
  of `tag-schemas.json`. **Count it at runtime — do not hard-code 29 or 35:**
  ```bash
  node -e "const t=require('./packages/core/src/lib/schemas/tag-schemas.json').tags;console.log(Object.keys(t).length,'canonical tags')"
  ```
- Cross-check the vault has them: `mcp__parachute-vault__list-tags` (or
  `GET .../api/tags?include_schema=true`) returns the canonical set.
- **FAIL:** `created > 0` on the **second** run ⇒ seeding is non-idempotent
  (a bug) — stop and investigate `seed-tag-schemas.ts`.

## Note

Seeding never deletes or overwrites: the guards are `if (!(fname in curFields))`
and `if (!curDescription && !!desiredDescription)`. A user's customized schema
is safe.
