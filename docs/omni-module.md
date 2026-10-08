# Omni module — `/api/omni/*`

Benjamin Life · 2026-10-08 · M1 (+ M2 read routes). The owner-only gateway inside the
Prism Server between the **Omni app** (SwiftUI, iPhone/iPad/Mac) and **Hermes** (Nous
Research Hermes Agent on the Mac Mini, the canonical thread store). Spec:
`omniharmonicagent/docs/omni/integration-contract.md` §§ 4–7. Code: `apps/server/src/routes/omni.ts`
and `apps/server/src/omni/*`. Tests: `apps/server/test/omni-gateway.test.ts`,
`apps/server/test/omni-executor.test.ts` (Hermes faked, never contacted).

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

Hermes side (VERIFY on the Mini): the `api_server` platform enabled with a strong
`API_SERVER_KEY`, bound to loopback; the Prism MCP configured with a `pp_` PAT so writes
carry Prism's writer stamp.

## Who may call

| Route group | Credential | Refused |
|---|---|---|
| Everything except `/hooks/*` | The **server owner** (`OWNER_EMAIL`) by browser session cookie **or** native device token `Authorization: Bearer pd_…` | anonymous → `401 unauthorized`; another account (even an admin), a capability link, the loopback owner token, an in-process Prism-MCP dispatch → `403 forbidden` |
| `/hooks/*` | Loopback request (no `X-Forwarded-For`/`X-Real-IP`/`CF-Connecting-IP`) **and** `Authorization: Bearer <OMNI_SERVICE_TOKEN>` | everything else → `403 forbidden` |

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
the replay when nothing runs). Reconnect with `?after=<last seq>`.

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
  "executor": {"name": "prism-live-actions:email", "available": true, "enabled": false}
}
```

`digest` = SHA-256 (hex) of the canonical JSON (keys sorted at every depth, no whitespace) of
`{"kind": <kind>, "payload": <payload>}`. The app may recompute it to check what it shows.

| `kind` | `payload` | Executor |
|---|---|---|
| `email` | `{to:[≤20], cc?:[≤20], subject, body}` (plain text) | `POST /api/actions/email/send` (`ACTIONS_EMAIL_ENABLED`) |
| `email-reply` | `{noteId, expectTo:[…], cc?, body}` | `POST /api/actions/email/reply` |
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

Every proposal, edit, refusal and execution writes an `omni_audit` row (ids + 16-hex digest
prefixes, never the payload).

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

## Not built yet (deferred, with reasons)

- `/api/omni/push` (Omni-own APNs topic), `/nudges*` (M3), `POST /tasks/:id/dispatch` (M2,
  needs the task write-back design), voice (M4).
- `tweet` / `wallet-proposal` executors (their scripts live in the agent repo).
- `proton_send.py --approved` as an email executor (the live-action route is used instead; it
  enforces plain text only through the app, not the `find_markdown` check).
- `omni://auth/callback` in `DEVICE_REDIRECT_URIS` and an `omni-native` client id
  (`auth/device.ts`, outside this module).
- The Hermes `omni-bridge` plugin itself (agent repo).
