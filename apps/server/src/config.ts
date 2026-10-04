/**
 * Prism Server configuration, read from the environment (load with
 * `node --env-file=.env`). The Parachute token is held ONLY here, server-side —
 * it is never sent to a client.
 */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  // Loopback by default. The public entrypoint is the Cloudflare tunnel, which
  // dials this from the same host, so binding the wildcard only ever added
  // reachability we don't want: until 2026-08-11 the server answered on the LAN
  // (10.0.0.38:8787) and on every Tailscale node, putting the magic-link/login
  // routes and the collab WebSocket in front of anyone on those networks.
  // (Anonymous callers still resolved to an actor with no grants — this was
  // exposed surface, not open data.) Set BIND_HOST=0.0.0.0 to opt back in.
  bindHost: process.env.BIND_HOST ?? "127.0.0.1",
  appOrigin: (process.env.APP_ORIGIN ?? "http://localhost:8787").replace(/\/+$/, ""),

  // Trust the "local owner" path (a headerless, presumed-loopback request may
  // present the COLLAB/vault token as the owner). This is ONLY safe when the
  // public entrypoint is a proxy that stamps a forwarding header (Cloudflare
  // tunnel) — on a RAW exposed port, headerless external traffic would be
  // wrongly trusted (P5.2 finding). So it FAILS CLOSED for a public https
  // server unless TRUST_LOCAL is explicitly set; dev/desktop (loopback
  // APP_ORIGIN) defaults on. A tunneled prod deploy sets TRUST_LOCAL=true.
  trustLocal:
    process.env.TRUST_LOCAL !== undefined
      ? process.env.TRUST_LOCAL === "true"
      : !(process.env.APP_ORIGIN ?? "").startsWith("https"),

  parachuteUrl: (process.env.PARACHUTE_URL ?? "http://localhost:1940").replace(/\/+$/, ""),
  parachuteVault: process.env.PARACHUTE_VAULT ?? "default",
  parachuteToken: process.env.PARACHUTE_TOKEN ?? "",

  // ── Hub identity / token validation (Phase 0 — scope-guard) ──
  // The hub (@openparachute/hub) is the JWT issuer; we validate vault tokens
  // against its JWKS (auth/vault-token.ts). `hubOrigin` pins the token `iss` —
  // the hub's PUBLIC origin after `parachute expose` (e.g.
  // https://agent.omniharmonic.com), which is what the hub stamps on mints.
  // JWKS is FETCHED from `hubJwksOrigin` (loopback by default) to avoid a tunnel
  // hairpin when the public origin points back at this same box. `hubAllowedIssuers`
  // is an additive allowlist (comma-separated) so a token minted under any of the
  // hub's own origins validates — never request-derived (see scope-guard's
  // security invariant). Same env-var contract as Parachute's own resource
  // servers, so a co-located deploy shares one source of truth.
  hubOrigin: (process.env.PARACHUTE_HUB_ORIGIN ?? "http://127.0.0.1:1939").replace(/\/+$/, ""),
  hubJwksOrigin: (process.env.PARACHUTE_HUB_JWKS_ORIGIN ?? "http://127.0.0.1:1939").replace(/\/+$/, ""),
  hubAllowedIssuers: (process.env.PARACHUTE_HUB_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean),

  // Whether the owner may CREATE a brand-new vault from the UI (shells out to
  // `parachute-vault create`, which needs the host operator token). Defaults ON
  // so a normal single-host deploy works; set ALLOW_VAULT_CREATE=false to allow
  // only LINKING existing vaults (e.g. a hardened host with no operator token).
  allowVaultCreate: process.env.ALLOW_VAULT_CREATE !== "false",

  // The hub's PUBLIC base URL for agent/MCP access (e.g. the cloudflared
  // hostname `parachute expose` serves — https://agent.example.com). Used by
  // routes/mcp.ts to hand members a reachable `<base>/vault/<name>/mcp` URL.
  // Empty → minting still works but the URL falls back to parachuteUrl
  // (loopback), which only helps same-host agents.
  mcpPublicUrl: (process.env.MCP_PUBLIC_URL ?? "").replace(/\/+$/, ""),

  sessionSecret: process.env.SESSION_SECRET ?? "",
  capabilitySecret: process.env.CAPABILITY_SECRET ?? process.env.SESSION_SECRET ?? "",

  ownerEmail: (process.env.OWNER_EMAIL ?? "").trim().toLowerCase(),

  // Web Push (WP3.3, push.ts). Generate with `npm run gen-vapid -w @prism/server`.
  // Unset → push is disabled (the routes report it; the turn hook is a no-op).
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  // VAPID `sub` claim (a contact the push service can reach). Default mailto:OWNER_EMAIL.
  vapidSubject: process.env.VAPID_SUBJECT ?? (process.env.OWNER_EMAIL ? `mailto:${process.env.OWNER_EMAIL.trim()}` : ""),

  // APNs (iOS push, apns.ts). Host bootstrap config: `.env` ONLY — never add any
  // of these to EDITABLE_ENV. APNS_KEY_PATH = the Apple .p8 auth key (must be
  // 0600 or stricter, else APNs stays off with a startup warning). Unset key
  // path / key id / team id → APNs disabled (web push is unaffected).
  apnsKeyPath: (process.env.APNS_KEY_PATH ?? "").trim(),
  apnsKeyId: (process.env.APNS_KEY_ID ?? "").trim(),
  apnsTeamId: (process.env.APNS_TEAM_ID ?? "").trim(),
  apnsTopic: (process.env.APNS_TOPIC ?? "").trim() || "com.benjaminlife.prism.client",

  // Governance integrity (WP0.3, governance-integrity.ts): the HMAC key that signs
  // every governance-* note the governance service writes. Set → notes with a
  // missing/invalid `gov_sig` are IGNORED (a forged membership or vote written
  // straight to the vault confers nothing). Empty → integrity is off and every
  // governance note is trusted as read (the pre-WP0.3 behaviour; logged at
  // startup). Deliberately NOT derived from another secret: enabling it hides
  // every unsigned note, so it must be an explicit act paired with
  // scripts/governance-sign-existing.ts. Generate: `openssl rand -base64 48`.
  governanceSigningSecret: process.env.GOVERNANCE_SIGNING_SECRET ?? "",

  // Member self-serve WHOLE-VAULT MCP tokens (routes/mcp.ts POST /api/mcp/token).
  // FROZEN by default: such a token bypasses every Prism grant and — until
  // governance integrity is on everywhere — could write governance notes. Prism
  // MCP credentials (Architecture v2 WP6.x) replace it. Listing and revoking
  // already-minted tokens keep working regardless. MEMBER_VAULT_TOKENS=true
  // re-enables minting.
  memberVaultTokens: process.env.MEMBER_VAULT_TOKENS === "true",

  // ── Prism MCP endpoint (/mcp, Architecture v2 WP6.1 — mcp/*) ──
  // OPT-IN: hub-JWT subjects (`sub`, exact match, comma-separated) that may act
  // as the OWNER on /mcp. Empty (default) → hub JWTs are NOT accepted on /mcp at
  // all. When set, a hub JWT must carry `vault:<primary>:admin` AND an allowlisted
  // sub — a plain vault token is also what members and member-minted agents hold,
  // so audience alone must never make a caller the owner.
  mcpOwnerHubSubs: (process.env.MCP_OWNER_HUB_SUBS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Per-credential request budget on /mcp (per minute), and the per-IP budget of
  // FAILED authentications (per 10 minutes) before the IP is refused outright.
  // How long `GET /health` (and `/api/health`) waits for the vault's own /health
  // before answering 503. 0 = no timeout (the old behaviour: hangs with the vault).
  vaultHealthTimeoutMs: Number(process.env.VAULT_HEALTH_TIMEOUT_MS ?? 2000),
  mcpRatePerMinute: Number(process.env.MCP_RATE_PER_MINUTE ?? 120),
  mcpAuthFailuresPer10Min: Number(process.env.MCP_AUTH_FAILURES_PER_10MIN ?? 20),

  // Dedicated owner token for the trusted desktop app's real-time connection.
  // The Tauri webview presents this to /collab to join live docs as the owner —
  // separate from the vault token, so the powerful vault credential stays out of
  // the webview. Shared between this .env and the desktop's prism-config.json.
  collabToken: process.env.COLLAB_TOKEN ?? "",

  // Suggest-only enforcement on the collab socket (R07/R12). ON (default): raw
  // Yjs updates over /collab require EDIT; a suggest-level connection is
  // read-only (it still reads + shows presence) and changes the document only
  // through the bounded commands at POST /api/collab/:id/commands. Setting
  // COLLAB_SUGGEST_ENFORCED=false is the rollback switch: it restores the old
  // read-write suggest socket (a "Can suggest" grant is then trust-based again).
  // The command endpoint works in both states. Restart required.
  collabSuggestEnforced: process.env.COLLAB_SUGGEST_ENFORCED !== "false",
  // Human collaboration commands (POST /api/collab/:id/commands) per actor per
  // document per minute. A person preparing suggestions and comments by hand
  // does not sustain one every two seconds; this bounds what one actor can make
  // the server spend on one document (each command re-hashes the document) well
  // below the 120/min per-IP limiter that sits in front of it.
  collabCommandsPerMinute: Number(process.env.COLLAB_COMMANDS_PER_MINUTE ?? 30),

  // ── Native sign-in / device tokens (WP2.1, auth/device.ts) ──
  // Exact-match allowlist of redirect URIs a native client may use with
  // /auth/device/authorize (comma-separated). Loopback redirects
  // (http://127.0.0.1:<any port>/… or http://[::1]:<port>/…, RFC 8252 §7.3) are
  // additionally accepted unless DEVICE_ALLOW_LOOPBACK=false.
  deviceRedirectUris: (process.env.DEVICE_REDIRECT_URIS ?? "prism://auth/callback")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  deviceAllowLoopback: process.env.DEVICE_ALLOW_LOOPBACK !== "false",
  // Sliding idle expiry and absolute lifetime of a device token, in days.
  deviceTokenIdleDays: Number(process.env.DEVICE_TOKEN_IDLE_DAYS ?? 90),
  deviceTokenMaxDays: Number(process.env.DEVICE_TOKEN_MAX_DAYS ?? 365),
  // Browser origins of native shells (Tauri iOS/macOS = tauri://localhost,
  // Windows/Android = http://tauri.localhost). They get NON-credentialed CORS on
  // /api, /auth, /acl — bearer device tokens only; cookies stay same-origin.
  nativeOrigins: (process.env.NATIVE_ORIGINS ?? "tauri://localhost,http://tauri.localhost")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean),

  // ── Parachute-to-Parachute federation (Horizon C) ──
  // This server's Ed25519 PRIVATE signing key as a base64url-encoded 32-byte
  // seed. Used to sign federation requests/connections to peer hubs; only the
  // PUBLIC key is ever shared. Empty → auth/peer.ts generates an ephemeral
  // in-memory keypair and warns (federation works within the process but the
  // identity is not stable across restarts).
  peerSigningKey: process.env.PEER_SIGNING_KEY ?? "",
  // Master switch for the federation transport/routes. Trust pairing can be
  // exercised independently; this gates the live sync (Phase 2+).
  federationEnabled: process.env.FEDERATION_ENABLED === "true",

  // ── Fireflies transcript sync (server-side ingest + self-cleanup) ──
  // The loop pulls transcripts at a few fixed LOCAL hours, ingests new ones, and
  // deletes each from Fireflies once its note is confirmed in the vault — keeping
  // the account under the free-tier daily API-request quota (50/day). The daily
  // budget is the HARD ceiling on Fireflies calls/day (enforced, not advisory):
  // default 40 is free-tier-safe; raise to ~450 while on Pro to drain a backlog
  // fast, then revert. Hours are interpreted in `firefliesTz`.
  // Deleting from Fireflies is IRREVERSIBLE. Off unless explicitly enabled: the
  // loop otherwise runs as a DRY RUN that logs exactly what it would delete. A
  // delete additionally requires per-transcript proof the body is in the vault
  // (see isIngestConfirmed) — this flag only decides whether proof may act.
  firefliesDeleteEnabled: process.env.FIREFLIES_DELETE_ENABLED === "true",
  firefliesDailyBudget: Number(process.env.FIREFLIES_DAILY_BUDGET ?? 40),
  firefliesMaxNewPerRun: Number(process.env.FIREFLIES_MAX_NEW_PER_RUN ?? 6),
  firefliesMaxDeletePerRun: Number(process.env.FIREFLIES_MAX_DELETE_PER_RUN ?? 9),
  firefliesSyncHours: (process.env.FIREFLIES_SYNC_HOURS ?? "11,13,15,18")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23),
  firefliesTz: process.env.FIREFLIES_TZ ?? "America/Denver",
  // When Fireflies leaves a recording untranscribed (it stops transcribing over
  // the minutes cap), hand the audio back for transcription rather than letting
  // the recording rot un-ingestable. Recovery only — it never deletes.
  firefliesRecoverEmpty: process.env.FIREFLIES_RECOVER_EMPTY !== "false",
  firefliesMaxRecoveriesPerRun: Number(process.env.FIREFLIES_MAX_RECOVERIES_PER_RUN ?? 3),
  /** Plan transcription-minutes cap (free = 400). Warns at 80%. */
  firefliesQuotaMinutesCap: Number(process.env.FIREFLIES_QUOTA_MINUTES_CAP ?? 400),

  resendApiKey: process.env.RESEND_API_KEY ?? "",
  magicFrom: process.env.MAGIC_FROM ?? "Prism <login@example.com>",

  dbPath: process.env.DB_PATH ?? "./prism-server.db",

  // Semantic search (RAG). Embeddings are model-deterministic, so the Rust
  // backend's indexer and this server's query-time path can both call the same
  // model and get comparable vectors. With no EMBED_ENDPOINT we fall back to a
  // deterministic, dependency-free local embedder (lexical, offline) — the
  // pipeline still runs and is testable; quality just isn't semantic.
  embedEndpoint: (process.env.EMBED_ENDPOINT ?? "").replace(/\/+$/, ""), // e.g. http://localhost:11434/v1
  embedModel: process.env.EMBED_MODEL ?? "nomic-embed-text",
  embedApiKey: process.env.EMBED_API_KEY ?? "",
  // Dimension of the offline fallback embedder (ignored for a real endpoint,
  // whose dimension is whatever the model returns).
  embedFallbackDim: Number(process.env.EMBED_FALLBACK_DIM ?? 384),
  // How often the worker sweeps the vault to keep the semantic index current.
  // Deliberately much slower than the 60s ingest tick: even the lean note list is
  // a whole-vault fetch, and embeddings are not latency-critical.
  // 0 DISABLES the sweep — for a deploy that doesn't want RAG, and for tests,
  // where an unref'd background timer hitting the vault is cross-test noise.
  indexIntervalMs: Number(process.env.INDEX_INTERVAL_MS ?? 300_000),
  // How often the Fathom ingester may run. It re-fetches the vault's whole
  // transcript set to dedupe, so running it on the 60s ingest tick was pure
  // waste — especially now that Fireflies is the live transcript source.
  fathomIntervalMs: Number(process.env.FATHOM_INTERVAL_MS ?? 3_600_000),
  // How often the ClickUp task ingester may run. Incremental after the first
  // backfill (cursor = max task date_updated), so a 5-minute cadence is cheap.
  // 0 DISABLES it (the on-demand /api/integrations/clickup/sync route still works).
  clickupIntervalMs: Number(process.env.CLICKUP_INTERVAL_MS ?? 300_000),
  // Server Gmail ingest (worker/gmail.ts, Architecture v2 WP1.2) — the port of the
  // desktop's email_sync. OFF by default: the desktop and the server must never
  // both run it (set the desktop's `disable_email_sync=true` FIRST). Needs the
  // `google` credential ({account}) and the co-located `gog` CLI. While on, the
  // health registry reports "email" as an authoritative SERVER source instead of
  // inferring it from the newest email note. GMAIL_INTERVAL_MS = the desktop's 3 min.
  gmailSyncEnabled: process.env.GMAIL_SYNC_ENABLED === "true",
  gmailIntervalMs: Number(process.env.GMAIL_INTERVAL_MS ?? 180_000),
  // Server Calendar ingest (worker/calendar.ts, Architecture v2 WP1.3) — the port
  // of the desktop's calendar_sync. It DELETES notes, so three independent gates:
  //   CALENDAR_SYNC_ENABLED  — OFF by default; the desktop and the server must never
  //                            both run it (set the desktop's disable_calendar_sync=true FIRST);
  //   CALENDAR_SHADOW        — fetch + diff + record intents, write NOTHING (wins over
  //                            ENABLED; safe to run alongside the live desktop sync);
  //   CALENDAR_DELETE_MODE   — log (default) | archive | delete: what a live pass does
  //                            with notes whose event vanished from Google. Anything
  //                            unrecognised falls back to "log".
  // CALENDAR_INTERVAL_MS = the desktop's 5 min. CALENDAR_MAX_ORPHANS_PER_PASS is a
  // mass-deletion brake (0 = off): above it, archive/delete apply nothing that pass.
  calendarSyncEnabled: process.env.CALENDAR_SYNC_ENABLED === "true",
  calendarShadow: process.env.CALENDAR_SHADOW === "true",
  calendarDeleteMode: parseCalendarDeleteMode(process.env.CALENDAR_DELETE_MODE),
  calendarIntervalMs: Number(process.env.CALENDAR_INTERVAL_MS ?? 300_000),
  calendarIntentsKeep: Number(process.env.CALENDAR_INTENTS_KEEP ?? 500),
  calendarMaxOrphansPerPass: Number(process.env.CALENDAR_MAX_ORPHANS_PER_PASS ?? 25),
  // Server Proton Mail ingest (worker/proton.ts, Architecture v2 WP1.2b) — the port
  // of the agent's `proton_mail.py sync` (Proton Mail Bridge IMAP on loopback).
  //   PROTON_SYNC_ENABLED — OFF by default; the script's launchd job and the server
  //                         must never both write (unload the launchd job FIRST);
  //   PROTON_SHADOW       — connect + fetch + diff + record intents, write NOTHING
  //                         (wins over ENABLED; safe alongside the live script).
  // Credential kind `proton-bridge` = {host, port, username, password, security,
  // certSha256}. Cadence/window/cap default to the script's (300 s, 7 days, 200).
  // PROTON_TIMEZONE = the zone for the note's `date` (the script used the host's);
  // empty = this process's zone. PROTON_LINK_PEOPLE links a NEW note to an EXISTING
  // person note (`email-from`) — never creates people; the script never linked.
  protonSyncEnabled: process.env.PROTON_SYNC_ENABLED === "true",
  protonShadow: process.env.PROTON_SHADOW === "true",
  protonIntervalMs: Number(process.env.PROTON_INTERVAL_MS ?? 300_000),
  protonSinceDays: Number(process.env.PROTON_SINCE_DAYS ?? 7),
  protonMaxPerPass: Number(process.env.PROTON_MAX_PER_PASS ?? 200),
  protonMailboxes: (process.env.PROTON_MAILBOXES ?? "INBOX")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  protonTimezone: process.env.PROTON_TIMEZONE ?? "",
  protonIntentsKeep: Number(process.env.PROTON_INTENTS_KEEP ?? 500),
  protonLinkPeople: process.env.PROTON_LINK_PEOPLE === "true",
  protonImapTimeoutMs: Number(process.env.PROTON_IMAP_TIMEOUT_MS ?? 30_000),
  // Messages over this RFC822.SIZE are never downloaded (intent skip-too-large, no
  // note) — bounds per-message memory; 0 = no cap.
  protonMaxMessageBytes: Number(process.env.PROTON_MAX_MESSAGE_BYTES ?? 10_485_760),
  // Live actions (Arch v2 WP1.5, routes/actions.ts, docs/live-actions.md): the
  // server acts AS THE OWNER (sends email, RSVPs, posts to Matrix). Each family is
  // OFF by default; while off its routes answer 503 `actions_disabled`.
  actionsEmailEnabled: process.env.ACTIONS_EMAIL_ENABLED === "true",
  actionsCalendarEnabled: process.env.ACTIONS_CALENDAR_ENABLED === "true",
  actionsMatrixEnabled: process.env.ACTIONS_MATRIX_ENABLED === "true",
  // Matrix rooms an AGENT-originated request (Prism MCP in-process dispatch, the
  // loopback owner token) may post/react in. The human owner via a session or
  // device token may target any JOINED room. Empty = agents may post nowhere.
  actionsMatrixAgentRooms: (process.env.ACTIONS_MATRIX_AGENT_ROOMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Proton Bridge folder that "archive" moves a message into.
  actionsEmailArchiveMailbox: process.env.ACTIONS_EMAIL_ARCHIVE_MAILBOX ?? "Archive",
  actionsSmtpTimeoutMs: Number(process.env.ACTIONS_SMTP_TIMEOUT_MS ?? 30_000),
  // Per-owner rate limits (fixed windows). Sends are the expensive/abusable ones.
  actionsEmailSendPerHour: Number(process.env.ACTIONS_EMAIL_SEND_PER_HOUR ?? 30),
  actionsMatrixSendPer10Min: Number(process.env.ACTIONS_MATRIX_SEND_PER_10MIN ?? 60),
  actionsCalendarPer10Min: Number(process.env.ACTIONS_CALENDAR_PER_10MIN ?? 30),
  // How often the worker recompiles the governance constitution into grant rows
  // (governance-grants.ts). The route path already reconciles on every successful
  // mutation, so this is the SAFETY NET, not the mechanism: it catches a
  // membership that has simply expired (nothing mutated, but the grant should
  // stop applying) and any write that landed while a reconcile failed. On a
  // deploy with no governance-config note it costs one cached probe per interval.
  // 0 DISABLES it.
  governanceReconcileMs: Number(process.env.GOVERNANCE_RECONCILE_MS ?? 300_000),
  // How often the worker asks each vault to compact its note-version history
  // (vault ≥0.7.9 only; older vaults answer 404 and are skipped). The vault only
  // compacts on its own at startup, so without this a long-running vault keeps a
  // full snapshot per update of every big, frequently-appended note. Needs a
  // `vault:<name>:admin` token: minted 1h-ephemeral per run via the operator CLI,
  // or PARACHUTE_ADMIN_TOKEN. 0 DISABLES it.
  historyCompactIntervalMs: Number(process.env.HISTORY_COMPACT_INTERVAL_MS ?? 86_400_000),
  // Worker health + staleness alerts (worker/health.ts). A source is "stale" when
  // nothing succeeded within its threshold, "failing" after WORKER_FAIL_STREAK
  // consecutive errors. A threshold of 0 turns the STALENESS check off for that
  // source (failure streaks still count). Desktop-owned sources (email, calendar,
  // skills) are inferred from the newest vault note of each kind, cached for
  // WORKER_DESKTOP_PROBE_MS. One email + vault `alert` note per episode; set
  // WORKER_ALERTS_ENABLED=false for status-only (tests do).
  // Server skill scheduler (worker/skills.ts, Architecture v2 WP1.1). Runs the
  // vault's `agent-skill` notes on the worker tick — the port of the desktop's
  // skill_scheduler. OFF by default: the desktop and the server must never both
  // run skills (set the desktop's `disable_skill_scheduler=true` FIRST). While on,
  // the server stamps `metadata.runner: "server"` on every enabled skill note it
  // takes over (the lease; the desktop skips those). Routing mirrors the desktop's
  // `effective_routing`: the skill note's `provider`/`model` override these
  // defaults; provider `local`/`ollama` + a model → LM Studio, else the WP0.1
  // claude runner. SKILLS_LOAD_FREE_MIN_PCT is the lms-guard threshold: a model
  // that is NOT already loaded is never JIT-loaded below this free-memory %.
  skillsEnabled: process.env.SKILLS_ENABLED === "true",
  skillsDefaultProvider: process.env.SKILLS_DEFAULT_PROVIDER ?? "claude",
  skillsLocalBaseUrl: (process.env.SKILLS_LOCAL_BASE_URL ?? "http://127.0.0.1:1234/v1").replace(/\/+$/, ""),
  skillsLocalModel: process.env.SKILLS_LOCAL_MODEL ?? "",
  skillsLoadFreeMinPct: Number(process.env.SKILLS_LOAD_FREE_MIN_PCT ?? 35),
  // JIT-load guard, part 2 (2026-10-03 host stall: free % was 54–76 while swap was
  // nearly full; loading the ~7 GB model paged the server and the vault out). A model
  // that is not resident loads only when
  //  (a) memory free now ≥ model size × SKILLS_LOAD_HEADROOM + SKILLS_LOAD_RESERVE_MB
  //      (no credit for swap on macOS). "Free now" = memory_pressure free % × RAM, or
  //      with SKILLS_LOAD_HEADROOM_SOURCE=reclaimable the vm_stat figure (free +
  //      cache pages — what can be handed out without paging anything out; stricter);
  //  (b) the system is not already swapping out faster than
  //      SKILLS_LOAD_MAX_SWAPOUT_PER_S pages/s (macOS vm_stat rate; 0 = off). When the
  //      prober's last sample is stale, admission waits SKILLS_LOAD_PAGING_WINDOW_MS
  //      and probes again (0 = never wait);
  //  (c) swap used ≤ SKILLS_LOAD_MAX_SWAP_USED_PCT — unset = OFF on macOS (dynamic
  //      swap total makes the % meaningless), 80 elsewhere.
  // Model size = what the model server reports, else SKILLS_LOCAL_MODEL_MB.
  skillsLoadHeadroom: Number(process.env.SKILLS_LOAD_HEADROOM || 1.0),
  skillsLoadReserveMb: Number(process.env.SKILLS_LOAD_RESERVE_MB || 2048),
  skillsLocalModelMb: Number(process.env.SKILLS_LOCAL_MODEL_MB || 7168),
  skillsLoadMaxSwapUsedPct: process.env.SKILLS_LOAD_MAX_SWAP_USED_PCT?.trim() ? Number(process.env.SKILLS_LOAD_MAX_SWAP_USED_PCT) : (null as number | null),
  skillsLoadMaxSwapoutPerS: Number(process.env.SKILLS_LOAD_MAX_SWAPOUT_PER_S ?? 2000),
  skillsLoadPagingWindowMs: Number(process.env.SKILLS_LOAD_PAGING_WINDOW_MS ?? 2000),
  skillsLoadHeadroomSource: (process.env.SKILLS_LOAD_HEADROOM_SOURCE === "reclaimable" ? "reclaimable" : "free-pct") as "free-pct" | "reclaimable",
  // null = unset: darwin uses memory_pressure + absolute free swap, linux falls back to 80%.
  skillsSwapMaxPct: process.env.AGENT_SWAP_MAX_PCT?.trim() ? Number(process.env.AGENT_SWAP_MAX_PCT) : (null as number | null),
  skillsSwapMinFreeMb: Number(process.env.AGENT_SWAP_MIN_FREE_MB || 512),
  skillsFreeMinPct: Number(process.env.AGENT_FREE_MIN_PCT ?? 15),
  /** Mid-run (between notes) free-% floor for local skills; see SkillsSettings.runFreeMinPct. */
  skillsRunFreeMinPct: Number(process.env.SKILLS_RUN_FREE_MIN_PCT ?? 8),
  skillsLocalRunTimeoutMs: Number(process.env.SKILLS_LOCAL_RUN_TIMEOUT_MS ?? 1_500_000),
  workerAlertsEnabled: (process.env.WORKER_ALERTS_ENABLED ?? "true") !== "false",
  workerFailStreak: Number(process.env.WORKER_FAIL_STREAK ?? 3),
  workerDesktopProbeMs: Number(process.env.WORKER_DESKTOP_PROBE_MS ?? 180_000),
  workerStaleMs: {
    matrix: Number(process.env.WORKER_STALE_MATRIX_MS ?? 900_000),
    clickup: Number(process.env.WORKER_STALE_CLICKUP_MS ?? 1_800_000),
    fireflies: Number(process.env.WORKER_STALE_FIREFLIES_MS ?? 108_000_000), // 30h: runs at fixed local hours
    fathom: Number(process.env.WORKER_STALE_FATHOM_MS ?? 0), // superseded by Fireflies: failures only
    email: Number(process.env.WORKER_STALE_EMAIL_MS ?? 43_200_000), // 12h: inferred from the newest email note — a quiet night is not an outage
    calendar: Number(process.env.WORKER_STALE_CALENDAR_MS ?? 86_400_000), // 24h: calendar notes only change when events do
    calendarServer: Number(process.env.WORKER_STALE_CALENDAR_SERVER_MS ?? 3_600_000), // 1h: a server pass succeeds every 5 min
    proton: Number(process.env.WORKER_STALE_PROTON_MS ?? 3_600_000), // 1h: a pass succeeds every 5 min even with no new mail
    skills: Number(process.env.WORKER_STALE_SKILLS_MS ?? 21_600_000), // 6h
  },
  // Matrix: accept pending room invites (mautrix bridges INVITE the user to every
  // new chat portal; an un-joined room never appears in /sync, so its messages
  // are invisible to the ingester). Off by default — on a long-lived bridge the
  // backlog can be 1000+ portals, and joining one creates a thread note for it.
  // MATRIX_AUTO_JOIN_PER_RUN throttles how many invites one 60s pass accepts
  // (default 10 = Synapse's rc_joins burst; a 429 ends the batch early anyway).
  matrixAutoJoin: process.env.MATRIX_AUTO_JOIN === "true",
  matrixAutoJoinPerRun: Number(process.env.MATRIX_AUTO_JOIN_PER_RUN ?? 10),
  // Matrix repair sweep (worker/matrix.ts reconcileMatrix): every interval,
  // probe EVERY joined room's newest message against its thread note and fetch
  // any gap — the net under the incremental sync. 0 disables. PER_SWEEP caps
  // repaired rooms per sweep (each one re-queues local-model triage).
  matrixReconcileMs: Number(process.env.MATRIX_RECONCILE_MS ?? 3_600_000),
  matrixReconcilePerSweep: Number(process.env.MATRIX_RECONCILE_PER_SWEEP ?? 25),
  // One Matrix pass per vault at a time (worker/scheduler.ts), so every call in a
  // pass is bounded: a hung read would otherwise stop Matrix ingest until a restart.
  // 0 = no timeout.
  matrixVaultTimeoutMs: Number(process.env.MATRIX_VAULT_TIMEOUT_MS ?? 30_000),
  matrixReadTimeoutMs: Number(process.env.MATRIX_READ_TIMEOUT_MS ?? 120_000),
  // A room a pass failed on is replayed by the following passes (the window between
  // that pass's cursor and the current one); after this many failed replays it is
  // given up on — loudly (a failed pass outcome + cursor `matrix-lost`).
  matrixReplayMaxTries: Math.max(1, Number(process.env.MATRIX_REPLAY_MAX_TRIES ?? 10)),
  // Overall budget of one reconcile sweep (it runs in the background, under its own
  // guard, one probe per joined room). Past it the rest waits for the next sweep. 0 = none.
  matrixReconcileDeadlineMs: Number(process.env.MATRIX_RECONCILE_DEADLINE_MS ?? 20 * 60_000),
  // Link message-thread notes to person notes (`messages-with`), as the desktop's
  // message_sync did via person_linker before Matrix ingest moved server-side
  // (the server ingester never ported it). OFF by default: see CLAUDE.md
  // "Matrix person linking" — on, it creates person notes for the other side of
  // DMs (rooms of <=3 joined members, bridge bots skipped) and links existing
  // people in group rooms; that is the rule that once minted ~3.3k junk stubs
  // when it had no member cap, so it is opt-in until reviewed against live data.
  matrixLinkPeople: process.env.MATRIX_LINK_PEOPLE === "true",
  // ── Identity + linking layer (docs/roadmap/workspace-experience/BACKEND-STATUS-GRAPH.md) ──
  // Everything below is OFF / inert by default: nothing links on ingest and the
  // backfill job only runs when the owner starts it (dry run unless told otherwise).
  // MATRIX_LINK_EXISTING links a thread to people who ALREADY exist (never creates
  // one — that stays MATRIX_LINK_PEOPLE). MATRIX_STORE_PARTICIPANT_IDS adds the
  // stable sender ids (`participantIds`) to thread notes so matching is by id.
  matrixLinkExisting: process.env.MATRIX_LINK_EXISTING === "true",
  matrixStoreParticipantIds: process.env.MATRIX_STORE_PARTICIPANT_IDS === "true",
  // PROTON_LINK_RECIPIENTS adds `email-to` for direct recipients who exist as people.
  protonLinkRecipients: process.env.PROTON_LINK_RECIPIENTS === "true",
  // New Fathom / Fireflies transcripts get `attended-by` links to existing people.
  transcriptLinkPeople: process.env.TRANSCRIPT_LINK_PEOPLE === "true",
  // ClickUp tasks get `assigned-to` (existing person) / `belongs-to` (existing project).
  clickupLinkEnabled: process.env.CLICKUP_LINK_ENABLED === "true",
  // Forward linkers put identities they could not resolve into the review queue.
  peopleQueueOnIngest: process.env.PEOPLE_QUEUE_ON_INGEST === "true",
  // The owner's own person note (path or id) and extra names/addresses that mean
  // "the owner" (a first name on a task). Without PEOPLE_OWNER_PERSON the note is
  // the one live person claiming OWNER_EMAIL / PEOPLE_OWNER_EMAILS, if exactly one.
  peopleOwnerPerson: (process.env.PEOPLE_OWNER_PERSON ?? "").trim(),
  peopleOwnerEmails: (process.env.PEOPLE_OWNER_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  peopleOwnerAliases: (process.env.PEOPLE_OWNER_ALIASES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // Backfill job limits. MAX_WRITES is the hard per-run cap on note PATCHes of a
  // WRITE run (a request may lower it, never raise it past PEOPLE_LINK_MAX_WRITES_CEILING).
  peopleLinkMaxWrites: Number(process.env.PEOPLE_LINK_MAX_WRITES ?? 200),
  peopleLinkMaxWritesCeiling: Number(process.env.PEOPLE_LINK_MAX_WRITES_CEILING ?? 20_000),
  peopleLinkPaceMs: Number(process.env.PEOPLE_LINK_PACE_MS ?? 50),
  // Threads: names may link in rooms of at most GROUP_NAME_MAX participants;
  // larger rooms link strong-key matches only (at most GROUP_LINK_CAP of them);
  // rooms above GROUP_MAX_MEMBERS are skipped.
  peopleLinkGroupNameMax: Number(process.env.PEOPLE_LINK_GROUP_NAME_MAX ?? 8),
  peopleLinkGroupMaxMembers: Number(process.env.PEOPLE_LINK_GROUP_MAX_MEMBERS ?? 50),
  peopleLinkGroupLinkCap: Number(process.env.PEOPLE_LINK_GROUP_LINK_CAP ?? 15),
  // Matrix membership lookups the backfill may make per run (0 = never ask Matrix).
  peopleLinkMemberLookups: Number(process.env.PEOPLE_LINK_MEMBER_LOOKUPS ?? 300),
  peopleLinkMemberPaceMs: Number(process.env.PEOPLE_LINK_MEMBER_PACE_MS ?? 150),
  // The review queue never holds more than this many OPEN rows per vault; past
  // it nothing is inserted and the caller counts `queue-full`.
  peopleQueueMaxOpen: Number(process.env.PEOPLE_QUEUE_MAX_OPEN ?? 1000),
  // Open rows FILED BY AGENTS (prism_people_file_review) are capped separately
  // and never count toward PEOPLE_QUEUE_MAX_OPEN, so they cannot crowd out
  // ingest rows. 0 = agents cannot file.
  peopleQueueMaxAgentOpen: Number(process.env.PEOPLE_QUEUE_MAX_AGENT_OPEN ?? 100),
  // Consecutive failed Matrix membership lookups that end a run's lookup stage.
  peopleLinkMemberFailures: Number(process.env.PEOPLE_LINK_MEMBER_FAILURES ?? 3),
  // The job / merge abort after this many consecutive failed writes that are not
  // a 409 (a broken vault must end the run as an ERROR, not as "done").
  peopleLinkMaxConsecutiveErrors: Number(process.env.PEOPLE_LINK_MAX_CONSECUTIVE_ERRORS ?? 5),
  // Every vault call the job / merge / resolve makes is abandoned after this long.
  peopleVaultTimeoutMs: Number(process.env.PEOPLE_VAULT_TIMEOUT_MS ?? 30_000),
  // Emails with more direct recipients than this get no `email-to` links.
  peopleLinkMaxRecipients: Number(process.env.PEOPLE_LINK_MAX_RECIPIENTS ?? 10),
  // Agents working the review queue through Prism MCP (mcp/tool-people.ts): how
  // many rows one credential may resolve/dismiss, how many gaps it may file and
  // how many merge RECOMMENDATIONS it may record per rolling 24 h. 0 = none.
  peopleAgentDecisionsPerDay: Number(process.env.PEOPLE_AGENT_DECISIONS_PER_DAY ?? 200),
  peopleAgentFilesPerDay: Number(process.env.PEOPLE_AGENT_FILES_PER_DAY ?? 50),
  peopleAgentRecommendationsPerDay: Number(process.env.PEOPLE_AGENT_RECOMMENDATIONS_PER_DAY ?? 50),
  // …and per ACCOUNT across all of its credentials together (a second ceiling).
  peopleAgentAccountDecisionsPerDay: Number(process.env.PEOPLE_AGENT_ACCOUNT_DECISIONS_PER_DAY ?? 400),
  peopleAgentAccountFilesPerDay: Number(process.env.PEOPLE_AGENT_ACCOUNT_FILES_PER_DAY ?? 100),
  peopleAgentAccountRecommendationsPerDay: Number(process.env.PEOPLE_AGENT_ACCOUNT_RECOMMENDATIONS_PER_DAY ?? 100),
  // Agent decision ledger rows and CLOSED merge recommendations older than this are pruned.
  peopleAgentRetentionDays: Number(process.env.PEOPLE_AGENT_RETENTION_DAYS ?? 180),
  // Bridge chat-list resync: `<management room id>=<command>` pairs, comma-
  // separated (e.g. `!abc:localhost=sync-chats`), sent every interval. A
  // bridge only portals chats Telegram/etc. PUSHES updates for; with hundreds of
  // chats that push is unreliable, and an un-portaled chat is invisible to
  // Matrix — so ask the bridge to walk its dialog list on a schedule.
  matrixBridgeResync: (process.env.MATRIX_BRIDGE_RESYNC ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf("=");
      return { roomId: x.slice(0, i), command: x.slice(i + 1) };
    })
    .filter((x) => x.roomId.startsWith("!") && x.command),
  matrixBridgeResyncMs: Number(process.env.MATRIX_BRIDGE_RESYNC_MS ?? 10_800_000),
} as const;

/**
 * A single Parachute vault the server can bind a request to. Tokens live ONLY
 * here, server-side — they are never serialized to a client (see the
 * `GET /api/vaults` response in routes/vaults.ts, which omits `token`/`url`).
 */
export interface VaultEntry {
  id: string;
  label: string;
  url: string;
  vault: string;
  token: string;
}

/**
 * The vault registry (multi-vault Phase 1). Optional `PRISM_VAULTS` env is a
 * JSON array `[{id,label,url,vault,token}]`. When unset/empty we synthesize ONE
 * entry, "primary", from the existing single-vault config — so the default
 * behavior with one configured vault is byte-for-byte unchanged. The first
 * entry is always the primary/default (what `resolveVaultEntry()` returns with
 * no id, and what every non-owner route + the legacy `vault` client use).
 */
function buildVaultRegistry(): VaultEntry[] {
  const raw = process.env.PRISM_VAULTS?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`PRISM_VAULTS is not valid JSON: ${(e as Error).message}`);
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((e, i) => {
        const o = (e ?? {}) as Record<string, unknown>;
        const id = String(o.id ?? `vault-${i}`);
        return {
          id,
          label: String(o.label ?? o.vault ?? id),
          url: String(o.url ?? config.parachuteUrl).replace(/\/+$/, ""),
          vault: String(o.vault ?? config.parachuteVault),
          token: String(o.token ?? ""),
        };
      });
    }
  }
  return [
    {
      id: "primary",
      label: config.parachuteVault,
      url: config.parachuteUrl,
      vault: config.parachuteVault,
      token: config.parachuteToken,
    },
  ];
}

export const vaultRegistry: VaultEntry[] = buildVaultRegistry();

// NOTE: `resolveVaultEntry()` lives in db.ts (not here), because the runtime
// registry is the ENV base (this `vaultRegistry`) MERGED with owner-added vaults
// stored in SQLite. db.ts already imports config, so the merge/resolve goes there
// to avoid a config↔db import cycle. Import it from "./db".

/** Whether a real embedding endpoint is configured (else the offline fallback). */
export const embeddingsConfigured = () => config.embedEndpoint.length > 0;

/** Whether magic-link email sign-in is available (Resend configured). */
export const emailEnabled = () => config.resendApiKey.length > 0;

/** Fail fast at startup if required secrets are missing. */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.parachuteToken) missing.push("PARACHUTE_TOKEN");
  if (!config.sessionSecret) missing.push("SESSION_SECRET");
  if (!config.ownerEmail) missing.push("OWNER_EMAIL");
  // Each vault in the registry needs a url + vault name + token to be usable.
  // (For the default single-vault case this mirrors the PARACHUTE_* check above;
  // explicit PRISM_VAULTS entries are validated individually.)
  for (const v of vaultRegistry) {
    const bad = [!v.url && "url", !v.vault && "vault", !v.token && "token"].filter(Boolean);
    if (bad.length) missing.push(`PRISM_VAULTS["${v.id}"] (${bad.join("+")})`);
  }
  const unique = [...new Set(missing)];
  if (unique.length) {
    throw new Error(`Prism Server misconfigured — missing env: ${unique.join(", ")}`);
  }
  // Two live writers of vault/messages/email/ (WP1.2b). Shadow writes nothing, so
  // GMAIL_SYNC_ENABLED + PROTON_SHADOW is allowed.
  if (config.gmailSyncEnabled && config.protonSyncEnabled && !config.protonShadow) {
    throw new Error(
      "Prism Server misconfigured — GMAIL_SYNC_ENABLED and PROTON_SYNC_ENABLED are both true: both would write email notes under vault/messages/email/. Turn one off (email comes from Proton Bridge; Gmail is not provisioned on the account).",
    );
  }
}

export type CalendarDeleteMode = "log" | "archive" | "delete";

/** CALENDAR_DELETE_MODE → a known mode. Fails SAFE: unset, empty or a typo is
 *  "log" (nothing deleted), never "delete". */
export function parseCalendarDeleteMode(v: string | undefined): CalendarDeleteMode {
  const m = (v ?? "").trim().toLowerCase();
  if (m === "archive" || m === "delete" || m === "log") return m;
  if (m) console.warn(`[config] CALENDAR_DELETE_MODE="${v}" is not log|archive|delete — using "log"`);
  return "log";
}
