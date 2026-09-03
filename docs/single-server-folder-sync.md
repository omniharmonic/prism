# Single-Server Vault-to-Vault Folder Sync — Design

*Lane B design doc. Branch `feat/single-server-folder-sync`. Status: implemented behind owner-gated `/acl/mirrors` routes; verified on scratch vaults only.*

## The problem

Benjamin's "Spirit of the Front Range" folder (a path prefix in his personal vault) should sync into the Front Range Commons vault **on the same Prism server** — folder structure included. Today a collaborator invited to the shared material **can see notes but not folders**, and the only sharing machinery that moves notes between vaults (federation) **assumes two distinct servers**.

## Root cause (B1 findings)

Two independent gaps produce the symptom.

### 1. Folders are never conveyed as data

A "folder" exists nowhere in Prism as an entity — not in the DB, not in the gateway, not in Parachute's exposed surface. Folders are a **client-side derivation** from the `path` field of notes the client actually received (`ProjectTree.buildTree` walks `note.path` segments; the web shim's `listTree()` is literally `GET /notes?limit=50000`).

Grants can scope to **note / tag / space / vault only** (`permissions.ts:82-87`). `resource_type='path'` is deliberately reserved for *public publications* and is never a grant (`db.ts:610-615`); `NoteRef` doesn't even carry a `path` field to match against. So a collaborator's `GET /notes` returns a sparse, grant-scoped set, and their sidebar can only materialize the ancestor folders of those specific notes. Sibling folders, structural folders, and the folder-as-a-unit never appear. **That is the "notes but not folders" symptom.**

### 2. The federation pipeline is path-destroying and two-server-shaped

- The mirror manifest carries only `{ spaceNoteKey, kind, title? }` — no path (`routes/federation.ts:105-113`). On accept, the receiving hub writes every note to `shared/<space-id>/<space-note-key>.md` (`acl.ts:1486`). Folder structure is discarded by design; ongoing CRDT edits persist only `{ content }`.
- A space's `path_prefix` / tag scopes are **declarative only** — nothing server-side enrolls matching notes; membership is one explicit API call per note.
- There is **no server-side outbound mirror pusher** (only the verify harness sends manifests).
- On a single server, `PeerBinding` would open a WebSocket **to itself** (localhost loopback moving CRDT bytes between two docs in the same process), and the Ed25519 pairing / peer-conn tokens / owner accept-reject handshake all authenticate *yourself to yourself*.

## Decision (B2): a poll-and-diff mirror worker, not a CRDT short-circuit

**Chosen: a new background worker (`worker/vault-mirror.ts`) that diffs a source path prefix against a destination prefix and writes through the existing per-vault `vaultClient` factory.** The CRDT/federation path is left fully intact and untouched.

Rationale:

1. **Folder sync is a path + lifecycle problem, not a live-editing problem.** What must propagate is note *existence, path, tags, content, moves, deletes* under a prefix. The CRDT layer models none of that: it has no enrollment scanner, no path propagation (destroys them), one Y.Doc per already-enrolled note, and no delete/move semantics. Reusing it would mean building the enrollment scanner + path map *anyway*, plus untangling the loopback transport — all cost, no benefit.
2. **The worker pattern is proven and already multi-vault.** Five ingesters (Matrix, Fathom, Fireflies, …) follow the exact `runXOnce` contract: `vaultClient(id)` resolves per-vault tokens from the merged registry, `scheduler.ts tick()` gives isolation + cadence, cursors live in the settings kv store, dedup-by-source-id in metadata is the house idiom.
3. **Same-server means same trust domain.** Both vaults belong to the same owner on the same hub; the peer-pairing/mirror-accept ceremony exists to protect *against a remote peer* and is pure friction here.
4. **Live collab still works where it matters.** The mirrored copy in the Commons vault is a real note; opening it in a shared context uses the normal `${vaultId}::${noteId}` collab path. v1 is a **one-way mirror (source wins)** — matching the actual use case ("his systems write to his own folder and it propagates"). Two-way sync is future work (see below).

## Architecture

```
vault A (personal)                    PRISM SERVER                     vault B (commons)
  SFR/…  ──listNotes(pathPrefix)──▶  worker/vault-mirror.ts  ──create/update/delete──▶  FrontRange/SFR/…
                                      │  vault_mirrors table (config)
                                      │  scheduler.ts tick() (cadence) + POST /acl/mirrors/:id/sync (on demand)
                                      └  dedup: metadata.mirror_source = "<srcVault>:<srcNoteId>"
```

### Config: `vault_mirrors` table

```sql
CREATE TABLE IF NOT EXISTS vault_mirrors (
  id          TEXT PRIMARY KEY,
  src_vault   TEXT NOT NULL,   -- vault registry id
  src_prefix  TEXT NOT NULL,   -- normalized path prefix in source vault
  dest_vault  TEXT NOT NULL,
  dest_prefix TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  delete_mode TEXT NOT NULL DEFAULT 'archive',  -- 'archive' | 'delete' | 'keep'
  created_at  INTEGER NOT NULL,
  last_run_at INTEGER,
  last_result TEXT             -- JSON summary of the last run
);
```

Not a secret (unlike ingester credentials), needs listing/UI → dedicated table, owner-gated CRUD under `/acl/mirrors` (create validates both vault ids against the registry and both prefixes via `normalizePathPrefix`; self-mirror `src==dest && overlapping prefix` is rejected).

### Sync algorithm — `runMirrorOnce(mirror)`

Per run (idempotent, convergent):

1. `src = vaultClient(mirror.src_vault)`, `dst = vaultClient(mirror.dest_vault)`.
2. List **without content**: `src.listNotes({ pathPrefix: src_prefix })`, `dst.listNotes({ pathPrefix: dest_prefix })`; re-filter both with `pathInPrefix` (defense-in-depth, same as publications).
3. Index dest notes by `metadata.mirror_source` (`"<src_vault>:<src_note_id>"`). Dest notes under the prefix *without* the marker are **left alone forever** (native Commons notes can coexist inside the mirrored folder).
4. For each source note, compute `destPath = dest_prefix + "/" + relative(src.path, src_prefix)`:
   - **New** (no marker match) → `dst.createNote({ content, path: destPath, tags, metadata: { …src.metadata, mirror_source, mirror_source_updated_at } })`.
   - **Changed** (`src.updatedAt !== mirror_source_updated_at`) → fetch full source note, `dst.updateNote(id, { content, path: destPath, metadata merge })` + tag diff. Path is recomputed every run, so **moves/renames inside the prefix propagate** as a path update, folder structure intact.
   - **Unchanged** → skip (no vault write).
5. **Deletes — verified, conservative.** A marked dest note whose source id is absent from the listing is deleted **only after** a direct `src.getNote(id)` re-fetch confirms 404 (never on a listing hiccup — the Fireflies lesson). `delete_mode`: `archive` (default — move under `dest_prefix + "/_archive/"`, nothing destroyed), `delete` (hard delete), `keep` (never touch).
6. Record `{created, updated, deleted, skipped, errors}` into `last_result`; per-note try/catch so one bad note can't wedge the mirror.

**Folder semantics.** Folders are implicit in paths everywhere in this codebase (no folder objects, no folder API), so *preserving relative paths IS propagating folder structure* — the destination sidebar tree materializes the same hierarchy. Corollary: **empty folders don't exist as data anywhere** and therefore cannot sync; only folders containing at least one note propagate (documented limitation).

**Conflict policy (v1).** One-way, source-wins. An edit made directly to a mirrored copy in the dest vault survives only until the source note next changes. This matches the stated flow (Benjamin's systems write to *his* folder). Collaborators who should co-author should be pointed at the source note's collab doc, or wait for two-way (future work).

### Scheduling

`scheduler.ts tick()` gains one step after the per-vault ingester loop: `runVaultMirrorsOnce()` iterates `enabled` mirror rows (per-mirror try/catch). Mirrors are per-*pair*, not per-vault-entry, hence a separate iteration rather than a tuple in the per-vault list. On-demand: `POST /acl/mirrors/:id/sync`.

### Collaborator folder visibility (the second half of the symptom)

With the mirror in place, notes land in the Commons vault at real nested paths, so any collaborator whose grants cover them (tag / vault-level membership) gets a proper folder tree from the existing client-side derivation — nothing new needed on the read path *if* granting by tag or vault.

As a **small additive follow-up** (in scope if time allows, otherwise HANDOFF): path-prefix **grants**, so the owner can share "this folder" directly — ~3 touches: allow `resource_type='path'` grants, add `path` to `NoteRef` + populate in the gateway's `ref()`, add a `pathInPrefix` branch to `effectiveLevel`, and extend `visibleNotes` to pull `listNotes({ pathPrefix })` per path grant. The client tree then renders folders with zero client changes.

## What this does NOT change

- Two-server federation (spaces, peers, mirror handshake, CRDT bindings) — untouched, additive-only.
- Publishing, workspaces, memberships, the gateway allowlist.
- No live-vault writes anywhere in tests: the verify harness provisions throwaway scratch vaults via the same CLI path as `mode:"create"` and tears them down.

## Future work

- **Two-way sync**: share one collab doc across both copies (the `${vaultId}::${noteId}` doc-name scheme makes this plausible) or CRDT-merge at the worker layer.
- **Change feed**: Parachute has no webhook/feed; poll-and-diff is the ceiling today. Cursor on vault-level `updatedAt` would cut listing cost for big folders.
- **UI**: a "Mirror this folder…" affordance in the Network panel driving `/acl/mirrors`.

## Verification

`apps/server/scripts/verify-folder-sync.ts` (mirrors the structure of `verify-crdt-conflict.ts`: self-contained, `.env`-driven, `rec()/fail` accounting, full teardown, exit code). Proves on **scratch vaults**: nested tree appears with structure; edit propagates; move propagates; delete is verified + archived; unmarked dest notes untouched; disabled mirror is a no-op.
