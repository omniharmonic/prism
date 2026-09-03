# Prism Platform Roadmap — Multi-Tenant, Federated, Self-Hostable Knowledge Platform

> Status: implementation plan (v1). Authored 2026-06-30.
> Supersedes the *scope* of `network-vision.md` (which specced the single-owner
> Network UX) by committing to the **full multi-tenant team workspace** — the
> "Notion/Google-Docs killer" — built on **Parachute hub identity** as the trust
> substrate. `network-vision.md` remains the canonical UX spec for the Network
> surface; this doc is the architecture + phased build to make it multi-tenant.

---

## 0. The thesis (what we are building and why it's now tractable)

Prism today is a beautiful **single-owner** interface over one Parachute vault,
fronted by a home-grown Node gateway (`apps/server`) that holds **one god-token**
and recognizes **one owner** (`OWNER_EMAIL`, compared by `===` in 8 places).
Sharing exists (per-note grants, capability links, publishing, peer federation),
but everything assumes exactly one privileged human and one vault.

The ambition: **a self-hostable platform where a node hosts multiple tenants
(teams/people) with real isolation, rich per-note/per-tag/per-folder
collaboration, private personal notes inside shared workspaces, AI-native
ingestion that runs server-side (no Mac required), and peer-to-peer federation
between independent nodes.** Both topologies are first-class:

- **"Each friend runs their own node"** → nodes federate slices to each other.
- **"One operator hosts a team"** → many tenants on one node, isolated, with
  member roles and granular permissions.

### Why this is feasible without rebuilding an identity provider

The single most important finding from the architecture review: **Parachute's hub
(`@openparachute/hub` 0.7.1, `:1939`) has quietly become a real multi-user
OAuth 2.1 + JWT identity provider** with everything a tenancy substrate needs,
and Prism's `apps/server` currently *shadows* it with a weaker parallel stack.

| Capability | Parachute hub provides (canonical) | Prism re-implemented (weaker) |
|---|---|---|
| Identity / accounts | argon2id accounts, TOTP 2FA, single-use invites, httpOnly sessions, first-admin model (`hub/src/{sessions,invites,two-factor-store}.ts`) | scrypt accounts + magic-link + invites (`apps/server/src/auth/*`) |
| Authorization tokens | `vault:<name>:<verb>` JWTs, attenuated mint/revoke, JWKS + 60s revocation (`hub/src/{jwt-sign,scope-attenuation}.ts`, `@openparachute/scope-guard`) | **one static god-token** in `.env` (`config.parachuteToken`) |
| Multi-vault | native: one SQLite per vault, all behind `/vault/<name>/api`, per-vault user assignment (`user_vaults`, role∈{read,write}) | a Phase-1 `X-Prism-Vault` header, owner-only, passthrough-only |
| Process / ports / exposure | module supervisor, port authority (1939–1949), Cloudflare/Tailscale tunnels (`hub/src/{supervisor,port-assign,expose-state}.ts`) | pm2 + manual `cloudflared` |
| Third-party extension | generic **module contract** — ship `.parachute/module.json`, self-register, get a reverse-proxy mount + `<name>:admin` token "with zero hub code changes" | (none — `apps/server` is a standalone process) |

**What the hub deliberately does NOT provide — and stays Prism's differentiator:**
no content-type/renderer system, **no CRDT/collab**, **no per-note/per-tag ACL
with comment/suggest tiers**, **no capability links**, **no federation**. (The
"surfaces & renderers" concept some expected is a *separate downstream product
kit*, not a view abstraction — confirmed false lead.) Prism's renderer registry,
type-aware Yjs collab, rich ACL, and Ed25519 federation have **no upstream
equivalent**. We keep all of it and layer it **on top of hub identity** instead
of on top of a god-token.

So the strategy is a clean split:

- **ADOPT** the hub's identity + token kernel → tenancy = vault, members = hub
  accounts, vault access = hub-minted scoped JWTs validated by scope-guard. This
  *deletes* our weakest re-implementations and gives us multi-tenant primitives
  for free.
- **KEEP & EXTEND** the document-collaboration plane (renderers, collab, ACL,
  capability links, publishing, federation) — now vault-scoped and role-aware.

### The dependency chain (why the phases are ordered this way)

```
Phase 0  Trust-root convergence  ─┐  (replace god-token + single-owner with
         (hub JWT kernel, roles)  │   hub-minted scoped tokens + a role model)
                                   ▼
Phase 1  Vault-scoped tenancy   ──┐  (the deferred vault_id migration becomes
         (vault_id everywhere)    │   the spine: every grant/doc/space is scoped)
                                   ▼
Phase 2  Roles + team workspace ──┐  (members, admin panel, folder sharing,
         (the headline feature)    │   private notes, scoped note creation)
                                   ▼
Phase 3  Server-first runtime   ──┐  (per-tenant secrets + Node worker: ingest
         (+ per-tenant secrets)    │   & agent run server-side, no Mac needed)
                                   ▼
Phase 4  Federation depth       ──┐  (node-to-node: Parachute Sync, granular
         (Parachute Sync)          │   controls, two-hub CI — now vault-scoped)
                                   ▼
Phase 5  Self-host as hub module ─┐  (hub owns ports/supervision/exposure;
         (deploy convergence)      │   one-command node bring-up; VPS-safe)
                                   ▼
Phase 6  Cross-platform desktop  ─   (desktop = one client among many)
```

Each phase is independently shippable and testable against a live stack. Phases
0–3 are specced deep with code below; 4–6 are solid but lighter (they inherit the
hard primitives from 0–3).

### Security invariant (must hold at every phase)

> **No request ever reads or writes a note, grant, doc, or secret outside the
> vault/tenant it is scoped to; no client ever receives a vault token; the
> permission math (`effectiveLevel`) remains the single authoritative guard.**

Every phase below ends with how it preserves this, and the `verify-*.ts`
harnesses are extended in lockstep (never after).

---

## Phase 0 — Trust-root convergence (the foundation)

**Goal.** Stop being our own trust root. Replace the single static god-token and
the single-`OWNER_EMAIL` boolean with (a) **hub-minted, per-vault, scope-guarded
JWTs** for vault access and (b) a **role abstraction** that can name more than one
privileged human per vault. Nothing user-visible changes; everything downstream
gets simpler.

**Why first.** Multi-tenancy is impossible while "owner" is a boolean and the
vault credential is one god-token. This phase introduces the two abstractions
(scoped tokens, roles) that Phases 1–2 build on, *without* yet changing the data
model — a safe, mostly-internal refactor with a green security suite at the end.

### 0.1 — Validate inbound vault access with `@openparachute/scope-guard@^0.5.0`

> **Version target:** hub **0.7.3**, vault **0.6.3**, scope-guard **0.5.0** (the
> current published stable as of 2026-06-30; vault 0.6.3 already requires
> scope-guard `^0.5.0`). The local dev boxes were on hub 0.7.1 / vault 0.6.1 —
> bump them. The API below is the **real 0.5.0 surface**, verified against the
> published tarball (an earlier draft of this doc guessed `createScopeGuard({jwksUri})`
> / `verify` / `parseScope` — those do **not** exist; use what's below).

Today the server never validates a Parachute JWT — it just forwards
`config.parachuteToken` (`routes/api.ts:40`). When we move to per-vault minted
tokens (0.2) and per-tenant access (Phase 1), the server must *validate* the
token it holds and understand its scope.

**Tasks**
- Add `@openparachute/scope-guard@^0.5.0` to `apps/server/package.json`.
- New `apps/server/src/auth/vault-token.ts` — **mirror the canonical reference
  impl `@openparachute/vault/src/hub-jwt.ts` almost verbatim** (it wires the
  iss/jwks split + the new multi-origin `allowedIssuers`). Construct ONE guard per
  process; reuse it (it holds the JWKS + revocation caches). JWKS is auto-fetched
  and the revocation list is polled (60s, fail-closed on cold cache) — do **not**
  reimplement caching.
- Wire it where tokens enter the system (vault-provision, link, env load) so a
  malformed/expired/legacy `pvt_*` token fails fast at startup, not at first
  request.

```ts
// apps/server/src/auth/vault-token.ts (new) — REAL scope-guard 0.5.0 API
import {
  createScopeGuard, HubJwtError,
  hasScope, enforceVaultScope,
  type HubJwtClaims, type ScopeGuard,
} from "@openparachute/scope-guard";
import { config } from "../config";

// hubOrigin validates the token `iss`; jwksOrigin lets us fetch keys over
// loopback (avoids a tunnel hairpin); allowedIssuers (NEW in 0.5.0) accepts a
// token minted under any of several origins the node is reachable on
// (loopback + <ip>.sslip.io + custom domain) — relevant once exposed (Phase 5).
const guard: ScopeGuard = createScopeGuard({
  hubOrigin: () => config.hubOrigin,                       // e.g. http://127.0.0.1:1939
  jwksOrigin: () => config.hubJwksOrigin ?? config.hubOrigin,
  allowedIssuers: () => config.hubAllowedIssuers,          // string[]; [] = strict single-iss
});

/** Verify a hub-issued vault JWT for `vaultName`, or throw HubJwtError.
 *  Audience is `vault.<name>`; scopes inherit (admin ⊇ write ⊇ read). */
export async function verifyVaultToken(token: string, vaultName: string): Promise<HubJwtClaims> {
  let claims: HubJwtClaims;
  try {
    claims = await guard.validateHubJwt(token, { expectedAudience: `vault.${vaultName}` });
  } catch (e) {
    if (e instanceof HubJwtError) throw new Error(`vault token invalid (${e.code})`); // signature|expired|revoked|…
    throw e;
  }
  if (!hasScope(claims.scopes, `vault:${vaultName}:read`)) throw new Error("token lacks vault scope");
  if (!enforceVaultScope(claims, vaultName)) throw new Error("token not pinned to vault"); // defense-in-depth
  return claims; // { sub, scopes, aud, jti, clientId, vaultScope, permissions? }
}
```

> **Tag-scoping note:** a token may carry `claims.permissions.scoped_tags`
> (Parachute's coarse "this token only sees these tags"). scope-guard passes it
> through verbatim; Prism *interprets* it as an extra narrowing on top of
> `effectiveLevel` (defense-in-depth, mirroring how the gateway already treats tag
> queries as narrowing-only).

**Acceptance.** A revoked token is rejected within ≤60s without a restart; a
legacy `pvt_*` token is rejected at startup with a clear message; an audience
mismatch (`vault.A` token used for vault B) throws; `verify-gateway.ts` still
green.

### 0.2 — Per-vault scoped tokens (drop the god-token)

`config.parachuteToken` is one token with full write to the primary vault. Replace
it with a token *per registry entry*, minted at the scope that entry needs.
`VaultEntry` already carries a per-vault `token` (`config.ts:65-71`) — the registry
shape is right; what changes is **how tokens are obtained and that they're scoped**.

**Tasks**
- `assertConfig()` (`config.ts:129`) validates each entry's token *scope* matches
  its vault name via `verifyVaultToken(token, entry.vault)` (not just presence).
- Vault provisioning (`vault-provision.ts`, desktop `vaults.rs:163`) already mints
  via `parachute auth mint-token --scope vault:<name>:write` — confirm scope is
  per-vault, not a shared god-scope, and 1-year TTL (the F2 fix already did this
  on desktop; mirror on the server path).
- Remove the assumption that `config.parachuteToken` is *the* token; everywhere
  that reads it (`parachute.ts` `vaultClient()`) already routes through a
  `VaultEntry` — audit for any direct `config.parachuteToken` reads outside the
  registry and route them through `resolveVaultEntry()`.

**Preferred end-state (ties to Phase 5 — hub module `credentials`).** Rather than
*embedding* a minted token in `.env` at all, the hub's module contract
(`module-manifest.ts`, H4) lets a module **declare** a standing vault credential
with a scope *template* `vault:{vault}:write` (regex-enforced — never `admin`,
never another namespace). The operator approves once (`POST /admin/connections
{kind:"credential"}`) and the hub **mints the token and POSTs it to an endpoint
Prism declares**. So the long-term shape is: Prism never holds a god-token *and*
never has a human paste a token — it receives an operator-approved, per-vault,
rotatable token from the hub. Phase 0.2 ships the manual/minted path; Phase 5.1
(module registration) upgrades it to this credential-delivery path. Design
`VaultEntry.token` as *rotatable* now (a setter that re-validates) so the Phase-5
swap is drop-in.

**Acceptance.** No single token grants access to two vaults; deleting one vault's
token breaks only that vault; `verify-gateway.ts` + `verify-invite-flow.ts` green.

### 0.3 — Pin the canonical Parachute API contract

The vault REST contract has sharp edges we must handle uniformly before
multi-tenant write traffic multiplies them: **optimistic concurrency** (`PATCH`
with `if_updated_at` → `428 Precondition Required` / `409 Conflict`) and the
**lean list shape** (`NoteIndex` with `byteSize`/`preview` when
`include_content=false`).

**Tasks**
- In `apps/server/src/parachute.ts`, centralize a `vaultFetch()` that maps
  `428`/`409` to a typed `VaultConflict` error and surfaces `next_cursor`.
- In `routes/api.ts` `patch("/notes/:id")` (already threads
  `ifUpdatedAt: body.if_updated_at ?? note.updatedAt`, `api.ts:161`) — return the
  conflict envelope to the client instead of a generic 502, so the editor can
  resolve (the collab path is CRDT and immune; this is for non-collab REST PATCH).
- Web `HttpVaultClient` + desktop `ParachuteClient`: branch list-vs-detail on
  `include_content`; handle `{notes, next_cursor}` vs a flat array.

**Acceptance.** A concurrent REST edit returns `409` with both versions (not a
data loss); large vault lists page via cursor.

### 0.4 — The role abstraction (replace the single-owner boolean)

This is the keystone of the whole roadmap. Today `isOwner: boolean` is computed
in `resolveActor()` (`actor.ts:28`) and short-circuits `effectiveLevel`
(`permissions.ts:44`), the gateway middleware (`api.ts:56-59`), and collab
(`collab.ts:~420`). We replace the boolean with a **per-vault role**, *without yet
adding the vault dimension to storage* (that's Phase 1) — in Phase 0 the role is
still derived from `OWNER_EMAIL` for the primary vault, so behavior is identical,
but every call site now speaks `role`, not `isOwner`.

**Tasks**
- Define the role ladder and a resolver seam:

```ts
// apps/server/src/roles.ts (new)
// Workspace roles sit ABOVE the per-note Level ladder. owner/admin manage the
// workspace (members, publish, federate, settings); member/guest are scoped by
// grants. In Phase 0 this is derived from OWNER_EMAIL; Phase 1 backs it with a
// real memberships table keyed by vault.
export type Role = "owner" | "admin" | "member" | "guest";
export const ROLES: readonly Role[] = ["guest", "member", "admin", "owner"] as const;
export const roleRank = (r: Role) => ROLES.indexOf(r);
export const roleAtLeast = (have: Role | null, need: Role) =>
  have != null && roleRank(have) >= roleRank(need);

/** A role grants a FLOOR on effective level: owner/admin → "own", member → null
 *  (scoped purely by their grants), guest → null. This is how "admin can edit
 *  everything in the workspace" is expressed without a per-note grant. */
export const roleFloor = (r: Role | null): import("./permissions").Level | null =>
  r === "owner" || r === "admin" ? "own" : null;
```

- Change `Actor` (`actor.ts:16-19`) to carry `role` instead of `isOwner`:

```ts
// apps/server/src/auth/actor.ts  (Phase 0: role derived from OWNER_EMAIL)
export type Actor =
  | { kind: "user"; email: string; role: Role; grants: Grant[] }
  | { kind: "link"; capabilityId: string; role: "guest"; grants: Grant[] }
  | { kind: "anon"; role: "guest"; grants: Grant[] };

export function resolveActor(c: Context): Actor {
  const session = readSession(c);
  if (session) {
    const email = session.email;
    return {
      kind: "user",
      email,
      // Phase 0: single-vault role from OWNER_EMAIL. Phase 1 replaces this with
      // workspaceRole(email, activeVault(c)) backed by the memberships table.
      role: email === config.ownerEmail ? "owner" : "member",
      grants: grantsForUser(email),
    };
  }
  /* …desktop-owner bearer path → role:"owner"; capability → role:"guest"; … */
}
```

- Thread the role floor through `effectiveLevel` (`permissions.ts:43`):

```ts
// apps/server/src/permissions.ts
export function effectiveLevel(grants: Grant[], note: NoteRef, floor: Level | null): Level | null {
  let level = floor;                                   // was: if (isOwner) return "own"
  const tagSet = new Set(note.tags);
  const spaceSet = new Set(note.spaceIds ?? []);
  for (const g of grants) {
    const matches =
      (g.resource_type === "note" && g.resource === note.id) ||
      (g.resource_type === "tag" && tagSet.has(g.resource)) ||
      (g.resource_type === "space" && spaceSet.has(g.resource)) ||
      (g.resource_type === "vault");                   // NEW: whole-workspace grant (Phase 2)
    if (matches) level = maxLevel(level, g.level);
  }
  return level;
}
```

- Update the two short-circuits to use the role floor:

```ts
// routes/api.ts middleware — owner/admin get the transparent passthrough
api.use("*", async (c, next) => {
  const actor = resolveActor(c);
  if (roleAtLeast(actor.role, "admin")) return proxyToVault(c);   // was actor.isOwner
  await next();
});
// …and call sites: effectiveLevel(actor.grants, ref(n), roleFloor(actor.role))
```

- Same substitution in `collab.ts` `authorizeConnection` (the `isOwner = email
  === config.ownerEmail` at ~`collab.ts:420`).

**Acceptance.** Grep for `isOwner` returns zero hits in `apps/server/src`
(replaced by `role`/`roleFloor`/`roleAtLeast`); `verify-gateway.ts`,
`verify-invite-flow.ts`, `verify-collab-share.ts` all green — **behavior
byte-identical** because the only role-producer is still `OWNER_EMAIL`. This is
the safety property: Phase 0 is a pure refactor; the role *model* is in place but
the role *source* doesn't change until Phase 1.

### Phase 0 risks & mitigations
- **Touches the security boundary we just hardened.** Mitigation: behavior-preserving
  by construction (single role-producer), gated on the full `verify-*` suite +
  a fresh two-hub run. Land 0.4 behind a green suite before 0.1–0.3 change token
  plumbing.
- **Hub OAuth public-expose is "early testers."** Mitigation: Phase 0 adopts only
  the *token-validation kernel* (scope-guard + JWKS), not hub-hosted end-user
  login. Prism keeps its own sessions/magic-link/password. We consume hub-minted
  vault tokens; we do not (yet) delegate human auth to the hub.

---

## Phase 1 — Vault-scoped multi-tenancy (the spine)

**Goal.** Make every access-control, collab, and federation record **vault-scoped**.
This is the `vault_id` migration `network-vision.md:202` deferred — now the
central work. After Phase 1, "tenant" = "vault": a grant, a published site, a
collab doc, a space, a session's active context all belong to exactly one vault,
and nothing leaks across.

**Why now.** Phase 0 gave us roles and scoped tokens but the *storage* is still
single-vault: `grants`, `capabilities`, `publications`, `spaces`,
`federated_notes`, `collab_docs` have no `vault_id` (`db.ts:47-222`). Until they
do, a second tenant's grants would collide with the first's.

### 1.1 — Schema migration: `vault_id` across the 6 tables (+ 3 federation tables)

**Tasks**
- Add `vault_id TEXT NOT NULL DEFAULT 'primary'` to: `grants`, `capabilities`,
  `publications`, `spaces`, `federated_notes`, `collab_docs`, and the federation
  satellites `pending_suggestions`, `federation_mirror_requests`,
  `federation_outbox`. The `DEFAULT 'primary'` is the migration's safety net —
  every existing row belongs to the env primary vault, so current single-vault
  deployments are unaffected.
- Follow the existing additive-migration pattern (`db.ts:227-252`):

```ts
// apps/server/src/db.ts — one block per table, mirroring the password_hash migration
for (const table of [
  "grants", "capabilities", "publications", "spaces",
  "federated_notes", "collab_docs", "pending_suggestions",
  "federation_mirror_requests", "federation_outbox",
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "vault_id")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'primary'`);
  }
}
// Composite indexes so per-vault queries stay fast.
db.exec(`
  CREATE INDEX IF NOT EXISTS grants_vault_subject  ON grants(vault_id, subject_type, subject);
  CREATE INDEX IF NOT EXISTS grants_vault_resource ON grants(vault_id, resource_type, resource);
  CREATE INDEX IF NOT EXISTS collab_docs_vault     ON collab_docs(vault_id, name);
`);
```

- **`collab_docs` PK change** (`db.ts:69`, currently `name TEXT PRIMARY KEY` =
  note id). A note id is only unique *within* a vault. Migrate to a composite key
  `(vault_id, name)`. SQLite can't alter a PK in place → rebuild: create
  `collab_docs_v2` with the composite PK, copy rows with `vault_id='primary'`,
  drop+rename. This is the one non-additive migration; gate it behind a one-time
  version bump in `settings`.

### 1.2 — Vault-scoped grant/capability resolution

Every grant lookup must filter by the active vault.

**Tasks**
- `grantsForUser(email)` → `grantsForUser(email, vaultId)` (`db.ts:519`); same for
  `grantsForCapability`, `upsertGrant`, `grantsForUser`'s `anyone`-union.
- The active vault for a request comes from the existing `X-Prism-Vault` header
  (`api.ts:37`), now honored on **every** route, not just the owner passthrough.
  Resolve it once in a middleware and stash on the context:

```ts
// apps/server/src/routes/api.ts — resolve active vault before actor grants load
api.use("*", async (c, next) => {
  const entry = resolveVaultEntry(c.req.header("x-prism-vault"));   // already exists, db.ts:341
  c.set("vault", entry);                                           // typed via Hono Variables
  await next();
});
```

- `resolveActor(c)` reads `c.get("vault").id` and calls `grantsForUser(email,
  vaultId)`, so an actor's grants are *already* scoped to the active vault.

### 1.3 — `workspaceRole(email, vaultId)` — the real role source

Phase 0's role came from `OWNER_EMAIL`. Phase 1 backs it with a `memberships`
table so a vault can have multiple owners/admins/members.

```ts
// apps/server/src/db.ts (new table)
CREATE TABLE IF NOT EXISTS memberships (
  vault_id   TEXT NOT NULL,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL,          -- 'owner' | 'admin' | 'member' | 'guest'
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, email)
);
```

```ts
// apps/server/src/roles.ts
export function workspaceRole(email: string, vaultId: string): Role {
  const row = db.prepare(
    "SELECT role FROM memberships WHERE vault_id = ? AND email = ?",
  ).get(vaultId, email) as { role: Role } | undefined;
  if (row) return row.role;
  // Bootstrap/back-compat: the env OWNER_EMAIL is owner of the primary vault even
  // before any membership row is written (so an upgraded deploy keeps working).
  if (email === config.ownerEmail && vaultId === "primary") return "owner";
  return "guest";
}
```

`resolveActor` now does `role: workspaceRole(email, c.get("vault").id)`. The
gateway, `effectiveLevel` floor, and collab authz all flow from this.

**Interop with the hub's `user_vaults` (don't reinvent vault membership).** The
hub *already* has a per-user, per-vault assignment table — `user_vaults` (hub
migration v10) with a `role` column and helpers `vaultVerbsForRole(role)` /
`vaultVerbsForUserVault(db, userId, vaultName)` (`hub/src/users.ts`,
`api-users.ts`; API: `POST /api/users`, `PATCH /api/users/:id/vaults`,
`GET /api/users/vaults`). This governs **whether a user can obtain a vault token
at all** (and at which verb). The clean split:

- **Hub `user_vaults`** = *can this identity touch this vault, at read/write/admin?*
  (the token-authority layer). Prism should treat it as the source of truth for
  vault *membership* and reconcile its `memberships` table against it (e.g. on
  invite-accept, also assign the hub `user_vaults` row so the member can be minted
  a scoped token by the hub).
- **Prism `memberships.role`** = the *finer workspace role* (owner/admin/member/
  guest) that drives Prism's management UI + the `effectiveLevel` floor — a
  distinction the hub doesn't model.

> **Gotcha to honor:** hub `vaultVerbsForRole('write')` returns
> `["read","write","admin"]` — i.e. **any hub-assigned `write` user gets admin
> verbs on that vault** ("any assigned user gets admin", Aaron's call). So a Prism
> *member* (who should NOT have vault-admin) must map to hub `role='read'` unless
> we also want them token-admin, OR Prism mints the member's token itself at a
> narrower scope. Decide per-role mapping explicitly in `workspaceRole`'s
> reconciliation; do not assume hub `write` == Prism `member`.

### 1.4 — Vault-scope the gateway, ACL, publish, and collab paths

The agent review found these still pinned to the singleton `vault` client
(`api.ts:15`, `acl.ts:12`, `collab.ts:29`). Repoint each to the request's active
vault.

**Tasks**
- `routes/api.ts`: `visibleNotes()` and every `vault.*` call use
  `vaultClient(c.get("vault"))` instead of the singleton, so a non-owner's
  reads come from *their* vault.
- `routes/acl.ts`: the whole owner-management surface (publish, spaces, people,
  capability links) operates on `c.get("vault")`. Grants written here carry its
  `vault_id`.
- `apps/server/src/collab.ts`: `authorizeConnection` and `federationTarget`
  resolve the vault from the connection (the WS URL carries the vault, e.g.
  `/collab/:vault/:noteId?t=`), and `loadDocumentState`/`storeDocumentState` key
  `collab_docs` by `(vault_id, note id)`.

### 1.5 — Client: the active vault is the tenant selector

The seam already has `listVaults/getActiveVault/setActiveVault`
(`CollabSharing.tsx:240-242`) and the web client already sends `X-Prism-Vault`
(`apps/web/src/parachute/rest.ts`). Phase 1 makes switching the vault switch the
*entire* authorization context, not just the owner passthrough — no client API
change, but now a **member** (not just the owner) sees a vault switcher scoped to
the workspaces they belong to.

**Tasks**
- `GET /api/vaults` (`routes/vaults.ts`) returns the vaults the **actor is a
  member of** (join `memberships`), not just the env registry — so a guest invited
  to one workspace sees exactly one.
- The `VaultSwitcher` (`packages/core/src/components/.../navigation/VaultSwitcher.tsx`)
  is unchanged structurally; it now lists membership-derived workspaces.

### Phase 1 acceptance & security
- **AC:** Two vaults configured; a grant/publish/space/collab-doc created in vault
  A is invisible in vault B (DB rows differ by `vault_id`; cross-vault read → 403).
- **AC:** A member of A who is a guest of B sees A's notes at their A-level and B's
  notes at their B-level, never each other's.
- **Security:** add `verify-multitenant.ts` — provisions 2 vaults + 2 users with
  asymmetric roles, asserts no cross-vault leak across notes/grants/publish/collab.
  This joins the `verify-*` suite as a required gate.

### Phase 1 risks
- **The `collab_docs` PK rebuild is the riskiest migration.** Mitigation: it's
  copy-then-swap inside a transaction, gated on a `settings` version flag, with a
  backup of the table first; tested on a throwaway DB before the live one.
- **Performance:** every grant query gains a `vault_id` predicate. Mitigation: the
  composite indexes in 1.1; the row counts here are tiny (grants/members), so this
  is negligible.

---

## Phase 2 — Roles, membership & the team workspace (the headline)

**Goal.** Turn the vault-scoped substrate into the **Notion-style team workspace**:
invite members with roles, a Members & Permissions admin panel, folder/tag
sharing wired to UI, scoped note creation for members, and **private-to-creator
notes** so personal notes live safely inside a shared vault.

This is the Phase-1 *anchor* the user chose, now sitting on real multi-tenant
foundations.

### 2.1 — Membership & invitations (roles, not just access)

Phase 1 added the `memberships` table; Phase 2 adds the lifecycle.

**Tasks**
- `routes/acl.ts` (admin-gated via `roleAtLeast(actor.role, "admin")`):
  - `GET  /acl/members` → `[{ email, name, role, joinedAt }]` for the active vault.
  - `PUT  /acl/members` `{ email, role }` → upsert membership; if the user has no
    account, reuse `grantAndInvite()`'s invite path (`acl.ts:72`) so they get an
    accept link (returned to the admin even with no Resend, mirroring the F6 fix).
  - `DELETE /acl/members/:email` → remove membership (and optionally cascade their
    per-note grants in this vault).
- Extend the `CollabSharing` seam:

```ts
// packages/core/src/data/CollabSharing.tsx — new optional methods (degrade gracefully)
export interface WorkspaceMember { email: string; name: string | null; role: Role; joinedAt: number }
// …on interface CollabSharing:
listMembers?(): Promise<WorkspaceMember[]>;
setMember?(email: string, role: Role): Promise<SetPersonResult>;   // reuses invite → inviteUrl
removeMember?(email: string): Promise<void>;
```

### 2.2 — Members & Permissions admin panel

Per the UX inventory in `network-vision.md:170-177`, the home is a **new section
of the Network virtual tab** (mounted via `ContentType` + `Registry` +
`VIRTUAL_TAB_IDS`), not Settings. It sits beside the existing
`PublishPanel`/`FederatePanel`/`VaultsPanel`.

**Tasks**
- New `packages/core/src/components/renderers/network/MembersPanel.tsx`:
  - Members list (email · name · role badge · joined) with role dropdown + remove.
  - "Invite member" → email + role → calls `setMember`; on `inviteUrl` returned,
    show the copy-to-clipboard invite link (no email service required).
  - A **grants audit** sub-view: every grant in the active vault (subject ·
    resource (note/tag/folder) · level · who granted), each revocable — backed by
    a new `GET /acl/grants` (admin) that lists the vault's grants.
- Gate the whole panel on `roleAtLeast(role,"admin")` (hidden for members/guests;
  absent seam methods → hidden, the existing pattern).

### 2.3 — Wire folder/tag email-sharing (the already-built endpoint)

The single highest-value quick win in the whole roadmap: `PUT/DELETE
/acl/tags/:tag/people` **already exists and works** (`acl.ts:323-339`,
`grantAndInvite`) but **no client ever calls it** — only per-note sharing is
exposed. Since a tag ≈ a folder in Parachute, this *is* "share an entire folder
with specific email addresses."

**Tasks**
- Extend the seam: `setTagPerson?(tag, email, level)`, `removeTagPerson?(tag,
  email)`, `getTagAccess?(tag) → TagAccess[]` (the `TagAccess` type already exists,
  `CollabSharing.tsx:29`).
- Web impl in `apps/web/src/collab/grant.ts` calling the existing endpoints.
- UI: in the `ShareDialog` (which already *displays* tag-access read-only,
  `ShareDialog.tsx:379-386`) add a "Share this folder/tag" affordance; and surface
  it from a tag/folder right-click in `ProjectTree` → deep-link into the Network
  Members panel with the tag pre-filled (the "publish/federate this collection"
  bridge `network-vision.md:165-168`, extended to "share").

**Acceptance.** Owner shares folder `#spirit-of-the-front-range` with
`alice@…` at `edit` from the UI → Alice gets an invite link → registers → sees and
edits exactly that folder's notes, nothing else. (End-to-end, no CLI.)

### 2.4 — Scoped note creation for members

Today non-owners get a hard `403` on `POST /notes` and `DELETE /notes`
(`api.ts:120-122,169-171`). A "member" who can't create notes isn't a member.

**Tasks**
- Relax `POST /notes` for non-admins **scoped to their writable slice**: a member
  may create a note **only if** the note's tags/path fall within a tag/folder they
  hold `edit`+ on (so creation can't smuggle a note into an unshared area):

```ts
// routes/api.ts
api.post("/notes", async (c) => {
  const actor = resolveActor(c);
  const body = await c.req.json<{ content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }>();
  if (!roleAtLeast(actor.role, "admin")) {
    // A member may only create within a tag/folder they can already edit.
    const target: NoteRef = { id: "<new>", tags: body.tags ?? [] };
    if (!atLeast(effectiveLevel(actor.grants, target, roleFloor(actor.role)), "edit"))
      return c.json({ error: "forbidden", reason: "create outside your shared slice" }, 403);
  }
  const vault = vaultClient(c.get("vault"));
  const created = await vault.createNote(body);
  // Stamp creator for private-to-creator (2.5) and audit.
  await vault.updateNote(created.id, { metadata: { ...created.metadata, prism_creator: actor.kind === "user" ? actor.email : null } });
  return c.json(created);
});
```

- `DELETE /notes/:id`: allow if `effectiveLevel ≥ edit` **and** (admin OR the
  creator) — never let a member delete others' notes by default.

### 2.5 — Private-to-creator notes (Notion private pages)

The gap: grants are additive-only (`effectiveLevel` only MAXes up), there's no
"private" floor and no note-level creator the permission layer reads. We add a
**visibility floor**, not a deny grant (denies compose badly).

**Design.** A note may carry `metadata.prism_visibility: "private" | "workspace"`
(default `"workspace"`). When `private`, `effectiveLevel` ignores tag/space/vault
grants and honors **only** (a) the creator (`metadata.prism_creator`), and (b)
explicit per-**note** grants. So a private note inside a shared folder is invisible
to the folder's members until the creator explicitly shares that note.

```ts
// apps/server/src/permissions.ts
export interface NoteRef { id: string; tags: string[]; spaceIds?: string[];
  creator?: string | null; visibility?: "private" | "workspace"; }

export function effectiveLevel(grants: Grant[], note: NoteRef, floor: Level | null, subject?: string): Level | null {
  // Private notes: creator gets "own"; everyone else needs an explicit NOTE grant.
  if (note.visibility === "private") {
    if (subject && note.creator && subject === note.creator) return "own";
    let lvl: Level | null = null;
    for (const g of grants)
      if (g.resource_type === "note" && g.resource === note.id) lvl = maxLevel(lvl, g.level);
    return lvl;                                    // floor + tag/space/vault grants IGNORED
  }
  let level = floor;
  /* …unchanged tag/space/vault matching… */
}
```

- `ref(note)` (`api.ts:21`) reads `creator`/`visibility` from `note.metadata`.
- Admins/owners: note that `roleFloor` is **not** applied to private notes — even
  an admin doesn't see a member's private note unless granted. (Product decision,
  matches Notion; flag if the owner wants an admin override — easy to add as a
  workspace setting.)
- UI: a "Make private" toggle on a note; a lock badge; the Share dialog shows
  "Private to you — shared with N people."

**Acceptance.** Member Bob creates a note in shared folder `#projects` and marks
it private → Alice (also a member of `#projects`) cannot see it via list, search,
or direct GET (403) → Bob shares that one note with Alice at `view` → she sees
only it.

### 2.6 — Whole-workspace grant

The `resource_type='vault'` grant (added to `effectiveLevel` in 0.4) lets an admin
grant a member broad access without enumerating tags — "this person can edit
everything in this workspace." Distinct from a *role* (which also confers
management rights); a `vault` grant is pure note-level access.

**Tasks**
- `db.ts` grants `resource_type` comment updated to include `'vault'`; `resource`
  = the `vault_id`.
- `PUT /acl/vault/people` `{ email, level }` (admin) → upserts a vault grant.
- Surface in the Members panel as a per-member "workspace access level".

### Phase 2 acceptance & security
- **AC (the demo):** From a fresh browser, an admin invites two members, shares one
  folder with one of them, the other gets workspace-wide `edit`, both create notes
  in their slices, one marks a note private and it stays private — all from the UI.
- **Security:** `verify-multitenant.ts` extended with the private-note matrix
  (creator sees, members don't, explicit grant flips it) and the scoped-create
  guard (member can't create outside their slice).

### Phase 2 risks
- **Private-note correctness is security-critical** (a leak here is a privacy
  breach). Mitigation: it's a *floor that removes* access (fail-closed: unknown →
  no access), covered by the verify matrix, and the change is localized to
  `effectiveLevel` (the single guard) + `ref()`.
- **Vault note model stores creator/visibility in metadata** (Parachute has no
  native ACL). Mitigation: that's the canonical extension point (metadata is
  Prism's to own); the permission layer reads it, the vault just stores it.

---

## Phase 3 — Server-first runtime & per-tenant secrets

**Goal.** A tenant doesn't run a Mac. So **context ingestion** (Matrix, Notion,
transcripts) and **agent dispatch** (`claude -p`) must run **server-side, scoped
per tenant**, with each tenant's integration credentials held in a **per-tenant
encrypted secret store**. This is what makes the web/mobile app fully capable
without a desktop — the user's "access it through the web app on mobile" goal.

**Why now.** Phases 0–2 made the server multi-tenant for *data*; Phase 3 makes it
multi-tenant for *compute*. The agent review found the seam is cleaner than
feared: every service already *writes* via HTTP→Parachute, and `claude -p` is 95%
subprocess orchestration — but the gate is a secret store that doesn't exist.

### 3.1 — Per-tenant encrypted secret store

**Tasks**
- New table + module:

```ts
// apps/server/src/db.ts
CREATE TABLE IF NOT EXISTS tenant_secrets (
  vault_id    TEXT NOT NULL,
  owner_email TEXT NOT NULL,        -- whose credential (a member's own Matrix token, etc.)
  kind        TEXT NOT NULL,        -- 'matrix' | 'notion' | 'fathom' | 'anthropic' | …
  ciphertext  BLOB NOT NULL,        -- AES-256-GCM(secret), key from SECRETS_KEY (env, never in db)
  iv          BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (vault_id, owner_email, kind)
);
```

- `apps/server/src/secrets.ts`: `putSecret/getSecret/listSecretKinds`, AES-256-GCM
  with a master key from `SECRETS_KEY` (env, 32 bytes, never persisted; documented
  in `assertConfig`). This is the multi-tenant blocker the agent flagged — built
  once, every server-side integration uses it.
- `assertConfig()` requires `SECRETS_KEY` when any server-side integration is
  enabled.

### 3.2 — The Node "Prism worker" (port the pure-logic ingesters)

Per the agent recommendation: a **colocated Node worker inside `apps/server`**, not
a headless Rust binary (which drags the macOS/Keychain/Tauri coupling). Port the
services whose only host tie is a credential string.

**Tasks (port from Rust → Node, scoped per tenant)**
- `message_sync` (Matrix) — pure `reqwest`→`fetch` against `/_matrix/client/v3`;
  credential from `tenant_secrets(kind='matrix')`.
- `notion_task_sync` — Notion API key from secrets.
- `transcript_sync` Fathom/Fireflies — API keys from secrets. (Meetily stays
  desktop: it's a local SQLite file.)
- A `worker/scheduler.ts` that, per vault with the integration configured, runs
  the poll loop and writes via the vault's scoped token (`vaultClient(entry)`).
- Leave `calendar_sync`/`email_sync` (the `gog` keyring) and the **local-model
  agentic loop** (`local_agent.rs` — real Rust logic, not orchestration)
  **desktop-only**; gate them clearly in the web UI (the parity doc's GATE list).

### 3.3 — Server-side agent executor (`/api/agent`)

Port `spawn_claude_process` (`agent_dispatch.rs:412-514`) to Node. It's binary
resolution + a fixed argv template + env scrubbing + a timeout + vault-note
persistence — all 1:1 in `child_process.spawn`.

**Tasks**
- New `routes/agent.ts`, mounted **before** the gateway, **admin-gated** (session
  cookie only — never capability/anon; this spawns a host process):
  - `POST /api/agent/dispatch` `{ skill, noteId?, prompt }` → spawns `claude -p`
    with the per-vault managed `.mcp.json` (so the agent targets the active
    tenant's vault) and the vault's scoped token; returns a dispatch id.
  - `POST /api/agent/cancel/:id`.
  - `GET  /api/agent/stream/:id` (SSE) → live status; durable history is already
    `agent-dispatch`/`agent-output` vault notes (read via the gateway).
- **Hard safety:** never accept a free-form command line; the argv is a fixed
  template (`-p --model … --mcp-config <managed> -- <prompt>`), per the agent
  review's dominant risk note. Owner/admin only, rate-limited, per-tenant MCP
  config written to a tenant-scoped temp path.
- Web: rewire the `agent-activity` virtual tab (`AgentActivity.tsx`) to call these
  endpoints + read history from the vault (the parity doc's #2/#3 recommendations).

### Phase 3 acceptance & security
- **AC:** With no desktop running, a tenant configures their Matrix token in the
  web UI → messages ingest into *their* vault on the server's schedule; they
  trigger an agent skill from the browser and watch it stream.
- **Security:** the executor is owner/admin-session-gated, fixed-argv, per-tenant
  MCP/token; secrets are encrypted at rest; one tenant's worker can't read
  another's secret (PK includes `vault_id`). Add `verify-agent-exec.ts` asserting
  a non-admin/capability/anon caller gets 403 and the argv can't be injected.

### Phase 3 risks
- **Arbitrary-command-execution is the dominant risk.** Mitigation: fixed argv,
  session-only auth, rate limit, no shell — exactly the constraints the parity doc
  prescribes.
- **Porting effort.** Mitigation: scope to the pure-logic services first (Matrix,
  Notion, Fathom) + the `claude -p` executor (~1 week each per the estimates);
  explicitly defer `gog`/Meetily/local-model loop (host-bound) rather than rewrite
  them.

---

## Phase 4 — Federation depth & Parachute Sync (node-to-node)

**Goal.** Make the peer layer real and friendly. Two topologies converge here:
independent nodes federating slices, and tenants on one node sharing across
workspaces. Headline feature: **Parachute Sync** — a one-click "mirror this note
to a peer," which the review confirmed **already exists as federation** (the
`space_note_key` one-doc bridge + mirror-accept literally reproduces a note in a
peer's vault) and needs a friendly wrapper + one wiring fix, not a new engine.

### 4.1 — Wire client routing by `space_note_key` (federation gap #2)

The blocker: own clients still open a federated note by its **local id**, so its
edits aren't live-bridged to the peer. The lookup route exists
(`/api/federated/:noteId → spaceNoteKey`); the clients don't use it.

**Tasks**
- `apps/web/src/collab/CollabDoc.tsx` and desktop `Canvas.tsx` (`COLLAB_TYPES`
  swap): before opening a collab doc, resolve `/api/federated/:noteId`; if it
  returns a `spaceNoteKey`, open the Yjs doc under that key (so local edits flow to
  the peer through the existing bridge).
- Add `AC-6`-style coverage that asserts the **client** (not just the route) opens
  under the key.

### 4.2 — "Parachute Sync": per-note mirror in one action

Collapse the 4-step space flow (create space → add note → grant peer → mirror)
into one per-note affordance, presented alongside the existing Notion/Google/GitHub
sync destinations — but routed to the **server's** federation endpoints (it can't
be a Rust `SyncAdapter`; forcing CRDT into the snapshot-based trait would
re-implement Yjs badly).

**Tasks**
- Seam: `mirrorNoteToPeer?(noteId, pubkey, level)` → server orchestrates
  `createSpace`(singleton) + `addNoteToSpace` + `grantSpacePeer` + `POST
  /api/federation/mirror`.
- UI: in the note's Share/Sync surface, "Sync with a peer" → pick a paired peer +
  level → live two-word status (Synced/Syncing/Offline), reusing the
  `FederatePanel` status vocabulary.

### 4.3 — Granular federation controls

The review found space-level grants only; add the controls the vision wants.

**Tasks**
- **Per-note level within a space** (override the space default for one note).
- **TTL / expiry** on peer grants (time-boxed access).
- Offer `comment`/`own` space levels in the UI (already in `permissions.ts`, not
  surfaced — `FederatePanel.tsx:57`).
- **Edit audit:** record peer edits (who/when) for the owner's review.
- All vault-scoped (rides Phase 1): spaces belong to a vault; a peer grant is in
  that vault's context.

### 4.4 — Deeper two-hub testing in CI

The harness exists (`verify-two-hub.ts`, AC-1..AC-12) but isn't in CI, and AC-5
(binding live) / AC-10 (suggest→inbox) are weak.

**Tasks**
- Make `two-hub-up.sh` + `verify-two-hub.ts` a CI job (ephemeral hubs, isolated
  vaults/ports — never the default vault).
- Add coverage for: mirror **reject**, grant **downgrade** (edit→view) mid-session,
  concurrent-edit **content** correctness (not just marker presence), kind-mismatch
  skip, reconnect storms, and the AC-6 **client** wiring from 4.1.

### Phase 4 acceptance
- Two independent nodes; on node A, one click mirrors a note to node B's owner; B
  approves the inbound request; an edit on either side converges in <15s; revoke
  halts it; all green in CI on every push.

---

## Phase 5 — Self-hosting as a hub module (deploy convergence)

**Goal.** Make standing up a node trivial and VPS-safe by **leaning on the hub's
supervision/ports/exposure** instead of pm2 + manual cloudflared. The review's
highest-leverage infra move: **register Prism's server as a Parachute hub
module**, so the hub owns install/start/port/proxy-mount/exposure — the same
machinery it already runs for vaults.

### 5.1 — Register Prism as a hub module

**Tasks**
- Ship `.parachute/module.json` (schema verified against hub 0.7.3
  `src/module-manifest.ts`). Required: `name` (`^[a-z][a-z0-9-]*$`),
  `manifestName`, `port`, `paths[]`, `health` (leading `/`). Key optional fields
  for Prism:
  - **`websocket: true`** — **deny-by-default**; required so the hub's Bun-native
    WS bridge (`ws-bridge.ts`) forwards `Upgrade: websocket` to `/collab`. (The
    bridge is explicitly sized for "Hocuspocus / y-websocket … CRDT sync bursts" —
    transport only; Prism still authenticates the socket via `authorizeConnection`.)
  - **`credentials: [{ scope: "vault:{vault}:write", endpoint, … }]`** — the H4
    standing-credential flow from Phase 0.2: the hub mints a per-vault token on
    operator approval and POSTs it to our `endpoint`, so we drop the embedded
    token.
  - **`scopes.defines: ["prism:<verb>", …]`** — any OAuth scopes Prism owns, which
    **must** be namespaced `<name>:<verb>` (a module may not define `vault:*`).
  - Optional `stripPrefix`, `uiUrl`, `managementUrl`, `configSchema` (flat
    JSON-Schema for the hub's config portal), `focus`. The legacy `kind` field is
    **retired** (hub#301/#330) — omit it.
- The hub then supervises Prism (crash-restart budget, port assignment from the
  1939–1949 range, reverse-proxy mount) "with zero hub code changes," and
  `expose-state.ts` (Cloudflare Tunnel / Tailscale Funnel) provides the public URL
  — **replacing** the bespoke pm2 + `cloudflared` topology.
- **Option (recommended): route `/collab` through the hub WS bridge** rather than
  exposing Prism's own port. The CRDT/collab logic stays entirely Prism's; the hub
  just proxies the upgrade — one fewer exposed port, and exposure/auth ride the
  hub. The `allowedIssuers` multi-origin support (scope-guard 0.5.0) means tokens
  minted under the loopback origin still validate when the request arrives via the
  tunnel origin.

### 5.2 — VPS/Hetzner-safe deploy (close the trust gap)

The critical finding: `auth/local.ts:21` treats any request **without** a
forwarding header as the trusted local owner. Behind Cloudflare that's fine; on a
raw Hetzner port it would **treat external traffic as the desktop owner** — a
critical misconfig.

**Tasks**
- Make the "local owner" path require an explicit opt-in (`TRUST_LOCAL=true`,
  default **false** on a server profile), and/or require a configured trusted-proxy
  header. Fail closed.
- Ship a `systemd` unit + a `Dockerfile`/compose (none exist today) so a Linux
  deploy is one command.

### 5.3 — Plugin-driven one-command node bring-up

**Tasks**
- Extend the `prism-setup` skill to orchestrate the full hub-native flow: install
  hub + vault, create the vault, mint the scoped token, register the Prism module,
  enable exposure, seed schemas — guided, idempotent, with the readline-masking
  + port-aware fixes (the deferred F3/F4).
- "Magic" tag→server mapping: the setup reads the vault's tag schemas and
  pre-configures renderers/dashboards accordingly.

### Phase 5 acceptance
- A motivated non-engineer, on a fresh Hetzner box or a Mac mini, runs one guided
  flow and ends with a public, exposed, multi-tenant Prism node — no pm2, no manual
  tunnel, no raw-port trust hole.

---

## Phase 6 — Cross-platform desktop & polish

**Goal.** Desktop becomes **one client among many** against multi-tenant servers,
and runs on Linux/Windows.

**Tasks**
- **Delete/target-gate the one hard blocker:** `security-framework = "3"` is
  declared unconditionally in `apps/desktop/src-tauri/Cargo.toml:36` but **never
  imported** — it fails the Linux/Windows build. Remove it (or gate under
  `[target.'cfg(target_os="macos")']`). This is a few-hours change.
- Secret-store fallback off-mac (the macOS `security` CLI Keychain path
  degrades to plaintext today — add a Linux secret-service / Windows credential
  store, or document the fallback).
- Config-path + `gog`/Meetily discovery fallbacks for non-mac.
- Desktop talks to a remote multi-tenant Prism server as a first-class client
  (generalize the existing `vault_link`, which today targets Parachute hubs
  directly, into "connect to a Prism node" with session auth).

### Phase 6 acceptance
- `cargo build` succeeds on Linux + Windows; a Linux user runs the desktop app
  against a remote node.

---

## Cross-cutting concerns (every phase)

### Security & testing ledger
The `apps/server/scripts/verify-*.ts` suite is the contract; each phase extends it
**before** merging, never after:

| Harness | Guards | Phase that extends it |
|---|---|---|
| `verify-gateway.ts` | owner passthrough + non-owner filtering + deny-by-default | 0 (role refactor), 1 (vault-scope) |
| `verify-invite-flow.ts` | invite → register → scoped access | 0, 2 (roles/members) |
| `verify-collab-share.ts` | 4 collab kinds × levels | 1 (vault-scoped collab) |
| `verify-multitenant.ts` **(new)** | no cross-vault leak; private notes; scoped create | 1, 2 |
| `verify-agent-exec.ts` **(new)** | executor is admin-only, non-injectable | 3 |
| `verify-two-hub.ts` + `verify-federation.ts` | live convergence, reject/downgrade, client wiring | 4 (into CI) |

### The Parachute interop ledger (adopt / interop / keep)

> **Version targets (verified 2026-06-30 against published tarballs):** hub
> **0.7.3**, vault **0.6.3**, scope-guard **0.5.0**. The "keep our own" verdicts
> below were **re-validated against 0.7.3/0.6.3**: Parachute still has **no**
> native per-note/per-tag end-user ACL, no comment/suggest tiers, no
> capability/anyone-with-link sharing, no CRDT/Yjs collab, no Ed25519/federation,
> and no renderer registry. Those remain exclusively Prism's. The vault REST + MCP
> contract is **unchanged** from what the seam already targets (no new tools; the
> 9 + admin-hidden `manage-token`/`prune-schema`).

| Area | Decision | Phase |
|---|---|---|
| Hub-minted `vault:<name>:<verb>` JWTs + scope-guard `0.5.0` (`validateHubJwt`/`hasScope`/`enforceVaultScope`; copy `vault/src/hub-jwt.ts`) | **ADOPT** | 0 |
| Canonical `/vault/<name>/api` contract (`aud=vault.<name>`, 409/428, cursor paging — note: cursor is incompatible with FTS `search`) | **ADOPT** (no changes needed for 0.6.3) | 0 |
| Hub `user_vaults` (per-user vault role/verbs) as the membership/token-authority substrate; Prism `memberships` adds the finer workspace role | **INTEROP** (keep Prism sessions; reconcile both tables; mind `write`→admin) | 0–1 |
| Hub module contract (`module.json`: `websocket:true`, `credentials`, `scopes.defines`) for deploy/ports/exposure + standing per-vault token + collab WS bridge | **ADOPT** | 0.2 / 5 |
| Renderer registry, type-aware Yjs collab | **KEEP** | — |
| Per-note/per-tag/per-folder ACL, comment/suggest tiers, private notes, capability links | **KEEP & EXTEND** | 2 |
| Ed25519 federation / spaces / Parachute Sync | **KEEP & EXTEND** (re-eval vs hub OAuth-DCR later) | 4 |
| `argon2id` password hashing (parity with hub) | **ADOPT** (swap from scrypt) | 0 (optional) |

**Forward-looking (design toward, don't block on).** The hub is actively
hardening on `0.7.4-rc.*` (rc.20 the day this was written). The headline imminent
work per its README is a **hardened OAuth-2.1 issuer + per-module scope
enforcement that makes public (non-tailnet) exposure "now safe"** — the multi-origin
`allowedIssuers` already shipped (0.5.0) is the first piece. Build Prism's
resource-server + module registration against the **0.7.3/0.6.3/scope-guard-0.5.0**
contract now; expect public-exposure scope enforcement to firm up *around* that
contract, not replace it. (This is also why Phase 0 adopts only the token kernel
and keeps Prism's own login: the hub's *end-user* OAuth issuer is still framed as
"soon.")

### What we explicitly are NOT doing (v1 non-goals)
- Hub-hosted end-user login (OAuth public-expose is "early testers") — Prism keeps
  its own sessions; we adopt only the token kernel.
- Per-field / section-level ACL; read receipts beyond a basic edit audit.
- Moving `gog`-backed Gmail/Calendar, Meetily, or the local-model agentic loop
  server-side (host-bound; stay desktop, gated in web).
- Custom DNS/domain management for publications.

---

## Sequencing summary & first concrete steps

**Order:** 0 → 1 → 2 → 3 → 4 → 5 → 6, each shippable. Phases 0–2 are the
multi-tenant core (the "Notion-killer"); 3 makes it Mac-free; 4 makes it a
network; 5 makes it easy to host; 6 makes it cross-platform.

**Quick wins available immediately (no dependency on the big refactor), if you
want proof-of-progress before Phase 0 lands:**
1. **Wire folder/tag email-sharing UI** (Phase 2.3) — the endpoint already works;
   this is pure client + seam work and delivers "share a folder with an email"
   today.
2. **Delete the dead `security-framework` dep** (Phase 6) — unblocks a Linux build
   in a few hours.
3. **Stale federation-manager header** — gap #1 (peer-URL registry) is already
   closed in code; update the comment so the next reader isn't misled.

**The first real Phase-0 PR:** introduce `roles.ts` + the `Actor.role` refactor
(0.4) behind a green `verify-*` suite — behavior-identical, but every short-circuit
now speaks `role`. That single PR is the hinge the entire multi-tenant platform
swings on.
