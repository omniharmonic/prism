/**
 * SQLite store for identity + access control (sessions, users, magic-link
 * tokens, and grants). Lives on the home server next to the vault; holds no
 * vault data, only who-can-do-what.
 */
import Database from "better-sqlite3";
import { notifyAccessChanged } from "./access-events";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { config, vaultRegistry, type VaultEntry } from "./config";
import { isCap, levelForCaps, type Cap, type Level } from "./permissions";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

// This db holds added-vault TOKENS (plus sessions + grants). SQLite creates the
// file world-readable by default; tighten it and its WAL/SHM siblings to 0600.
// Best-effort (skips the in-memory test db; siblings may not exist yet).
if (config.dbPath !== ":memory:" && !config.dbPath.startsWith(":")) {
  for (const p of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
    try {
      chmodSync(p, 0o600);
    } catch {
      /* sibling absent or not ours — best effort */
    }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS canvas_relation_vaults (vault_id TEXT PRIMARY KEY, identity TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS canvas_assertions (
    vault_id TEXT NOT NULL, canvas_id TEXT NOT NULL, arrow_id TEXT NOT NULL,
    source_id TEXT NOT NULL, target_id TEXT NOT NULL, relationship TEXT NOT NULL,
    PRIMARY KEY(vault_id,canvas_id,arrow_id)
  );
  CREATE INDEX IF NOT EXISTS canvas_assertions_edge ON canvas_assertions(vault_id,source_id,target_id,relationship);
  CREATE TABLE IF NOT EXISTS canvas_relations (
    vault_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relationship TEXT NOT NULL,
    owned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(vault_id,source_id,target_id,relationship)
  );
  CREATE TABLE IF NOT EXISTS canvas_relation_sources (
    vault_id TEXT NOT NULL, source_id TEXT NOT NULL, updated_at TEXT,
    PRIMARY KEY(vault_id,source_id)
  );
  CREATE TABLE IF NOT EXISTS canvas_relation_jobs (
    vault_id TEXT NOT NULL, canvas_id TEXT NOT NULL, source_id TEXT NOT NULL,
    PRIMARY KEY(vault_id,canvas_id,source_id)
  );
  CREATE TABLE IF NOT EXISTS canvas_relation_receipts (
    vault_id TEXT NOT NULL, canvas_id TEXT NOT NULL, fingerprint TEXT NOT NULL, retained INTEGER NOT NULL,
    PRIMARY KEY(vault_id,canvas_id)
  );
  CREATE TABLE IF NOT EXISTS users (
    email      TEXT PRIMARY KEY,
    name       TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  CREATE TABLE IF NOT EXISTS grants (
    id            TEXT PRIMARY KEY,
    subject_type  TEXT NOT NULL,   -- 'user' | 'link' | 'anyone' | 'peer'
    subject       TEXT NOT NULL,   -- email | capability id | '*' | peer pubkey
    resource_type TEXT NOT NULL,   -- 'note' | 'tag' | 'space'
    resource      TEXT NOT NULL,   -- note id | tag name | space id
    level         TEXT NOT NULL,   -- Level
    created_by    TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS grants_subject  ON grants(subject_type, subject);
  CREATE INDEX IF NOT EXISTS grants_resource ON grants(resource_type, resource);
  CREATE TABLE IF NOT EXISTS capabilities (
    id            TEXT PRIMARY KEY,   -- capability id (also the grant subject)
    resource_type TEXT NOT NULL,
    resource      TEXT NOT NULL,
    level         TEXT NOT NULL,
    label         TEXT,
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS capabilities_resource ON capabilities(resource_type, resource);
  CREATE TABLE IF NOT EXISTS collab_docs (
    vault_id          TEXT NOT NULL DEFAULT 'primary',  -- the tenant; a note id is only unique WITHIN a vault
    name              TEXT NOT NULL,      -- note id
    state             BLOB NOT NULL,      -- Yjs encoded state (CRDT continuity)
    source_updated_at INTEGER,            -- Parachute updatedAt at last store (external-edit detection)
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (vault_id, name)
  );
  -- Live documents whose latest state is in collab_docs but NOT yet in the vault
  -- (a store that could not render or write). The Yjs state is safe; this row is
  -- the reminder to write the note later (collab.ts retries; cleared on success).
  CREATE TABLE IF NOT EXISTS collab_unsaved (
    vault_id TEXT NOT NULL DEFAULT 'primary',
    name     TEXT NOT NULL,      -- note id
    doc_name TEXT NOT NULL,      -- the collab document name it is served under
    since    INTEGER NOT NULL,
    PRIMARY KEY (vault_id, name)
  );
  CREATE TABLE IF NOT EXISTS invites (
    token_hash  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    name        TEXT,
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    accepted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS invites_email ON invites(email);

  -- ── Publishing (Horizon B) ─────────────────────────────────────────────
  -- A publication is the CONFIG for a public read-only site (slug, template,
  -- optional password). ACCESS is a separate 'anyone' grant in the grants
  -- table — config and authorization stay decoupled (effectiveLevel is still
  -- the only guard). Publish = insert this row + an anyone grant in one txn.
  CREATE TABLE IF NOT EXISTS publications (
    id            TEXT PRIMARY KEY,   -- slug (also the public URL segment)
    resource_type TEXT NOT NULL,      -- 'tag' | 'path' ('note' reserved)
    resource      TEXT NOT NULL,      -- tag name OR normalized path prefix
    template      TEXT NOT NULL,      -- 'wiki' (template registry key)
    title         TEXT,
    home_note_id  TEXT,               -- landing note; null → derive at read time
    excluded_note_ids TEXT,           -- JSON string[] of note ids to DROP from the set; null → []
    password_hash TEXT,               -- scrypt (auth/password.ts); null → open
    theme         TEXT,               -- JSON blob
    expires_at    INTEGER,            -- null → no expiry
    created_by    TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS publications_resource ON publications(resource_type, resource);
  CREATE TABLE IF NOT EXISTS publication_presentations (
    slug TEXT PRIMARY KEY, live_revision INTEGER NOT NULL, live_json TEXT NOT NULL,
    draft_revision INTEGER NOT NULL DEFAULT 0, draft_json TEXT, draft_base_revision INTEGER
  );
  CREATE TABLE IF NOT EXISTS publication_presentation_history (
    slug TEXT NOT NULL, revision INTEGER NOT NULL, presentation_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, created_by TEXT,
    PRIMARY KEY(slug,revision)
  );


  -- ── Parachute-to-Parachute collaboration (Horizon C) ───────────────────
  -- A paired peer hub, identified by its Ed25519 public key (base64url). We
  -- store only the PUBLIC key; no vault token ever crosses the boundary.
  CREATE TABLE IF NOT EXISTS peers (
    pubkey     TEXT PRIMARY KEY,   -- Ed25519 public key, base64url
    email      TEXT,
    label      TEXT,
    created_at INTEGER NOT NULL,
    paired_at  INTEGER,            -- when the handshake completed; null = pending
    collab_url TEXT                -- peer hub's /collab WS URL (for FederationManager.syncSpaces)
  );
  -- One-time pairing codes (invite.ts analog: single-use, hashed, TTL'd).
  CREATE TABLE IF NOT EXISTS peer_pairings (
    code_hash  TEXT PRIMARY KEY,
    label      TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  -- A shared space: a named, bidirectionally-synced collection scoped by
  -- tags/path. Peer membership is a grant (subject_type='peer', resource_type
  -- ='space', resource=space id).
  CREATE TABLE IF NOT EXISTS spaces (
    id                 TEXT PRIMARY KEY,
    title              TEXT,
    scope_include_tags TEXT,   -- JSON string[] (any-of)
    scope_exclude_tags TEXT,   -- JSON string[]
    path_prefix        TEXT,
    created_by         TEXT,
    created_at         INTEGER NOT NULL
  );
  -- Bidirectional note-identity map. space_note_key is a content-independent
  -- UUID minted when a note first enters a space; it is the Yjs documentName
  -- for federation so both hubs address the same CRDT despite differing local
  -- ids. kind is PINNED at join (mismatched inbound updates are rejected).
  CREATE TABLE IF NOT EXISTS federated_notes (
    space_note_key    TEXT PRIMARY KEY,
    space_id          TEXT NOT NULL,
    local_id          TEXT NOT NULL,   -- this hub's note id
    kind              TEXT NOT NULL,   -- document|code|spreadsheet|canvas
    peer_synced_at    INTEGER,
    source_updated_at INTEGER,         -- Parachute updatedAt high-water mark
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS federated_notes_space ON federated_notes(space_id);
  CREATE INDEX IF NOT EXISTS federated_notes_local ON federated_notes(local_id);
  -- Durable outbound buffer: Yjs updates queued while a peer WS is down, flushed
  -- on reconnect (Yjs is idempotent under replay).
  CREATE TABLE IF NOT EXISTS federation_outbox (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    space_note_key TEXT NOT NULL,
    peer_pubkey    TEXT NOT NULL,
    update_blob    BLOB NOT NULL,
    queued_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS federation_outbox_peer ON federation_outbox(peer_pubkey);

  -- Peer-edit audit (Phase 4.3): a row per inbound edit a federated PEER applied
  -- to one of our shared docs, so the owner can review who edited what and when.
  CREATE TABLE IF NOT EXISTS peer_edits (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    space_note_key TEXT NOT NULL,
    local_id       TEXT NOT NULL,
    peer_pubkey    TEXT NOT NULL,
    edited_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS peer_edits_time ON peer_edits(edited_at DESC);

  -- Durable pending suggestions (Horizon C, suggest-level). A suggest-level peer
  -- (or capability) does NOT merge into the live doc; its proposed change lands
  -- here for the owner to accept/reject, and MUST survive a server restart (the
  -- live collab path keeps suggestions only in memory). note_id is this hub's
  -- local note; space_note_key records the federation origin when applicable.
  CREATE TABLE IF NOT EXISTS pending_suggestions (
    id             TEXT PRIMARY KEY,
    space_note_key TEXT,
    note_id        TEXT NOT NULL,
    author         TEXT,            -- peer pubkey | email | capability id
    author_kind    TEXT,            -- 'peer' | 'user' | 'link'
    summary        TEXT,            -- short human description
    payload        TEXT NOT NULL,   -- the proposed change (Yjs update b64, or text/html)
    status         TEXT NOT NULL,   -- 'pending' | 'accepted' | 'rejected'
    created_at     INTEGER NOT NULL,
    resolved_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS pending_suggestions_note   ON pending_suggestions(note_id);
  CREATE INDEX IF NOT EXISTS pending_suggestions_status ON pending_suggestions(status);

  -- Inbound federation mirror requests (Horizon C). A paired PEER asks this hub to
  -- mirror a shared space's notes (so both hubs hold the same space_note_keys). A
  -- peer must NOT silently write into our vault, so the request lands here for the
  -- OWNER to accept/reject — accepting creates the local space + peer grant +
  -- placeholder notes + federated_notes rows. One pending row per (peer, space).
  CREATE TABLE IF NOT EXISTS federation_mirror_requests (
    id          TEXT PRIMARY KEY,
    peer_pubkey TEXT NOT NULL,
    space_id    TEXT NOT NULL,    -- the shared space id (same UUID on both hubs)
    space_title TEXT,
    payload     TEXT NOT NULL,    -- JSON [{ spaceNoteKey, kind, title? }]
    status      TEXT NOT NULL,    -- 'pending' | 'accepted' | 'rejected'
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS federation_mirror_status ON federation_mirror_requests(status);
  CREATE INDEX IF NOT EXISTS federation_mirror_peer   ON federation_mirror_requests(peer_pubkey, space_id);

  -- Owner-mutable runtime settings (kv). Currently: federation_enabled, so the
  -- owner can toggle the federation bridge from the UI without a restart. Each
  -- key falls back to its config/env default when unset.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Owner-added vaults (multi-vault: in-app create/link). The ENV-configured
  -- vaults live in config.ts (PRISM_VAULTS / PARACHUTE_*); these rows are the
  -- vaults added at runtime from the UI. Their TOKEN lives here, server-side
  -- ONLY — it is never returned to a client (GET /api/vaults omits token+url).
  CREATE TABLE IF NOT EXISTS prism_vaults (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    url        TEXT NOT NULL,
    vault      TEXT NOT NULL,
    token      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- ── Workspaces: a workspace groups one or more VAULTS + members + a subdomain
  -- (the "one server, many workspaces" model). One Node server hosts N of these;
  -- the public/serving path resolves the active workspace by Host header, and the
  -- owner admin UI selects one to manage. Backward-compatible: every vault not
  -- explicitly assigned belongs to the 'default' workspace, so a single-workspace
  -- deploy is unchanged. Membership/grants stay per-VAULT (a workspace's access is
  -- the union over its vaults).
  CREATE TABLE IF NOT EXISTS workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    hostname   TEXT,                    -- subdomain that routes here (nullable until set)
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vault_workspaces (
    vault_id     TEXT PRIMARY KEY,      -- each vault belongs to exactly ONE workspace
    workspace_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS vault_workspaces_ws ON vault_workspaces(workspace_id);

  -- ── Multi-tenancy: per-vault workspace membership (Phase 1) ──────────────
  -- A "tenant" = a vault; membership names WHO belongs to a vault and at what
  -- workspace ROLE (owner/admin/member/guest — see roles.ts). This is the source
  -- of truth for workspaceRole(email, vaultId); it sits ABOVE the per-note grants
  -- table and reconciles with the hub's own user_vaults (the token-authority
  -- layer). The env OWNER_EMAIL is owner of 'primary' even with no row (bootstrap).
  CREATE TABLE IF NOT EXISTS memberships (
    vault_id   TEXT NOT NULL,
    email      TEXT NOT NULL,
    role       TEXT NOT NULL,          -- 'owner' | 'admin' | 'member' | 'guest'
    created_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, email)
  );
  CREATE INDEX IF NOT EXISTS memberships_email ON memberships(email);

  -- ── Per-tenant integration secrets (Phase 3 server-first runtime) ────────
  -- Encrypted-at-rest credentials (Matrix/Notion/Fathom/… tokens) keyed by
  -- (vault, owner, kind). This is the multi-tenant gate: a server-side ingester
  -- or agent run reads the secret for the tenant it's acting on, never another's.
  -- ciphertext = AES-256-GCM(secret)||authTag; the master key (SECRETS_KEY) lives
  -- in the environment, NEVER in this db. See src/secrets.ts.
  CREATE TABLE IF NOT EXISTS tenant_secrets (
    vault_id    TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    kind        TEXT NOT NULL,
    ciphertext  BLOB NOT NULL,
    iv          BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (vault_id, owner_email, kind)
  );

  -- ── Member-minted MCP tokens (audit registry) ────────────────────────────
  -- One row per hub JWT a vault member minted for their agent's MCP access
  -- (routes/mcp.ts). The TOKEN ITSELF IS NEVER STORED — only its jti (for
  -- revocation via the hub) and enough context to list "who has standing
  -- agent access to which vault". revoked_at is our local mark; the hub's
  -- revocation list is the enforcement point (~60s propagation).
  CREATE TABLE IF NOT EXISTS mcp_tokens (
    jti        TEXT PRIMARY KEY,
    vault_id   TEXT NOT NULL,      -- registry vault id
    email      TEXT NOT NULL,      -- the member who minted it
    scope      TEXT NOT NULL,      -- e.g. vault:front-range-commons:write
    label      TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS mcp_tokens_vault ON mcp_tokens(vault_id);
  -- Audit of owner-run revocations of legacy member tokens (WP6.5,
  -- routes/mcp.ts). Never token material: jti + who + outcome only.
  CREATE TABLE IF NOT EXISTS mcp_token_revocations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    actor      TEXT NOT NULL,      -- the owner who ran it
    jti        TEXT NOT NULL,
    email      TEXT NOT NULL,      -- the token's minter
    vault_id   TEXT NOT NULL,
    outcome    TEXT NOT NULL,      -- revoked | failed
    notified   INTEGER NOT NULL DEFAULT 0,
    error      TEXT
  );

  -- ── Governance signature ledger (WP0.3, governance-integrity.ts) ─────────
  -- The CURRENT gov_sig of every governance note the server wrote, per vault.
  -- A signature alone proves "the server wrote this state once"; the ledger
  -- makes it "…and it is the latest state". With GOVERNANCE_SIGNING_SECRET set a
  -- note is trusted only if its sig verifies AND equals this row's sig — so a
  -- vault-history restore of an older signed state, or a deleted note recreated
  -- with its old id + sig, is rejected. sig NULL = tombstone (deleted through
  -- governance). No row = untrusted (no trust-on-first-use). Populated by the
  -- service's signed writers and by scripts/governance-sign-existing.ts.
  CREATE TABLE IF NOT EXISTS governance_sig_ledger (
    vault_id   TEXT NOT NULL,
    note_id    TEXT NOT NULL,
    sig        TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, note_id)
  );

  -- ── Vault mirrors (single-server vault-to-vault folder sync) ─────────────
  -- A mirror converges one path prefix (folder) of a source vault onto a prefix
  -- in a destination vault ON THIS SERVER — one-way, source-wins, folder
  -- structure preserved (paths rebased). This is the intra-server sibling of
  -- federation spaces: no peer, no CRDT transport, just the worker diffing two
  -- prefixes through the per-vault clients. See src/worker/vault-mirror.ts.
  CREATE TABLE IF NOT EXISTS vault_mirrors (
    id          TEXT PRIMARY KEY,
    src_vault   TEXT NOT NULL,      -- registry vault id
    src_prefix  TEXT NOT NULL,      -- normalized path prefix (paths.ts)
    dest_vault  TEXT NOT NULL,
    dest_prefix TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    delete_mode TEXT NOT NULL DEFAULT 'archive',  -- 'archive' | 'delete' | 'keep'
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    last_run_at INTEGER,
    last_result TEXT               -- JSON MirrorRunResult of the last run
  );

  -- ── Device tokens (WP2.1, auth/device.ts — native sign-in) ───────────────
  -- A revocable per-device bearer credential for native clients (Tauri laptop /
  -- iPhone). ONLY the SHA-256 of the secret is stored. It resolves to the same
  -- user actor a session for \`email\` would (identity, not a vault binding — the
  -- vault comes from X-Prism-Vault exactly as for a session). Sliding expiry:
  -- every (throttled) use pushes expires_at out, capped at max_expires_at.
  CREATE TABLE IF NOT EXISTS device_tokens (
    id             TEXT PRIMARY KEY,           -- dev_<random>, safe to show/list
    token_hash     TEXT NOT NULL UNIQUE,       -- sha256(pd_...) hex
    email          TEXT NOT NULL,
    label          TEXT,
    client_id      TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    last_seen_at   INTEGER,
    expires_at     INTEGER NOT NULL,           -- sliding (idle) expiry
    max_expires_at INTEGER NOT NULL,           -- absolute cap
    revoked_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS device_tokens_email ON device_tokens(email);

  -- Short-lived, single-use authorization codes (PKCE S256 only).
  CREATE TABLE IF NOT EXISTS device_auth_codes (
    code_hash      TEXT PRIMARY KEY,
    email          TEXT NOT NULL,
    client_id      TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    label          TEXT,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    used_at        INTEGER,
    device_id      TEXT                        -- set on redemption (replay → revoke)
  );

  -- A pending /auth/device/authorize request, held server-side while the user
  -- signs in, so the params survive the login bounce without ever travelling
  -- through a client-controlled redirect. Referenced by an httpOnly cookie.
  -- ── Durable agent sessions (Arch v2 WP3.1, agent-sessions.ts) ────────────
  -- A multi-turn \`claude\` conversation: the server uuid is ALSO the CLI session
  -- id (--session-id on turn 1, --resume after). Scoped to (vault_id, owner_email).
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id                 TEXT PRIMARY KEY,
    vault_id           TEXT NOT NULL,
    owner_email        TEXT NOT NULL,
    title              TEXT,
    profile            TEXT NOT NULL DEFAULT 'vault-rw',   -- vault-ro | vault-rw | prism-ro | prism-rw
    note_id            TEXT,                               -- open note (context on turn 1 only)
    cli_session_id     TEXT,                               -- from system/init (== id)
    status             TEXT NOT NULL DEFAULT 'idle',       -- idle | running | archived
    transcript_note_id TEXT,
    cost_usd           REAL NOT NULL DEFAULT 0,            -- CLI's cumulative session cost
    event_seq          INTEGER NOT NULL DEFAULT 0,         -- last assigned agent_events.seq (monotonic even after pruning)
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_sessions_owner ON agent_sessions(vault_id, owner_email, updated_at);
  CREATE TABLE IF NOT EXISTS agent_turns (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    prompt     TEXT NOT NULL,
    note_id    TEXT,
    status     TEXT NOT NULL,          -- queued|running|done|error|cancelled|interrupted
    pid        INTEGER,
    exit_code  INTEGER,
    error      TEXT,
    cost_usd   REAL,
    started_at INTEGER,
    ended_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS agent_turns_session ON agent_turns(session_id, started_at);
  CREATE TABLE IF NOT EXISTS agent_followups (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    version INTEGER NOT NULL DEFAULT 1,
    policy_version INTEGER NOT NULL,
    permission_mode TEXT NOT NULL,
    allow_after_failure INTEGER NOT NULL DEFAULT 0,
    turn_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(session_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS agent_followups_session ON agent_followups(session_id, status, created_at);
  -- Per-turn spend ledger (WP3.4 daily budget). Separate from agent_turns because
  -- archiving a session deletes its turn rows — the day's spend must survive that.
  CREATE TABLE IF NOT EXISTS agent_cost_log (
    turn_id     TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL,
    cost_usd    REAL NOT NULL,
    at          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_cost_log_owner ON agent_cost_log(owner_email, at);
  -- Web Push subscriptions (Arch v2 WP3.3, push.ts). One row per browser
  -- endpoint; owner-only. The payload sent to them carries ids only.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    failures   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_email ON push_subscriptions(email);
  -- APNs device tokens (WP5 iOS push, apns.ts). ONE row per native device: the
  -- row is bound to the pd_ device credential that registered it and is deleted
  -- when that device is revoked / signs out (auth/device.ts revokeDevice). The
  -- token is a routing address, not a credential, but is still never logged
  -- (only a sha256 prefix). Sends also join device_tokens, so a row whose device
  -- is revoked/expired is never delivered to even if a delete was missed.
  CREATE TABLE IF NOT EXISTS apns_tokens (
    device_id    TEXT PRIMARY KEY REFERENCES device_tokens(id) ON DELETE CASCADE,
    token        TEXT NOT NULL,              -- lowercase hex
    environment  TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    owner_email  TEXT NOT NULL,
    vault_id     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS apns_tokens_owner ON apns_tokens(owner_email);
  CREATE INDEX IF NOT EXISTS apns_tokens_token ON apns_tokens(token);
  -- Live actions audit (Arch v2 WP1.5, actions/store.ts). One row per action
  -- attempt that passed the server-owner gate. NEVER a message body, subject or
  -- plain recipient address: targets are ids (note/room/event/calendar ids) and
  -- short SHA-256 hashes. error is scrubbed + capped.
  CREATE TABLE IF NOT EXISTS action_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    actor_email     TEXT NOT NULL,
    via             TEXT NOT NULL,      -- session | device | local-token | mcp
    origin          TEXT NOT NULL,      -- human | agent
    action          TEXT NOT NULL,      -- e.g. email.send, matrix.react
    vault_id        TEXT NOT NULL,
    target          TEXT NOT NULL,      -- JSON: ids + hashes only
    idempotency_key TEXT,
    status          TEXT NOT NULL,      -- ok | failed | refused | replayed
    error           TEXT
  );
  CREATE INDEX IF NOT EXISTS action_audit_ts ON action_audit(ts);
  -- Idempotency ledger: (actor, key) → the first outcome, replayed on retry so a
  -- retried request never sends twice. request_hash binds the key to one body.
  CREATE TABLE IF NOT EXISTS action_idempotency (
    actor_email  TEXT NOT NULL,
    key          TEXT NOT NULL,
    action       TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state        TEXT NOT NULL,         -- pending | done
    http_status  INTEGER,
    response     TEXT,                  -- JSON (never a body/address)
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (actor_email, key)
  );
  -- Normalized AgentEvents (never text_delta — those are coalesced into text).
  CREATE TABLE IF NOT EXISTS agent_events (
    session_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    turn_id    TEXT NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,          -- JSON AgentEvent
    at         INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE IF NOT EXISTS device_auth_requests (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state          TEXT,
    label          TEXT,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL
  );
`);

// ── Prism MCP personal access tokens (WP6.1, auth/pat.ts) ────────────────────
// Bearer credentials for agents calling the Prism MCP endpoint (/mcp). ONLY the
// SHA-256 of the `pp_…` secret is stored. Each PAT is bound to ONE vault and
// resolves to its owner's ordinary user actor (role + grants recomputed per
// request), capped by `scope` (read → read-only tools only). Accepted on the MCP
// endpoint only — never as a general web credential. Row access lives in pat.ts.
db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_pats (
    id           TEXT PRIMARY KEY,             -- pat_<random>, safe to show/list
    token_hash   TEXT NOT NULL UNIQUE,         -- sha256(pp_...) hex
    prefix       TEXT NOT NULL,                -- first chars of the token, for recognition in lists
    email        TEXT NOT NULL,                -- the subject (account) the PAT acts as
    vault_id     TEXT NOT NULL,                -- registry vault id the PAT is bound to
    scope        TEXT NOT NULL,                -- 'read' | 'write'
    label        TEXT,
    device_id    TEXT,                         -- native device that minted it (dies with the device)
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at   INTEGER NOT NULL,
    revoked_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS mcp_pats_email ON mcp_pats(email);
`);

// ── Folder / database sync configs (Client parity B, worker/sync-store.ts) ────
// The server ports of the desktop's GitHub folder sync (github-sync-configs.json)
// and Notion DATABASE sync (notion-sync-configs.json). No credential lives here:
// pushes use the vault's stored `github` / `notion` secret (tenant_secrets).
// sync_audit has one row per outbound write batch (and per config change): ids,
// repo/database names, counts and a scrubbed error — never note content.
db.exec(`
  CREATE TABLE IF NOT EXISTS github_sync_configs (
    id                TEXT PRIMARY KEY,
    vault_id          TEXT NOT NULL,
    vault_path        TEXT NOT NULL,
    owner             TEXT NOT NULL,
    repo              TEXT NOT NULL,
    branch            TEXT NOT NULL,
    file_extension    TEXT NOT NULL DEFAULT '.md',
    commit_strategy   TEXT NOT NULL,            -- per_save | batched | manual
    conflict_strategy TEXT NOT NULL,            -- local-wins | remote-wins
    auto_sync         INTEGER NOT NULL DEFAULT 0,
    allow_public      INTEGER NOT NULL DEFAULT 0, -- auto-sync into a PUBLIC repo needs this explicit opt-in
    repo_private      INTEGER,                  -- last seen visibility (1/0), null = unknown
    id_map            TEXT NOT NULL DEFAULT '{}', -- note id -> repo path
    blob_map          TEXT NOT NULL DEFAULT '{}', -- repo path -> blob sha Prism last wrote/saw
    last_synced       TEXT NOT NULL DEFAULT '',
    last_result       TEXT,                     -- JSON counts of the last push
    last_error        TEXT,
    imported_from     TEXT,                     -- desktop config id (import)
    created_by        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS github_sync_configs_vault ON github_sync_configs(vault_id);
  CREATE UNIQUE INDEX IF NOT EXISTS github_sync_configs_target ON github_sync_configs(vault_id, vault_path, owner, repo, branch);
  CREATE TABLE IF NOT EXISTS notion_db_sync_configs (
    id                TEXT PRIMARY KEY,
    vault_id          TEXT NOT NULL,
    database_id       TEXT NOT NULL,
    database_name     TEXT NOT NULL,
    parachute_tag     TEXT NOT NULL,
    path_prefix       TEXT NOT NULL,
    property_map      TEXT NOT NULL DEFAULT '[]',
    title_property    TEXT NOT NULL,
    content_property  TEXT,
    sync_direction    TEXT NOT NULL,            -- bidirectional | pull | push
    conflict_strategy TEXT NOT NULL,            -- notion-wins | parachute-wins | newer-wins
    auto_sync         INTEGER NOT NULL DEFAULT 0,
    id_map            TEXT NOT NULL DEFAULT '{}', -- notion page id -> note id
    last_synced       TEXT NOT NULL DEFAULT '',
    last_result       TEXT,
    last_error        TEXT,
    created_by        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notion_db_sync_configs_vault ON notion_db_sync_configs(vault_id);
  CREATE TABLE IF NOT EXISTS sync_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    actor      TEXT NOT NULL,                   -- email, or "auto-sync" / "worker"
    vault_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,                   -- github | notion-db
    config_id  TEXT,
    action     TEXT NOT NULL,                   -- init | push | push-file | auto-push | sync | import | update | remove
    target     TEXT NOT NULL,                   -- owner/repo@branch | notion database id
    status     TEXT NOT NULL,                   -- ok | noop | failed
    detail     TEXT,                            -- JSON counts / commit sha (never content)
    error      TEXT
  );
  CREATE INDEX IF NOT EXISTS sync_audit_ts ON sync_audit(ts);
`);

// Additive agent policy migration: old sessions retain their original profile.
for (const [table, fields] of Object.entries({
  agent_sessions: { permission_mode: "TEXT", policy_version: "INTEGER NOT NULL DEFAULT 1", pending_mode: "TEXT", request_id: "TEXT", request_hash: "TEXT" },
  agent_turns: { permission_mode: "TEXT", policy_version: "INTEGER", profile: "TEXT", request_id: "TEXT", request_hash: "TEXT", request_ready: "INTEGER NOT NULL DEFAULT 0", context_json: "TEXT NOT NULL DEFAULT '[]'" },
  // What vault content a collab snapshot is built on (see "collab doc state" below).
  collab_docs: { base_hash: "TEXT", ahead: "INTEGER NOT NULL DEFAULT 0", base_state: "BLOB", attempts: "TEXT", attempt_state: "BLOB" },
  collab_unsaved: { reason: "TEXT", permanent: "INTEGER NOT NULL DEFAULT 0", attempts: "INTEGER NOT NULL DEFAULT 0", last_attempt: "INTEGER", next_attempt: "INTEGER NOT NULL DEFAULT 0" },
})) {
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of Object.entries(fields)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS agent_session_request ON agent_sessions(vault_id, owner_email, request_id) WHERE request_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS agent_turn_request ON agent_turns(session_id, request_id) WHERE request_id IS NOT NULL;
`);
db.exec(`CREATE TABLE IF NOT EXISTS agent_policy_audit (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, actor TEXT NOT NULL,
  from_mode TEXT NOT NULL, to_mode TEXT NOT NULL, policy_version INTEGER NOT NULL,
  state TEXT NOT NULL, at INTEGER NOT NULL
)`);

// Migration: accounts now carry a password (CREATE TABLE will not alter old databases).
{
  const cols = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "password_hash")) {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
  }
  // Migration: accounts gained a profile avatar (a small data: URL, bounded at
  // the API). Used to identify a person on their comments/cursors/edits.
  if (!cols.some((c) => c.name === "avatar")) {
    db.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
  }
}

// Migration (WP2.1 L3): an MCP token minted while authenticated by a native
// device token records that device, so revoking the device revokes it too.
{
  const cols = db.prepare("PRAGMA table_info(mcp_tokens)").all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "device_id")) {
    db.exec("ALTER TABLE mcp_tokens ADD COLUMN device_id TEXT");
  }
}

// Migration: peers gained a collab_url (the peer hub's /collab WS URL) so the
// FederationManager can self-discover endpoints instead of taking them from the
// caller. Add the column to an older db.
{
  const cols = db.prepare("PRAGMA table_info(peers)").all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "collab_url")) {
    db.exec("ALTER TABLE peers ADD COLUMN collab_url TEXT");
  }
}

// Migration: publications gained per-site "tending" controls — a list of note
// ids to DROP from the public set even though they match the tag/path. Add the
// column to an older db (CREATE TABLE IF NOT EXISTS won't alter an existing one).
{
  const cols = db.prepare("PRAGMA table_info(publications)").all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "excluded_note_ids")) {
    db.exec("ALTER TABLE publications ADD COLUMN excluded_note_ids TEXT");
  }
}

// ── Multi-tenancy migration (Phase 1): vault_id across every access-control,
// collab, and federation table. Additive with DEFAULT 'primary' — every existing
// row belongs to the env primary vault, so a single-vault deploy is byte-identical
// after the migration. (CREATE TABLE IF NOT EXISTS won't alter an existing table.)
// `collab_docs` also needs its PRIMARY KEY widened from (name) to (vault_id, name)
// since a note id is only unique WITHIN a vault — that PK rebuild is a separate,
// carefully-guarded step (see below); here we just add the column.
for (const table of [
  "grants",
  "capabilities",
  "publications",
  "spaces",
  "federated_notes",
  "collab_docs",
  "pending_suggestions",
  "federation_mirror_requests",
  "federation_outbox",
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "vault_id")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'primary'`);
  }
}
// Composite indexes so per-vault grant lookups stay fast (the hot path: load a
// subject's grants within the active vault).
db.exec(`
  CREATE INDEX IF NOT EXISTS grants_vault_subject  ON grants(vault_id, subject_type, subject);
  CREATE INDEX IF NOT EXISTS grants_vault_resource ON grants(vault_id, resource_type, resource);
`);

// TTL / expiry on grants (Phase 4.3): a nullable epoch-ms deadline. NULL = never
// expires (every existing grant → byte-identical behavior). Today only PEER
// grants honor it (time-boxed federation access); grantsForPeer filters expired.
{
  const cols = db.prepare(`PRAGMA table_info(grants)`).all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "expires_at")) {
    db.exec(`ALTER TABLE grants ADD COLUMN expires_at INTEGER`);
  }
}

// Capability list on grants (P1): a nullable JSON array of Cap names. NULL — the
// value every existing row keeps — means "derive the caps from `level`", so the
// whole pre-caps corpus of grants behaves byte-identically. A non-null list is
// authoritative for the caps path, and the row's `level` is kept coherent with
// it by upsertGrant/addGrant (level = levelForCaps(caps)).
{
  const cols = db.prepare(`PRAGMA table_info(grants)`).all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "caps")) {
    db.exec(`ALTER TABLE grants ADD COLUMN caps TEXT`);
  }
}

// `collab_docs` PRIMARY KEY rebuild: (name) → (vault_id, name). SQLite can't
// alter a PK in place, so copy-then-swap inside a transaction — the one
// non-additive migration. Version-gated (runs once) and a no-op when the table
// is already composite (fresh DBs get the composite PK from CREATE TABLE above).
// Existing rows carry vault_id='primary' from the ADD COLUMN default, so a
// single-vault deploy keeps every doc's CRDT state byte-for-byte.
{
  // Self-contained settings I/O — this runs at module load, BEFORE the shared
  // getSetting/setSetting prepared statements below are initialized.
  const flag = (db.prepare("SELECT value FROM settings WHERE key = ?").get("collab_docs_pk_v2") as { value: string } | undefined)?.value;
  if (flag !== "done") {
    const cols = db.prepare(`PRAGMA table_info(collab_docs)`).all() as Array<{ name: string; pk: number }>;
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    const alreadyComposite = pkCols.length === 2 && pkCols.includes("vault_id") && pkCols.includes("name");
    if (cols.length && !alreadyComposite) {
      const rebuild = db.transaction(() => {
        db.exec(`CREATE TABLE collab_docs_v2 (
          vault_id          TEXT NOT NULL DEFAULT 'primary',
          name              TEXT NOT NULL,
          state             BLOB NOT NULL,
          source_updated_at INTEGER,
          updated_at        INTEGER NOT NULL,
          PRIMARY KEY (vault_id, name)
        )`);
        db.exec(`INSERT INTO collab_docs_v2 (vault_id, name, state, source_updated_at, updated_at)
                 SELECT COALESCE(vault_id, 'primary'), name, state, source_updated_at, updated_at FROM collab_docs`);
        db.exec(`DROP TABLE collab_docs`);
        db.exec(`ALTER TABLE collab_docs_v2 RENAME TO collab_docs`);
      });
      rebuild();
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("collab_docs_pk_v2", "done");
  }
}
db.exec(`CREATE INDEX IF NOT EXISTS collab_docs_vault ON collab_docs(vault_id, name);`);

// Human collaboration command receipts (suggest-only enforcement, human-collab.ts).
// One row per (vault, note, actor, request id): the idempotency ledger for
// POST /api/collab/:id/commands. It lives HERE, not in the Y.Doc, because a
// document's Yjs state is rebuilt from the note on an external-edit reseed and
// would drop any receipt root — a retried request would then apply twice.
//   state = 'applied'  the change is in the IN-MEMORY document only; written in
//                      the same synchronous section as the Yjs mutation.
//           'durable'  the document state containing it was persisted (snapshot
//                      + vault); flipped in the same transaction as that store.
// An 'applied' row never outlives the in-memory document it describes: loading
// THAT document (same `doc_name`) drops them (the change was lost with the old
// instance), so a retry re-applies instead of claiming a change that never
// reached storage. Unconfirmed rows are scoped by `doc_name`, not by note: a
// federated note can be open under its space key and under its bare id at once,
// and one instance's load/store must not drop or confirm the other's commands.
const COLLAB_RECEIPTS_DDL = `
  CREATE TABLE IF NOT EXISTS collab_command_receipts (
    vault_id      TEXT NOT NULL,
    note_id       TEXT NOT NULL,
    doc_name      TEXT NOT NULL,          -- the collab document it was applied to (note id, vault::id, or a space key)
    actor         TEXT NOT NULL,          -- server-derived: user:<email> | capability:<id>
    request_id    TEXT NOT NULL,          -- client uuid
    command_hash  TEXT NOT NULL,          -- sha256 of the canonical command body
    kind          TEXT NOT NULL,
    result        TEXT NOT NULL,          -- JSON HumanCollabResult (ids only, no content)
    state         TEXT NOT NULL,          -- applied | durable
    created_at    INTEGER NOT NULL,
    durable_at    INTEGER,
    body_bytes    INTEGER NOT NULL DEFAULT 0, -- rendered-body growth this command caused (per-actor budget)
    comment_bytes INTEGER NOT NULL DEFAULT 0, -- comment data it added (per-actor budget)
    PRIMARY KEY (vault_id, note_id, actor, request_id)
  );
  CREATE INDEX IF NOT EXISTS collab_command_receipts_doc ON collab_command_receipts(doc_name, state);
  CREATE INDEX IF NOT EXISTS collab_command_receipts_age ON collab_command_receipts(created_at);
  CREATE INDEX IF NOT EXISTS collab_command_receipts_actor ON collab_command_receipts(vault_id, note_id, actor, created_at);
`;
/**
 * Create / migrate the receipts table. Receipts live at most ~24 h and an
 * upgrade restarts the server (every in-memory document is reloaded, which
 * forgets unconfirmed receipts anyway), so an older shape — the first two
 * pre-release commits had no `doc_name`, then no byte columns, and an index on
 * (vault_id, note_id, state) — is DROPPED and recreated rather than altered.
 * Losing a durable receipt cannot cause a second application: a command can
 * only apply when the document revision equals the one it was prepared
 * against, which its own effect changed. Exported for the migration test.
 */
export function migrateCollabReceipts(d: Database.Database): "created" | "current" | "recreated" {
  const cols = new Set((d.prepare("PRAGMA table_info(collab_command_receipts)").all() as Array<{ name: string }>).map((c) => c.name));
  if (cols.size === 0) {
    d.exec(COLLAB_RECEIPTS_DDL);
    return "created";
  }
  const want = ["doc_name", "body_bytes", "comment_bytes"];
  if (want.every((c) => cols.has(c))) {
    d.exec(COLLAB_RECEIPTS_DDL); // indexes are IF NOT EXISTS
    return "current";
  }
  d.transaction(() => {
    d.exec("DROP TABLE collab_command_receipts"); // drops its indexes with it
    d.exec(COLLAB_RECEIPTS_DDL);
  })();
  return "recreated";
}
migrateCollabReceipts(db);

// ── Runtime settings (owner-mutable kv) ──────────────────────────────────────
const selectSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSetting = db.prepare(
  "INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value=@value",
);
function getSetting(key: string): string | null {
  return (selectSetting.get(key) as { value: string } | undefined)?.value ?? null;
}
function setSetting(key: string, value: string): void {
  upsertSetting.run({ key, value });
}

// Worker cursors (Phase 3): the incremental-sync resume token per (vault, kind),
// e.g. the Matrix /sync next_batch. Persisted in `settings` so a restart resumes.
export function getWorkerCursor(vaultId: string, kind: string): string | null {
  return getSetting(`cursor:${kind}:${vaultId}`);
}
export function setWorkerCursor(vaultId: string, kind: string, cursor: string): void {
  setSetting(`cursor:${kind}:${vaultId}`, cursor);
}

/** Interactive AI routing (parity A, local-ai.ts): raw JSON, validated by the caller. */
export function getAgentRoutingSetting(): string | null {
  return getSetting("agent-routing");
}
export function setAgentRoutingSetting(json: string): void {
  setSetting("agent-routing", json);
}

/**
 * Federation enablement is runtime-mutable so the owner can flip the bridge from
 * the UI (no .env edit / restart). Persisted in `settings`, defaulting to the
 * `FEDERATION_ENABLED` env flag when never set. Read straight from the row each
 * call (a 1-row prepared SELECT — the gate is per connection/action, not a hot
 * loop), so a toggle takes effect immediately and tests stay isolated (resetDb
 * clears the row → the env default returns). All the old `config.federationEnabled`
 * gates now call `getFederationEnabled()`.
 */
export function getFederationEnabled(): boolean {
  const stored = getSetting("federation_enabled");
  return stored === null ? config.federationEnabled : stored === "true";
}
export function setFederationEnabled(enabled: boolean): void {
  setSetting("federation_enabled", enabled ? "true" : "false");
}

// ── Added vaults (runtime registry; owner-managed via /acl/vaults) ───────────
// The ENV base (config.vaultRegistry) is immutable boot config; these rows are
// vaults the owner created/linked from the UI. Tokens are stored here and NEVER
// serialized to a client.
const insertVaultEntry = db.prepare(
  `INSERT INTO prism_vaults (id, label, url, vault, token, created_at)
   VALUES (@id, @label, @url, @vault, @token, @created_at)`,
);
const selectVaultEntries = db.prepare("SELECT * FROM prism_vaults ORDER BY created_at ASC");
const selectVaultEntry = db.prepare("SELECT * FROM prism_vaults WHERE id = ?");
const deleteVaultEntryStmt = db.prepare("DELETE FROM prism_vaults WHERE id = ?");
const updateVaultEntryTokenStmt = db.prepare("UPDATE prism_vaults SET token = ? WHERE id = ?");

const stripVaultRow = (r: VaultEntry & { created_at?: number }): VaultEntry => ({
  id: r.id,
  label: r.label,
  url: r.url,
  vault: r.vault,
  token: r.token,
});

export function addVaultEntry(e: VaultEntry): VaultEntry {
  insertVaultEntry.run({ ...e, created_at: Date.now() });
  return e;
}
export function listVaultEntries(): VaultEntry[] {
  return (selectVaultEntries.all() as Array<VaultEntry & { created_at: number }>).map(stripVaultRow);
}
export function getVaultEntry(id: string): VaultEntry | null {
  const row = selectVaultEntry.get(id) as (VaultEntry & { created_at: number }) | undefined;
  return row ? stripVaultRow(row) : null;
}
/** Replace an owner-ADDED vault's token (rotation). Env vaults aren't in this
 *  table, so this returns false for them. Never returns the token. */
export function updateVaultEntryToken(id: string, token: string): boolean {
  return updateVaultEntryTokenStmt.run(token, id).changes > 0;
}
export function removeVaultEntry(id: string): void {
  db.transaction(() => {
    deleteVaultEntryStmt.run(id);
    for (const table of ["canvas_assertions", "canvas_relations", "canvas_relation_sources", "canvas_relation_jobs", "canvas_relation_receipts", "canvas_relation_vaults"]) {
      db.prepare(`DELETE FROM ${table} WHERE vault_id=?`).run(id);
    }
  })();
}

/**
 * The full vault registry: the ENV base (config.vaultRegistry) followed by the
 * owner-added vaults from SQLite, deduped by id with the ENV entries WINNING
 * (so the env primary[0] always stays primary/active). This is the authoritative
 * registry read by GET /api/vaults and the owner passthrough.
 */
export function getVaultRegistry(): VaultEntry[] {
  const merged: VaultEntry[] = [...vaultRegistry];
  const seen = new Set(merged.map((v) => v.id));
  for (const e of listVaultEntries()) {
    if (seen.has(e.id)) continue; // env wins
    seen.add(e.id);
    merged.push(e);
  }
  return merged;
}

/**
 * Resolve a vault id against the MERGED registry. Unknown/absent id → the
 * primary (first env entry), so a stale/bogus `X-Prism-Vault` header degrades to
 * the default vault rather than erroring. Lives here (not config.ts) so it can
 * see db-added vaults without a config↔db import cycle.
 */
export function resolveVaultEntry(id?: string | null): VaultEntry {
  if (id) {
    const found = getVaultRegistry().find((v) => v.id === id);
    if (found) return found;
  }
  return vaultRegistry[0]!;
}

// ── Member-minted MCP tokens (audit registry) ────────────────────────────────
export interface McpTokenRow {
  jti: string;
  vault_id: string;
  email: string;
  scope: string;
  label: string | null;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
  /** The native device (device_tokens.id) whose token minted this, if any. */
  device_id?: string | null;
}

const insertMcpToken = db.prepare(
  `INSERT INTO mcp_tokens (jti, vault_id, email, scope, label, expires_at, created_at, device_id)
   VALUES (@jti, @vault_id, @email, @scope, @label, @expires_at, @created_at, @device_id)`,
);
const selectMcpTokensForVault = db.prepare("SELECT * FROM mcp_tokens WHERE vault_id = ? ORDER BY created_at DESC");
const selectMcpToken = db.prepare("SELECT * FROM mcp_tokens WHERE jti = ?");
const markMcpTokenRevoked = db.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE jti = ?");

export function recordMcpToken(row: Omit<McpTokenRow, "created_at" | "revoked_at"> & { label?: string | null }): void {
  // `label` is normalized explicitly rather than by spread-over-default: with
  // `{ label: null, ...row }` an optional property present-but-undefined wins the
  // spread and better-sqlite3 throws on binding undefined (and TS flags TS2783).
  insertMcpToken.run({ ...row, label: row.label ?? null, device_id: row.device_id ?? null, created_at: Date.now() });
}
/** Unrevoked MCP tokens minted through a given native device. */
export function liveMcpTokensForDevice(deviceId: string): McpTokenRow[] {
  return db.prepare("SELECT * FROM mcp_tokens WHERE device_id = ? AND revoked_at IS NULL").all(deviceId) as McpTokenRow[];
}
export function listMcpTokens(vaultId: string): McpTokenRow[] {
  return selectMcpTokensForVault.all(vaultId) as McpTokenRow[];
}
export function getMcpToken(jti: string): McpTokenRow | null {
  return (selectMcpToken.get(jti) as McpTokenRow | undefined) ?? null;
}
export function setMcpTokenRevoked(jti: string): void {
  markMcpTokenRevoked.run(Date.now(), jti);
}
/** Every unrevoked, unexpired member whole-vault token across all vaults (WP6.5). */
export function listActiveMcpTokens(now = Date.now()): McpTokenRow[] {
  return db.prepare("SELECT * FROM mcp_tokens WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(now) as McpTokenRow[];
}
export function recordMcpTokenRevocation(r: { actor: string; jti: string; email: string; vault_id: string; outcome: "revoked" | "failed"; notified: boolean; error?: string | null }): void {
  db.prepare("INSERT INTO mcp_token_revocations (ts, actor, jti, email, vault_id, outcome, notified, error) VALUES (?,?,?,?,?,?,?,?)").run(
    Date.now(), r.actor, r.jti, r.email, r.vault_id, r.outcome, r.notified ? 1 : 0, r.error ?? null,
  );
}
export function markMcpRevocationNotified(jti: string): void {
  db.prepare("UPDATE mcp_token_revocations SET notified = 1 WHERE jti = ? AND outcome = 'revoked'").run(jti);
}
export function listMcpTokenRevocations(limit = 200): Array<{ ts: number; actor: string; jti: string; email: string; vault_id: string; outcome: string; notified: number; error: string | null }> {
  return db.prepare("SELECT ts, actor, jti, email, vault_id, outcome, notified, error FROM mcp_token_revocations ORDER BY id DESC LIMIT ?").all(limit) as never;
}

// ── Governance signature ledger (WP0.3) ──────────────────────────────────────
const upsertGovSig = db.prepare(
  `INSERT INTO governance_sig_ledger (vault_id, note_id, sig, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(vault_id, note_id) DO UPDATE SET sig = excluded.sig, updated_at = excluded.updated_at`,
);
const selectGovSig = db.prepare("SELECT sig FROM governance_sig_ledger WHERE vault_id = ? AND note_id = ?");

/** Record a governance note's CURRENT signature, or a tombstone (`null`) on delete. */
export function setLedgerSig(vaultId: string, noteId: string, sig: string | null): void {
  upsertGovSig.run(vaultId, noteId, sig, Date.now());
}
/** `undefined` = no row; `null` = tombstone; string = the current signature. */
export function getLedgerSig(vaultId: string, noteId: string): string | null | undefined {
  const row = selectGovSig.get(vaultId, noteId) as { sig: string | null } | undefined;
  return row ? row.sig : undefined;
}

// ── Vault mirrors (single-server vault-to-vault folder sync) ─────────────────
export type MirrorDeleteMode = "archive" | "delete" | "keep";

export interface VaultMirror {
  id: string;
  src_vault: string;
  src_prefix: string;
  dest_vault: string;
  dest_prefix: string;
  enabled: boolean;
  delete_mode: MirrorDeleteMode;
  created_by: string | null;
  created_at: number;
  last_run_at: number | null;
  last_result: string | null;
}

const insertMirror = db.prepare(
  `INSERT INTO vault_mirrors (id, src_vault, src_prefix, dest_vault, dest_prefix, enabled, delete_mode, created_by, created_at)
   VALUES (@id, @src_vault, @src_prefix, @dest_vault, @dest_prefix, @enabled, @delete_mode, @created_by, @created_at)`,
);
const selectMirrors = db.prepare("SELECT * FROM vault_mirrors ORDER BY created_at ASC");
const selectMirror = db.prepare("SELECT * FROM vault_mirrors WHERE id = ?");
const updateMirrorStmt = db.prepare("UPDATE vault_mirrors SET enabled = @enabled, delete_mode = @delete_mode WHERE id = @id");
const deleteMirrorStmt = db.prepare("DELETE FROM vault_mirrors WHERE id = ?");
const recordMirrorRunStmt = db.prepare("UPDATE vault_mirrors SET last_run_at = @at, last_result = @result WHERE id = @id");

type MirrorRow = Omit<VaultMirror, "enabled"> & { enabled: number };
const mirrorFromRow = (r: MirrorRow): VaultMirror => ({ ...r, enabled: !!r.enabled });

export function createVaultMirror(m: {
  src_vault: string;
  src_prefix: string;
  dest_vault: string;
  dest_prefix: string;
  delete_mode?: MirrorDeleteMode;
  created_by?: string | null;
}): VaultMirror {
  const id = randomUUID();
  insertMirror.run({
    id,
    src_vault: m.src_vault,
    src_prefix: m.src_prefix,
    dest_vault: m.dest_vault,
    dest_prefix: m.dest_prefix,
    enabled: 1,
    delete_mode: m.delete_mode ?? "archive",
    created_by: m.created_by ?? null,
    created_at: Date.now(),
  });
  return getVaultMirror(id)!;
}
export function listVaultMirrors(): VaultMirror[] {
  return (selectMirrors.all() as MirrorRow[]).map(mirrorFromRow);
}
export function getVaultMirror(id: string): VaultMirror | null {
  const row = selectMirror.get(id) as MirrorRow | undefined;
  return row ? mirrorFromRow(row) : null;
}
export function updateVaultMirror(id: string, patch: { enabled?: boolean; delete_mode?: MirrorDeleteMode }): VaultMirror | null {
  const cur = getVaultMirror(id);
  if (!cur) return null;
  updateMirrorStmt.run({
    id,
    enabled: (patch.enabled ?? cur.enabled) ? 1 : 0,
    delete_mode: patch.delete_mode ?? cur.delete_mode,
  });
  return getVaultMirror(id);
}
export function removeVaultMirror(id: string): void {
  deleteMirrorStmt.run(id);
}
const deleteMirrorsForVaultStmt = db.prepare("DELETE FROM vault_mirrors WHERE src_vault = ? OR dest_vault = ?");
/** Drop every mirror referencing a vault (called when the vault leaves the
 *  registry). CRITICAL: an orphaned mirror would silently retarget the PRIMARY
 *  vault via resolveVaultEntry's fallback — its delete-verify would then 404 on
 *  every copy and mass-archive/delete the destination. Returns rows removed. */
export function removeVaultMirrorsForVault(vaultId: string): number {
  return deleteMirrorsForVaultStmt.run(vaultId, vaultId).changes;
}
export function recordMirrorRun(id: string, result: unknown): void {
  recordMirrorRunStmt.run({ id, at: Date.now(), result: JSON.stringify(result) });
}

// ── Workspaces (one server, many workspaces) ─────────────────────────────────
/** The id of the implicit default workspace: every vault not explicitly assigned
 *  belongs to it, so a single-workspace deploy is unchanged. */
export const DEFAULT_WORKSPACE_ID = "default";

export interface WorkspaceRow {
  id: string;
  name: string;
  hostname: string | null;
  created_at: number;
}

const insertWorkspace = db.prepare(
  `INSERT INTO workspaces (id, name, hostname, created_at) VALUES (@id, @name, @hostname, @created_at)
   ON CONFLICT(id) DO UPDATE SET name = @name, hostname = @hostname`,
);
const selectWorkspaces = db.prepare("SELECT id, name, hostname, created_at FROM workspaces ORDER BY created_at ASC");
const selectWorkspace = db.prepare("SELECT id, name, hostname, created_at FROM workspaces WHERE id = ?");
const selectWorkspaceByHost = db.prepare("SELECT id, name, hostname, created_at FROM workspaces WHERE hostname = ? COLLATE NOCASE");
const deleteWorkspaceStmt = db.prepare("DELETE FROM workspaces WHERE id = ?");
const upsertVaultWorkspace = db.prepare(
  `INSERT INTO vault_workspaces (vault_id, workspace_id) VALUES (?, ?)
   ON CONFLICT(vault_id) DO UPDATE SET workspace_id = excluded.workspace_id`,
);
const selectVaultWorkspace = db.prepare("SELECT workspace_id FROM vault_workspaces WHERE vault_id = ?");
const selectVaultsForWorkspace = db.prepare("SELECT vault_id FROM vault_workspaces WHERE workspace_id = ?");
const deleteVaultWorkspacesFor = db.prepare("DELETE FROM vault_workspaces WHERE workspace_id = ?");

/** Ensure the implicit default workspace exists (idempotent, run at boot). */
export function ensureDefaultWorkspace(): void {
  if (!selectWorkspace.get(DEFAULT_WORKSPACE_ID)) {
    insertWorkspace.run({ id: DEFAULT_WORKSPACE_ID, name: "Default", hostname: null, created_at: now() });
  }
}

export function listWorkspaces(): WorkspaceRow[] {
  return selectWorkspaces.all() as WorkspaceRow[];
}
export function getWorkspace(id: string): WorkspaceRow | null {
  return (selectWorkspace.get(id) as WorkspaceRow | undefined) ?? null;
}
export function createWorkspace(w: { id: string; name: string; hostname?: string | null }): WorkspaceRow {
  insertWorkspace.run({ id: w.id, name: w.name, hostname: w.hostname ?? null, created_at: now() });
  return getWorkspace(w.id)!;
}
export function updateWorkspace(id: string, patch: { name?: string; hostname?: string | null }): void {
  const cur = getWorkspace(id);
  if (!cur) return;
  insertWorkspace.run({
    id,
    name: patch.name ?? cur.name,
    hostname: patch.hostname !== undefined ? patch.hostname : cur.hostname,
    created_at: cur.created_at,
  });
}
export function deleteWorkspace(id: string): void {
  if (id === DEFAULT_WORKSPACE_ID) return; // the default workspace is permanent
  deleteVaultWorkspacesFor.run(id); // its vaults fall back to 'default'
  deleteWorkspaceStmt.run(id);
}

/** Which workspace a vault belongs to (unassigned → the default workspace). */
export function workspaceForVault(vaultId: string): string {
  const row = selectVaultWorkspace.get(vaultId) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? DEFAULT_WORKSPACE_ID;
}
/** Vault ids explicitly assigned to a workspace, PLUS (for the default workspace)
 *  every registry vault with no explicit assignment. */
export function vaultsForWorkspace(workspaceId: string): string[] {
  const explicit = (selectVaultsForWorkspace.all(workspaceId) as Array<{ vault_id: string }>).map((r) => r.vault_id);
  if (workspaceId !== DEFAULT_WORKSPACE_ID) return explicit;
  const assigned = new Set((db.prepare("SELECT vault_id FROM vault_workspaces").all() as Array<{ vault_id: string }>).map((r) => r.vault_id));
  const unassigned = getVaultRegistry().map((v) => v.id).filter((id) => !assigned.has(id));
  return [...new Set([...explicit, ...unassigned])];
}
export function assignVaultToWorkspace(vaultId: string, workspaceId: string): void {
  upsertVaultWorkspace.run(vaultId, workspaceId);
}
/** Resolve a workspace by the request Host header's hostname (exact match on the
 *  configured subdomain). Null when no workspace claims that host. */
export function workspaceForHostname(hostname: string): WorkspaceRow | null {
  if (!hostname) return null;
  return (selectWorkspaceByHost.get(hostname) as WorkspaceRow | undefined) ?? null;
}

/**
 * Resolve the ACTIVE workspace for a request. Order: an explicit
 * `X-Prism-Workspace` header (the owner's admin switcher) wins; else the request
 * Host's subdomain matched against a workspace's configured hostname (how a
 * subdomain serves its own workspace); else the default workspace. Unknown
 * ids/hosts degrade to 'default', so the pre-workspace behavior is unchanged.
 */
export function resolveWorkspaceId(opts: { workspaceHeader?: string | null; hostHeader?: string | null }): string {
  const wh = opts.workspaceHeader?.trim();
  if (wh && getWorkspace(wh)) return wh;
  const host = (opts.hostHeader ?? "").split(":")[0]!.trim().toLowerCase();
  if (host) {
    const w = workspaceForHostname(host);
    if (w) return w.id;
  }
  return DEFAULT_WORKSPACE_ID;
}
// NOTE: ensureDefaultWorkspace() is invoked at the END of this module (after the
// `now` helper it uses is initialized) — a module-load call here would hit a
// temporal-dead-zone ReferenceError on `now`.

export type SubjectType = "user" | "link" | "anyone" | "peer";
// "path" is used ONLY as a publication's resource_type (publish-by-directory);
// it is never a grant resource_type (path publications are guarded by the
// path-membership predicate, not by grants — see routes/publish.ts).
// "vault" is a whole-workspace grant (resource = the vault_id): broad access to
// every note in the vault, distinct from the management RIGHTS a role confers.
export type ResourceType = "note" | "tag" | "space" | "path" | "vault" | "page";

export interface Grant {
  id: string;
  /** The vault (tenant) this grant belongs to. Defaults to 'primary' so a
   *  single-vault deploy is unchanged; multi-tenant callers pass the active vault. */
  vault_id: string;
  subject_type: SubjectType;
  subject: string;
  resource_type: ResourceType;
  resource: string;
  level: Level;
  created_by: string | null;
  created_at: number;
  /** Epoch-ms expiry; NULL = never. Currently honored for peer grants (4.3). */
  expires_at: number | null;
  /**
   * Explicit capability list (P1), stored as JSON text. NULL/absent = derive from
   * `level` (the pre-caps behavior of every existing grant). Optional in the TYPE
   * so a plain `{...level}` grant literal stays valid; the db always materializes
   * it (null or a parsed array).
   */
  caps?: Cap[] | null;
}

export interface Session {
  id: string;
  email: string;
  created_at: number;
  expires_at: number;
}

const now = () => Date.now();

// ---- sessions ----
const insertSession = db.prepare(
  "INSERT INTO sessions (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)",
);
const selectSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
const deleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");

export function createSession(id: string, email: string, ttlMs: number): void {
  insertSession.run(id, email, now(), now() + ttlMs);
}
export function getSession(id: string): Session | null {
  const s = selectSession.get(id) as Session | undefined;
  if (!s) return null;
  if (s.expires_at < now()) {
    deleteSession.run(id);
    return null;
  }
  return s;
}
export function destroySession(id: string): void {
  if (deleteSession.run(id).changes) notifyAccessChanged();
}

// ---- device tokens (WP2.1 native sign-in; see auth/device.ts) ----
export interface DeviceTokenRow {
  id: string;
  token_hash: string;
  email: string;
  label: string | null;
  client_id: string;
  created_at: number;
  last_seen_at: number | null;
  expires_at: number;
  max_expires_at: number;
  revoked_at: number | null;
}
export interface DeviceAuthCodeRow {
  code_hash: string;
  email: string;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  label: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  device_id: string | null;
}
export interface DeviceAuthRequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  label: string | null;
  created_at: number;
  expires_at: number;
}

export function insertDeviceToken(r: Omit<DeviceTokenRow, "last_seen_at" | "revoked_at">): void {
  db.prepare(
    `INSERT INTO device_tokens (id, token_hash, email, label, client_id, created_at, last_seen_at, expires_at, max_expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(r.id, r.token_hash, r.email, r.label, r.client_id, r.created_at, r.created_at, r.expires_at, r.max_expires_at);
}
export function getDeviceTokenByHash(hash: string): DeviceTokenRow | null {
  return (db.prepare("SELECT * FROM device_tokens WHERE token_hash = ?").get(hash) as DeviceTokenRow | undefined) ?? null;
}
export function getDeviceToken(id: string): DeviceTokenRow | null {
  return (db.prepare("SELECT * FROM device_tokens WHERE id = ?").get(id) as DeviceTokenRow | undefined) ?? null;
}
export function touchDeviceToken(id: string, lastSeen: number, expiresAt: number): void {
  db.prepare("UPDATE device_tokens SET last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL").run(lastSeen, expiresAt, id);
}
export function revokeDeviceTokenRow(id: string): boolean {
  const changed = db.prepare("UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id).changes > 0;
  if (changed) notifyAccessChanged();
  return changed;
}
/** Live (unrevoked, unexpired) devices — for one user, or every user when email is null. */
export function listLiveDeviceTokens(email: string | null): DeviceTokenRow[] {
  const t = now();
  return (
    email === null
      ? db.prepare("SELECT * FROM device_tokens WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(t)
      : db.prepare("SELECT * FROM device_tokens WHERE email = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(email, t)
  ) as DeviceTokenRow[];
}

export function insertDeviceAuthCode(r: Omit<DeviceAuthCodeRow, "used_at" | "device_id">): void {
  db.prepare("DELETE FROM device_auth_codes WHERE expires_at < ?").run(now() - 60 * 60_000);
  db.prepare(
    `INSERT INTO device_auth_codes (code_hash, email, client_id, code_challenge, redirect_uri, label, created_at, expires_at, used_at, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(r.code_hash, r.email, r.client_id, r.code_challenge, r.redirect_uri, r.label, r.created_at, r.expires_at);
}
export function getDeviceAuthCode(hash: string): DeviceAuthCodeRow | null {
  return (db.prepare("SELECT * FROM device_auth_codes WHERE code_hash = ?").get(hash) as DeviceAuthCodeRow | undefined) ?? null;
}
/** Atomically claim an unused, unexpired code. False = already used / expired / unknown. */
export function claimDeviceAuthCode(hash: string): boolean {
  const t = now();
  return (
    db.prepare("UPDATE device_auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").run(t, hash, t)
      .changes === 1
  );
}
export function setDeviceAuthCodeDevice(hash: string, deviceId: string): void {
  db.prepare("UPDATE device_auth_codes SET device_id = ? WHERE code_hash = ?").run(deviceId, hash);
}

export function insertDeviceAuthRequest(r: DeviceAuthRequestRow): void {
  db.prepare("DELETE FROM device_auth_requests WHERE expires_at < ?").run(now());
  db.prepare(
    `INSERT INTO device_auth_requests (id, client_id, redirect_uri, code_challenge, state, label, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.id, r.client_id, r.redirect_uri, r.code_challenge, r.state, r.label, r.created_at, r.expires_at);
}
export function getDeviceAuthRequest(id: string): DeviceAuthRequestRow | null {
  const r = db.prepare("SELECT * FROM device_auth_requests WHERE id = ?").get(id) as DeviceAuthRequestRow | undefined;
  if (!r || r.expires_at < now()) return null;
  return r;
}
export function deleteDeviceAuthRequest(id: string): void {
  db.prepare("DELETE FROM device_auth_requests WHERE id = ?").run(id);
}

// ---- users ----
const upsertUserStmt = db.prepare(
  "INSERT INTO users (email, name, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING",
);
export function ensureUser(email: string, name?: string): void {
  upsertUserStmt.run(email, name ?? null, now());
}

export interface UserRow {
  email: string;
  name: string | null;
  password_hash: string | null;
  avatar: string | null;
  created_at: number;
}
const selectUser = db.prepare("SELECT email, name, password_hash, avatar, created_at FROM users WHERE email = ?");
export function getUser(email: string): UserRow | null {
  return (selectUser.get(email) as UserRow | undefined) ?? null;
}

const updateProfileName = db.prepare("UPDATE users SET name = ? WHERE email = ?");
const updateProfileAvatar = db.prepare("UPDATE users SET avatar = ? WHERE email = ?");
/** Update a user's own profile: display name and/or avatar (only the provided
 *  fields). Email is the account identity (primary key) and is not changed here. */
export function setUserProfile(email: string, patch: { name?: string; avatar?: string | null }): void {
  ensureUser(email);
  if (patch.name !== undefined) updateProfileName.run(patch.name, email);
  if (patch.avatar !== undefined) updateProfileAvatar.run(patch.avatar, email);
}
export function hasAccount(email: string): boolean {
  const u = getUser(email);
  return !!u && !!u.password_hash;
}

const insertAccount = db.prepare(
  `INSERT INTO users (email, name, password_hash, created_at) VALUES (@email, @name, @password_hash, @created_at)
   ON CONFLICT(email) DO UPDATE SET name = @name, password_hash = @password_hash`,
);
/** Create or update an account with a password (used by register + owner bootstrap). */
export function setAccount(email: string, name: string, passwordHash: string): void {
  insertAccount.run({ email, name, password_hash: passwordHash, created_at: now() });
}

const updatePassword = db.prepare("UPDATE users SET password_hash = ? WHERE email = ?");
export function setUserPassword(email: string, passwordHash: string): void {
  ensureUser(email);
  updatePassword.run(passwordHash, email);
}

// ---- invites (owner-issued; gate registration to invited emails) ----
export interface Invite {
  token_hash: string;
  email: string;
  name: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
}
const insertInvite = db.prepare(
  `INSERT INTO invites (token_hash, email, name, created_by, created_at, expires_at)
   VALUES (@token_hash, @email, @name, @created_by, @created_at, @expires_at)`,
);
const selectInvite = db.prepare("SELECT * FROM invites WHERE token_hash = ?");
const markInviteAccepted = db.prepare("UPDATE invites SET accepted_at = ? WHERE token_hash = ?");
const selectPendingInviteByEmail = db.prepare(
  "SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
);

export function storeInvite(tokenHash: string, email: string, name: string | null, createdBy: string, ttlMs: number): void {
  insertInvite.run({
    token_hash: tokenHash,
    email,
    name,
    created_by: createdBy,
    created_at: now(),
    expires_at: now() + ttlMs,
  });
}
/** Look up a still-valid invite by its token hash (does not consume it). */
export function getValidInvite(tokenHash: string): Invite | null {
  const row = selectInvite.get(tokenHash) as Invite | undefined;
  if (!row || row.accepted_at || row.expires_at < now()) return null;
  return row;
}
export function acceptInvite(tokenHash: string): void {
  markInviteAccepted.run(now(), tokenHash);
}
export function pendingInviteForEmail(email: string): Invite | null {
  return (selectPendingInviteByEmail.get(email, now()) as Invite | undefined) ?? null;
}

// ---- magic links ----
const insertMagic = db.prepare(
  "INSERT INTO magic_links (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)",
);
const selectMagic = db.prepare("SELECT * FROM magic_links WHERE token_hash = ?");
const markMagicUsed = db.prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ?");

export function storeMagicLink(tokenHash: string, email: string, ttlMs: number): void {
  insertMagic.run(tokenHash, email, now(), now() + ttlMs);
}
export function consumeMagicLink(tokenHash: string): string | null {
  const row = selectMagic.get(tokenHash) as
    | { email: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!row || row.used_at || row.expires_at < now()) return null;
  markMagicUsed.run(now(), tokenHash);
  return row.email;
}

// ---- grants ----
// Grant input: vault_id is OPTIONAL (defaults to 'primary') so every existing
// single-vault call site is unchanged; multi-tenant callers pass the active vault.
type GrantInput = Omit<Grant, "id" | "created_at" | "vault_id" | "expires_at"> & {
  id?: string;
  vault_id?: string;
  expires_at?: number | null;
};

const insertGrant = db.prepare(
  `INSERT INTO grants (id, vault_id, subject_type, subject, resource_type, resource, level, created_by, created_at, expires_at, caps)
   VALUES (@id, @vault_id, @subject_type, @subject, @resource_type, @resource, @level, @created_by, @created_at, @expires_at, @caps)`,
);

// ── caps (P1) at the db boundary ─────────────────────────────────────────────
// Stored as JSON text; every read goes through `hydrate`, which is DEFENSIVE:
// unparseable text, a non-array, or an array with no known cap names all read
// back as null (= "derive from level"), so a corrupt/hand-edited row degrades to
// the pre-caps behavior instead of throwing or granting something unknown.
function parseCaps(raw: unknown): Cap[] | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const caps = [...new Set(parsed.filter(isCap))];
  return caps.length ? caps : null;
}
/** Canonical caps for storage: known names only, deduped; empty → null. */
const normalizeCaps = (caps: Cap[] | null | undefined): Cap[] | null => {
  if (!caps) return null;
  const clean = [...new Set(caps.filter(isCap))];
  return clean.length ? clean : null;
};
const serializeCaps = (caps: Cap[] | null | undefined): string | null => {
  const clean = normalizeCaps(caps);
  return clean ? JSON.stringify(clean) : null;
};
/** Turn a raw grants row into a Grant (caps JSON text → Cap[] | null). */
const hydrate = (row: unknown): Grant => {
  const r = row as Grant & { caps?: unknown };
  return { ...r, caps: parseCaps(r.caps) };
};
const hydrateAll = (rows: unknown[]): Grant[] => rows.map(hydrate);
// User grants are scoped to the active vault: a member of vault A must not pick up
// their (or an "anyone") grant from vault B. (anyone grants are per-vault too.)
// EXPIRY (P2): an expired grant must not authorize anything. Peer grants have
// filtered on this since 4.3; the user path did not, which was harmless only
// because nothing wrote `expires_at` on a user grant. Governance memberships DO
// (a term-limited role compiles to an expiring grant), so an unfiltered read here
// would keep a recalled steward's access alive forever. NULL still means never.
const selectGrantsByUser = db.prepare(
  "SELECT * FROM grants WHERE vault_id = ? AND ((subject_type = 'user' AND subject = ?) OR subject_type = 'anyone')" +
    " AND (expires_at IS NULL OR expires_at > ?)",
);
const selectGrantsByCapability = db.prepare(
  "SELECT * FROM grants WHERE subject_type = 'link' AND subject = ?",
);
const selectGrantsByResource = db.prepare(
  "SELECT * FROM grants WHERE vault_id = ? AND resource_type = ? AND resource = ?",
);
const deleteGrantStmt = db.prepare("DELETE FROM grants WHERE id = ?");

export function addGrant(g: GrantInput): Grant {
  // COHERENCE RULE (P1): when a grant carries explicit caps, its `level` is
  // DERIVED, never taken from the caller — a caps grant and its ladder projection
  // can therefore never disagree, so level-based consumers (collab, the older
  // routes) see a correct, never-inflated view of it.
  const caps = normalizeCaps(g.caps);
  const row: Grant = {
    ...g,
    vault_id: g.vault_id ?? "primary",
    id: g.id ?? randomUUID(),
    created_at: now(),
    expires_at: g.expires_at ?? null,
    caps,
    level: caps ? levelForCaps(caps) : g.level,
  };
  insertGrant.run({ ...row, caps: serializeCaps(caps) });
  return row;
}
/** Grants for a signed-in user IN a vault (their own + any "anyone-with-link"
 *  grants in that vault). Defaults to the primary vault for single-vault callers. */
export function grantsForUser(email: string, vaultId = "primary"): Grant[] {
  return hydrateAll(selectGrantsByUser.all(vaultId, email, now()));
}
/** Grants attached to a specific capability link (each carries its own vault_id;
 *  a link is bound to one resource in one vault). */
export function grantsForCapability(capabilityId: string): Grant[] {
  return hydrateAll(selectGrantsByCapability.all(capabilityId));
}
export function grantsForResource(type: ResourceType, resource: string, vaultId = "primary"): Grant[] {
  return hydrateAll(selectGrantsByResource.all(vaultId, type, resource));
}
/** The distinct vault_ids where this user holds ≥1 direct grant — a guest
 *  invited to a workspace (via /acl people-sharing) has grants but no membership
 *  row, yet should still see that one workspace in their switcher (Phase 1.5). */
const selectGrantVaultsByUser = db.prepare(
  "SELECT DISTINCT vault_id FROM grants WHERE subject_type = 'user' AND subject = ?",
);
export function vaultIdsWithGrantsForUser(email: string): string[] {
  return (selectGrantVaultsByUser.all(email.toLowerCase()) as Array<{ vault_id: string }>).map((r) => r.vault_id);
}
export function removeGrant(id: string): void {
  const grant = getGrantById(id);
  if (deleteGrantStmt.run(id).changes) notifyAccessChanged(grant?.vault_id);
}

// ── governance-materialized grants (P2) ──────────────────────────────────────
// The constitution compiles to ORDINARY grant rows, marked by a `created_by` of
// "governance:<roleId>". That prefix is the whole contract: the reconciler owns
// exactly these rows and never touches any other, so a grant a human made by hand
// survives every reconcile — including one that revokes everything governance
// granted. Expired rows are INCLUDED: the reconciler must be able to see and
// clean up what it wrote, even after it stopped applying.
const selectGovernanceGrants = db.prepare(
  "SELECT * FROM grants WHERE vault_id = ? AND created_by LIKE 'governance:%'",
);
export function listGovernanceGrants(vaultId = "primary"): Grant[] {
  return hydrateAll(selectGovernanceGrants.all(vaultId));
}
// ── grants audit (Phase 2.2): list every grant in a vault, and fetch one by id
// (so a revoke can be scoped to the admin's OWN vault — no cross-vault deletes).
const selectGrantsByVault = db.prepare("SELECT * FROM grants WHERE vault_id = ? ORDER BY created_at DESC");
const selectGrantById = db.prepare("SELECT * FROM grants WHERE id = ?");
export function listGrantsForVault(vaultId: string): Grant[] {
  return hydrateAll(selectGrantsByVault.all(vaultId));
}
export function getGrantById(id: string): Grant | null {
  const row = selectGrantById.get(id);
  return row ? hydrate(row) : null;
}

const selectGrantBySubjectResource = db.prepare(
  `SELECT * FROM grants WHERE vault_id = ? AND subject_type = ? AND subject = ? AND resource_type = ? AND resource = ?`,
);
const updateGrantLevel = db.prepare("UPDATE grants SET level = ?, expires_at = ?, caps = ? WHERE id = ?");

/** Insert or, if a grant for the same (vault, subject, resource) exists, update
 *  its level (and expiry — re-granting refreshes/clears the TTL, and likewise
 *  replaces/clears the caps list: a re-grant states the access in full).
 *
 *  COHERENCE RULE (P1): if caps are supplied, the stored `level` is
 *  `levelForCaps(caps)` — computed HERE, so no caller can desynchronize the two
 *  columns. A caps-less upsert is byte-identical to the pre-caps behavior. */
export function upsertGrant(g: GrantInput): Grant {
  const vaultId = g.vault_id ?? "primary";
  const existingRow = selectGrantBySubjectResource.get(
    vaultId,
    g.subject_type,
    g.subject,
    g.resource_type,
    g.resource,
  );
  if (existingRow) {
    const existing = hydrate(existingRow);
    const expires_at = g.expires_at ?? null;
    const caps = normalizeCaps(g.caps);
    const level = caps ? levelForCaps(caps) : g.level;
    updateGrantLevel.run(level, expires_at, serializeCaps(caps), existing.id);
    notifyAccessChanged(vaultId);
    return { ...existing, level, expires_at, caps };
  }
  return addGrant(g);
}

const deleteGrantBySubjectResourceStmt = db.prepare(
  `DELETE FROM grants WHERE vault_id = ? AND subject_type = ? AND subject = ? AND resource_type = ? AND resource = ?`,
);
export function removeGrantBySubjectResource(
  subjectType: SubjectType,
  subject: string,
  resourceType: ResourceType,
  resource: string,
  vaultId = "primary",
): void {
  if (deleteGrantBySubjectResourceStmt.run(vaultId, subjectType, subject, resourceType, resource).changes) notifyAccessChanged(vaultId);
}

// ── Memberships (Phase 1 multi-tenancy) ──────────────────────────────────────
export interface MembershipRow {
  vault_id: string;
  email: string;
  role: string; // 'owner' | 'admin' | 'member' | 'guest' (validated by roles.ts)
  created_at: number;
}
const upsertMembershipStmt = db.prepare(
  `INSERT INTO memberships (vault_id, email, role, created_by, created_at)
   VALUES (@vault_id, @email, @role, @created_by, @created_at)
   ON CONFLICT(vault_id, email) DO UPDATE SET role = @role`,
);
const selectMembershipRole = db.prepare("SELECT role FROM memberships WHERE vault_id = ? AND email = ?");
const selectMembershipsByVault = db.prepare(
  "SELECT vault_id, email, role, created_at FROM memberships WHERE vault_id = ? ORDER BY created_at",
);
const selectMembershipsByUser = db.prepare(
  "SELECT vault_id, email, role, created_at FROM memberships WHERE email = ?",
);
const deleteMembershipStmt = db.prepare("DELETE FROM memberships WHERE vault_id = ? AND email = ?");

/** The raw membership role string for (email, vault), or null if not a member.
 *  roles.ts `workspaceRole` wraps this with the OWNER_EMAIL bootstrap fallback. */
export function getMembershipRole(email: string, vaultId: string): string | null {
  return (selectMembershipRole.get(vaultId, email) as { role: string } | undefined)?.role ?? null;
}
export function setMembership(vaultId: string, email: string, role: string, createdBy: string | null): void {
  ensureUser(email);
  upsertMembershipStmt.run({ vault_id: vaultId, email, role, created_by: createdBy, created_at: now() });
  notifyAccessChanged(vaultId);
}
export function removeMembership(vaultId: string, email: string): void {
  if (deleteMembershipStmt.run(vaultId, email).changes) notifyAccessChanged(vaultId);
}
export function listMemberships(vaultId: string): MembershipRow[] {
  return selectMembershipsByVault.all(vaultId) as MembershipRow[];
}
export function membershipsForUser(email: string): MembershipRow[] {
  return selectMembershipsByUser.all(email) as MembershipRow[];
}

// ---- users (listing) ----
const selectUsers = db.prepare("SELECT email, name FROM users ORDER BY email");
export function listUsers(): Array<{ email: string; name: string | null }> {
  return selectUsers.all() as Array<{ email: string; name: string | null }>;
}

// ---- capabilities (link metadata, so the share dialog can list + re-render links) ----
export interface Capability {
  id: string;
  resource_type: ResourceType;
  resource: string;
  level: Level;
  label: string | null;
  expires_at: number;
  created_at: number;
}
const insertCapability = db.prepare(
  `INSERT INTO capabilities (id, resource_type, resource, level, label, expires_at, created_at)
   VALUES (@id, @resource_type, @resource, @level, @label, @expires_at, @created_at)`,
);
const selectCapabilitiesByResource = db.prepare(
  "SELECT * FROM capabilities WHERE resource_type = ? AND resource = ? ORDER BY created_at DESC",
);
const deleteCapabilityStmt = db.prepare("DELETE FROM capabilities WHERE id = ?");

export function createCapability(c: Omit<Capability, "created_at">): Capability {
  const row: Capability = { ...c, created_at: now() };
  insertCapability.run(row);
  return row;
}
export function capabilitiesForResource(type: ResourceType, resource: string): Capability[] {
  return selectCapabilitiesByResource.all(type, resource) as Capability[];
}
export function deleteCapability(id: string): void {
  deleteCapabilityStmt.run(id);
}

// ---- collab doc state (Yjs CRDT continuity across unloads) ----
// ONE persisted notion of "what vault content this snapshot is built on",
// honoured identically at load, in the reconciler and in the store:
//
//   state              the latest durable Yjs state of the document
//   source_updated_at  the vault version (updatedAt, ms) the snapshot is based on
//   base_hash          hash of that version's CONTENT — a vault copy with this
//                      hash is not news, whatever its timestamp (metadata-only
//                      write). NULL on rows written before this column existed
//                      (those fall back to the timestamp rule).
//   ahead              0: `state` IS the vault content (rendering it gives the
//                      note). 1: `state` holds changes the vault does not have.
//   base_state         while ahead: the Yjs state that IS the vault content (the
//                      true base of any three-way merge); NULL = unknown.
//   attempts           hashes of the content of vault writes that were SENT but
//                      not confirmed (newest last). A vault copy with one of
//                      these hashes is OUR OWN write whose acknowledgement was
//                      lost — never an external edit. `state` always contains
//                      every attempted write (it is saved BEFORE the write).
//   attempt_state      the Yjs state of the newest attempt, once `state` moved on
//                      (NULL = `state` still is it).
export interface DocState {
  state: Uint8Array;
  sourceUpdatedAt: number | null;
  baseHash: string | null;
  ahead: boolean;
  /** The Yjs state that equals the vault content: `state` itself when not ahead, the kept base when ahead (null = unknown). */
  base: Uint8Array | null;
  attempts: string[];
}
export interface DocMeta {
  sourceUpdatedAt: number | null;
  baseHash: string | null;
  ahead: boolean;
  attempts: string[];
}
const DOC_ATTEMPTS_KEPT = 4;
const parseAttempts = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const selectDocState = db.prepare("SELECT state, source_updated_at, base_hash, ahead, base_state, attempts FROM collab_docs WHERE vault_id = ? AND name = ?");
const selectDocMeta = db.prepare("SELECT source_updated_at, base_hash, ahead, attempts FROM collab_docs WHERE vault_id = ? AND name = ?");
const upsertDocState = db.prepare(
  `INSERT INTO collab_docs (vault_id, name, state, source_updated_at, base_hash, ahead, base_state, attempts, attempt_state, updated_at)
   VALUES (@vault_id, @name, @state, @source_updated_at, @base_hash, 0, NULL, NULL, NULL, @updated_at)
   ON CONFLICT(vault_id, name) DO UPDATE SET state=@state, source_updated_at=@source_updated_at, base_hash=@base_hash, ahead=0, base_state=NULL, attempts=NULL, attempt_state=NULL, updated_at=@updated_at`,
);

/** CRDT doc state, scoped to a vault (a note id is only unique within a vault).
 *  vaultId defaults to 'primary' so pre-multitenant callers are unaffected. */
export function getDocState(name: string, vaultId = "primary"): DocState | null {
  const row = selectDocState.get(vaultId, name) as { state: Buffer; source_updated_at: number | null; base_hash: string | null; ahead: number; base_state: Buffer | null; attempts: string | null } | undefined;
  if (!row) return null;
  const state = new Uint8Array(row.state);
  const ahead = row.ahead === 1;
  return { state, sourceUpdatedAt: row.source_updated_at, baseHash: row.base_hash, ahead, base: ahead ? (row.base_state ? new Uint8Array(row.base_state) : null) : state, attempts: parseAttempts(row.attempts) };
}
/** The same without the Yjs blobs (the reconciler asks every tick). */
export function getDocMeta(name: string, vaultId = "primary"): DocMeta | null {
  const row = selectDocMeta.get(vaultId, name) as { source_updated_at: number | null; base_hash: string | null; ahead: number; attempts: string | null } | undefined;
  return row ? { sourceUpdatedAt: row.source_updated_at, baseHash: row.base_hash, ahead: row.ahead === 1, attempts: parseAttempts(row.attempts) } : null;
}
/**
 * The snapshot IS the vault content at `sourceUpdatedAt` (a load, a confirmed
 * write, a write that turned out to be unnecessary). `baseHash` = the hash of
 * that content (omit only where the content is not known: legacy callers).
 */
export function saveDocState(name: string, state: Uint8Array, sourceUpdatedAt: number | null, vaultId = "primary", baseHash: string | null = null): void {
  upsertDocState.run({ vault_id: vaultId, name, state: Buffer.from(state), source_updated_at: sourceUpdatedAt, base_hash: baseHash, updated_at: now() });
}
const insertDocAhead = db.prepare(
  `INSERT INTO collab_docs (vault_id, name, state, source_updated_at, base_hash, ahead, base_state, attempts, attempt_state, updated_at)
   VALUES (@vault_id, @name, @state, NULL, NULL, 1, NULL, @attempts, NULL, @updated_at)`,
);
// RHS column names are the row's OLD values: the base is kept (or taken from the
// last in-sync state), and the newest attempt's state is kept once `state` moves on.
const updateDocAhead = db.prepare(
  `UPDATE collab_docs SET
     base_state = CASE WHEN ahead = 1 THEN base_state ELSE state END,
     attempt_state = CASE WHEN attempts IS NOT NULL AND attempt_state IS NULL THEN state ELSE attempt_state END,
     state = @state, ahead = 1, updated_at = @updated_at
   WHERE vault_id = @vault_id AND name = @name`,
);
const updateDocAttempt = db.prepare(
  `UPDATE collab_docs SET
     base_state = CASE WHEN ahead = 1 THEN base_state ELSE state END,
     state = @state, ahead = 1, attempts = @attempts, attempt_state = NULL, updated_at = @updated_at
   WHERE vault_id = @vault_id AND name = @name`,
);
/** The document holds changes the vault does not have: save them, keep the base. */
export function saveDocAhead(name: string, state: Uint8Array, vaultId = "primary"): void {
  const params = { vault_id: vaultId, name, state: Buffer.from(state), updated_at: now() };
  if (updateDocAhead.run(params).changes === 0) insertDocAhead.run({ ...params, attempts: null });
}
/**
 * A vault write of `state` (content hash `hash`) is about to be SENT. Saved first,
 * so that whatever happens to the acknowledgement the snapshot contains what was
 * written and the hash says "this vault copy is ours".
 */
export const saveDocAttempt = db.transaction((name: string, state: Uint8Array, hash: string, vaultId: string): void => {
  const meta = getDocMeta(name, vaultId);
  const attempts = JSON.stringify([...(meta?.attempts ?? []).filter((h) => h !== hash), hash].slice(-DOC_ATTEMPTS_KEPT));
  const params = { vault_id: vaultId, name, state: Buffer.from(state), attempts, updated_at: now() };
  if (updateDocAttempt.run(params).changes === 0) insertDocAhead.run(params);
});
const confirmDocAttemptStmt = db.prepare(
  `UPDATE collab_docs SET state = COALESCE(attempt_state, state), source_updated_at = @source, base_hash = @hash, ahead = 0, base_state = NULL, attempts = NULL, attempt_state = NULL, updated_at = @updated_at
   WHERE vault_id = @vault_id AND name = @name`,
);
/** Set what the snapshot is built on, without touching `state` (see `rebaseDoc`). */
const rebaseDocStmt = db.prepare(
  `UPDATE collab_docs SET source_updated_at = @source, base_hash = COALESCE(@hash, base_hash),
     base_state = CASE WHEN @base_mode = 'keep' THEN base_state WHEN @base_mode = 'attempt' THEN COALESCE(attempt_state, state) ELSE @base END,
     ahead = CASE WHEN @base_mode = 'keep' THEN ahead ELSE 1 END,
     attempts = CASE WHEN @clear_attempts = 1 THEN NULL ELSE attempts END,
     attempt_state = CASE WHEN @clear_attempts = 1 THEN NULL ELSE attempt_state END,
     updated_at = @updated_at
   WHERE vault_id = @vault_id AND name = @name`,
);
/**
 * The vault moved and the snapshot's BASE moves with it; `state` stays.
 *  - `{ source }`                          metadata-only write: same content, newer version.
 *  - `{ source, hash, base: "attempt" }`   the vault holds OUR attempted write `hash`: the
 *                                          newest attempt's state is the base when it is that
 *                                          attempt, else the base is unknown.
 *  - `{ source, hash, base: <state> }`     an external edit was merged in: `base` is the Yjs
 *                                          state that equals the new vault content (null = unknown).
 */
export function rebaseDoc(name: string, vaultId: string, to: { source: number | null; hash?: string; base?: Uint8Array | null | "attempt" }): void {
  const meta = getDocMeta(name, vaultId);
  if (!meta) return;
  let mode: "keep" | "attempt" | "set" = to.base === undefined ? "keep" : to.base === "attempt" ? "attempt" : "set";
  // Only the NEWEST attempt has a kept state; an older one that landed leaves the base unknown.
  if (mode === "attempt" && meta.attempts[meta.attempts.length - 1] !== to.hash) mode = "set";
  rebaseDocStmt.run({
    vault_id: vaultId,
    name,
    source: to.source,
    hash: to.hash ?? null,
    base_mode: mode,
    base: mode === "set" && to.base instanceof Uint8Array ? Buffer.from(to.base) : null,
    clear_attempts: to.hash !== undefined ? 1 : 0,
    updated_at: now(),
  });
}

// ---- notes whose live state has not reached the vault (collab.ts retries; /acl/workers reports) ----
export interface CollabUnsavedRow {
  vault_id: string;
  name: string;
  doc_name: string;
  since: number;
  /** Why the last write did not happen (a ConversionFailure, `vault <status>`, `conflict`, `unreadable`, `gave_up`). */
  reason: string | null;
  /** 1 = retrying cannot help (the page is too large / the vault refuses it): kept, surfaced, not retried. */
  permanent: number;
  attempts: number;
  last_attempt: number | null;
  next_attempt: number;
}
const markUnsavedStmt = db.prepare(
  `INSERT INTO collab_unsaved (vault_id, name, doc_name, since, reason, permanent) VALUES (@vault_id, @name, @doc_name, @since, @reason, @permanent)
   ON CONFLICT(vault_id, name) DO UPDATE SET reason = @reason, permanent = @permanent, doc_name = @doc_name`,
);
const clearUnsavedStmt = db.prepare("DELETE FROM collab_unsaved WHERE vault_id = ? AND name = ?");
const getUnsavedStmt = db.prepare("SELECT * FROM collab_unsaved WHERE vault_id = ? AND name = ?");
// Least recently attempted first (never-attempted rows lead), so no row can starve the others.
const dueUnsavedStmt = db.prepare("SELECT * FROM collab_unsaved WHERE permanent = 0 AND next_attempt <= ? ORDER BY COALESCE(last_attempt, 0), since LIMIT ?");
const allUnsavedStmt = db.prepare("SELECT * FROM collab_unsaved ORDER BY since LIMIT ?");
const attemptUnsavedStmt = db.prepare("UPDATE collab_unsaved SET attempts = attempts + 1, last_attempt = @at, next_attempt = @next WHERE vault_id = @vault_id AND name = @name");
const statsUnsavedStmt = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(permanent), 0) AS permanent, MIN(since) AS oldest FROM collab_unsaved");
/** Remember that this note's live state (in collab_docs) has not reached the vault yet (`since` is kept across repeats). */
export function markCollabUnsaved(name: string, vaultId: string, docName: string, reason: string | null = null, permanent = false): void {
  markUnsavedStmt.run({ vault_id: vaultId, name, doc_name: docName, since: now(), reason, permanent: permanent ? 1 : 0 });
}
export function clearCollabUnsaved(name: string, vaultId: string): void {
  clearUnsavedStmt.run(vaultId, name);
}
export function getCollabUnsaved(name: string, vaultId: string): CollabUnsavedRow | null {
  return (getUnsavedStmt.get(vaultId, name) as CollabUnsavedRow | undefined) ?? null;
}
export function isCollabUnsaved(name: string, vaultId: string): boolean {
  return getCollabUnsaved(name, vaultId) !== null;
}
/** Rows whose retry is due, least recently attempted first. */
export function dueCollabUnsaved(limit = 5, at = now()): CollabUnsavedRow[] {
  return dueUnsavedStmt.all(at, limit) as CollabUnsavedRow[];
}
export function listCollabUnsaved(limit = 50): CollabUnsavedRow[] {
  return allUnsavedStmt.all(limit) as CollabUnsavedRow[];
}
/** One retry was made: count it and push the next one out (exponential, 1 min → 6 h). */
export function noteCollabUnsavedAttempt(name: string, vaultId: string, at = now()): void {
  const row = getCollabUnsaved(name, vaultId);
  if (!row) return;
  const wait = Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(row.attempts, 9));
  attemptUnsavedStmt.run({ vault_id: vaultId, name, at, next: at + wait });
}
export function collabUnsavedStats(): { total: number; permanent: number; oldestSince: number | null } {
  const r = statsUnsavedStmt.get() as { total: number; permanent: number; oldest: number | null };
  return { total: r.total, permanent: r.permanent, oldestSince: r.oldest };
}

// ---- human collaboration command receipts (see the table comment above) ----
export interface CollabCommandReceipt {
  vault_id: string;
  note_id: string;
  doc_name: string;
  actor: string;
  request_id: string;
  command_hash: string;
  kind: string;
  result: string;
  state: "applied" | "durable";
  created_at: number;
  durable_at: number | null;
  body_bytes: number;
  comment_bytes: number;
}
/** An unconfirmed receipt, as the load/store paths handle it. */
export interface UnconfirmedCollabReceipt {
  rowid: number;
  kind: string;
  result: string;
}
const selectCollabReceipt = db.prepare(
  "SELECT * FROM collab_command_receipts WHERE vault_id = ? AND note_id = ? AND actor = ? AND request_id = ?",
);
const insertCollabReceiptStmt = db.prepare(
  `INSERT INTO collab_command_receipts (vault_id, note_id, doc_name, actor, request_id, command_hash, kind, result, state, created_at, durable_at, body_bytes, comment_bytes)
   VALUES (@vault_id, @note_id, @doc_name, @actor, @request_id, @command_hash, @kind, @result, 'applied', @created_at, NULL, @body_bytes, @comment_bytes)`,
);
const selectUnconfirmedCollabReceipts = db.prepare(
  "SELECT rowid, kind, result FROM collab_command_receipts WHERE doc_name = ? AND state = 'applied' ORDER BY rowid",
);
const confirmCollabReceiptStmt = db.prepare("UPDATE collab_command_receipts SET state = 'durable', durable_at = ? WHERE rowid = ? AND state = 'applied'");
const dropUnconfirmedCollabReceiptsStmt = db.prepare("DELETE FROM collab_command_receipts WHERE doc_name = ? AND state = 'applied'");
const countCollabReceiptsStmt = db.prepare("SELECT COUNT(*) AS n FROM collab_command_receipts WHERE vault_id = ? AND note_id = ?");
const countCollabReceiptsActorStmt = db.prepare("SELECT COUNT(*) AS n FROM collab_command_receipts WHERE vault_id = ? AND note_id = ? AND actor = ?");
const pruneCollabReceiptsStmt = db.prepare("DELETE FROM collab_command_receipts WHERE created_at < ?");
const pruneCollabReceiptsDocStmt = db.prepare("DELETE FROM collab_command_receipts WHERE vault_id = ? AND note_id = ? AND created_at < ?");

export function getCollabReceipt(vaultId: string, noteId: string, actor: string, requestId: string): CollabCommandReceipt | null {
  return (selectCollabReceipt.get(vaultId, noteId, actor, requestId) as CollabCommandReceipt | undefined) ?? null;
}
/** Record a command as applied-in-memory. Throws on a duplicate key. */
export function insertCollabReceipt(r: Omit<CollabCommandReceipt, "state" | "durable_at" | "body_bytes" | "comment_bytes"> & { body_bytes?: number; comment_bytes?: number }): void {
  insertCollabReceiptStmt.run({ body_bytes: 0, comment_bytes: 0, ...r });
}
const deleteCollabReceiptStmt = db.prepare("DELETE FROM collab_command_receipts WHERE rowid = ? AND state = 'applied'");
/** Forget unconfirmed receipts whose change is no longer in the document. */
export function deleteUnconfirmedCollabReceipts(rowids: number[]): void {
  for (const r of rowids) deleteCollabReceiptStmt.run(r);
}
const actorUsageStmt = db.prepare(
  `SELECT
     SUM(CASE WHEN kind IN ('resolve','delete-comment') THEN 0 ELSE 1 END) AS growing,
     SUM(CASE WHEN kind IN ('resolve','delete-comment') THEN 1 ELSE 0 END) AS housekeeping,
     COALESCE(SUM(body_bytes), 0) AS body,
     COALESCE(SUM(comment_bytes), 0) AS comments
   FROM collab_command_receipts WHERE vault_id = ? AND note_id = ? AND actor = ?`,
);
/** One actor's recent use of one document (within retention). */
export function collabActorUsage(vaultId: string, noteId: string, actor: string): { growing: number; housekeeping: number; body: number; comments: number } {
  const r = actorUsageStmt.get(vaultId, noteId, actor) as { growing: number | null; housekeeping: number | null; body: number; comments: number };
  return { growing: r.growing ?? 0, housekeeping: r.housekeeping ?? 0, body: r.body, comments: r.comments };
}
/** The commands applied to this in-memory document that no store has confirmed yet. */
export function unconfirmedCollabReceipts(docName: string): UnconfirmedCollabReceipt[] {
  return selectUnconfirmedCollabReceipts.all(docName) as UnconfirmedCollabReceipt[];
}
/**
 * The in-memory document is being (re)loaded: its unconfirmed changes are gone.
 * Returns the rows it forgot (so the loader can clean up what they left in a
 * half-saved snapshot), read and deleted in one transaction.
 */
export const takeUnconfirmedCollabReceipts = db.transaction((docName: string): UnconfirmedCollabReceipt[] => {
  const rows = unconfirmedCollabReceipts(docName);
  if (rows.length) dropUnconfirmedCollabReceiptsStmt.run(docName);
  return rows;
});
export function countCollabReceipts(vaultId: string, noteId: string, actor?: string): number {
  const row = actor === undefined ? countCollabReceiptsStmt.get(vaultId, noteId) : countCollabReceiptsActorStmt.get(vaultId, noteId, actor);
  return (row as { n: number }).n;
}
/** Retention: drop receipts created before `cutoff` (one document, or all). */
export function pruneCollabReceipts(cutoff: number, vaultId?: string, noteId?: string): number {
  return vaultId !== undefined && noteId !== undefined
    ? pruneCollabReceiptsDocStmt.run(vaultId, noteId, cutoff).changes
    : pruneCollabReceiptsStmt.run(cutoff).changes;
}
/**
 * Persist a document's Yjs state and confirm EXACTLY the receipts in `confirm`,
 * in ONE transaction. `confirm` is the set the caller captured in the same
 * synchronous section in which it rendered the content it then wrote to the
 * vault — so a receipt turns 'durable' only if the vault copy really contains
 * its change. A command applied while that vault write was in flight is in the
 * snapshot but NOT in `confirm`; its own store confirms it. Pass [] when the
 * vault write failed.
 */
export const saveDocStateConfirming = db.transaction(
  (name: string, state: Uint8Array, sourceUpdatedAt: number | null, vaultId: string, confirm: number[], baseHash: string | null = null): number => {
    saveDocState(name, state, sourceUpdatedAt, vaultId, baseHash);
    let n = 0;
    const at = now();
    for (const rowid of confirm) n += confirmCollabReceiptStmt.run(at, rowid).changes;
    return n;
  },
);
/** The attempted vault write was acknowledged: the snapshot saved with the attempt IS the vault content now. Confirms the commands it carried, in the same transaction. */
export const confirmDocAttempt = db.transaction((name: string, vaultId: string, sourceUpdatedAt: number | null, hash: string, confirm: number[]): number => {
  confirmDocAttemptStmt.run({ vault_id: vaultId, name, source: sourceUpdatedAt, hash, updated_at: now() });
  let n = 0;
  const at = now();
  for (const rowid of confirm) n += confirmCollabReceiptStmt.run(at, rowid).changes;
  return n;
});

// ---- grants (peer subject) ----
// Expired peer grants (TTL, 4.3) simply don't load → federation access lapses on
// its own with no sweep needed. NULL expires_at = never expires.
const selectGrantsByPeer = db.prepare(
  "SELECT * FROM grants WHERE subject_type = 'peer' AND subject = ? AND (expires_at IS NULL OR expires_at > ?)",
);
/** Grants attached to a paired peer (matched by its pubkey), excluding expired. */
export function grantsForPeer(pubkey: string): Grant[] {
  return hydrateAll(selectGrantsByPeer.all(pubkey, now()));
}

// ---- publications (Horizon B) ----
export interface Publication {
  id: string;
  /** The vault this publication serves from. Rows from before multi-vault
   *  publishing carry the migration default 'primary', so they behave
   *  byte-identically; readers still treat null/undefined as 'primary'
   *  defensively (a hand-inserted row). */
  vault_id: string;
  resource_type: ResourceType;
  resource: string;
  template: string;
  title: string | null;
  home_note_id: string | null;
  excluded_note_ids: string | null; // JSON string[]
  password_hash: string | null;
  theme: string | null;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
}
/** The vault a publication belongs to ('primary' for pre-multi-vault rows). */
export const publicationVaultId = (pub: Publication): string => pub.vault_id ?? "primary";
const insertPublication = db.prepare(
  `INSERT INTO publications (id, vault_id, resource_type, resource, template, title, home_note_id, excluded_note_ids, password_hash, theme, expires_at, created_by, created_at)
   VALUES (@id, @vault_id, @resource_type, @resource, @template, @title, @home_note_id, @excluded_note_ids, @password_hash, @theme, @expires_at, @created_by, @created_at)`,
);
const selectPublication = db.prepare("SELECT * FROM publications WHERE id = ?");
const selectPublicationByResource = db.prepare(
  "SELECT * FROM publications WHERE vault_id = ? AND resource_type = ? AND resource = ? LIMIT 1",
);
const selectPublications = db.prepare("SELECT * FROM publications ORDER BY created_at DESC");
const deletePublicationStmt = db.prepare("DELETE FROM publications WHERE id = ?");
const updatePublicationStmt = db.prepare(
  `UPDATE publications SET template=@template, title=@title, home_note_id=@home_note_id, excluded_note_ids=@excluded_note_ids, password_hash=@password_hash, theme=@theme, expires_at=@expires_at WHERE id=@id`,
);

export function createPublication(
  p: Omit<Publication, "created_at" | "excluded_note_ids" | "vault_id"> & {
    excluded_note_ids?: string | null;
    /** Defaults to 'primary' — every pre-multi-vault call site is unchanged. */
    vault_id?: string;
  },
): Publication {
  const row: Publication = { excluded_note_ids: null, vault_id: "primary", ...p, created_at: now() };
  insertPublication.run(row);
  return row;
}

/** Parsed list of note ids excluded from a publication's public set (defaults to
 *  [] when unset or malformed). */
export function excludedNoteIds(pub: Publication): string[] {
  if (!pub.excluded_note_ids) return [];
  try {
    const parsed = JSON.parse(pub.excluded_note_ids);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
export function getPublicationBySlug(slug: string): Publication | null {
  return (selectPublication.get(slug) as Publication | undefined) ?? null;
}
export function getPublicationByResource(type: ResourceType, resource: string, vaultId = "primary"): Publication | null {
  return (selectPublicationByResource.get(vaultId, type, resource) as Publication | undefined) ?? null;
}
export function listPublications(): Publication[] {
  return selectPublications.all() as Publication[];
}
export function deletePublication(slug: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM publication_presentations WHERE slug = ?").run(slug);
    db.prepare("DELETE FROM publication_presentation_history WHERE slug = ?").run(slug);
    deletePublicationStmt.run(slug);
  })();
}
/** Patch the mutable fields of a publication (title/home/excluded/password/theme/expiry). */
export function updatePublication(
  slug: string,
  patch: Partial<Pick<Publication, "template" | "title" | "home_note_id" | "excluded_note_ids" | "password_hash" | "theme" | "expires_at">>,
): Publication | null {
  const existing = getPublicationBySlug(slug);
  if (!existing) return null;
  const merged: Publication = { ...existing, ...patch };
  updatePublicationStmt.run({
    id: slug,
    template: merged.template,
    title: merged.title,
    home_note_id: merged.home_note_id,
    excluded_note_ids: merged.excluded_note_ids,
    password_hash: merged.password_hash,
    theme: merged.theme,
    expires_at: merged.expires_at,
  });
  return merged;
}

// ---- peers (Horizon C) ----
export interface Peer {
  pubkey: string;
  email: string | null;
  label: string | null;
  created_at: number;
  paired_at: number | null;
  collab_url: string | null;
}
const insertPeer = db.prepare(
  `INSERT INTO peers (pubkey, email, label, created_at, paired_at, collab_url)
   VALUES (@pubkey, @email, @label, @created_at, @paired_at, @collab_url)
   ON CONFLICT(pubkey) DO UPDATE SET email=@email, label=@label, paired_at=@paired_at,
     collab_url=COALESCE(@collab_url, collab_url)`,
);
const selectPeer = db.prepare("SELECT * FROM peers WHERE pubkey = ?");
const selectPeers = db.prepare("SELECT * FROM peers ORDER BY created_at DESC");
const deletePeerStmt = db.prepare("DELETE FROM peers WHERE pubkey = ?");
const updatePeerCollabUrl = db.prepare("UPDATE peers SET collab_url = ? WHERE pubkey = ?");

export function upsertPeer(p: { pubkey: string; email?: string | null; label?: string | null; paired_at?: number | null; collab_url?: string | null }): Peer {
  const row: Peer = {
    pubkey: p.pubkey,
    email: p.email ?? null,
    label: p.label ?? null,
    created_at: now(),
    paired_at: p.paired_at ?? null,
    // COALESCE in the upsert preserves an existing URL when this call omits one.
    collab_url: p.collab_url ?? null,
  };
  insertPeer.run(row);
  return (selectPeer.get(p.pubkey) as Peer);
}
export function setPeerCollabUrl(pubkey: string, url: string | null): void {
  updatePeerCollabUrl.run(url, pubkey);
}
export function getPeer(pubkey: string): Peer | null {
  return (selectPeer.get(pubkey) as Peer | undefined) ?? null;
}
export function listPeers(): Peer[] {
  return selectPeers.all() as Peer[];
}
export function removePeer(pubkey: string): void {
  if (deletePeerStmt.run(pubkey).changes) notifyAccessChanged();
}

// ---- peer pairing codes (single-use, hashed, TTL'd) ----
const insertPairing = db.prepare(
  `INSERT INTO peer_pairings (code_hash, label, created_by, created_at, expires_at)
   VALUES (?, ?, ?, ?, ?)`,
);
const selectPairing = db.prepare("SELECT * FROM peer_pairings WHERE code_hash = ?");
const markPairingUsed = db.prepare("UPDATE peer_pairings SET used_at = ? WHERE code_hash = ?");

export interface Pairing {
  code_hash: string;
  label: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}
export function storePairing(codeHash: string, label: string | null, createdBy: string, ttlMs: number): void {
  insertPairing.run(codeHash, label, createdBy, now(), now() + ttlMs);
}
/** Consume a pairing code (single-use). Returns the row if still valid, else null. */
export function consumePairing(codeHash: string): Pairing | null {
  const row = selectPairing.get(codeHash) as Pairing | undefined;
  if (!row || row.used_at || row.expires_at < now()) return null;
  markPairingUsed.run(now(), codeHash);
  return row;
}

// ---- spaces ----
export interface Space {
  id: string;
  title: string | null;
  scope_include_tags: string | null; // JSON string[]
  scope_exclude_tags: string | null; // JSON string[]
  path_prefix: string | null;
  created_by: string | null;
  created_at: number;
}
const insertSpace = db.prepare(
  `INSERT INTO spaces (id, title, scope_include_tags, scope_exclude_tags, path_prefix, created_by, created_at)
   VALUES (@id, @title, @scope_include_tags, @scope_exclude_tags, @path_prefix, @created_by, @created_at)`,
);
const selectSpace = db.prepare("SELECT * FROM spaces WHERE id = ?");
const selectSpaces = db.prepare("SELECT * FROM spaces ORDER BY created_at DESC");
const deleteSpaceStmt = db.prepare("DELETE FROM spaces WHERE id = ?");

export function createSpace(s: Omit<Space, "created_at">): Space {
  const row: Space = { ...s, created_at: now() };
  insertSpace.run(row);
  return row;
}
export function getSpace(id: string): Space | null {
  return (selectSpace.get(id) as Space | undefined) ?? null;
}
export function listSpaces(): Space[] {
  return selectSpaces.all() as Space[];
}
export function deleteSpace(id: string): void {
  deleteSpaceStmt.run(id);
}

// ---- federated notes (cross-vault identity map) ----
export interface FederatedNote {
  space_note_key: string;
  space_id: string;
  local_id: string;
  kind: string;
  peer_synced_at: number | null;
  source_updated_at: number | null;
  created_at: number;
  vault_id: string; // the tenant this hub maps the federated note into (default 'primary')
}
const insertFederatedNote = db.prepare(
  `INSERT INTO federated_notes (space_note_key, space_id, local_id, kind, peer_synced_at, source_updated_at, created_at)
   VALUES (@space_note_key, @space_id, @local_id, @kind, @peer_synced_at, @source_updated_at, @created_at)
   ON CONFLICT(space_note_key) DO UPDATE SET local_id=@local_id, kind=@kind, peer_synced_at=@peer_synced_at, source_updated_at=@source_updated_at`,
);
const selectFederatedByKey = db.prepare("SELECT * FROM federated_notes WHERE space_note_key = ?");
const selectFederatedByLocal = db.prepare("SELECT * FROM federated_notes WHERE local_id = ?");
const selectFederatedBySpace = db.prepare("SELECT * FROM federated_notes WHERE space_id = ?");
const deleteFederatedStmt = db.prepare("DELETE FROM federated_notes WHERE space_note_key = ?");

export function upsertFederatedNote(
  f: Omit<FederatedNote, "created_at" | "vault_id"> & { created_at?: number; vault_id?: string },
): FederatedNote {
  // vault_id is not written by the prepared statement (the DB column defaults to
  // 'primary'); it's carried on the read shape only. Callers may omit it — and it
  // must NOT be passed to .run() (better-sqlite3 rejects unknown named params).
  const created_at = f.created_at ?? now();
  insertFederatedNote.run({
    space_note_key: f.space_note_key,
    space_id: f.space_id,
    local_id: f.local_id,
    kind: f.kind,
    peer_synced_at: f.peer_synced_at,
    source_updated_at: f.source_updated_at,
    created_at,
  });
  return { ...f, vault_id: f.vault_id ?? "primary", created_at };
}
export function getFederatedByKey(key: string): FederatedNote | null {
  return (selectFederatedByKey.get(key) as FederatedNote | undefined) ?? null;
}
export function getFederatedByLocal(localId: string): FederatedNote | null {
  return (selectFederatedByLocal.get(localId) as FederatedNote | undefined) ?? null;
}
export function federatedNotesForSpace(spaceId: string): FederatedNote[] {
  return selectFederatedBySpace.all(spaceId) as FederatedNote[];
}
/** The space ids a local note participates in (for permissions.NoteRef.spaceIds). */
export function spaceIdsForLocalNote(localId: string): string[] {
  return [...new Set((selectFederatedByLocal.all(localId) as FederatedNote[]).map((f) => f.space_id))];
}
export function deleteFederatedNote(key: string): void {
  deleteFederatedStmt.run(key);
}

// ---- federation outbox (queued Yjs updates for offline peers) ----
const insertOutbox = db.prepare(
  `INSERT INTO federation_outbox (space_note_key, peer_pubkey, update_blob, queued_at)
   VALUES (?, ?, ?, ?)`,
);
const selectOutboxByPeer = db.prepare(
  "SELECT * FROM federation_outbox WHERE peer_pubkey = ? ORDER BY id ASC",
);
const deleteOutboxStmt = db.prepare("DELETE FROM federation_outbox WHERE id = ?");

export interface OutboxItem {
  id: number;
  space_note_key: string;
  peer_pubkey: string;
  update_blob: Uint8Array;
  queued_at: number;
}
export function queueOutbox(spaceNoteKey: string, peerPubkey: string, update: Uint8Array): void {
  insertOutbox.run(spaceNoteKey, peerPubkey, Buffer.from(update), now());
}
export function outboxForPeer(pubkey: string): OutboxItem[] {
  const rows = selectOutboxByPeer.all(pubkey) as Array<{
    id: number; space_note_key: string; peer_pubkey: string; update_blob: Buffer; queued_at: number;
  }>;
  return rows.map((r) => ({ ...r, update_blob: new Uint8Array(r.update_blob) }));
}
export function clearOutboxItem(id: number): void {
  deleteOutboxStmt.run(id);
}

// ── peer-edit audit (4.3) ─────────────────────────────────────────────────────
export interface PeerEdit {
  id: number;
  space_note_key: string;
  local_id: string;
  peer_pubkey: string;
  edited_at: number;
}
const insertPeerEdit = db.prepare(
  "INSERT INTO peer_edits (space_note_key, local_id, peer_pubkey, edited_at) VALUES (?, ?, ?, ?)",
);
const selectPeerEdits = db.prepare("SELECT * FROM peer_edits ORDER BY edited_at DESC, id DESC LIMIT ?");
export function recordPeerEdit(spaceNoteKey: string, localId: string, peerPubkey: string): void {
  insertPeerEdit.run(spaceNoteKey, localId, peerPubkey, now());
}
export function listPeerEdits(limit = 200): PeerEdit[] {
  return selectPeerEdits.all(limit) as PeerEdit[];
}

// ---- pending suggestions (durable; survive restart) ----
export interface Suggestion {
  id: string;
  space_note_key: string | null;
  note_id: string;
  author: string | null;
  author_kind: string | null;
  summary: string | null;
  payload: string;
  status: "pending" | "accepted" | "rejected";
  created_at: number;
  resolved_at: number | null;
}
const insertSuggestion = db.prepare(
  `INSERT INTO pending_suggestions (id, space_note_key, note_id, author, author_kind, summary, payload, status, created_at, resolved_at)
   VALUES (@id, @space_note_key, @note_id, @author, @author_kind, @summary, @payload, @status, @created_at, @resolved_at)`,
);
const selectSuggestion = db.prepare("SELECT * FROM pending_suggestions WHERE id = ?");
const selectSuggestionsByStatus = db.prepare(
  "SELECT * FROM pending_suggestions WHERE status = ? ORDER BY created_at DESC",
);
const selectAllSuggestions = db.prepare("SELECT * FROM pending_suggestions ORDER BY created_at DESC");
const selectSuggestionsByNote = db.prepare(
  "SELECT * FROM pending_suggestions WHERE note_id = ? ORDER BY created_at DESC",
);
const updateSuggestionStatus = db.prepare(
  "UPDATE pending_suggestions SET status = ?, resolved_at = ? WHERE id = ?",
);
const deleteSuggestionStmt = db.prepare("DELETE FROM pending_suggestions WHERE id = ?");

export function createSuggestion(
  s: Omit<Suggestion, "created_at" | "resolved_at" | "status"> & { status?: Suggestion["status"] },
): Suggestion {
  const row: Suggestion = { ...s, status: s.status ?? "pending", created_at: now(), resolved_at: null };
  insertSuggestion.run(row);
  return row;
}
export function getSuggestion(id: string): Suggestion | null {
  return (selectSuggestion.get(id) as Suggestion | undefined) ?? null;
}
export function listSuggestions(status?: Suggestion["status"]): Suggestion[] {
  return (status ? selectSuggestionsByStatus.all(status) : selectAllSuggestions.all()) as Suggestion[];
}
export function suggestionsForNote(noteId: string): Suggestion[] {
  return selectSuggestionsByNote.all(noteId) as Suggestion[];
}
export function setSuggestionStatus(id: string, status: Suggestion["status"]): void {
  updateSuggestionStatus.run(status, now(), id);
}
export function deleteSuggestion(id: string): void {
  deleteSuggestionStmt.run(id);
}

// ---- federation mirror requests (inbound space-share, owner-reviewed) ----
export interface MirrorRequest {
  id: string;
  peer_pubkey: string;
  space_id: string;
  space_title: string | null;
  payload: string; // JSON [{ spaceNoteKey, kind, title? }]
  status: "pending" | "accepted" | "rejected";
  created_at: number;
  resolved_at: number | null;
}
const insertMirrorReq = db.prepare(
  `INSERT INTO federation_mirror_requests (id, peer_pubkey, space_id, space_title, payload, status, created_at, resolved_at)
   VALUES (@id, @peer_pubkey, @space_id, @space_title, @payload, 'pending', @created_at, NULL)`,
);
const selectMirrorReq = db.prepare("SELECT * FROM federation_mirror_requests WHERE id = ?");
const selectPendingMirrorByPeerSpace = db.prepare(
  "SELECT * FROM federation_mirror_requests WHERE peer_pubkey = ? AND space_id = ? AND status = 'pending' LIMIT 1",
);
const selectMirrorByStatus = db.prepare("SELECT * FROM federation_mirror_requests WHERE status = ? ORDER BY created_at DESC");
const selectAllMirror = db.prepare("SELECT * FROM federation_mirror_requests ORDER BY created_at DESC");
const updateMirrorPayload = db.prepare("UPDATE federation_mirror_requests SET payload = ?, space_title = ? WHERE id = ?");
const updateMirrorStatus = db.prepare("UPDATE federation_mirror_requests SET status = ?, resolved_at = ? WHERE id = ?");
const deleteMirrorReqStmt = db.prepare("DELETE FROM federation_mirror_requests WHERE id = ?");

/** Create (or, if one is already pending for this peer+space, refresh) a mirror
 *  request. Idempotent so a peer re-pushing the same space updates the manifest
 *  instead of piling up duplicates. */
export function upsertMirrorRequest(r: {
  peer_pubkey: string;
  space_id: string;
  space_title?: string | null;
  payload: string;
}): MirrorRequest {
  const existing = selectPendingMirrorByPeerSpace.get(r.peer_pubkey, r.space_id) as MirrorRequest | undefined;
  if (existing) {
    updateMirrorPayload.run(r.payload, r.space_title ?? existing.space_title, existing.id);
    return { ...existing, payload: r.payload, space_title: r.space_title ?? existing.space_title };
  }
  const row: MirrorRequest = {
    id: randomUUID(),
    peer_pubkey: r.peer_pubkey,
    space_id: r.space_id,
    space_title: r.space_title ?? null,
    payload: r.payload,
    status: "pending",
    created_at: now(),
    resolved_at: null,
  };
  insertMirrorReq.run(row);
  return row;
}
export function getMirrorRequest(id: string): MirrorRequest | null {
  return (selectMirrorReq.get(id) as MirrorRequest | undefined) ?? null;
}
export function listMirrorRequests(status?: MirrorRequest["status"]): MirrorRequest[] {
  return (status ? selectMirrorByStatus.all(status) : selectAllMirror.all()) as MirrorRequest[];
}
export function setMirrorRequestStatus(id: string, status: MirrorRequest["status"]): void {
  updateMirrorStatus.run(status, now(), id);
}
export function deleteMirrorRequest(id: string): void {
  deleteMirrorReqStmt.run(id);
}

// Bootstrap the implicit default workspace. Done HERE (module end) so the `now`
// helper it uses is already initialized (a call up where the functions are
// defined would hit the temporal dead zone).
ensureDefaultWorkspace();
