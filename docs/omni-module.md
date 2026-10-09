# Omni module — `/api/omni/*`

Benjamin Life · 2026-10-08 · M1 (+ M2 read routes). The owner-only gateway inside the
Prism Server between the **Omni app** (SwiftUI, iPhone/iPad/Mac) and **Hermes** (Nous
Research Hermes Agent on the Mac Mini, the canonical thread store). Spec:
`omniharmonicagent/docs/omni/integration-contract.md` §§ 4–7. Code: `apps/server/src/routes/omni.ts`
and `apps/server/src/omni/*`. Tests: `apps/server/test/omni-gateway.test.ts`,
`omni-executor.test.ts`, `omni-proton-send.test.ts`, `omni-stub.test.ts` (Hermes is the
stub in `apps/server/scripts/lib/hermes-stub.ts`; a real one is never contacted).
To work on the app without the Mac Mini: [Developing against a stub Hermes](#developing-against-a-stub-hermes).

## Configuration (`apps/server/.env`, restart pm2 after a change)

| Variable | Default | Meaning |
|---|---|---|
| `OMNI_ENABLED` | off | `true` turns the module on. Off: **every** `/api/omni/*` route (hooks too) answers `404`. |
| `OMNI_HERMES_URL` | `http://127.0.0.1:8642` | Hermes API server. Plain `http` only to a loopback host; otherwise `https`. |
| `OMNI_HERMES_KEY_ENV` | `OMNI_HERMES_KEY` | The NAME of the env var that holds Hermes' `API_SERVER_KEY`. The key is sent only as `Authorization: Bearer` to that URL, redirects are refused, it is never logged or echoed. |
| `OMNI_SERVICE_TOKEN` | unset | Secret (≥ 16 chars) the Hermes `omni-bridge` plugin presents on the loopback hook routes. Unset → hooks refused. |
| `OMNI_HERMES_TIMEOUT_MS` | 15000 | Per non-streaming Hermes call. |
| `OMNI_HERMES_STREAM_IDLE_MS` | 300000 | A turn's stream is abandoned after this long with no bytes (Hermes sends keepalives). |
| `OMNI_TURN_MAX_MS` | 3600000 | Hard ceiling per turn. |
| `OMNI_APPROVAL_TTL_MS` | 86400000 | Default lifetime of a proposed approval. |
| `OMNI_EVENTS_PER_THREAD` | 2000 | Persisted stream events kept per thread. |
| `OMNI_MAX_STREAMS` | 16 | Concurrent SSE connections (thread streams + `/events`). |
| `OMNI_EMAIL_EXECUTOR` | `proton-send` | Who sends an approved email (Benjamin, 2026-10-08: option B). `proton-send` = the agent repo's `scripts/proton_send.py --approved` (markdown refusal + third-party-recipient guard); `live-actions` = Prism's own `/api/actions/email/*` (`ACTIONS_EMAIL_ENABLED`). |
| `OMNI_PROTON_SEND` | unset | ABSOLUTE path to `proton_send.py` on the Mini (e.g. `/Users/benjaminlife/dev/omniharmonic_agent/scripts/proton_send.py`). Unset or missing file → approved emails answer `executor_disabled` and stay pending. |
| `OMNI_PROTON_PYTHON` | `python3` | Python that runs it (the agent repo's venv, if it has one). |
| `OMNI_PROTON_SEND_TIMEOUT_MS` | 90000 | Past it the send is killed and recorded `unknown` (check Sent before re-sending). |

Hermes side (VERIFY on the Mini): the `api_server` platform enabled with a strong
`API_SERVER_KEY`, bound to loopback; the Prism MCP configured with a `pp_` PAT so writes
carry Prism's writer stamp.

## Who may call

| Route group | Credential | Refused |
|---|---|---|
| Everything except `/hooks/*` | The **server owner** (`OWNER_EMAIL`) by browser session cookie **or** native device token `Authorization: Bearer pd_…` | anonymous → `401 unauthorized`; another account (even an admin), a capability link, the loopback owner token, an in-process Prism-MCP dispatch → `403 forbidden` |
| `/hooks/*` | Loopback request (no `X-Forwarded-For`/`X-Real-IP`/`CF-Connecting-IP`, and the server trusts loopback: `TRUST_LOCAL=true`, which an `https` `APP_ORIGIN` does not default to) **and** `Authorization: Bearer <OMNI_SERVICE_TOKEN>` | everything else → `403 forbidden` |

The app signs in with Prism's native sign-in (`docs/native-auth.md`) as
`client_id=omni-native`, redirect `omni://auth/callback` (iPhone/iPad) or a loopback
redirect (Mac). That client exists only while `OMNI_ENABLED=true`. A server that sets
`DEVICE_REDIRECT_URIS` itself must list `omni://auth/callback` there.

Every non-GET app route also passes the live-actions CSRF guard: `Content-Type:
application/json` is required (`415 unsupported_media_type` — also for bodyless POSTs, send
`{}`), and unless the credential is a device token, `Sec-Fetch-Site: cross-site|same-site`
or an `Origin` other than `APP_ORIGIN`/`NATIVE_ORIGINS` → `403 csrf_refused`.

Errors are `{error: <code>, detail?: <text>}`. Common codes: `bad_request` (400),
`not_found` (404), `conflict` (409), `hermes_not_configured` (503), `hermes_unavailable`
(502), `hermes_auth` (502, Hermes refused the gateway's key), `hermes_timeout` (504),
`hermes_rejected` (400), `too_many_streams` (429).

## Version

`GET /api/omni/version` → `{"api": 1, "minClient": "1.0"}`.

## Threads

A thread **is** a Hermes session (`id` = the session id). The gateway keeps only
app-side metadata (state, objective, task binding, unread, event log).

**Thread object**

```json
{
  "id": "omni_3f…",            "title": "Call Dana",       "state": "working",
  "objective": null,            "taskNoteId": null,          "lastActivityAt": "2026-10-08T15:04:00.000Z",
  "unread": 0,                  "pinned": false,             "archived": false,
  "nextCheckAt": null,          "waitingOn": null,           "model": "gpt-5-codex",
  "preview": "…",               "messageCount": 6,           "running": true,
  "lastSeq": 12,                "source": "text"
}
```

`state` ∈ `working | needs-you | waiting | scheduled | done`. Derived: a running turn →
`working`; a pending approval in the thread → `needs-you`; otherwise the stored state
(`done` after a successful turn, `needs-you` after a failed one, `waiting` after a cancel).

| Route | Body / query | Answer |
|---|---|---|
| `GET /api/omni/threads` | `?state=working,needs-you&q=<text>&archived=1` | `{threads:[Thread], next:null, hermes:"ok"\|"unavailable"}` — Hermes sessions merged with local rows; when Hermes is down, local rows only with `hermes:"unavailable"`. Pinned first, then newest. |
| `POST /api/omni/threads` | `{prompt, title?, objective?, taskNoteId?, noteIds?:[≤20], source?: "text"\|"voice"\|"nudge"\|"prism"}` | `201 {thread, turnId}` — creates the Hermes session `omni_<hex>` and starts the first turn. |
| `GET /api/omni/threads/:id` | | `{thread, messages:[Message], cards:[Card], approvals:[Approval], activeTurnId}`; clears `unread`. |
| `PATCH /api/omni/threads/:id` | `{title?, pinned?, archived?, state?, unread?: bool}` (unknown keys → 400) | `{thread}`; title/pinned/archived are written to Hermes too. |
| `POST /api/omni/threads/:id/turns` | `{text, noteIds?}`, header `Idempotency-Key` (optional, 8–200 `[A-Za-z0-9._:-]`) | `202 {turnId, status:"running"}`; `409 {error:"conflict", turnId}` while a turn runs (attach to it); same key again → `200 {turnId, status}` + `Idempotent-Replayed: true`. A Hermes session started elsewhere (Telegram, Buzz) is adopted. |
| `GET /api/omni/threads/:id/stream?after=<seq>` | also honours `Last-Event-ID` | SSE, below. |
| `POST /api/omni/turns/:id/cancel` | `{}` | `202 {turnId, status:"cancelling"}` (aborts the stream and calls Hermes `POST /v1/runs/{run}/stop`); an ended turn → `200 {turnId, status}`. |

**Message** (from Hermes `GET /api/sessions/{id}/messages`, newest 200):
`{id, role:"user"|"assistant", text, at}` or, for tool rows, `{id, role:"tool", toolName, at}`
— a tool's raw output is never forwarded.

`noteIds` are appended to the message Hermes receives as one bracketed line naming the ids;
Hermes reads the notes itself through its Prism tools.

### Stream (SSE)

Persisted events: `event: <t>`, `data: {"seq", "turnId", "t", …}`, `id: <seq>`. Live-only
`text_delta`: no `id`. `: ping` every 25 s. The stream replays everything after `after`,
then follows the running turn and **closes after the turn's final `status`** (or right after
the replay when nothing runs). Reconnect with `?after=<last seq>`. One connection replays
at most 1000 stored events: after a long absence, reconnect from the last seq until a
replay brings nothing new.

| `t` | Fields | Notes |
|---|---|---|
| `init` | `runId` | the Hermes run started |
| `text_delta` | `blockId, text` | live tokens; never persisted |
| `text` | `blockId, text` | final text of a block — REPLACES its deltas |
| `tool_use` | `id, name, input` | `name` without the `mcp__server__` prefix; `input` redacted (secret-named keys, token-shaped values) + truncated |
| `tool_result` | `toolUseId, ok, summary` | `summary` ≤ 300 chars, scrubbed |
| `card` | `card: Card` | a record the agent changed (below) |
| `approval` | `approval: Approval` | a draft was proposed, or a decision finished |
| `status` | `state, reason?` | thread state; `reason` = an error code, `queued`, `agent_message`, `hermes_approval_requested` |
| `result` | `ok, durationMs, errorCode?` | exactly one per turn |

`result.errorCode`: `cancelled`, `auth`, `usage_limit`, `budget`, `timeout`,
`iteration_limit`, `agent_failed`, `stream_ended`, `hermes_auth`, `hermes_unavailable`,
`hermes_timeout`, `hermes_not_configured`, `internal_error`. Hermes' own error text is
never forwarded.

A server restart ends running turns as `interrupted` (Hermes keeps what it already wrote).

## Record cards

```json
{
  "kind": "record", "noteId": "01J…", "op": "created|updated|deleted|commented|suggested",
  "type": "task", "title": "Call Dana Friday", "path": "vault/tasks/call-dana", "tags": ["task"],
  "icon": null, "summary": "properties status, due", "changedKeys": ["status", "due"],
  "bodyDelta": {"chars": 120},
  "writer": {"kind": "agent", "label": "Omni"}, "updatedAt": "…", "threadId": "omni_…",
  "links": {"prism": "https://<prism-origin>/page/01J…", "prismApp": "prism://page/01J…", "omni": "omni://record/01J…"},
  "private": false
}
```

`type` is Prism's `inferContentType`. `writer.kind` is `agent` for Prism MCP writes and
`external` for raw Parachute MCP writes (clients treat unknown kinds as `external`).

**How cards are found, and the limits.**
1. A `tool.completed` (never `tool.failed`) of a write tool — `prism_create_note`,
   `prism_update_note`, `prism_delete_note`, `prism_restore_version`, `prism_sheet_update`,
   `prism_add_comment`, `prism_resolve_comment`, `prism_suggest_edit`, or the vault MCP's
   `create-note`/`update-note`/`delete-note`. Updates/deletes name the id in the tool input.
2. Hermes' stream carries no tool RESULT, so a create's new id is unknown: the card is
   resolved by the input `path` through the tree projection, else by watching the tree change
   feed during the turn (+30 s) for a row that appears with that path — or, with no path, that
   carries all the create's tags and its `metadata.title`, and only when exactly one pending
   create matches.
3. The tree has no writer column: a note written by the agent through any other tool, or a
   create with neither path nor tags+title, gets no card. A note created by someone else at
   the same path within the window would be attributed to the agent.
4. Cards are stored per thread (`GET /threads/:id` → `cards`, newest first).

## Approvals (the gate)

Invariant: Hermes can only **propose**; only a human decision on a signed-in session or
device, bound to the exact payload shown, causes an outward action — and only through
Prism's existing guarded executors.

**Approval object**

```json
{
  "id": "apr_…", "threadId": "omni_…", "kind": "email",
  "payload": {"to": ["kevin@example.com"], "subject": "Buoy spec", "body": "…full text…"},
  "digest": "<64 hex>", "summary": "Email Kevin", "status": "pending",
  "createdAt": "…", "expiresAt": "…", "decidedAt": null, "result": null,
  "supersededBy": null, "revises": null,
  "executor": {"name": "proton-send", "available": true, "enabled": false}
}
```

`digest` = SHA-256 (hex) of the canonical JSON (keys sorted at every depth, no whitespace) of
`{"kind": <kind>, "payload": <payload>}`. The app may recompute it to check what it shows.

| `kind` | `payload` | Executor |
|---|---|---|
| `email` | `{to:[≤20], cc?:[≤20], subject, body}` (plain text) | `proton_send.py send --approved` (default; see below) or `POST /api/actions/email/send` |
| `email-reply` | `{noteId, expectTo:[…], cc?, body}` | `proton_send.py send --approved --reply-to-note <noteId> --to <each expectTo>` or `POST /api/actions/email/reply` |
| `message` | `{roomId, body}` | `POST /api/actions/matrix/send` (`ACTIONS_MATRIX_ENABLED`) |
| `calendar-invite` | `{title, start, end, attendees?, location?, description?}` (RFC 3339) | `POST /api/actions/calendar/create` (`ACTIONS_CALENDAR_ENABLED`) |
| `tweet` | `{text}` | none wired yet → `executor_unavailable` |
| `wallet-proposal` | `{to, amount, token?, chain, purpose}` | none wired yet → `executor_unavailable` |

Status: `pending → approved (claimed) → sent | failed | unknown`, or `expired`,
`cancelled`, `revised`. `unknown` = the executor may have acted (no answer / 5xx) — check
before sending again.

| Route | Body | Answer |
|---|---|---|
| `GET /api/omni/approvals?status=pending` | | `{approvals:[Approval]}` (expired ones are marked first) |
| `GET /api/omni/approvals/:id` | | `{approval}` |
| `PUT /api/omni/approvals/:id` (edit) | `{digest: <of the draft edited>, payload}` | `201 {approval: <NEW, new digest>, replaced}`; the old one becomes `revised`. Human origin required. |
| `POST /api/omni/approvals/:id/decision` (alias `/decide`) | `{decision: "send"\|"cancel"\|"revise", digest, feedback?}` (`approve`/`reject` and `payloadHash` accepted as synonyms); header `Idempotency-Key` **required** | see below |

Decision rules, in order:
1. Human origin: the request authenticated by session or device token, without
   `X-Prism-Action-Origin: agent` → else `403 human_origin_required` (audited).
2. `Idempotency-Key` missing/malformed → `400`.
3. Expired → `410 expired`. Already decided: the SAME key → the stored outcome with
   `Idempotent-Replayed: true`; another key → `409 already_decided` (`in_progress` while
   executing).
4. `digest` ≠ the stored digest → `409 digest_mismatch` (the app must show the draft again).
5. `cancel` → `cancelled`. `revise` → `revised`, and with `feedback` a new turn asks Hermes
   for a new draft (`{approval, turnId}`).
6. `send`: executor not wired → `503 executor_unavailable`; family flag off →
   `503 executor_disabled` — the approval **stays pending**, nothing is called. Otherwise the
   approval is claimed atomically and the live-action route is called IN PROCESS with the
   decider's own credential and `Idempotency-Key: omni-<approval id>`, so every live-action
   gate (owner, flag, validation, human origin, idempotency, `action_audit`) applies unchanged.
   Answer `200` (sent) / `422` (failed; `result` carries the live action's error code) /
   `502` (unknown), body `{approval}`.

A refused `send` (`executor_disabled`, `executor_unavailable`) is not a decision: nothing is
stored, so the same `Idempotency-Key` again gets the same `503`, without
`Idempotent-Replayed`. The replay answer exists only once the approval left `pending`.

Every proposal, edit, refusal and execution writes an `omni_audit` row (ids + 16-hex digest
prefixes, never the payload).

### Email executor: `proton_send.py` (option B)

`src/omni/proton-send.ts`. Fixed argv (`send --approved --json --body-file - --subject … --to … [--cc …] [--allow-external]`), each value one argv element, no shell; the body on stdin; cwd = the agent repo root; env = HOME/USER/LOGNAME/PATH/LANG/LC_*/TMPDIR/TZ only — never a Prism secret, never `PROTON_SEND_ALLOW_EXTERNAL`. `--allow-external` is passed when a recipient is not the owner, but third-party mail still needs `PROTON_SEND_ALLOW_EXTERNAL=1` in the AGENT repo's `.env` — the recipient policy stays in `proton_send.py`. A reply sends exactly the recipients shown on the card (`expectTo`); the note supplies the subject and threading headers. Outcome: exit 0 → `sent` (+ `messageId`); a refusal `proton_send.py` raises before it opens the SMTP socket (markdown, recipient guard, Bridge unreachable / pin / login) → `failed`; a refused SMTP exchange, a timeout or a signal → `unknown`. Tests: `test/omni-proton-send.test.ts` (fake spawner). Later: port the two guards into live actions and switch `OMNI_EMAIL_EXECUTOR`.

## Change channel and push

`GET /api/omni/events` — SSE of ids-only notices, recycled every 15 min:
`event: thread|approval|card`, `data: {type, id, op, threadId?}`. Ops: thread
`created|working|done|needs-you|waiting|message`; approval
`pending|sent|failed|unknown|cancelled|revised`; card = the card op.

Push (APNs, content-free, through the existing sender): `{aps:{alert:{title:"Omni", body:
<generic>}, category}, type:"omni", category:"OMNI_THREAD"|"OMNI_APPROVAL", id, url:
"omni://thread/<id>"|"omni://approval/<id>"}` — on a proposal, on an agent-initiated
message, and when a turn ends while nobody watches its stream. **Deferred:** it uses Prism's
configured APNs topic; an Omni-own registration (`/api/omni/push`, own bundle topic) is not
built yet.

## Jobs (Hermes cron)

| Route | Body | Answer |
|---|---|---|
| `GET /api/omni/jobs` | | `{jobs:[{id, name, schedule, enabled, paused?, next_run_at?, last_run_at?, last_status?, last_error? (≤300), deliver?, skill?, skills?, repeat?, state?}]}` |
| `POST /api/omni/jobs` | `{name, schedule, prompt? (≤5000) \| skill?, deliver?}` | `201 {job}` |
| `POST /api/omni/jobs/:id/pause\|resume\|run` | `{}` | `{job}`; ids are 12 hex chars |

## Today (M2, read-only)

`GET /api/omni/today?date=YYYY-MM-DD` (default: the server's local date; the app should send
its own) →

```json
{
  "date": "2026-10-08",
  "agenda": [{"noteId", "title", "start", "end", "location", "meetLink", "link"}],
  "tasks": [{"noteId", "title", "status", "due", "priority", "threadId", "link"}],
  "taskIdentity": "person|account|unset",
  "needsYou": {"approvals": [Approval], "nudges": []},
  "inFlight": [{"id", "title", "state", "lastActivityAt"}],
  "openLoops": null, "brief": null,
  "errors": {"agenda": "query_502"}
}
```

Each section calls an existing route (`POST /api/query`) in process with the caller's own
credential; a failed section is `null` and named in `errors`. Agenda = `meeting` notes whose
`date` is the day, cancelled dropped. Tasks = open `assignedToMe` tasks by due date. Nudges,
open loops and the brief arrive with M3.

## Hooks (Hermes `omni-bridge` plugin; loopback + service token)

| Route | Body | Answer |
|---|---|---|
| `POST /api/omni/hooks/propose` | `{kind, payload, threadId?, summary? (≤300), expiresInSec? (60–604800)}` | `201 {id, digest, status:"pending", expiresAt}` — stores the draft, emits `approval` to the thread, pushes `OMNI_APPROVAL`. Sends nothing. |
| `POST /api/omni/hooks/turn` | `{sessionId}` | `202 {ok, threadId}` — a turn the app did not start (heartbeat, cron, `/goal`): unread +1, notice, push `OMNI_THREAD`. The app then reads the thread. |

## Developing against a stub Hermes

For app work on the laptop, with no Mac Mini, no real Hermes and no way to send anything.
The gateway is the real one; only Hermes is replaced.

```bash
cd apps/server
scripts/omni-dev.sh               # stub Hermes on 127.0.0.1:18642 + dev gateway on 127.0.0.1:8797
scripts/omni-dev.sh walkthrough   # in another terminal: 21 checks, one PASS/FAIL line each
scripts/omni-dev.sh scenarios     # what the stub can be told to do
```

The app's server URL is `http://127.0.0.1:8797` — this Mac and its simulators only (both
processes bind `127.0.0.1`; a phone on the network cannot reach them). Sign in through the
browser as the dev owner (`client_id=omni-native`), exactly as against production.

What `omni-dev.sh` does:

- Reads a **dev** env file (`apps/server/.env.dev`, or `OMNI_DEV_ENV_FILE`). It refuses
  `.env`, and refuses an env file whose `PARACHUTE_URL` is not loopback. Run it on the
  laptop only: on the Mini, loopback **is** the production vault.
- Uses its own SQLite file (`prism-omni-dev.db`, or `OMNI_DEV_DB`), copied once from the env
  file's `DB_PATH` so the dev owner's account and password exist. Another dev server may keep
  running on its own port and database. Delete the file to start clean.
- Makes a random Hermes key and a random hook service token at each start. They exist only
  in the two processes' environment: never in a file, never printed.
- Forces `OMNI_ENABLED=true`, `OMNI_HERMES_URL` = the stub, and **every executor off**:
  `OMNI_PROTON_SEND` empty, `ACTIONS_EMAIL_ENABLED` / `ACTIONS_CALENDAR_ENABLED` /
  `ACTIONS_MATRIX_ENABLED` = `false` (tweet and wallet have no executor). Approving a draft
  answers `503 executor_disabled` (or `executor_unavailable`) and the draft stays pending.
- Waits until the stub accepts the new key before it starts the gateway, so the gateway
  cannot be talking to some other Hermes on the machine. The stub refuses port 8642.

Ports: `OMNI_DEV_PORT` (8797), `OMNI_DEV_STUB_PORT` (18642).

### The stub (`scripts/omni-stub-hermes.ts`, logic in `scripts/lib/hermes-stub.ts`)

It implements the routes `src/omni/hermes-client.ts` calls and no others, checks the bearer
on each, binds `127.0.0.1` only, and keeps sessions, transcripts and jobs in memory (a
restart forgets them: the thread list still shows the gateway's own rows, but opening one
answers `404 not_found`). The test
suite drives the same code through the client's fetch seam.

What a turn does is chosen by a marker anywhere in the message the person types:

| Message contains | The turn |
|---|---|
| (no marker) | A normal answer: streamed chunks about 120 ms apart, one read-only tool call, the final text. |
| `stub:slow` / `stub:slow:<seconds>` | A chunk every second (default 120), then it holds. For cancel. |
| `stub:approval` / `stub:approval:<kind>` | Plays the `omni-bridge` plugin: a `tool.started` for `omni_propose`, then a real `POST /api/omni/hooks/propose` with the service token and `threadId`, then the answer. Kinds: `email` (default), `email-reply`, `message`, `calendar-invite`, `tweet`, `wallet-proposal`. Drafts use `example.com` addresses. |
| `stub:error` / `stub:error:<code>` | `run.failed`, optionally with a Hermes code (`auth_failed` → `auth`, `rate_limit` → `usage_limit`, `budget_exceeded` → `budget`, `timeout`, `max_iterations` → `iteration_limit`). |
| `stub:drop` | The connection breaks mid-answer → `hermes_unavailable`. |
| `stub:truncate` | The stream ends with no terminal frame → `stream_ended`. |
| `stub:http:<status>` | The chat request itself is refused (401 → `hermes_auth`, 5xx → `hermes_unavailable`). |
| `stub:card:<noteId>` | Reports a successful `prism_update_note` on that note of the dev vault, so the gateway builds a record card. The stub writes nothing. |
| `stub:followup` | A normal answer, then 3 s later a message nobody asked for, announced with `POST /api/omni/hooks/turn`. |
| `stub:hermes-approval`, `stub:queued`, `stub:empty` | Hermes' own approval request; a queued run; a run with no text. |

The gateway's own "revise" turn names `omni_propose`, so "Revise with Omni" produces a new
draft from the stub too.

To test the app's own reconnect, start `stub:slow`, drop the app's stream, and reattach with
`?after=<last seq>`: the turn keeps running in the gateway.

### What the stub cannot tell us

The gateway has never met a real Hermes. The stub was written from the gateway's client,
so it agrees with the client by construction. These assumptions need a test against the
installed Hermes before the app is pointed at production:

1. **Route and field names.** That `/api/sessions`, `/api/sessions/{id}/messages`,
   `/api/sessions/{id}/chat/stream`, `/v1/runs/{id}/stop` and `/api/jobs*` exist on the
   installed version with these shapes (`{data, has_more}`, `{session}`, `{jobs}`, `{job}`),
   and that the `api_server` platform is enabled.
2. **Creating a session with our own id.** `POST /api/sessions {id: "omni_<hex>"}` — the
   stub accepts a caller-chosen id and answers 409 for a taken one. Hermes may mint its own.
3. **Stream event names and fields.** `run.started`, `assistant.delta {delta}`,
   `assistant.completed {content}`, `tool.started {tool_name, args}`,
   `tool.completed|tool.failed {tool_name, preview}`, `run.completed|failed|cancelled`,
   `error {code}`, and `run_id` on the frames (the gateway reads the run id from the first
   frame that has one). A different name is silently ignored, not an error.
4. **Cancel.** That `/v1/runs/{run_id}/stop` stops a run started through
   `/api/sessions/{id}/chat/stream` (open item 1 in `voice-v1.md` § 14), and that dropping
   the stream interrupts the run. The gateway does both.
5. **Hanging up after `run.completed`.** The gateway closes the stream as soon as it reads
   the terminal frame. If Hermes treats that as an interrupt before it has saved the turn,
   the last message could be lost. The stub saves first.
6. **Tool names and matching.** Hermes' progress frames carry no call id; the gateway pairs
   `tool.completed` with the oldest open `tool.started` of the same name, and strips
   `mcp__<server>__`. Record cards depend on the exact tool names (`prism_update_note`, …)
   and on `args` being the tool input.
7. **Messages.** That `order=latest&limit=N` returns the newest N in chronological order,
   with `role`, `content` (string or parts), `tool_name`, `timestamp` (seconds or ISO).
8. **Error bodies and codes.** `{error:{code}}` with `session_not_found`; which codes a
   failed run carries (the gateway maps them by pattern and falls back to `agent_failed`).
9. **Keepalives and long silences.** The stub sends `: keepalive` every 15 s. A real model
   call that sends nothing for `OMNI_HERMES_STREAM_IDLE_MS` ends the turn as `timeout`.
10. **Concurrency.** What Hermes does with a second message while a run is active on the
    session from another surface (Telegram): the stub just runs it; `run.queued` is only
    played on request.
11. **Jobs.** Field names (`enabled`, `state`, `next_run_at`, …), what `pause` changes, and
    whether `include_disabled=true` is the right switch.
12. **The `omni-bridge` plugin does not exist yet.** The stub plays what the plugin should
    do; whether Hermes' plugin API can call the hooks during and after a turn, and pass the
    session id as `threadId`, is unproven.

It also says nothing about speed, cost, model behaviour, real tool calls, or real note
writes (cards from `create` watch the tree feed; the stub never creates a note).

## Not built yet (deferred, with reasons)

- `/api/omni/push` (Omni-own APNs topic), `/nudges*` (M3), `POST /tasks/:id/dispatch` (M2,
  needs the task write-back design), voice (M4).
- `tweet` / `wallet-proposal` executors (their scripts live in the agent repo).
- The Hermes `omni-bridge` plugin itself (agent repo). The dev stub plays its two calls.
- A test against a real Hermes (the list above).
