# Testing Handoff — Implement & Run the Full Test Suite Locally

**Audience:** a local Claude Code agent with a live environment (Parachute hub on `:1939`, vault on `:1940`, the Tauri desktop app, and a real browser) — capabilities the authoring agent did **not** have.

**Goal:** stand up and run Prism's two-layer test suite end to end, then close the known gaps. The doc is split so you can do the **CONFIGURE** work (run/verify existing code) first as a regression baseline, then the **BUILD** work (write new code/tests/CI).

Prism has exactly two test layers:

| Layer | What it needs | What it proves | Where it lives |
|---|---|---|---|
| **A — Automated** | `npm ci` only. No vault, no browser. | Regression baseline: routers, authz pipeline, CRDT seeding logic, builds, Rust units. | `apps/server/test/*.test.ts` (149 tests), workspace typechecks, web build, `check:sw`, `cargo`. |
| **B — Live** | Running hub + vault + Prism Server; some steps a browser. | Real gateway gating, publishing security, collab seeding over the wire, invite/register/login, two-client CRDT. | `apps/server/scripts/verify-*.{ts,mjs}`. |

> Reading-order rule: Layer A is your **regression baseline** — get it green before touching Layer B. Layer B exercises infrastructure Layer A stubs out.

---

## 0. Prerequisites (CONFIGURE)

| Requirement | Check | Fix if missing |
|---|---|---|
| Node 22+ | `node -v` | install Node 22 |
| Deps installed | `npm ls -w @prism/server >/dev/null` | `npm ci` (from repo root) |
| Parachute hub up (`:1939`) | `curl -s localhost:1939/health` | start the hub (`@openparachute/hub`) |
| Parachute vault up (`:1940`) | `curl -s localhost:1940/health` | start Parachute |
| Vault write token | `parachute auth mint-token --scope vault:default:write` | mint one; it is a JWT (`pvt_*` opaque tokens are rejected with 401) |
| Rust toolchain (for Layer A Rust + desktop) | `cargo --version` | install stable Rust + Tauri Linux deps (see `.github/workflows/ci.yml` lines 36–40) |

### 0.1 Create `apps/server/.env` (CONFIGURE)

The live server and **all** Layer B `verify-*` scripts load `--env-file=.env`. Generate it:

```bash
cd apps/server
# preview first — generates secrets, does NOT write:
node --env-file-if-exists=.env --import tsx scripts/prism-setup.ts --dry-run
# then write it (chmod 600). Use --force only to regenerate secrets.
node --env-file-if-exists=.env --import tsx scripts/prism-setup.ts
```

Required keys in `.env` (fill `PARACHUTE_TOKEN` with the minted write JWT):

```
PARACHUTE_TOKEN=<vault:default:write JWT>
SESSION_SECRET=<generated>
CAPABILITY_SECRET=<generated>
OWNER_EMAIL=<your owner inbox, e.g. synergy@benjaminlife.one>
APP_ORIGIN=http://localhost:8787
PARACHUTE_URL=http://localhost:1940
PARACHUTE_VAULT=default
```

> `prism-setup.ts` also idempotently seeds 35 tag schemas via `seedTagSchemas()` (additive-only). Run `--dry-run` twice on a seeded vault and expect `0 created, 0 updated, 35 unchanged` — that proves idempotency.
>
> **Claimed-but-missing:** PROGRESS.md `L-Onb-Seed` and `.claude-plugin/README.md` line 9 claim a `prism-setup` **Claude skill** exists. It does **not** — only the TypeScript script `apps/server/scripts/prism-setup.ts` exists. Do not look for `.claude/skills/prism-setup/SKILL.md`; it isn't there. (Out of scope to fix here; noted so you don't burn time.)

### 0.2 `.env.test` (CONFIGURE — already present, do not edit)

Layer A uses `apps/server/.env.test` (committed, deterministic, **not** secrets): `DB_PATH=:memory:`, `PARACHUTE_URL=http://vault.test` (fake), fixed HMAC secrets. Each test **file** runs in its own process (node:test default), so each gets a fresh in-memory DB. No live vault is touched.

---

## 1. Layer A — Automated regression baseline (CONFIGURE)

Run every command from the **repo root** unless noted. Get all of these green before Layer B.

| # | Command | Proves | Acceptance |
|---|---|---|---|
| A1 | `npm run typecheck` | core + desktop + web + server typecheck (see root `package.json` `typecheck`) | exit 0 |
| A2 | `npm test -w @prism/server` | 149 node:test tests over real Hono routers + authz, in-memory DB + `FakeVault` (stubbed `global.fetch`) | exit 0; ~3–4s; 149 pass / 0 fail |
| A3 | `npm run build -w @prism/web` | web PWA `tsc && vite build` | exit 0; `apps/web/dist` produced |
| A4 | `npm run check:sw -w @prism/web` | every server route prefix is in the SW `navigateFallbackDenylist` | exit 0; "no violations" |
| A5 | `cargo check --locked` in `apps/desktop/src-tauri` | Rust backend compiles | exit 0 (pre-existing warnings OK) |
| A6 | `cargo test --lib` in `apps/desktop/src-tauri` | Rust logic units | exit 0 |

The 149 server tests break down (for triage when one file fails):

| File | ~Tests | Covers |
|---|---|---|
| `test/collab.test.ts` | 33 | connection ACL, CRDT seed/round-trip, `loadDocumentState`/`storeDocumentState`, kind detection |
| `test/gateway.test.ts` | 16 | owner passthrough vs non-owner allowlist, per-route `effectiveLevel` filtering |
| `test/federation.test.ts` | 14 | peer-conn tokens, `resolveLevel` federation branch, durable outbox, Ed25519 pairing |
| `test/acl.test.ts` | 12 | grant CRUD, share-by-email, publish/unpublish endpoints |
| `test/perms.test.ts` | 10 | `effectiveLevel` ordering (view<comment<suggest<edit<own), tag vs id matching |
| `test/publish.test.ts` | 8 | manifest, single-note, graph leak-proofing, password gate, owner lifecycle |
| `test/capability.test.ts` | 6 | HMAC sign/verify, tamper + expiry rejection |
| auth / db / rag | ~14 | sessions, invite, password (scrypt), db migrations, rag |
| ratelimit / app | ~10 | login/register rate limits, app wiring |

`test/helpers.ts` provides `FakeVault`, `resetDb()`, and session/grant/capability factories — reuse these when you add tests.

---

## 2. Start the live server (CONFIGURE — required for all of Layer B)

```bash
cd apps/server && npm run dev   # node --env-file=.env --watch --import tsx src/index.ts
```

Listens on `http://localhost:8787` (matches `BASE` in the verify scripts and `APP_ORIGIN`).

> **Gotcha:** the server compiles via tsx on start. `npm run dev` uses `--watch` so it restarts on file change, but pm2/`npm start` deployments do **not** hot-reload — restart after any server-side change or a stale `noteKind` can corrupt a note through the wrong persistence path.

---

## 3. Layer B — Live verification scripts (CONFIGURE)

Each runs with the **same env as the server**. General form:

```bash
cd apps/server && node --env-file=.env --import tsx scripts/<name>.ts
```

> There are currently **no npm aliases** for these (root `package.json` has only `dev`/`build`/`typecheck`/`test`; `apps/server` has only `dev`/`start`/`typecheck`/`test`/`setup`/`setup:full`). Use the full `node --env-file` invocation, or add aliases as part of the BUILD work in §4.2.

### 3.1 `verify-gateway.ts`

| | |
|---|---|
| **Prereqs** | live server (§2) + vault. **Hardcoded note IDs** (see below). |
| **Command** | `node --env-file=.env --import tsx scripts/verify-gateway.ts` |
| **Proves** | anon `/api/notes` → empty (not the vault); a view-only tag capability sees only its tag's notes; a forbidden (untagged) note 403s; a write at `view` is denied; publishing graph is leak-proof; password gate unlock-cookie round-trips; unpublish clears the `anyone` grant. |
| **Acceptance** | every check prints PASS; process exits 0. |

> **BLOCKER — hardcoded fixtures.** `scripts/verify-gateway.ts` lines 13–15 hardcode:
> ```ts
> const TAG = "19c-philosophy";
> const GRANTED_NOTE = "2026-04-23-21-21-05-047018"; // carries TAG
> const FORBIDDEN_NOTE = "2026-04-10-21-08-52-167001"; // carries no tags
> ```
> If those notes/tag don't exist in **your** vault, the script fails. Before running, confirm they resolve:
> ```bash
> # via MCP query-notes, or REST:
> curl -s -H "Authorization: Bearer $PARACHUTE_TOKEN" \
>   localhost:1940/vault/default/api/notes/2026-04-23-21-21-05-047018
> ```
> If they don't resolve, either (a) substitute three real IDs/tag from your vault, or (b) do the **BUILD** generalization in §4.1 (preferred — it makes the script self-provisioning so this never breaks again).

### 3.2 `verify-collab-share.ts`

| | |
|---|---|
| **Prereqs** | live server + vault. Self-provisions `_test/share/*` notes and cleans them up. |
| **Command** | `node --env-file=.env --import tsx scripts/verify-collab-share.ts` |
| **Proves** | (1) **kind agreement** — client `detectKind` == server `noteKind` for all 6 note kinds; (2) **permission gating** — read-only enforced below `suggest`; (3) **Yjs seeding** — the correct field (`XmlFragment`/`Y.Text`/`Y.Array`/`Y.Map`) populates per kind; (4 — optional) **Playwright render layer**. |
| **Acceptance** | layers 1–3 PASS. Layer 4 **SKIPS** unless Playwright is installed (it is **not** in `devDependencies`). A skip is not a failure. |

### 3.3 `verify-federation.ts`

| | |
|---|---|
| **Prereqs** | live server + vault. Creates `_test` rows, cleans up. In-process (no 2nd hub). |
| **Command** | `node --env-file=.env --import tsx scripts/verify-federation.ts` |
| **Proves** | peer-conn token round-trip + tamper/expiry rejection; `resolveLevel` federation branch (paired+grant → level, unpaired → null); `federationTarget` space mapping; `effectiveLevel` space matching; durable outbox; pairing endpoint. |
| **Acceptance** | all checks PASS, exit 0. |

> **Note:** `FEDERATION_ENABLED` is default-off in production; the script forces the primitives directly so it does not require the flag. Two-hub convergence is **deferred** (needs a 2nd live hub+vault) — out of scope here.

### 3.4 `verify-invite-flow.ts`

| | |
|---|---|
| **Prereqs** | live server + vault. **Reuses `SHARED_NOTE`/`FORBIDDEN_NOTE` from the same vault fixtures as `verify-gateway.ts`** — same hardcoded-ID caveat (§3.1). |
| **Command** | `node --env-file=.env --import tsx scripts/verify-invite-flow.ts` |
| **Proves** | auto-invite on share-by-email; registration from invite token; single-use token (replay rejected); gateway scoping (shared note visible, forbidden note 403); login + collab authorize. |
| **Acceptance** | all checks PASS, exit 0. |

### 3.5 `verify-collab.mjs` (optional, fragile)

| | |
|---|---|
| **Prereqs** | live server + vault. **Manual token provisioning** — no setup script exists. |
| **Setup** | Provision a `_test` note containing `seed line from parachute`. Mint two capabilities (edit, view) and write tokens to `/tmp/p3-note.txt`, `/tmp/p3-edit.txt`, `/tmp/p3-view.txt` (use `createCapability` + `signCapability` against the running DB + `CAPABILITY_SECRET`). |
| **Command** | `node --env-file=.env apps/server/scripts/verify-collab.mjs` |
| **Proves** | two clients sync via CRDT; edits persist back to the vault; view-level is read-only (no view-level edit leaks). |
| **Acceptance** | all checks PASS. |

> This script's `/tmp` file handshake is brittle (see openQuestions). Consider rewriting it in TS and folding into the suite (§4 stretch).

---

## 4. BUILD tasks (write new code/tests/CI)

These close the gaps the live agent is uniquely positioned to fix.

### 4.1 Generalize `verify-gateway.ts` to self-provision throwaway notes  ✅ DONE (branch `claude/roadmap-test-coverage`)

**Was:** hardcoded `TAG`/`GRANTED_NOTE`/`FORBIDDEN_NOTE` (lines 13–15) broke when the owner's vault changed.

**Now done:** the gateway section provisions throwaway `_secgate` fixtures via `vault.createNote` + `vault.addTags` at the top of the async body, derives `GRANTED_NOTE`/`FORBIDDEN_NOTE` at runtime, asserts against `GATE_NOTE_COUNT` (not a magic `5`), and tears everything down (notes + the cap grant via `removeGrant`) in an outer `finally`, mirroring the publishing section. Typechecks clean; no hardcoded IDs remain.

**Acceptance (run it):** on **any** vault, `node --env-file=.env --import tsx scripts/verify-gateway.ts` → `ALL GATEWAY CHECKS PASSED`, and afterward no `_secgate`/`_sec*` notes remain (the script's own teardown checks assert this).

**Still TODO (smaller):** `verify-invite-flow.ts` may carry its own fixture assumptions — run it and, if it depends on specific vault state, give it the same self-provisioning treatment (optionally factor a shared `scripts/lib/` fixture helper).

### 4.2 npm aliases for the verify layer (RECOMMENDED, low-risk)

Add to `apps/server/package.json` `scripts`:

```json
"verify:gateway":   "node --env-file=.env --import tsx scripts/verify-gateway.ts",
"verify:collab":    "node --env-file=.env --import tsx scripts/verify-collab-share.ts",
"verify:federation":"node --env-file=.env --import tsx scripts/verify-federation.ts",
"verify:invite":    "node --env-file=.env --import tsx scripts/verify-invite-flow.ts",
"verify:live":      "npm run verify:gateway && npm run verify:collab && npm run verify:federation && npm run verify:invite"
```

**Acceptance:** `npm run verify:live -w @prism/server` runs all four against the live server and exits 0.

### 4.3 Playwright e2e layer — publishing + onboarding viewer-skip (REQUIRED)

Playwright is **not** in deps today. Add it and write a headless e2e covering the browser-only paths that no current automated test reaches.

**Setup:**
```bash
npm i -D -w @prism/web @playwright/test
npx playwright install --with-deps chromium
```
Create `apps/web/e2e/` with `playwright.config.ts` (baseURL `http://localhost:8787`, the live server) and add `"test:e2e": "playwright test"` to `apps/web` scripts.

**Tests to write:**

| Spec | Flow | Pass/fail |
|---|---|---|
| `publish.spec.ts` | Owner publishes a tag (Share dialog → Publish tab → `POST /acl/tags/:tag/publish`). Visit `/p/:slug`. | Public wiki renders the in-set notes. |
| `publish-wikilinks-graph.spec.ts` | On `/p/:slug`, click a `[[wikilink]]` to an in-set note; open the graph. | In-set wikilink navigates; **out-of-set edges are dropped** (no leak). An out-of-set wikilink is inert. |
| `publish-password.spec.ts` | Publish with a password; visit `/p/:slug` → locked manifest (nav withheld); `POST /api/p/:slug/auth` with the password sets the `pub_<slug>` cookie; reload → unlocked. Then `DELETE` (unpublish). | Locked state hides nav; correct password unlocks; **after unpublish `/p/:slug` and `/api/p/:slug` 404** and the `anyone/tag/view` grant is gone. |
| `onboarding-viewer-skip.spec.ts` | Open the web app via a capability/share link (non-owner, `isViewer=true`). | The Tauri onboarding wizard does **not** appear (`main.tsx` `skipOnboarding={isViewer}`). A genuine owner with `VITE_WEB_OWNER_ONBOARDING=true` **does** see it. |

> **Cache gotcha:** between runs, bust the PWA service worker or you test stale JS:
> `navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()))` + `caches.keys().then(ks => ks.forEach(k => caches.delete(k)))`. In Playwright, launch a fresh context per test or disable the SW.
> **Password sites require https:** the `pub_<slug>` unlock cookie is `secure` only when `APP_ORIGIN` is https, so the password spec must run against an https origin (or assert the cookie-not-set behavior on http and gate the unlock assertion behind https).

**Acceptance:** `npm run test:e2e -w @prism/web` passes all four specs against the live server; the unpublish step leaves no `publications` row and no `anyone` grant.

### 4.4 CI wiring for the no-vault automated layer (REQUIRED)

The existing `.github/workflows/ci.yml` already runs the **node** job (typecheck → server test → web build) and the **rust** job (cargo check → cargo test --lib). Two gaps:

1. **`check:sw` is not run in CI.** Add a step to the `node` job after the web build:
   ```yaml
   - name: Service-worker denylist guard
     run: npm run check:sw -w @prism/web
   ```
2. **Playwright e2e (§4.3) needs CI coverage but must not require a live vault.** Add a separate job that boots the server against a **stubbed/in-memory** path (reuse `.env.test`-style config, or a fixture vault), installs the chromium browser, and runs `test:e2e`. Mark it non-blocking initially if the live-vault dependency can't be fully stubbed; otherwise gate the publish specs that need vault writes behind a `live` tag and run only the SW/onboarding-skip specs in CI.

**Do not** add a CI job that needs the real hub+vault — Layer B (`verify-*`) stays manual/local for now (call this out in the PR description).

**Acceptance:** CI green on a branch push; the `node` job log shows the `check:sw` step passing; the e2e job runs the no-vault specs (or is explicitly documented as non-blocking).

### 4.5 Stretch — TS-ify `verify-collab.mjs`

Rewrite `verify-collab.mjs` in TypeScript, replacing the `/tmp/p3-*.txt` token handshake with in-process capability minting (`createCapability` + `signCapability`). Acceptance: single command, no `/tmp` files, same three assertions pass.

---

## 5. Final acceptance checklist

The agent is done when **all** of the following hold:

**Layer A (automated baseline):**
- [ ] `npm run typecheck` exits 0 (all 4 workspaces).
- [ ] `npm test -w @prism/server` → 149 pass / 0 fail, exit 0.
- [ ] `npm run build -w @prism/web` succeeds (`apps/web/dist` produced).
- [ ] `npm run check:sw -w @prism/web` reports no violations.
- [ ] `cargo check --locked` and `cargo test --lib` in `apps/desktop/src-tauri` exit 0 (pre-existing warnings OK).

**Layer B (live):**
- [ ] `verify-gateway.ts` ALL PASS: anon blocking, capability tag-scoping, view-level write denial, publish graph leak-proofing, password unlock-cookie round-trip, unpublish clears grant.
- [ ] `verify-collab-share.ts` PASSES layers 1–3 (kind agreement for all 6 kinds, read-only below `suggest`, correct Yjs field seeded); layer 4 SKIPS or passes.
- [ ] `verify-federation.ts` ALL PASS: token round-trip + tamper/expiry rejection, `resolveLevel` branch, space mapping, durable outbox, pairing endpoint.
- [ ] `verify-invite-flow.ts` ALL PASS: auto-invite, register-from-token, single-use replay rejected, gateway scoping, login+collab authorize.
- [ ] (optional) `verify-collab.mjs` ALL PASS.

**BUILD work:**
- [ ] §4.1: `verify-gateway.ts` (and `verify-invite-flow.ts`) self-provision throwaway notes — pass on a fresh vault with none of the old hardcoded IDs, and clean up after themselves.
- [ ] §4.3: Playwright e2e specs (publish, wikilinks/graph leak-proof, password+unpublish, onboarding viewer-skip) pass against the live server.
- [ ] §4.4: CI runs `check:sw`; the no-vault e2e job is wired (or documented non-blocking); no CI job depends on the real hub+vault.
- [ ] (recommended) §4.2 npm `verify:*` aliases added; (stretch) §4.5 done.

**Known claimed-but-missing / stubbed (acknowledge, don't chase):**
- [ ] `prism-setup` **Claude skill** does not exist (only the TS script). README/PROGRESS claim is wrong — out of scope here.
- [ ] Two-hub federation convergence is deferred (no 2nd live hub).
- [ ] Layer B is not CI'd (by design until a stubbable test-vault exists).
