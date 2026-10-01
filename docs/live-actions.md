# Live actions (Arch v2 WP1.5)

The Prism Server can act **as the server owner** toward the outside world, so the
phone (PWA / native) and the laptop client can do what used to need the desktop
app:

| Family | Routes (`POST /api/actions/…`) | Transport |
|---|---|---|
| Email | `email/send`, `email/reply`, `email/archive`, `email/mark-read` | Proton Mail Bridge on loopback: SMTP (send/reply), IMAP (archive/flags) |
| Calendar | `calendar/rsvp`, `calendar/create`, `calendar/update`, `calendar/delete` | the `gog` CLI (Google Calendar) |
| Matrix | `matrix/send`, `matrix/react` | the stored Matrix access token |

`GET /api/actions` reports `{email, calendar, matrix}` → `{enabled, configured}`
(+ `matrix.agentRooms`). The account's email is **Proton**, not Gmail: there is
no Gmail send path on the server.

Everything is **off by default**. While a family's flag is off, its routes answer
`503 actions_disabled` and nothing is contacted.

## Who may call them

**Server owner only** — `kind: "user"` with the email `OWNER_EMAIL`, through a
session cookie, a native device token (`pd_…`), or the loopback owner token.
A vault admin, a member, a guest, someone who is `owner` of a *different* vault,
a capability link and anon all get `403`. These actions use the owner's
mailbox, calendar and Matrix identity, so vault roles never reach them.

### Credentials: primary vault, server-owner-written only

Live actions read the `proton-bridge`, `google` and `matrix` credentials **only
from the primary vault**, whichever vault the owner is browsing
(`X-Prism-Vault`). The email notes that `reply`/`archive`/`mark-read` look up
also come from the primary vault. Writing or deleting the `matrix` and `google`
credentials (`PUT`/`DELETE /api/integrations/{matrix,google}`) is
**server-owner only** in every vault, like `proton-bridge`. Otherwise a vault admin
could point the owner's Matrix sends at their own homeserver, or choose the gog
account the owner's RSVPs use. Admins can still read the status and trigger a
sync. **Behaviour change:** an admin of a non-primary vault can no longer set
that vault's Matrix or Google credential (for its ingest / Docs sync). The
server owner sets it for them.

## CSRF

The session cookie is `SameSite=Lax`, so a page on a **sibling subdomain**
(same-site) could otherwise submit a form to these routes as the owner. Every
`POST /api/actions/*` therefore:

- requires `Content-Type: application/json` (else `415`). A form can only send
  `text/plain`, urlencoded or multipart bodies;
- takes the idempotency key **only** from the `Idempotency-Key` header. A
  custom header plus a JSON content type force a CORS preflight that the server
  never grants to foreign origins;
- for anything but a native bearer device token, refuses
  `Sec-Fetch-Site: cross-site|same-site` and any `Origin` that is neither
  `APP_ORIGIN` nor a `NATIVE_ORIGINS` entry (`403 csrf_refused`).

The PWA is same-origin and unaffected. The bearer-token native path is not an
ambient credential, so it is exempt from the fetch-site check. Dev gotcha: a
Vite dev server on another port counts as `same-site`, so use its proxy.

## Human vs agent origin

The origin is derived from **how the request authenticated**
(`requestVia()` in `auth/actor.ts`), never from anything the client claims:

| via | origin |
|---|---|
| `session` (browser cookie) | human |
| `device` (native `pd_` token) | human |
| `mcp` (in-process dispatch from a Prism MCP tool) | agent |
| `local-token` (loopback COLLAB_TOKEN / vault token: the desktop or a host script) | agent |

A client may **downgrade** itself with `X-Prism-Action-Origin: agent`. No
*header* can upgrade it, but see the threat model below: the classification
reflects the credential, not who holds it. Rules:

- **Email and calendar**: agent origin is refused outright
  (`403 agent_origin_refused`). Agent-initiated outward actions need a
  confirmation design first (deferred, see below).
- **Matrix**: a human may target any room the account has **joined** (checked
  live via `/joined_rooms`, cached 60 s; a cache miss refreshes once). An agent
  may target only rooms listed in `ACTIONS_MATRIX_AGENT_ROOMS` (and joined).
  An empty list means agents may post nowhere.

There are **no MCP tools** for these actions in this WP. The origin rules are in
place for when there are.

### Threat model: what the origin check does NOT cover

"Human" means *a session cookie or a device token*, not *a person*. Anything
running on the host as the user can obtain such a credential:

- **Agents Prism spawns are no longer in this class.** The server runner
  (WP0.1) and, since WP0.1d, the desktop agent (`claude -p` spawned by
  Prism.app via `clients/claude_args.rs`) both run with no built-in tools
  (`--tools ""`), only the vault MCP for the active vault, an empty fixed cwd
  and an env allowlist — they cannot read `apps/server/.env` or
  `prism-server.db`, so they cannot mint a "human" credential. (Before
  WP0.1d the desktop agent ran at the repo root with Bash and could.)
- Any **other** host-local process running as the same OS user — a manually
  started Claude Code session in this repo, a script, malware — can still read
  `.env` and the server DB, mint or replay an owner session and reach these
  routes as **human** origin, or decrypt the stored credentials and talk to
  Bridge, gog or Matrix directly.

So the human/agent split protects against **remote** agents (Prism MCP clients,
server agent sessions) and Prism's own spawned agents. It does not protect
against arbitrary host-local software running as the owner — treat the host
account itself as the trust boundary.

## Idempotency

Send the `Idempotency-Key: <fresh UUID per user action>` header. A body field is
**not** accepted (CSRF, above). It is **required** for `email/send`, `email/reply`, `calendar/create`,
`calendar/update`, `calendar/delete` and `matrix/send`, and optional for the naturally idempotent ones.

- Same key + same request → the first outcome is replayed with
  `Idempotent-Replayed: true`. Nothing is sent again.
- Same key + a different request → `422 idempotency_key_reused`.
- The first request is still running → `409 in_progress`. A pending attempt
  older than 10 min (a crash) → `409 outcome_unknown`.
- A failure that provably happened **before** anything left the server
  (validation, connect / TLS / pin / login, SMTP envelope refused, a Matrix
  4xx) **releases** the key, so the same key may retry. A failure after the send
  may have started (`502`, `sent: "unknown"`) is **kept** and replayed. A lost
  response can never turn into a second send.
- Matrix also gets a deterministic transaction id derived from the key, so the
  homeserver dedupes too.

The core client (`createHttpLiveActionsClient`) mints one key per call and
retries a *network* failure once with the same key.

## Email security (Proton Bridge)

Email uses the same `proton-bridge` credential as the ingest (`PUT
/api/integrations/proton-bridge`, server-owner only). Optional new fields:
`smtpPort` (default 1025), `smtpSecurity` (`starttls` default | `tls`),
`smtpCertSha256` (default = `certSha256`; Bridge serves one cert for both).

- The host must be **loopback**. The password never leaves the machine.
- **SMTP**: nodemailer's `SMTPConnection` is driven step by step. `connect()`
  finishes only after STARTTLS (`requireTLS`) and the post-TLS EHLO. Then the
  socket must be a `TLSSocket` whose certificate SHA-256 equals the pin, or the
  socket is closed and **AUTH is never sent**. Only then `login`, `send`, `quit`.
  `test/actions.test.ts` proves it against a loopback stub SMTP server
  (STARTTLS and implicit TLS, plus a server without STARTTLS). A wrong pin
  produces zero `AUTH` bytes and the password never appears on the wire.
- **IMAP** (archive, mark-read): the ingest's `connectPinnedImap()`, which checks
  the pin in `authenticate()` before LOGIN. The mailbox is opened read-write, and
  the message is found by **Message-ID** (UIDs can change), not by UID.
  IMAP `SEARCH HEADER Message-ID` is a *substring* match, so a short or crafted
  id like `<a>` could hit unrelated mail. Each candidate's own Message-ID header
  is fetched and compared exactly (`pickExactUid`), and the action runs only
  when **exactly one** matches. None → `404`, several → `409 ambiguous`, and
  nothing is changed in either case.
  `archive` = `UID MOVE` to `ACTIONS_EMAIL_ARCHIVE_MAILBOX` (`Archive`).
  `mark-read` = add/remove `\Seen`, then a best-effort `if_updated_at` PATCH of
  the note's `isUnread`/`labels` (no `force`).
- **Header injection**: every header input (to/cc addresses, subject,
  In-Reply-To, References, mailbox name) is refused if it contains CR/LF/NUL.
  Addresses must be plain `local@domain` (no display names, quoting or
  comments). There is no `bcc`.
- **Limits**: 20 recipients (to + cc), subject 500 chars, text body 200 KB, HTML
  500 KB, request body 1.2 MB, 50 References.
- Messages are composed by nodemailer's MailComposer (MIME + RFC 2047) with file
  and URL access disabled. Message-ID = `<uuid@account-domain>`.

### Reply threading

`email/reply {noteId, expectTo[], body, html?, cc?}` reads the stored email note
(tag `email`, written by the Proton ingest; by **note id only**, never a
full-list Message-ID lookup) and builds:

- `In-Reply-To: <messageId>`;
- `References: <threadId> <messageId>`. The ingest stores the References root as
  `threadId`; it collapses to one id when they match;
- `Subject: Re: <subject>` (kept as is if it already starts with `Re:` in any
  case; stored line breaks are flattened);
- `To:` the stored `replyTo` if present (the Proton ingest does not store
  Reply-To today, so this is forward-compatible), else the original sender, else
  (replying to your own message) the original recipients. Addresses are parsed
  with the ingest's RFC 5322 parser (`addresses()`: quoted names, comments,
  groups), not a first-`<…>` scan, so `"Eve <eve@evil>" <real@example>` yields
  `real@example`.
- **Target pinning:** `expectTo` is the address list the UI *showed* the user.
  If the server derives anything else (the note changed, a parser difference),
  the send is refused with `409 target_changed` and nothing is sent. Matrix
  needs no equivalent: the server acts on exactly the `roomId` the client sent
  and derives no target.

## Calendar (gog)

Uses the `google` credential (`{account}`) and the injectable `GogRunner`, the
same as the calendar ingest. Argv (gog v0.25):

```
rsvp:   gog calendar respond primary <eventId> --status=<accepted|declined|tentative> --account=<a> --json --no-input
create: gog calendar create primary --summary=… --from=<RFC3339> --to=<RFC3339>
        [--attendees=a,b] [--location=…] [--description=…] [--send-updates=all|none] --account=<a> --json --no-input
```

Every value is one `--flag=value` argv element (execFile, no shell), so a title
like `--with-zoom` stays a title. Event ids are allowlisted (no leading `-`).
Times must be RFC 3339 with an offset, end after start, and the span at most 31
days. A create runs with at most 50 attendees. `notify: false` →
`--send-updates=none`.

`calendar/rsvp` classifies gog's pre-send refusals ("event has no attendees", "cannot respond to your own event (you are the organizer)", not-a-guest) as `409 rsvp_not_applicable` with `sent: false`; the idempotency key is released. Unrecognised gog failures stay `502 upstream_failed`, `sent: "unknown"`.

### Edit and delete (parity A)

```
update: gog calendar update primary <eventId> [--summary=…] [--from=<RFC3339> --to=<RFC3339>]
        [--location=…] [--description=…] [--attendees=a,b] --send-updates=all|none
        --account=<a> --json --no-input
delete: gog calendar delete primary <eventId> --send-updates=all|none --force
        --account=<a> --json --no-input
```

- `calendar/update {eventId, title?, start?, end?, location?, description?, attendees?, notify?}`:
  at least one field; `start` and `end` together (same RFC 3339 / 31-day rules as create);
  `location` / `description` = `""` clears them; `attendees` **replaces** the guest list (≤ 50
  plain addresses); `notify: false` → `--send-updates=none` (default `all`).
- `calendar/delete {eventId, notify?}`: `--force` because gog otherwise asks for confirmation,
  which `--no-input` turns into a failure.
- Both require an `Idempotency-Key`, are refused for agent origin, use the calendar rate bucket
  and are audited as `calendar.update` (target: event id, the NAMES of the changed fields,
  `attendeesHash`, notify — never the title or an address) / `calendar.delete`.
- **Nothing-changed refusals** (`classifyCalendarWriteRefusal`): Google 404 / 410 / "not found" →
  `404 event_not_found`; 403 / "writer access" / not the organizer → `409 not_editable`; gog's
  own flag validation → `409 rejected`. All carry `sent: false` and release the key. Anything
  else is `502 upstream_failed`, `sent: "unknown"`, key kept.
- **The meeting note is updated right away** (`reflectLiveCalendarChange`, under the calendar
  ingest's per-vault lock) instead of waiting for the next 5-minute pass. Update: the metadata
  the ingest would derive from gog's returned event (`buildMeetingNote`), only the keys that
  differ, `if_updated_at`, path and body untouched (fallback when gog returns no event: the
  owner's own title/start/end/location/attendees). Delete: **soft-cancel**
  (`event_status: "cancelled"`), never a hard delete — the note may hold meeting notes; the
  reconcile skips cancelled notes and the Calendar hides them. The result is reported in the
  response's `note: {noteId, outcome}` (`updated | cancelled | unchanged | no-note | conflict |
  failed`) and never fails the action (Google already changed).
- UI: `CalendarDashboard` shows Edit / Delete on Google-synced events (they carry an
  `htmlLink`). Edit sends only the fields the owner changed (an untouched all-day event is never
  turned into a timed one; an empty attendees box keeps the guest list) with an "email guests"
  checkbox; Delete is a two-step inline confirm with "email guests a cancellation".

**Gotcha:** real gog reads its OAuth token from the macOS login keychain. That
works under pm2, which runs in the GUI session, but **not** from a plain ssh or
agent shell. Never test these with real gog from a shell; tests inject a fake
runner.

## Audit

Every attempt past the owner gate writes one `action_audit` row (SQLite, `db.ts`):

| column | |
|---|---|
| `ts`, `actor_email`, `via`, `origin` | who, and how they authenticated |
| `action` | `email.send`, `email.reply`, `email.archive`, `email.mark-read`, `calendar.rsvp`, `calendar.create`, `calendar.update`, `calendar.delete`, `matrix.send`, `matrix.react` |
| `vault_id` | the primary vault (whose credentials every action uses) |
| `target` | JSON with **ids and hashes only**: note id, room id, event ids, `recipients` count + `recipientsHash`, `messageIdHash`, `inReplyToHash`, `attendeesHash`, size |
| `idempotency_key` | |
| `status` | `ok` / `failed` / `refused` / `replayed` |
| `error` | scrubbed (addresses, tokens, key=value), ≤ 200 chars |

The audit never holds a message body, a subject or a plain address. Read it at
`GET /acl/actions/audit?limit=&action=email.send,matrix.send&before=<id>`
(server owner). `503 disabled` and `429 rate-limited` requests are not audited.

## Rate limits (per owner, fixed window)

| bucket | default | env |
|---|---|---|
| email send + reply | 30 / hour | `ACTIONS_EMAIL_SEND_PER_HOUR` |
| email archive + mark-read | 120 / 10 min | — |
| calendar rsvp + create + update + delete | 30 / 10 min | `ACTIONS_CALENDAR_PER_10MIN` |
| matrix send | 60 / 10 min | `ACTIONS_MATRIX_SEND_PER_10MIN` |
| matrix react | 120 / 10 min | — |

## Clients

- **Seam:** `@prism/core` `LiveActionsClient` (`lib/actions/client.ts`),
  `createHttpLiveActionsClient({fetch, headers})`, `<LiveActionsProvider>`,
  `useLiveActions(family)`. The hook returns the client only when the server
  reports that family `enabled && configured` for this viewer (403 → null).
  `liveActionErrorText(e)` gives the user-facing copy.
- **Web/native:** `apps/web/src/actions/HttpLiveActionsClient.ts` uses
  `serverFetch` + `contextHeaders()`, provided in `main.tsx` (null for
  capability viewers).
- **Calendar create** shows "Attendees will be emailed an invite" with a checkbox
  wired to `notify` (unchecked → `--send-updates=none`).
- **Wired:** Matrix send in `MessageRenderer` and `VaultMessagesDashboard`; email
  reply, compose-send, **Archive** and **Mark read/unread** in `EmailRenderer`;
  calendar **create**, **RSVP** (Google-synced events with guests), **edit** and **delete** (Google-synced events) in
  `CalendarDashboard`. Each falls back to the existing Tauri path when there is
  no live client.
- **Desktop:** unchanged. It has no provider and keeps its Tauri commands, which
  still use Gmail through gog for email, a pre-existing mismatch with the Proton
  account.

## Enabling (overseer)

1. Proton: the `proton-bridge` credential already exists if the ingest is set
   up. If Bridge's SMTP is not on 1025/STARTTLS, re-save it with `smtpPort` /
   `smtpSecurity` (and `smtpCertSha256` if the SMTP cert differs).
2. Google: the `google` credential (`{account}`), with `gog calendar list`
   working **as the pm2 user**.
3. Matrix: the `matrix` credential (already present for ingest). All three credentials must be stored in the **primary** vault, by the server owner.
4. `apps/server/.env`: `ACTIONS_EMAIL_ENABLED=true`, `ACTIONS_CALENDAR_ENABLED=true`,
   `ACTIONS_MATRIX_ENABLED=true` (any subset). Optional:
   `ACTIONS_MATRIX_AGENT_ROOMS=!a:hs,!b:hs`, `ACTIONS_EMAIL_ARCHIVE_MAILBOX`,
   `ACTIONS_SMTP_TIMEOUT_MS`, and the rate envs above.
5. Restart pm2 `prism-server`. Check `GET /api/actions`, send one test email to
   yourself from the web UI, then check `GET /acl/actions/audit`.

Rollback: set the flag(s) back to `false` and restart.

## Deferred

- MCP tools for these actions (agent-initiated outward actions need an
  explicit per-action confirmation design).
- Desktop on the server path; Gmail on the server (the account has none).
- Matrix read-receipts / room listing on the server. (Calendar update/delete shipped in parity A.)
- Reflecting `archive` on the vault note (the ingest never reflects moves; the
  note keeps its INBOX labels).
