# Prism Architecture v2 — the Mac mini is the node, everything else is a client

Status: **proposal for review** · 2026-09-30 · companion: [`WORKPLAN.md`](WORKPLAN.md)
Evidence: four research reports (desktop/server split, Tauri mobile, server agent sessions, Prism MCP) under
`docs/roadmap/parachute-upgrade/research/arch-*.md` (local-only; they quote private config), plus the
2026-09-30 post-upgrade performance incident.

## 1. Why now

Four asks, one root problem:

| Ask | What blocks it today |
|---|---|
| Run the desktop app on the laptop | The desktop **is** part of the backend. On the Mac mini it runs Gmail → vault, Calendar → vault (with deletes), the skill scheduler (message + ClickUp triage), an embedding push, and every agent turn. A second copy would double-ingest; it also holds a whole-vault token and relies on loopback-only owner auth. |
| A real phone app | The web shell is the right base, but auth is a same-origin session cookie, and there is no server agent the phone can talk to. |
| Ask an agent from the phone, run it on the mini | `apps/server/src/agent-exec.ts` + `routes/agent.ts` exist but are one-shot, in-memory, unhardened (they load every MCP server in `~/.claude.json`, allow `Read`), and **no client calls them**. |
| A Prism MCP | Agents only reach the vault MCP: no comments, suggestions, governance, sharing, semantic search, collab-safe edits — and member-minted tokens are **whole-vault**, bypassing Prism's per-note permissions (they can even forge governance notes). |

Plus what the upgrade exposed: if `Prism.app` quits on the mini, email/calendar ingest and all triage stop silently;
each desktop launch saturates the single-threaded vault for ~1 minute; and the mini runs close to its 16 GB limit.

## 2. Target architecture

```
                         ┌──────────────── Mac mini: the Prism node ─────────────────────────────┐
  iPhone app (Tauri) ─┐  │  Prism Server (Node, pm2)                                              │
  Laptop app (Tauri) ─┼──┤   ├ Auth plane: sessions · device tokens · MCP credentials            │
  Web / PWA ──────────┤  │   ├ Gateway /api (effectiveCaps on every non-owner call; read-coalesced)│
  Agents (MCP) ───────┘  │   ├ Agent runtime /api/agent (sessions, stream, replay, push)          │
     via Cloudflare      │   ├ Prism MCP /mcp (permission-aware tools, collab-safe writes)        │
     tunnel (https/wss)  │   ├ Collab /collab (Yjs)                                              │
                         │   ├ Workers: Matrix · ClickUp · Fireflies · Fathom · Gmail · Calendar  │
                         │   │          · skills (LM Studio, admission-guarded) · index · mirror  │
                         │   └ Push: Web Push → APNs                                             │
                         │  Parachute hub + vault (the only holder of data; token only in server) │
                         │  LM Studio · Docker (Synapse + bridges, Buzz)                          │
                         └───────────────────────────────────────────────────────────────────────┘
```

**Principles**

1. **One node, many clients.** Every background process, credential, CLI login and agent turn lives on the mini.
   Clients render, edit, and call the server — they never ingest and never hold a vault token.
2. **One auth plane.** Browser → session cookie. Native apps → a revocable per-device token obtained by signing in
   through the system browser (PKCE + deep link). Agents → a Prism MCP credential. All three resolve to the same
   `Actor`, so `effectiveCaps` stays the single permission guard.
3. **One client codebase.** The web build (`HttpVaultClient` over the gateway) becomes the client for *every*
   surface: browser, PWA, laptop app, iPhone app. Native shells add only plugins (keychain, deep links, push,
   notifications, share sheet). The Rust-heavy desktop becomes a legacy "host" mode, retired once the server owns
   ingest.
4. **Agents are first-class clients.** The agent runtime and the Prism MCP use the same gateway and permission math
   as people; the vault MCP stays for the owner's bulk/admin work.
5. **Protect the node.** Single-threaded vault → coalesce and project reads, replace polling with the vault's live
   subscribe. 16 GB host → every local-model and agent run passes a memory admission check.

## 3. The four components

### 3.1 Server owns ingest (desktop becomes a client)
- A desktop `ingest_mode: host | client` switch plus per-service disable flags ship **first** — no laptop install
  before it exists.
- Port to `apps/server/src/worker/`: skill scheduler (with LM Studio admission), Gmail, Calendar (deletes run
  dry-run/log-only first and are compared with the desktop's decisions). Same note paths and dedupe keys, so the server
  converges on existing notes instead of duplicating them. Each is a one-step cutover: disable on the desktop, then enable on the server.
- Retire Meetily (dormant) and the idle Notion task sync; drop the duplicate desktop embedding push now.
- Worker status + staleness alerts, so a stopped ingest can never be silent again.
- Live actions (send/archive email, RSVP, reply in Matrix) become admin-only, audited server routes.

### 3.2 Agent runtime on the server
- Durable sessions (`agent_sessions / agent_turns / agent_events`), one hardened `claude -p` per turn with
  `--output-format stream-json`, `--session-id` → `--resume`, `--strict-mcp-config`, a tool allowlist, empty cwd,
  secret-free env, budget cap. SSE stream with replay by sequence number, so a phone can background, reconnect,
  and catch up. Boot sweep marks orphaned turns `interrupted`.
- Every session mirrored to a vault note (`agent-session`) for audit and search.
- Concurrency 1 by default plus a memory admission check (the 16 GB host also runs a 12B model).
- Push on completion: Web Push first (PWA), APNs when the phone app lands.
- Owner-only on the claude.ai subscription. Members later move to an API key (`--bare`) plus Prism MCP tools.

### 3.3 Native clients (laptop + phone) — one Tauri client shell
- New `apps/client` Tauri 2 shell (macOS + iOS; Android later) that bundles the web build in a "native" mode:
  no service worker, a configurable server origin, a device token from the keychain, and fetch-based SSE.
- Sign-in via the system browser → `/auth/device/authorize` (reuses owner magic link, passwords, invites) → deep
  link back → `/auth/device/token`. Tokens are hashed, revocable, and listed per device in Account settings. The collab
  socket and every route accept them.
- Offline: the existing IndexedDB outbox for writes, plus a new read-through cache in `HttpVaultClient` (it helps the PWA
  too).
- Laptop gets menu-bar/global-shortcut/notification extras; the phone gets share-sheet capture and agent push.
- iOS needs Xcode, the iOS Rust targets, and Apple Developer enrollment. Personal use ships through TestFlight
  (no public-review risk).

### 3.4 Prism MCP
- Stateless Streamable-HTTP endpoint at `/mcp` on the Prism Server (`@modelcontextprotocol/server` v2, per the
  2026-07-28 spec). Every tool calls the existing routes in-process, so `resolveActor → effectiveCaps` is the only
  guard, and `tools/list` is filtered per actor.
- v1 tools: permission-filtered notes CRUD, semantic search, versions/restore, **collab-safe** updates (Yjs diff
  when the note is live), comments, suggested edits, spreadsheet ranges, dashboard queries, governance
  (state/propose/vote), scoped sharing. Never: publishing, federation, members/invites, server config, token minting.
- Auth v1: Prism-issued personal access tokens (per actor, hashed, revocable) + the owner's hub JWT. Member
  whole-vault vault tokens are retired once this ships. Spec-grade OAuth waits on hub per-surface audiences.
- Governance notes get an integrity signature from the server, so a vault-level writer can no longer forge memberships
  or votes.

## 4. Performance and capacity (node protection)
- Done 2026-09-30: gateway read coalescing + 5 s cache; Docker VM capped 8 → 3 GB (swap 5.5 → 2.8 GB).
- Next: a server-maintained **tree projection** (`GET /api/tree`: id/path/tags/type only, refreshed on writes and
  by the vault's live subscribe) instead of every client pulling ~16 MB; replace dashboard polling with
  subscribe-driven invalidation; ingesters use `if_exists` upserts (ends the create-409 storm); per-worker
  tag-scoped tokens (honest attribution, smaller blast radius).

## 5. What stays the same
The vault is the only data store; Prism's SQLite stays for grants/sessions/collab state; governance, publishing,
federation, renderers and the collab model are untouched; the web app keeps working at every step. Each cutover is
reversible (flags flip back; the desktop stays in host mode until the server has proven each source).

## 6. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Apple Developer Program ($99/yr) + install Xcode on the mini | Yes, required for the iPhone app. It's user-gated, so start early. |
| D2 | One Tauri client shell for laptop + phone (retire the Rust-heavy desktop after cutover) vs keep evolving the current desktop | One client shell |
| D3 | Agent auth | claude.ai subscription for owner-only now; an API key before any member uses agents |
| D4 | Push order | Web Push (PWA) first, APNs with the phone app |
| D5 | Member agents | Prism MCP PATs replace whole-vault member tokens (after WP6) |
| D6 | Local model for background skills | Keep gemma-12B behind the admission guard, or move triage to the ~4B model (saves ~4 GB per run) |
| D7 | Merge `claude/parachute-0.7.9-upgrade` to `main` and push | Yes, before architecture work branches from it |
