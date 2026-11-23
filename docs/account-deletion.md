# Account deletion

Any signed-in account can delete itself from inside the app — the iOS app, the Prism Client on
the Mac and the PWA all share the same Settings → Account screen (App Store Review Guideline
5.1.1(v)). This page is the contract and the **default policy**; the choices marked
*policy* are the ones the owner should confirm.

Code: `apps/server/src/account-delete.ts` (effects), `POST /auth/account/delete` in
`apps/server/src/routes/auth.ts` (gates), `trashPageOfDeletedAccount` in `apps/server/src/pages.ts`;
client `deleteAccount` in `apps/web/src/config.ts`, `AccountClient.deleteAccount` (optional seam,
`packages/core/src/data/Account.tsx`), `DeleteAccountDialog.tsx` + the danger zone at the bottom of
`AccountSettings.tsx`. Tests: `apps/server/test/account-delete.test.ts`,
`apps/web/e2e-fixtures/account-delete.spec.ts` (a11y surface `account-delete-dialog`).

## Route

`POST /auth/account/delete` with `Content-Type: application/json` and
`{"confirm": "<the account's email>", "password": "<its password>"}`.

It lives under `/auth/*`, so it is already in the service worker's `navigateFallbackDenylist`, it
gets the auth CORS rules, and it is rate-limited (`auth-account-delete`, 10 per 10 min per client).

Checked in this order:

| Condition | Answer |
|---|---|
| Not a person: a Prism MCP dispatch, a `pp_` PAT or any other non-device bearer, the loopback `COLLAB_TOKEN` / vault-token owner path, a capability link | `403 human_origin_required` |
| No credential, or a session / device token that no longer exists | `401 unauthorized` |
| CSRF (`csrfRefusal`, as for live actions): not JSON → `415`; with a session, `Sec-Fetch-Site: cross-site\|same-site` or a foreign `Origin` → `403 csrf_refused` (a `pd_` device token skips the site checks) | |
| The account is the SERVER owner (`OWNER_EMAIL`) | `409 owner_account` |
| `confirm` missing or not the account's email (trimmed, case-insensitive) | `400 confirm_mismatch` |
| A password account without the right `password` — also from a device token: a device token alone is not enough | `403 wrong_password` |
| An account with no password, from a device token (only a browser session may delete it) | `403 browser_session_required` |
| A deletion of this account is already running | `409 busy` |
| A vault could not be listed or written while moving the private pages | `503 vault_unavailable` — **nothing** of the account was deleted; retry |
| Done | `200 {ok: true, deleted: true, privatePagesTrashed: n}` and the session cookie is cleared |

A second call after success is `401` (the session / device token is gone).

## What is deleted

In this order; step 1 must succeed before anything of the account is touched.

1. **Private pages** — every note with `prism_visibility: "private"` and `prism_creator` = the
   account, in each vault the account is a member of or holds a grant in (plus the primary
   vault), found with one lean listing per vault. Each is moved to the Trash through the trash
   route's own compare-and-set write and trash ledger, as its own root (sub-pages other people
   wrote under it are not touched), with `prism_trashed_by: "deleted-account"`. A private page
   that was already in the Trash keeps its trash stamp.
   *Policy:* the page is handed to the **server owner** (`prism_creator` = `OWNER_EMAIL`) and stays
   **private**. A private page whose creator no longer exists is visible to nobody (admins do not
   override the private rule), so without the hand-over neither the Trash list, a restore nor the
   owner's own purge could reach it. Nobody else ever sees it; the normal trash retention
   (`TRASH_RETENTION_DAYS`, purge worker) then deletes it unless the owner restores it. The route
   never deletes a note from the vault.
2. **Credentials that are more than a row** — every live device through `revokeDevice` (PATs minted
   through that device, its APNs registration and the hub MCP tokens recorded with it go too), and
   every live legacy hub MCP token of the account is revoked at the hub. A hub revocation that fails
   is logged and that token row is kept so the owner can still see and revoke it (Network → Server →
   Legacy agent tokens).
3. **One SQLite transaction** removes:
   - `sessions`, `magic_links`, `device_tokens`, `device_auth_codes`, `device_account_history`;
   - `mcp_pats` (all of the account's PATs), revoked `mcp_tokens` rows;
   - `push_subscriptions`, `apns_tokens` (by account and by its devices);
   - `notifications` it received, `notification_settings`, `notification_email_log`,
     `notification_page_levels`, `reminders`, `access_requests` it made, `comment_participants`;
   - `invites` not yet accepted that it sent **or** that are addressed to it;
   - `grants` whose subject is the account (`subject_type = 'user'`), `memberships`;
   - `tenant_secrets` it stored (its integration credentials), `page_preferences`;
   - the `users` row.

   Then collab sockets and caches are told that access changed (`notifyAccessChanged`).

## What stays

- **Grants it made for others** (`created_by` keeps its address — that is what the scoped-sharer
  rules read); access decisions it took stay in force.
- **Its contributions in pages others can see**: content, comments, suggestions, version history.
  Writer stamps (`prism_last_writer`) resolve to no name once the `users` row is gone, so the UI
  shows them unnamed; `prism_creator` on its *shared* pages is left as it was.
- **Notifications it caused in other people's Inbox** stay, with their author removed
  (`actor_email` → NULL, shown as "Someone"); access requests it decided keep their outcome,
  with the decider removed.
- Accepted invites (the history of how other accounts joined).
- Vault-level history the vault itself keeps (`actor`/`via` on versions).

*Policy:* a vault-role owner or admin who is not the server owner may delete themselves; the vault
may then have no member owner left — the server owner still administers every vault.

## Audit

One `action_audit` row per attempt that passed the gates: `action: "account.delete"`,
`actor_email: "[deleted account]"` (never the address), `via` (`session` | `device`),
`origin: "human"`, `status: "ok"` with `target` = counts only (pages trashed / handed over,
vaults, and one count per table above, plus `mcpTokensFailed`), or `status: "failed"` with an
empty target when a vault could not be reached.

## Client

- **Settings → Account → Delete account** is the last section. It names the server
  (`AccountProfile.serverName` = the gateway's host) and opens `DeleteAccountDialog`: an in-app
  modal (never `window.confirm`) that says what happens, asks the person to type the account's
  email and, for a password account, its password. "Delete account" stays disabled until both are
  filled and the email matches; Enter submits; Escape / Cancel / the backdrop close it and return
  the focus to the button. A refusal is said inside the dialog (`role="alert"`) and nothing changes.
- **The server owner** (`AccountProfile.isServerOwner`) sees an explanation instead of the button:
  the account goes when the server is removed.
- Hidden where there is no `AccountClient` (the legacy desktop, share-link viewers) or the shell's
  client has no `deleteAccount`.
- **Unsent changes**: the web client refuses before contacting the server while this device holds
  queued writes or unsynced live documents (they could never be sent afterwards) and says to
  reconnect, or sign out and download them first.
- **After success** the device signs out locally through the same path as Sign out
  (`forgetLocalSession` in `config.ts`): no further authenticated request, the native shell forgets
  its device token (`host.onSignedOut`), the offline read cache and its `prism:offline-*` keys and
  this account's live-document bodies are removed. Then it reloads into the sign-in screen, which
  says once "Your account was deleted." (`sessionStorage` `prism:account-deleted`).

## Release order

Server first (an older server answers the route with the SPA or 404, and the dialog says the
account could not be deleted), then the PWA, then the Prism Client / iOS rebuild.
