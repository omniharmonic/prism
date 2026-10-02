# Feature verification ledger

This is the completion checklist for the approved R00–R16 plan, not a claim that every feature passes. Code inventory: `ced95c1`; deployment evidence belongs in [RELEASE-CHECKPOINTS.md](RELEASE-CHECKPOINTS.md). A passing server suite establishes isolated contracts, not successful live integration actions.

Production checks use synthetic notes and destinations verified to be private to the owner/bot. Never start the retired full desktop app just to satisfy its obsolete process monitor: ingestion now belongs to Prism Server. The installed thin app is `/Applications/Prism Client.app`.

## Runtime baseline

| Surface | Actual evidence | Remaining acceptance |
| --- | --- | --- |
| Prism Server / vault | Local/public health and eight active worker successes checked; only Prism Server restarted for incremental releases | Final migration parity ledger and full multi-client performance run |
| Web/PWA | Authenticated owner session; real service-worker update; private collaborative edits and reload; phone-width search/settings/calendar/link navigation | Physical iOS/Android/PWA, keyboard/IME/dictation, lock/unlock and full offline recovery |
| Installed thin client | Blank startup fixed; sign-in/workspace, real editing, live web collaboration, agent tools and review, calendar/search/wikilinks checked | Native extras below; capture screenshots unavailable to the automation process |
| Legacy desktop host | Application typecheck continues to pass; source retained for compatibility | Do not treat typecheck as runtime acceptance; isolated host test/build required without duplicate ingestion |
| Agent monitor | Companion commit `2d8a038` checks server/vault/workers instead of retired Prism.app; six isolated tests and live read-only probe | Observe the next normally scheduled monitor run; no test alert sent |

## Registered renderers and editing paths

The registry is `packages/core/src/components/renderers/Registry.ts`; collaborative adapters are selected by the host separately. Every row has a concrete remaining test journey even where the current evidence is only a code inventory.

| Feature | Current evidence | Required next journey / completion gate |
| --- | --- | --- |
| Document, note, briefing | Workspace/autosave/formatting/rename/recovery checks; private live web/native editing; production removed-note recovery | Large document, tables, media, code blocks, source round-trip, 200% zoom, large-scale editor performance; selected/unsaved context now covered by fixtures, production web snapshot receipt verified |
| Collaborative rich text | Scoped CRDT storage, actual web/native concurrent edits, individual agent suggestion accept/reject | Two reviewers with conflicting decisions, durable review audit, legacy draft recovery, physical offline reconnect |
| Message thread | Server live-source pages on web/thin client, stable event-ID deduplication, saved-window paging, identity/date labels and failure fixtures; production private self-room send→live read→reload verified exactly once | Private Telegram-via-Matrix inbound→canonical person; structured ingest/archives, edit/redaction reconciliation, media; installed batch acceptance (mobile composer clearance and stable responsive live reader verified) |
| Email | Rendering/composer fixtures and server source support | Private self-mail inbound→person link→Reply/Reply all/attachments, retained failed draft, no duplicate send |
| People | Access-filtered directory/profiles, explicit canonical links, guarded email/Matrix decisions and mobile/draft/error fixtures | Private production account add/remove and linked-record navigation verified; remaining identity repair preview/resume and ambiguity review queue |
| Inbox (`messages-dashboard`, `vault-messages`) | Triage, channel labels, limited-result disclosure, phone screenshots | Summary projection/paging; desktop split view; canonical People detail/review |
| Event and Calendar dashboard | Matching ambiguity/time tests; actual private event→exact meeting/transcript navigation on web/native; overlap/multi-day layout | Private external-calendar update/recurrence/notification readback; manual transcript overrides and multiple-recording writer |
| Code / collaborative code | Deferred engine and initial-Y.Text correction; real-Hocuspocus delay/save/reload; private production edit/reload/resize/undo/redo; view-only downgrade fixture | Production two clients edit separate lines; language/source round-trip; rename/export; read-only denial |
| Presentation | Registered renderer retained | Slide navigation, editing, fullscreen and export in web/native; small screen controls |
| Task / task board | Configurable per-note views, explicit ungrouped values, guarded property moves, list/menu/drag/read-only and pending-write fixtures pass | Private web/native moves, view persistence and live task-document opening verified. Property/date filter editing and unchanged tasks verified in private production web; view-local manual order and compact lists pass fixtures. Remaining: production/native ordering, paginated inventory and broader shared-vault journeys |
| Project | Registered renderer retained | Related tasks/notes, property edits and linked-source navigation in both clients |
| Spreadsheet / collaborative spreadsheet | Deferred adapter and failed-download recovery with real Hocuspocus cells; private production phone edit/reload | Production concurrent cell edits; formulas/import/export; paste ranges; read-only and reload |
| Website | Registered renderer retained | Safe preview/source edit, hosted build/publish controls and private preview; no secret-bearing embeds |
| Dashboard and widgets | Registered configurable dashboard retained | Widget inventory, filters/layout persistence, shared board source semantics, mobile scroll and read-only states |
| Canvas (legacy/local path) | Durable authored assertions, fresh endpoint access, retry/stale-scene/manual-link fixtures; legacy bridge Rust check passes; derived overlays never become assertions | Alternate host runtime, reviewed orphan/canvas-deletion cleanup and large-scene performance |
| Collaborative canvas | Production two-canvas shared-edge and manual-edge preservation verified; focused same-editor workspace, access-checked card navigation and decorative arrows; source bodies/metadata unchanged | Installed batch acceptance, real two-human/offline/retry journeys, canvas-deletion cleanup and large-scene performance |
| Focused graph / fullscreen | Scoped server neighborhood tests; 2D/list navigation, filters, access revalidation, mobile/fullscreen and 3D failure fixtures | Private web/native navigation verified; indexed/paginated large neighborhoods, saved exploration, performance/reduced-motion acceptance |
| 3D graph / publication graph | Existing renderer preserved behind lazy load; actual tooltip consumer treats markup as text | Actual WebGL interaction on installed client and public/private publication fixtures |
| Bioregion entity | Registered renderer retained | Type-specific properties, map/entity links and access-limited view |
| Map | Registered virtual renderer and media/map proxy seams retained | Private markers, filtering/detail navigation, token-free proxy on native, unavailable-provider fallback |
| Agent chat / document panel | Actual private read-only, suggest-only and read/write tool flows; persisted sessions/cost/context/drafts | Active-tool downgrade barrier in production, source preview continuity and broader document adapters; selected/unsaved/text-file snapshots verified in production web, durable follow-ups execute once without an open production browser |
| Agent activity / Automations | Registered activity dashboard and HostServices retained | Schedule/lease/history/cancel, local-vs-Claude routing and failure recovery using an isolated skill |
| Network administration | Workspace/vault/member/server/federation/governance/publishing panels retained | Rows below; every control must honor effective capabilities |
| Unknown content type | Placeholder remains the fallback | Unsupported type is visibly recoverable; raw content survives without being rewritten |

## Cross-cutting features, integrations and native extras

| Area | Current evidence | Concrete remaining verification |
| --- | --- | --- |
| Search/index | Scoped vectors, fresh snippets, durable job and permission tests; production private semantic result and index status | Secondary-vault private index lifecycle, production pause/resume if needed, recall/latency benchmark, large-inventory pagination |
| Wikilinks/backlinks | Unified ID/path/alias resolution; copy/paste/keyboard/rename fixtures; production aliases and ambiguous choices | Property/backlink polish; split-mark rich formatting; batch preview→cancel→resume on synthetic notes |
| Comments / suggestions | Shared schema/anchors and suggestion review tests; actual private agent edits | Guest comment/suggest/edit matrix; anchored-comment limits; concurrent review decisions |
| Guests/sharing | Responsive sharing panels and scoped role controls; real web guest-link revocation and installed owner reconnect; idle expiration and downgrade regressions | Production sharing/guest-link revoke/self-grant cleanup and responsive draft retention verified; installed native sharing panels and dismissal verified after Keychain approval. Remaining: account invitation/onboarding; full guest role matrix and effective-access preview |
| Governance | Existing signed policy/proposal services retained | Isolated shared vault: presets→policy preview→proposal→vote/quorum→apply/audit; bypass attempts through properties/agent/canvas/sync |
| Wiki publishing | Existing templates/scoped routes retained; graph export compatibility retained | Owner-private draft/preview/settings revision/restore, password and revoked access, private-link redaction, navigation/themes/assets |
| GitHub folder sync | Host seam and server implementation retained | Owner-private test repository; mapping/conflict/dry-run where supported; verify scope before any automatic push |
| Notion database / per-note sync | Host seam and setup modal retained | Owner-private test database/page; mapping, push/pull, unmapped-field preservation and retry/readback |
| Google Docs/Sheets/Slides sync | Delivered host services retained | Owner-private test resources; mapped content and conflict readback; no external sharing |
| Matrix/Telegram / Proton | Worker health checked; identity ambiguity tests | Private owner-only Matrix room send→live read→worker ingestion verified; self-email/Telegram destinations and canonical identity still pending |
| Fireflies / Fathom / calendar | Worker health and transcript matcher tests | Verify real source field parity read-only; synthetic calendar/transcript linking must never trigger provider deletion |
| ClickUp | Worker health and delivered service retained | Private test task/list only; mapping and readback; do not notify real collaborators |
| Skills / model routing | 19 HostServices seam checks; production active skills worker | Isolated harmless skill, cancel/lease/restart and local routing availability; maintain single server scheduling authority |
| Themes / brand / accessibility | Shared prism assets/tokens, mobile/header/keyboard fixtures and screenshots | All icons/export sizes, light/dark/high contrast, 200% zoom, reduced motion and physical touch targets |
| Native login/keychain/origin | User sign-in plus installed authenticated starts; six packaged Chromium/WebKit startup checks | Logout/token revocation, origin restriction and server switch in actual app; no credentials in logs |
| Native menus/windows/tray/shortcuts | Rust modules retained; earlier isolated native tests | Multiwindow, tray open/quit, menu accelerators, deep links and quick capture without disturbing real work |
| Native file drop / export / capture | `dropfiles.rs`, `export.rs`, `capture*.rs` retained | Synthetic files only; cancellation, destination handling, attachment round-trip and permission-denied recovery |
| Notifications/push | Server/native implementations retained | Private synthetic notification, click-back target, opt-out and permission denial |
| Offline/outbox/storage | Browser conflict/idempotency/scope/quota tests; production reconnect/scoped CRDT; account-scoped shortcuts and query cache isolation; private production favorite/recent reload; original-audience autosave and blocked-draft recovery fixtures | Legacy queue recovery, crash during write, multi-tab composer conflicts, physical PWA cold-start recovery |

A feature is complete only when its implementation and relevant client/production journey have named evidence. Empty cells, retained code, test counts and migration handoff assertions do not count as a pass.
