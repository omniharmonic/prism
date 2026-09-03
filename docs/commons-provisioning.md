# Provisioning a Bioregional Knowledge Commons

One command stands up a real commons vault end to end — schema, governance
constitution, data sources, and ingest — all verified. It runs against a Prism
Server (the gateway); the schema step talks to the vault directly.

```bash
node scripts/commons-init.mjs --config <config.json> [--enable] [--dry-run]
```

## What it does (each step is verified)

1. **Schema** — seeds the full canonical tag schema (all 54 tags incl. the
   bioregional ontology and the `parent_names` is-a tree) into the vault.
   Idempotent + additive (a second run reports zero changes).
2. **Governance** — creates the roles, policies, and memberships from the config,
   wires the constitution's amend policy, and writes the constitution. Governance
   is left **unlocked** unless you pass `--enable` (or set `governance.enable:true`)
   — locking is a one-way latch, so it's opt-in.
3. **Ingest** — runs each configured data source through the importers
   (GBIF/Darwin Core, GeoJSON, USGS WBD) and writes the typed notes with a
   provenance tag.
4. **Verify** — asserts the schema is present, governance reads back, and the
   ingested notes exist.

## Where it points

`HUB_ENV` (default `apps/server/.env`) supplies the coordinates:
- `PARACHUTE_URL` / `PARACHUTE_VAULT` / `PARACHUTE_TOKEN` — the vault (schema seed
  talks to it directly).
- `COLLAB_TOKEN` (or `PARACHUTE_TOKEN`) — the gateway owner Bearer (governance +
  ingest go through the Prism Server, honored over localhost).
- `HUB_URL` overrides the gateway origin.

## The config file

See `docs/commons.config.example.json` — a Front Range commons with an `admin`
tier (holds `amend_governance`), global `gardener` sign-off, a stricter
`#medicine` policy (3 gardeners), an auto-publishing `#watershed` policy, an
owner admin member, and three fixture data sources. Fields:

```jsonc
{
  "name": "…",
  "governance": {
    "roles":    [{ "name", "powers": [...], "scopeType": "global|tag", "scope" }],
    "policies": [{ "action", "scopeType", "scope", "thresholdN", "quorum",
                   "distinctRequired", "eligibleRole", "windowSeconds", "autoPublish" }],
    "members":  [{ "subject", "role" }],
    "config":   { "defaultThresholdN", "defaultEligibleRole", "amendPolicyAction" },
    "enable":   false
  },
  "dataSources": [
    { "source": "geojson-entities", "file|url": "…", "kind", "sensing", "extraTag" },
    { "source": "wbd-watersheds",   "file|url": "…", "extraTag" },
    { "source": "gbif-species",     "file|url": "…", "extraTag" }
  ]
}
```

Live GBIF/USGS/Murmurations endpoints work via `"url"` where network egress is
available; `"file"` makes provisioning deterministic and offline.

## Try it against the mock stack (no real vault)

```bash
./scripts/two-hub-mock.sh --keep
HUB_ENV=apps/server/.env.mock-a HUB_URL=http://localhost:8787 \
  node scripts/commons-init.mjs --config docs/commons.config.example.json
```

Verified this way: 54 tags seeded (idempotent), 3 roles + 5 policies + 1 member,
5 notes ingested, all checks green.

## Going to production
1. Copy `docs/commons.config.example.json`, set the real roles/policies/members
   (real emails) and the data sources you want.
2. Point `HUB_ENV` at your live server's `.env`.
3. Dry-run first: `--dry-run`.
4. Provision: `node scripts/commons-init.mjs --config your.json`.
5. When the roster + thresholds are right, ratify with `--enable` — after which
   every change (including disabling) requires an approved `amend_governance`
   proposal.
