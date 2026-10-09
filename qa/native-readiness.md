# Native readiness: Prism iOS/macOS and Omni

Benjamin Life (@omniharmonic) · 2026-10-08 · read-only review, nothing built or run.

Sources: `CLAUDE.md`, `docs/native-auth.md`, `docs/client-app.md` (§ iOS app,
§ Owner procedure), `docs/push.md`, `docs/events.md`,
`apps/server/src/routes/app-links.ts`, `apps/client/src-tauri/src/links.rs`,
the Omni contract (`omniharmonicagent/docs/omni/integration-contract.md`,
`decisions-for-benjamin.md` D4/D9), and the last 8 commits on this branch.

Ratings: **stable** = documented, tested, unchanged for several waves ·
**settling** = shape fixed, fields still being added · **volatile** = changed
recently or tied to an open decision.

---

## 1. Honest status

| Piece | State |
|---|---|
| macOS Prism Client (Tauri) | In daily use since WP4.3 |
| iOS target of the same app | **Compiles and runs (2026-10-08).** The debug simulator build succeeds (Xcode 27 / iOS 27) and the app was run in the simulator (`qa/ios-simulator-findings-2026-10-08.md`) and, the same day, on the owner's iPhone against production as a debug build. That was an informal session: no per-row device result is recorded (the sitting is `qa/device-pass-script.md`). No release / ad hoc build, no push, no universal-link tap has been checked. **TestFlight remains gated on parity sign-off.** |
| Swift plugin `plugins/prism-ios` | Compiles as part of that build. Only `LockPolicy` has tests (on the Mac) |
| Omni app | Not started. The only Swift today is `OmniVoice` (macOS), which talks to the unauthenticated loopback dashboard `:8420` |
| PrismKit (shared Swift package) | Proposal only |

Prerequisites before any iOS work:
- A Mac with Xcode 15.3+ and the iOS platform. Never build on the production host.
- Apple team `83Y42N33H8` signed in, plus a development or ad hoc profile for
  `com.benjaminlife.prism.client`.
- An APNs `.p8` key on the server (`APNS_KEY_PATH` at 0600, `APNS_KEY_ID`,
  `APNS_TEAM_ID`, `APNS_TOPIC`). Unset means push is off.
- Universal links need a team-signed build with an embedded profile. An ad hoc
  build that carries `associated-domains` is killed at launch.
- TestFlight only after full parity sign-off (owner rule).

---

## 2. Server APIs the apps need

All calls go to one origin with `Authorization: Bearer pd_…`.

| Area | Routes | Rating | Why |
|---|---|---|---|
| Sign-in | `/auth/device/authorize`, `/auth/device/token`, `/auth/devices`, `/auth/me` | stable | RFC 8252 + PKCE S256, documented, tested. Omni needs `omni://auth/callback` in `DEVICE_REDIRECT_URIS` and ideally its own `client_id` (small server change) |
| Tree | `GET /api/tree` | stable | ETag/304. Fields are additive (`icon`, `title`, `aliases` added late); decode unknown fields leniently |
| Change feed | `GET /api/events` (SSE) | stable | Ids only; reconnect means resync; `tree: true` flag |
| Note read | `GET /api/notes/:id`, versions | stable | `_caps`/`_review`/`_creator` exist for members only |
| Note write | `POST /api/notes`, `PATCH …` with `if_updated_at` | settling | Owner and member speak different dialects (`tags:{add,remove}` vs `add_tags/remove_tags`). The new single-write `changeTags` (325db08) picks the dialect from `_caps`. A native writer must do the same |
| Search | `GET /api/search`, `/api/search/filters` | stable | `sort`, `editor=` are newer but feature-detected |
| Tasks / databases | `POST /api/query`, `/api/properties/:id`, `/batch` | settling | Core shape is fixed; options keep growing (aggregates, `@me`, `assignedToMe`) |
| Schemas | `GET /api/schemas` | volatile | New hints every wave. d092e4e added `relationTarget {tag\|pathPrefix}` and `multiple`, with `relationTag` kept, plus the owner-only `POST /api/schemas/relation-targets` backfill |
| History writer | version rows and `/activity` `writer.kind` | volatile | d7993dc added `external` ("Changed outside Prism"). Treat any unknown kind as `unknown` |
| Notifications | `/api/notifications*`, `/api/reminders` | stable | Categories are additive (`assignment` is new) |
| Push | `POST/DELETE /api/push/apns` | stable | Payload is ids only: `/inbox/<id>` or `/agent/<uuid>` |
| People | `/api/people/conversations`, `/:id/conversations` | settling | New in w16 |
| Agent | `/api/agent/sessions`, turns, SSE `?after=seq` | settling | The wire format is copied into `@prism/core` and its reducer is tested. Gated **server-owner only** (D3) until per-actor tokens exist. Fine for Benjamin |
| Live actions | `/api/actions/*` | volatile | Flags off; idempotency keys and human origin required |
| Live editing | Hocuspocus `/collab?schema=5` | volatile | Schema bumped v3 to v5 in a few waves. Since 0527a1a, an unknown-kind load is refused with `busy` and the client retries (0.6/1.2/2.4 s). **Never write a native editor against it** |

Gaps on the server side:
- No `/api/version` check for client skew.
- No server-rendered note JSON.
- One `client_id`.
- Keychain item is not shared across apps or extensions.

---

## 3. What Omni can reuse

### Record card

Build it from data that already exists, not from a new endpoint.

| Field | Source | Rating |
|---|---|---|
| `id`, `path`, `tags`, `updatedAt`, `icon`, `title` | `/api/tree` row (title = `metadata.title`, else the path leaf) | stable |
| `type` | `inferContentType`: `prism_type` → known `type` → tag map in `tag-schemas.json` → extension → `document`. Ship the same JSON in PrismKit | stable |
| change summary | one line: changed keys + body size delta; richer diff from `/versions` | settling |
| writer kind | `person`/`guest`/`agent`/`suggestion`/`accepted-suggestion`/**`external`**/`unknown` | volatile (just grew) |
| live "edited since" | `/api/events` upsert for that id | stable |

The Omni contract §5 lists only four writer kinds. Add `external` there, and
treat any unknown kind as "unknown". Writes made through the raw Parachute MCP
show as `external` once the stamp is stale, which is one more reason to route
agent writes through the Prism MCP (`agent` kind).

### Deep links to a note

| Form | Example |
|---|---|
| Custom scheme | `prism://page/<id>` |
| Universal link | `https://<origin>/page/<id>` (also `/collab/<id>`, `/inbox[/<id>]`, `/agent[/<uuid>]`) |

Rules:
- The allowlist lives in three places, which must be changed together:
  `routes/app-links.ts`, `links.rs`, and `apps/web/src/native/appLinks.ts`.
- Ids must match `[A-Za-z0-9_-]`. Any query string stays in the browser.
- `prism://auth/*` is dropped silently.
- The association file is served only when the request host equals
  `APP_ORIGIN`'s host. `APPLE_APP_ID` accepts a comma list, so Omni can get its
  own `/omni/*` paths.
- **The fragment is dropped** (`links.rs`), so `/page/<id>#h-<slug>` opens
  the page at the top in the app. Heading links work only on the web.

How a link reaches the page:
1. `RunEvent::Opened` → validate.
2. Only a valid link foregrounds the app.
3. The shell holds one pending path (10-minute TTL).
4. `prism:open-link` → `openTab`. The app never navigates the window.

App-lock gate (iOS): nothing is handed to the page while the app is locked. The
link waits for `lock_ready` and for Swift `waitUnlocked`. Tapped notifications
are held the same way. Any new native-to-page hand-off must use this gate.

---

## 4. Recommendation

| App | Choice | Why |
|---|---|---|
| Prism (iOS + macOS) | **Finish the Tauri iOS client** | Its value is the editor, databases and collab, all in `packages/core`. A SwiftUI rewrite would have to match schema v5 or y-prosemirror deletes content. The security plumbing is already written. The risk that was "never compiled" is gone (it compiles and runs since 2026-10-08); what remains is the recorded device pass, which is days to weeks of work |
| Omni | **SwiftUI** | Small, list- and chat-shaped, runs on stable JSON APIs, and voice needs on-device Speech. Notes are read-only previews; "Open in Prism" uses the universal link |
| Shared | **PrismKit** Swift package | Auth (PKCE, `ASWebAuthenticationSession`, Keychain), `PrismClient` transport, SSE, Codable models, agent-session reducer port, APNs registration, link validator, `LockPolicy`/`AppLock` lifted from the plugin, content-type table, read-only renderer |

Native extensions for Prism (share extension, widgets, App Intents) can be
SwiftUI on PrismKit later. They need a shared keychain access group.

---

## 5. Cold-start deep-link test plan

Run on a signed device build, never on the production host.

| # | Setup | Action | Expect |
|---|---|---|---|
| 1 | App killed, signed in | Tap `https://<origin>/page/<id>` in Notes | App launches, opens that page once |
| 2 | Killed | `prism://page/<id>` from Safari | Same page; no duplicate tab |
| 3 | Killed, app lock on | Tap a page link | Lock cover first; page opens only after Face ID |
| 4 | Killed, lock on | Tap an APNs notification | Held until unlock, then `/inbox/<id>` or `/agent/<uuid>` |
| 5 | Killed, signed out | Tap a page link | Sign-in; after the reload, the link opens from `prism:pending-link` (≤ 10 min) |
| 6 | No server set (fresh iOS install) | Tap a link | Setup screen; link refused, nothing kept |
| 7 | Killed | Link with `?utm=x` | Opens in Safari, not the app |
| 8 | Killed | `/page/<id>#h-x` | Opens the page at the top (known gap) |
| 9 | Killed | `prism://auth/callback?…`, `prism://bogus` | Nothing visible |
| 10 | Killed | Look-alike host or alias host | Not claimed (association file 404 off `APP_ORIGIN`) |
| 11 | Page has no access | Valid link | Opens; the page shows "No access" (server decides) |
| 12 | Open > 10 min on the sign-in screen | Then sign in | Stale link dropped |

Before each pass: `curl` the public host for `/.well-known/apple-app-site-association`
(200, JSON, no redirect), and check `verify-client.mjs` is clean with no host
committed in the entitlements.

---

## 6. Known gaps

- iOS Rust (`cfg(ios)`) and the Swift plugin compile (first on 2026-10-08) and the app
  has run in the simulator and on the owner's iPhone as a debug build — but:
- No RECORDED owner device pass yet (`qa/device-pass-script.md`): universal links, menu
  accelerators, the export save panel, the share sheet, push and embeds in the app are
  all unverified on a device.
- Heading fragments are lost in app links.
- No `/api/version` check. Schema changes in hints and writer kinds will break
  strict decoders.
- Agent API is owner-only, and the Omni gateway (`/api/omni/*`) does not exist.
- Omni has no sign-in yet: it needs the redirect URI and client id change.
- The Keychain item is `ThisDeviceOnly` and not shared, so it blocks extensions
  and Omni-to-Prism token sharing.
- Embeds and PDFs are cards in the client because its CSP is unchanged
  (owner decision pending).
- The Omni contract §5 lists four writer kinds; it needs `external` and an
  `unknown` fallback added.
- Any native editor is ruled out until the editor schema stops moving.
