# D07 — Connections and server operations

Frontend slice on `feat/connections-polish`, based on `6e05bc9`. No backend, API, schema, provider, Settings, or NetworkRenderer changes. This does not claim all of R14/D07 complete.

## Reference and delivered behavior

`FRONTEND-ACCEPTANCE.md` D07 / R14.1–4 requires task-oriented integration settings with accurate scope, status and actions. Board `assets/25-connections-settings.png` supplies the quiet row hierarchy and mobile presentation. This implementation uses only existing seams; its account list is the actual supported integration registry, not the board's illustrative provider list.

`ServerPanel` now opens on Accounts, with separate Processing and Server operations sections. Rows use product names, explain what credentials are for, and disclose configuration state without claiming a connection is healthy or content has synced. Settings expand per connection; Proton host, port and security remain under Advanced. Credentials stay write-only, including when a faulty status response contains a secret field. Saves still replace the whole credential, preserve echoed optional scope fields and checkbox values, and require all existing mandatory inputs. Sync is still limited to the existing syncable kinds. Removing stored credentials retains its confirmation and exact endpoint semantics; it is not relabeled as disconnecting an external account.

Proton certificate detection sends only host/port/security, never the password. A detected fingerprint still requires explicit trust confirmation before saving. Existing error mapping and owner warnings remain. All existing operator actions remain: tunnel start/stop/restart, ingress/DNS guidance and restart confirmation, allowed server config, vault-token rotation, and legacy-token dry run/revoke/optional notification.

Actual worker reports appear under Processing, including their server/desktop origin. The UI explains that desktop activity is inferred from vault notes. Missing timestamps say Not reported; unavailable or disabled sources do not become fabricated healthy connections. Owner host groups render only after successful owner-only server information retrieval.

Scope-keyed remounts clear private drafts when the active vault, authenticated audience or injected sharing client changes. Read generations reject old responses; failed per-kind status checks show Status unavailable and disable configuration rather than substituting Not configured. An open failed-refresh draft is retained within the same scope but cannot be submitted until a fresh status succeeds. A late legacy-token dry run cannot open a confirmation or issue its second write after a scope switch.

Controls, inputs and checkbox targets meet 44px minimum height; fields have associated labels. Tabs support arrows/Home/End and keep same-vault drafts when switching sections. Private CSS is scoped to `.prism-connections`; it does not change global settings styling.

## Evidence

Actual browser fixtures render the real owner NetworkRenderer → ServerPanel path, plus the inner non-owner admin contract. All mutations are isolated injected seams with synthetic credentials, not production calls.

**14 Chromium + 14 WebKit journeys passed**, plus both phone visual journeys passed again after increasing operator-warning text contrast. Core and scoped fixture TypeScript checks and `git diff --check` passed. Browser journeys cover real account/settings rendering, secret non-prefill, Proton certificate trust, replacement payloads and optional scope preservation, sync/remove confirmation, pending and failed-save drafts, unavailable status/recovery, audience/vault resets, stale reads and legacy dry runs, owner/admin/member gates, keyboard sections, operator ingress/config/token actions, and phone layout. Commands: `playwright test -c apps/server/data/workspace-experience/checks/connections-{chromium,webkit}.config.mts`, `npm run typecheck --workspace=@prism/core`, and `tsc --noEmit -p apps/server/data/workspace-experience/checks/connections-types.json`. The local runners use port 5193, fixture mode, blocked service workers, and `PRISM_SERVER=http://127.0.0.1:1`. The committed `apps/web/e2e-fixtures/connections.spec.ts` can also run through the default web Playwright config (port 5188).

Visually inspected actual screenshots:

- `assets/evidence/connections/connections-desktop.png`
- `assets/evidence/connections/connections-phone-dark.png`
- `assets/evidence/connections/connections-credentials-phone-dark.png`
- `assets/evidence/connections/connections-server-phone.png`

## Explicit gaps and release follow-up

- Existing NetworkRenderer exposes ServerPanel only to server owners, even though its integration seams support non-owner admins. That outer gate is unchanged. A coordinated navigation decision is needed to expose Connections to the intended audiences; this slice does not widen authority.
- Provider health, last successful sync, mapping/conflict handling, account disconnect, and direct Telegram setup are not available uniformly through these seams. No substitute controls or invented status were added. Existing sync counts are shown only after the sync endpoint returns them.
- Read-only production and installed desktop layout checks remain for the root release pass. Do not exercise host shutdown, tunnel restart, token revocation, notifications or credential replacement merely to obtain production UI evidence.
- Backend authorization remains authoritative. Browser fixture outcomes prove the UI payloads and guards, not live integration credentials, external account access, worker health, or native parity.
