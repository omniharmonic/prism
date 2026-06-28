# Roadmap Testing Guide

How to verify the three roadmap horizons — **Onboarding**, **Publishing**, **Parachute-to-Parachute federation** — that landed on `main` (`e541f77`). It has two layers:

- **Layer A — automated, no vault required.** Typechecks, builds, and the `node:test` suite. These run anywhere (CI, a fresh clone) and are the regression net.
- **Layer B — live, vault + browser required.** The `verify-*` scripts and a manual UX checklist. These exercise the real Parachute vault, the running server, and the PWA. Run them on a machine where your vault is up.

---

## Layer A — automated (run these first, anywhere)

From the repo root, after `npm install`:

```bash
# Typecheck every workspace
( cd packages/core && npx tsc --noEmit )
( cd apps/server  && npx tsc --noEmit )
( cd apps/web     && npx tsc --noEmit )

# Web production build (also runs tsc)
npm run build -w @prism/web

# Service-worker denylist guard (publishing's SPA-shadow gotcha)
npm run check:sw -w @prism/web

# Server unit/integration suite — REAL Hono routers against an in-memory
# fake vault + in-memory SQLite. No live vault needed.
( cd apps/server && npm test )

# Rust backend (desktop). On Linux needs the Tauri system libs:
#   apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev
( cd apps/desktop/src-tauri && cargo check )
```

**Expected (verified on this branch):** all typechecks clean · web build green · `check:sw` pass · **`npm test` → 149/149 pass** · `cargo check` clean (2 pre-existing warnings).

### What `npm test` now covers for the new surface

The roadmap merge originally shipped with **no `node:test` coverage** for its new modules (it relied on the live `verify-*` scripts). This guide adds two in-process suites so the new surface is covered in CI:

| Suite | Covers |
|---|---|
| `apps/server/test/publish.test.ts` | manifest lists only in-tag notes · single-note 200 vs out-of-publication 403 · **graph leak-prevention** (out-of-set wikilinks drop, no private node/edge) · password gate (locked manifest withholds nav, 401 content, unlock-cookie round-trip, forged-cookie rejection) · owner lifecycle (publish idempotent, anyone-grant created, password set, unpublish clears grant, non-owner 403) |
| `apps/server/test/federation.test.ts` | peer-conn token round-trip + tamper/expiry/junk rejection · `resolveLevel` federation branch (paired peer + space grant → level; unpaired / wrong-space / no-grant → null; **inert when `FEDERATION_ENABLED` is off**) · `federationTarget` routing + kind-pin · `effectiveLevel` space matching · durable outbox · Ed25519 key validation/fingerprint · pairing endpoint (valid / single-use / bad-key) · durable suggestions inbox (accept/reject, owner-only) |

> Note: `apps/server/test/helpers.ts` `resetDb()` was extended to also clear the
> Horizon B/C tables (`publications`, `peers`, `peer_pairings`, `spaces`,
> `federated_notes`, `federation_outbox`, `pending_suggestions`) so each test
> file starts from a clean database.

---

## Layer B — live (vault + browser required)

These cannot run in a credential-less container — they need a real Parachute vault, the server's `.env` secrets, and (for the UX checklist) a browser.

### B0. Bring up the stack

```bash
# 1. Parachute hub (:1939) + vault (:1940) running locally, with a vault token:
parachute auth mint-token --scope vault:default:write    # → PARACHUTE_TOKEN

# 2. Server env. Either hand-write apps/server/.env, or use the new setup tool:
cd apps/server
node --env-file-if-exists=.env --import tsx scripts/prism-setup.ts --dry-run   # preview
node --env-file-if-exists=.env --import tsx scripts/prism-setup.ts             # provision
#   Required secrets in .env: PARACHUTE_TOKEN, SESSION_SECRET, CAPABILITY_SECRET,
#   OWNER_EMAIL, APP_ORIGIN. Optional: PEER_SIGNING_KEY, FEDERATION_ENABLED.

# 3. Start the server (compiles via tsx; does NOT hot-reload — restart after edits)
npm run dev        # or: pm2 restart prism-server
```

> **Gotcha (from CLAUDE.md):** the server does not hot-reload. After ANY server
> change, restart it before testing — a stale `noteKind` can persist a note
> through the wrong path and corrupt it.

### B1. Gateway + publishing security (`verify-gateway.ts`)

```bash
cd apps/server && node --env-file=.env --import tsx scripts/verify-gateway.ts
```
Asserts: anon sees nothing (not the vault), a capability sees only its tag, a
forbidden note 403s, writes denied at `view`, **and the publishing assertions**
(anon scope, no token leak, in/out-of-publication 403, graph edge-filter,
password gate). It seeds a temporary capability against your live vault using
two hardcoded note IDs — if those notes no longer exist, update `GRANTED_NOTE`
/`FORBIDDEN_NOTE`/`TAG` at the top of the script to ids in your vault.

### B2. Collab share-links across kinds × levels (`verify-collab-share.ts`)

```bash
cd apps/server && node --env-file=.env --import tsx scripts/verify-collab-share.ts
```
Needs the live server up. Checks kind agreement (client `inferContentType` ==
server `noteKind`), per-level capability gating (read-only below `suggest`, anon
rejected), and Yjs seeding per kind on throwaway `_test/share/*` notes.

### B3. Federation invariants (`verify-federation.ts`)

```bash
cd apps/server && node --env-file=.env --import tsx scripts/verify-federation.ts
```
In-process (single hub) — forces `federationEnabled` on for the check, exercises
peer-conn tokens, `resolveLevel`'s federation branch, kind-pinning, the space
grant match, and the outbox on throwaway `_test` rows, then cleans up.
**Live two-hub convergence is deferred** (needs a 2nd hub+vault) — see
`docs/federation.md` and the honest gaps in `apps/server/src/federation-manager.ts`.

### B4. Browser UX checklist (manual)

Bust the PWA service worker first (DevTools → Application → Service Workers →
Unregister, or `getRegistrations().then(rs => rs.forEach(r => r.unregister()))`
+ `caches.keys().then(ks => ks.forEach(k => caches.delete(k)))`) so you're not
testing stale JS.

**Onboarding — viewer skip**
- [ ] Open a share/capability link (`…?t=…`) in a fresh browser → lands directly in the shared content, **no setup wizard**.
- [ ] Sign in as an invited **non-owner** → app opens to content, no wizard.
- [ ] Desktop first run (Tauri) → the setup wizard **still appears** (unchanged).

**Publishing — Wiki**
- [ ] In the app, open the Share dialog → **Publish** tab → pick a tag, template = Wiki, click Publish. Note the count warning ("publishes N notes").
- [ ] Visit `/(p)/<slug>` anonymously → Wiki renders: nav tree, a home page, document body.
- [ ] Click a `[[wikilink]]` to an in-publication note → navigates; a link to a non-published note renders inert (no navigation, no leak).
- [ ] Backlinks panel + in-publication search work; the graph shows only published nodes.
- [ ] Set a password (Publish tab) → revisit `/(p)/<slug>` → prompted; wrong password rejected; correct password unlocks; nav was hidden while locked.
- [ ] Unpublish → the public URL 404s and the `anyone` grant is gone.

**Federation (gated)**
- [ ] With `FEDERATION_ENABLED` unset/off, confirm normal collab and publishing are unchanged (federation paths inert).
- [ ] Owner identity/pairing endpoints respond (`GET /acl/peers/identity`, pairing code issue/consume). Full two-hub sync is deferred.

---

## Coverage summary

| Area | Layer A (automated, here) | Layer B (live, your machine) |
|---|---|---|
| Onboarding viewer-skip | core/web tsc + build | browser checklist B4 |
| Onboarding setup CLI/plugin | server tsc; `prism-setup --dry-run` logic | `prism-setup.ts` against a real vault |
| Publishing routes + security | **`publish.test.ts`** (manifest/403/graph/password/lifecycle) | `verify-gateway.ts` + B4 Wiki checklist |
| Federation primitives | **`federation.test.ts`** (tokens/resolveLevel/outbox/pairing/suggestions) | `verify-federation.ts`; two-hub deferred |
| Collab (regression) | `collab.test.ts` (33 tests) | `verify-collab-share.ts` |

**Deferred / out of scope** (documented, non-blocking): live two-hub federation
convergence; `L-P2P-Accel` (Parachute-core change-feed / scoped peer-MCP / push
revocation). See `docs/roadmap/PROGRESS.md` and `docs/federation.md`.
