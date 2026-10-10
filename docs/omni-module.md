# Omni module — `/api/omni/*`

Benjamin Life · 2026-10-08 · M1 (+ M2 read routes). The owner-only gateway inside the
Prism Server between the **Omni app** (SwiftUI, iPhone/iPad/Mac) and **Hermes** (Nous
Research Hermes Agent on the Mac Mini, the canonical thread store). Spec:
`omniharmonicagent/docs/omni/integration-contract.md` §§ 4–7. Code: `apps/server/src/routes/omni.ts`
and `apps/server/src/omni/*`. Tests: `apps/server/test/omni-gateway.test.ts`,
`omni-executor.test.ts`, `omni-proton-send.test.ts`, `omni-stub.test.ts`, `omni-contract.test.ts`
(Hermes is the stub in `apps/server/scripts/lib/hermes-stub.ts`; a real one is never contacted).
To work on the app without the Mac Mini: [Developing against a stub Hermes](#developing-against-a-stub-hermes).
What Hermes really does, and how it was checked: [The contract with Hermes](#the-contract-with-hermes-v0205-verified).

## Configuration (`apps/server/.env`, restart pm2 after a change)

| Variable | Default | Meaning |
|---|---|---|
| `OMNI_ENABLED` | off | `true` turns the module on. Off: **every** `/api/omni/*` route (hooks too) answers `404`. |
| `OMNI_HERMES_URL` | `http://127.0.0.1:8642` | Hermes API server. Plain `http` only to a loopback host; otherwise `https`. |
| `OMNI_HERMES_KEY_ENV` | `OMNI_HERMES_KEY` | The NAME of the env var that holds Hermes' `API_SERVER_KEY`. The key is sent only as `Authorization: Bearer` to that URL, redirects are refused, it is never logged or echoed. |
| `OMNI_SERVICE_TOKEN` | unset | Secret (≥ 16 chars) the Hermes `omni-bridge` plugin presents on the loopback hook routes. Unset → hooks refused. |
| `OMNI_HERMES_TIMEOUT_MS` | 15000 | Per non-streaming Hermes call. |
| `OMNI_HERMES_STREAM_IDLE_MS` | 300000 | A turn's stream is abandoned after this long with no bytes at all (Hermes sends `: keepalive` every 30 s), and the run is asked to stop. |
| `OMNI_HERMES_STOP_RETRY_MS` | 30000 | How long a cancel keeps asking Hermes to stop the run. Hermes cannot stop a run in its first seconds (its agent is still being built) and answers `run_not_found`; the gateway asks again until it is accepted. |
| `OMNI_TURN_MAX_MS` | 3600000 | Hard ceiling per turn. |
| `OMNI_APPROVAL_TTL_MS` | 86400000 | Default lifetime of a proposed approval. |
| `OMNI_EVENTS_PER_THREAD` | 2000 | Persisted stream events kept per thread. |
| `OMNI_MAX_STREAMS` | 16 | Concurrent SSE connections (thread streams + `/events`). |
| `OMNI_EXECUTORS` | unset | `off` = no approved draft is executed, whatever `ACTIONS_*_ENABLED` and `OMNI_PROTON_SEND` say (those also serve Prism's own live actions). Approving answers `executor_disabled`; the draft stays pending. The switch for running Omni with sending off. |
| `OMNI_EXECUTOR_KINDS` | unset | Optional non-command allowlist, comma-separated exact kinds. Unset preserves existing family gates; empty or any unknown kind denies all sends. `email,email-reply` enables only email kinds, still subject to their family gates. `OMNI_EXECUTORS=off` remains strongest. Commands retain their independent gate. |
| `OMNI_COMMAND_APPROVALS` | unset | `off` = no `command` approval (a tool call of a turn that Hermes' `omni-bridge` plugin paused) can be approved: approving answers `executor_disabled`, so the call never runs. Independent of `OMNI_EXECUTORS`, which is about sends. |
| `OMNI_EMAIL_EXECUTOR` | `proton-send` | Who sends an approved email (Benjamin, 2026-10-08: option B). `proton-send` = the agent repo's `scripts/proton_send.py --approved` (markdown refusal + third-party-recipient guard); `live-actions` = Prism's own `/api/actions/email/*` (`ACTIONS_EMAIL_ENABLED`). |
| `OMNI_PROTON_SEND` | unset | ABSOLUTE path to `proton_send.py` on the Mini (e.g. `/Users/benjaminlife/dev/omniharmonic_agent/scripts/proton_send.py`). Unset or missing file → approved emails answer `executor_disabled` and stay pending. |
| `OMNI_PROTON_PYTHON` | `python3` | Python that runs it (the agent repo's venv, if it has one). |
| `OMNI_PROTON_SEND_TIMEOUT_MS` | 90000 | Past it the send is killed and recorded `unknown` (check Sent before re-sending). |

Hermes side: the `api_server` platform enabled with a strong `API_SERVER_KEY`, bound to
loopback; the `omni-bridge` plugin installed with `OMNI_SERVICE_TOKEN` and
`OMNI_GATEWAY_URL` in Hermes' `.env`; `platform_toolsets.api_server` narrowed (Hermes'
default gives an API turn a terminal). The exact steps, checks and rollbacks for the Mini
are in the agent repo: `docs/omni/row10-runbook.md`. A Prism MCP with a `pp_` PAT (so
writes carry Prism's writer stamp) is optional: without it the agent writes through the
vault MCP and cards say `writer.kind: "external"`.

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

## Version and health

`GET /api/omni/version` → `{"api": 1, "minClient": "1.0"}`.

`GET /api/omni/health` → is the chain up? Asked on demand; holds no secret.

```json
{
  "api": 1, "hermes": "ok",
  "hooks": {"serviceToken": true, "trustLocal": true, "ready": true},
  "executors": {"email": {"name": "proton-send", "available": true, "enabled": false}, "tweet": {"name": "none", "available": false, "enabled": false}},
  "runningTurns": 0, "checkedAt": "…"
}
```

`hermes` is `ok` or the code a turn would end with (`hermes_unavailable`, `hermes_auth`,
`hermes_timeout`, `hermes_not_configured`). `hooks.ready: false` means the `omni-bridge`
plugin's proposals would be refused: no `OMNI_SERVICE_TOKEN`, or the server does not trust
loopback (`TRUST_LOCAL`). `executors` lists every approval kind. The Omni gateway is not a
`/acl/workers` source (it has no schedule to be late for); this route is its health.

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
  "lastSeq": 12,                "source": "text",            "gone": false
}
```

`state` ∈ `working | needs-you | waiting | scheduled | done`. Derived: a running turn →
`working`; a pending approval in the thread → `needs-you`; otherwise the stored state
(`done` after a successful turn, `needs-you` after a failed one, `waiting` after a cancel).

`gone: true` — **Hermes no longer has this session**: only the gateway's own row is left
(Hermes pruned or reset its sessions; the dev stub lost its memory). It is claimed only on
proof. Hermes' list leaves out archived sessions — and Hermes archives old ones by itself
— so a thread missing from a complete list is asked for by id, and only Hermes' own
`session_not_found` makes it gone (the answer is remembered for five minutes; at most 40
threads are asked about per request). Never while Hermes is unreachable, never from a
truncated list (more than 200 sessions), never for a thread with a turn running here. An
archived thread is `archived: true`, `gone: false`. The app shows such a thread as "no longer
available" and offers to remove it: `PATCH {archived: true}` then changes the gateway's row
only. Nothing is deleted — approvals, cards and the audit trail keep their thread id.

| Route | Body / query | Answer |
|---|---|---|
| `GET /api/omni/threads` | `?state=working,needs-you&q=<text>&archived=1` | `{threads:[Thread], next:null, hermes:"ok"\|"unavailable"}` — Hermes sessions merged with local rows; when Hermes is down, local rows only with `hermes:"unavailable"`. Pinned first, then newest. |
| `POST /api/omni/threads` | `{prompt, title?, objective?, taskNoteId?, noteIds?:[≤20], source?: "text"\|"voice"\|"nudge"\|"prism"}` | `201 {thread, turnId}` — creates the Hermes session `omni_<hex>` and starts the first turn. The thread's title is the gateway's own: Hermes wants titles unique and ≤ 100 characters, so a title it refuses is simply not given to it. |
| `GET /api/omni/threads/:id` | | `{thread, messages:[Message], cards:[Card], approvals:[Approval], activeTurnId}`; clears `unread`. A thread Hermes no longer has → `404 {error:"not_found", detail, gone:true}` (an id neither side knows: plain `404 not_found`). Do not retry it. |
| `PATCH /api/omni/threads/:id` | `{title?, pinned?, archived?, state?, unread?: bool}` (unknown keys → 400) | `{thread}`; title/pinned/archived are written to Hermes too (a title Hermes refuses — a duplicate, or over 100 characters — stays the gateway's only). For a thread Hermes no longer has, the gateway's own row is changed and Hermes is not written to. |
| `POST /api/omni/threads/:id/turns` | `{text, noteIds?}`, header `Idempotency-Key` (optional, 8–200 `[A-Za-z0-9._:-]`) | `202 {turnId, status:"running"}`; `409 {error:"conflict", turnId}` while a turn runs (attach to it); same key again → `200 {turnId, status}` + `Idempotent-Replayed: true`. A Hermes session started elsewhere (Telegram, Buzz) is adopted. |
| `GET /api/omni/threads/:id/stream?after=<seq>` | also honours `Last-Event-ID` | SSE, below. |
| `POST /api/omni/turns/:id/cancel` | `{}` | `202 {turnId, status:"cancelling"}` — the turn ends as `cancelled` at once; the gateway hangs up and asks Hermes `POST /v1/runs/{run}/stop` until Hermes accepts (up to `OMNI_HERMES_STOP_RETRY_MS`). An ended turn → `200 {turnId, status}`. |

**Message** (from Hermes `GET /api/sessions/{id}/messages`, newest 200):
`{id, role:"user"|"assistant", text, at}` or, for tool rows, `{id, role:"tool", toolName, at}`
(`toolName` without the `mcp__server__` prefix) — a tool's raw output is never forwarded.
Left out: assistant rows with no text (the carrier of a tool call; Hermes' `(empty)`
placeholder) and Hermes' model-only rows (`display_kind: hidden`). A turn whose model call
failed leaves only the user's message in the transcript; its outcome is the stream's `result`.

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
| `text` | `blockId, text` | final text of a block — REPLACES its deltas. What the agent says before a tool call is its own block; the answer is the last one. |
| `tool_use` | `id, name, input` | `name` without the `mcp__server__` prefix; `input` redacted (secret-named keys, token-shaped values) + truncated. A call a Hermes plugin refused (omni-bridge's tool policy) never appears: Hermes sends nothing for it. |
| `tool_result` | `toolUseId, ok, summary` | `summary` ≤ 300 chars, scrubbed (empty against Hermes, whose stream carries no result). **A second `tool_result` for the same `toolUseId` replaces the first**: Hermes announces every finished tool as completed, and whether it failed is known only once the gateway has read the tool's stored row — at once for a note write, otherwise when the run ends. |
| `card` | `card: Card` | a record the agent changed (below) |
| `approval` | `approval: Approval` | a draft was proposed, or a decision finished |
| `status` | `state, reason?` | thread state; `reason` = an error code, `queued`, `agent_message`, `hermes_approval_requested` |
| `result` | `ok, durationMs, errorCode?` | exactly one per turn |

`result.errorCode`: `cancelled`, `auth`, `usage_limit`, `budget`, `timeout`,
`iteration_limit`, `agent_failed`, `stream_ended`, `hermes_auth`, `hermes_unavailable`,
`hermes_timeout`, `hermes_not_configured`, `internal_error`. Hermes' own error text is
never forwarded: Hermes reports a failed model call as if it were the assistant's answer
("API call failed after 3 retries: HTTP 429 …"), so the gateway holds the last text until
the run's end says whether it is an answer, and a failure's text is only matched to pick
the code (`auth`, `usage_limit`, `budget`, `timeout`, else `agent_failed`; a model answer
with no text at all is `agent_failed`).

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
1. A write tool that WORKED — `prism_create_note`, `prism_update_note`,
   `prism_delete_note`, `prism_restore_version`, `prism_sheet_update`, `prism_add_comment`,
   `prism_resolve_comment`, `prism_suggest_edit`, or the vault MCP's
   `create-note`/`update-note`/`delete-note`. Hermes' stream does not say whether a tool
   worked, so right after a write tool completes the gateway reads its stored row from the
   session transcript (a failed write gets no card and its `tool_result` is corrected); the
   run's end (`run.completed.messages`) settles anything left. Updates/deletes name the id
   in the tool input.
2. A create: the new note's id from the tool's own result when it names one; else the input
   `path` through the tree projection; else the tree change feed during the turn (+30 s) for
   a row that appears with that path — or, with no path, that carries all the create's tags
   and its `metadata.title`, and only when exactly one pending create matches.
3. The tree has no writer column: a note written by the agent through any other tool, or a
   create with no id in its result and neither path nor tags+title, gets no card. A note created by someone else at
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
| `command` | `{tool, command?, cwd?, input?, reason, rule, title?, origin?}` — one paused tool call: a shell command (`command`, ≤100 000 chars, + `cwd`) or another tool's whole `input` (an object, ≤64 KB canonical); `origin` ∈ `subagent`, `cron` when it is not the turn itself | `hermes-turn`: no sender. Hermes runs the call it paused. See "Command approvals" |

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

### Command approvals (`kind: "command"`)

A `command` approval is not a draft of something to send. It is **one tool call of a running
turn** that the agent repo's `omni-bridge` plugin paused because its tool policy says a
person must see it first (network egress from the shell, an install, a restart, a delete
outside the workspace, a scheduled job, …; agent repo `docs/omni/tool-policy.md`). The
plugin proposes it and blocks inside Hermes' `pre_tool_call` hook, polling the gateway,
until it is decided.

- **Propose**: `POST /hooks/propose` as for any kind. While the thread's turn is running the
  gateway also emits `status {state:"needs-you", reason:"approval_requested"}`.
- **Decide** (same route and rules 1–4 as above): `send` = *approve once* → status
  `approved`, with **no executor called**; the answer is `200 {approval}`. `cancel` = *deny*.
  `PUT` (edit) is refused with `400`, and `revise` only closes it (no new turn is started;
  the plugin reads it as a denial): a command runs as written or not at all.
  With `OMNI_COMMAND_APPROVALS=off`, `send` answers `503 executor_disabled` and it stays
  pending (and so never runs). `OMNI_EXECUTORS=off` does not apply to this kind.
- **The plugin learns the decision** from `GET /hooks/approvals/:id`, runs exactly the call
  it showed, and reports the end with `POST /hooks/approvals/:id/result {ok}`:
  `approved → sent` (it ran) or `failed` (it ran and failed).
- **Nobody answered**: the plugin gives up after its own wait (10 minutes by default) and
  calls `POST /hooks/approvals/:id/withdraw` → `cancelled`, `decidedVia: "withdrawn"`.
- **The turn ended first** (finished, stopped, failed): the gateway cancels every pending
  `command` approval proposed on that thread since the turn began →
  `cancelled`, `decidedVia: "turn-ended"`. An `approved` one that never reported back
  becomes `unknown` after two hours.
- Each of these emits an `approval` event on the thread's stream, so a card on screen
  changes without a refresh. `Approval.decidedVia` (`session` / `device` for a person's decision) lets
  the app say "Denied" versus "Withdrawn".

The digest binds the tap to the exact command: the plugin runs what it proposed, the
gateway stores what was proposed, and the app's decision must carry that digest.

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
message, and when any non-cancelled turn ends for an existing thread. Stream
subscriptions do not prove foreground visibility, so they never suppress completion
pushes. Foreground presentation remains controlled by the OS.

`POST /api/omni/push` takes `{token, environment:"sandbox"|"production"}` from an
owner's live `omni-native` device credential. `DELETE /api/omni/push` removes that
credential's registration. Browser sessions and Prism device credentials are refused.
The server binds the application to the authenticated device client id and fixes Omni's
topic to `com.benjaminlife.omni`; a client cannot supply a topic. Prism retains its
configured topic and its existing `/api/push/apns` route, which accepts only
`prism-native` credentials. Legacy rows migrate to Prism. Token replacement and invalid
token cleanup stay within an application and signing environment; device revoke removes
its row, and expired credentials are excluded from fanout. Native apps must derive the
APNs environment from the signed provisioning entitlement, never the build configuration.

## Jobs (Hermes cron)

| Route | Body | Answer |
|---|---|---|
| `GET /api/omni/jobs` | | `{jobs:[{id, name, schedule, enabled, paused?, next_run_at?, last_run_at?, last_status?, last_error? (≤300), deliver?, skill?, skills?, repeat?, state?}]}` |
| `POST /api/omni/jobs` | `{name, schedule, prompt? (≤5000) \| skill?, deliver?}` | `201 {job}`; a schedule or job Hermes will not take → `400 hermes_rejected`. `schedule` is `"0 7 * * *"`, `"every 2h"`, `"30m"` or a timestamp. |
| `POST /api/omni/jobs/:id/pause\|resume\|run` | `{}` | `{job}`; ids are 12 hex chars |

A job comes back in Hermes' own shape: `schedule` is an object `{kind, expr, display}`
(show `display`), a paused job has `enabled: false`, `state: "paused"` (there is no `paused`
field), times are ISO strings with an offset.

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
  "errors": {"agenda": "vault_error"}
}
```

Each section calls an existing route (`POST /api/query`) in process with the caller's own
credential; a failed section is `null` and named in `errors` with the query route's own code
(`vault_error`, `vault_unreachable`, `rate_limited`, …; `query_<status>` when it gave none).
A section whose query failed on the vault side (5xx) is asked **once more** after 750 ms
before it is given up: the vault has been seen to refuse a good token, or drop a large
listing, now and then. The two sections are whole-tag listings and can take several seconds
on a large vault; the app shows a loading state meanwhile. Agenda = `meeting` notes whose
`date` is the day, cancelled dropped. Tasks = open `assignedToMe` tasks by due date. Nudges,
open loops and the brief arrive with M3.

## Hooks (Hermes `omni-bridge` plugin; loopback + service token)

| Route | Body | Answer |
|---|---|---|
| `POST /api/omni/hooks/propose` | `{kind, payload, threadId?, summary? (≤300), expiresInSec? (60–604800)}` | `201 {id, digest, status:"pending", expiresAt}` — stores the draft, emits `approval` to the thread, pushes `OMNI_APPROVAL`. Sends nothing. |
| `GET /api/omni/hooks/approvals/:id` | | `200 {id, status, digest, decidedVia}` — what the plugin polls while a `command` approval is pending. `404` unknown. |
| `POST /api/omni/hooks/approvals/:id/result` | `{ok: boolean}` | `200 {id, status}` — how an approved `command` ended: `sent` or `failed`. `409` unless it is a `command` in `approved`. |
| `POST /api/omni/hooks/approvals/:id/withdraw` | `{}` | `200 {id, status}` — the plugin stopped waiting: a pending `command` becomes `cancelled` (`decidedVia: "withdrawn"`). Idempotent. |
| `POST /api/omni/hooks/turn` | `{sessionId}` | `202 {ok, threadId}` — a turn the app did not start (the thread continued from the Hermes CLI, a cron job, Telegram): unread +1, notice, push `OMNI_THREAD`. The app then reads the thread. While the app's own turn runs on that thread the call is acknowledged and ignored (`ignored: "turn_running"`). |

The plugin is `hermes/plugins/omni-bridge` in the agent repo. `omni_propose` exists only on
turns the gateway drives (Hermes' `api_server` platform) and files the draft under that
turn's session id; the model cannot name another thread. With the gateway unreachable the
tool returns an error to the model and nothing exists anywhere. The plugin also carries
the Omni **tool policy** (agent repo `docs/omni/tool-policy.md`): those turns may have
Hermes' full toolset, with every shell command in an OS sandbox, every sender refused (the
model is told to draft with `omni_propose`), and risky calls paused as `command` approvals.
Without it the approval gate would mean nothing, because Hermes' API server gives a turn
its full toolset, terminal included.

## Developing against a stub Hermes

For app work on the laptop, with no Mac Mini, no real Hermes and no way to send anything.
The gateway is the real one; only Hermes is replaced.

```bash
cd apps/server
scripts/omni-dev.sh               # stub Hermes on 127.0.0.1:18642 + dev gateway on 127.0.0.1:8797
scripts/omni-dev.sh walkthrough   # in another terminal: 21 checks, one PASS/FAIL line each
OMNI_DEV_HERMES_HOME=~/.hermes-dev scripts/omni-dev.sh   # the same gateway against a REAL dev Hermes (below)
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

- **Builds the web app when it is missing or stale** (`apps/web/dist` older than
  `apps/web/src`, `apps/web/public`, `apps/web/index.html` or `packages/core/src`): the browser
  sign-in page is that build. `OMNI_DEV_WEB_BUILD=0` skips it. If the build fails it says so
  and carries on; a server with no build answers page requests with a plain "the web app
  isn't built" page (503) instead of a bare 404.
- **Prints the sign-in link in a box.** The dev server sends no email; when you ask for the
  email link on the sign-in page, the link appears in this terminal, boxed, to open in the
  same browser.
- **Keeps the stub's sessions in a file** beside the dev database
  (`<db>.stub.json`, or `OMNI_DEV_STUB_STATE`; git-ignored, owner-only), so the threads the
  gateway lists still open after a restart.
- **Reconciles at start.** A thread in the dev database that the stub does not have (the
  state file was deleted, or the database is older than it) is archived in the dev database
  — never deleted — and the count is printed. `OMNI_DEV_RECONCILE=0` leaves them, to see
  the app's "no longer available" state.

Ports: `OMNI_DEV_PORT` (8797), `OMNI_DEV_STUB_PORT` (18642). Two backends can run side by
side with their own ports and `OMNI_DEV_DB`.

**Stopping it:** Ctrl-C in its own terminal. Do not `pkill -f omni-dev.sh`: that ends every
dev backend on the machine, not just yours.

### The stub (`scripts/omni-stub-hermes.ts`, logic in `scripts/lib/hermes-stub.ts`)

It implements the routes `src/omni/hermes-client.ts` calls and no others, checks the bearer
on each, binds `127.0.0.1` only, and keeps sessions, transcripts and jobs in memory —
written to `OMNI_STUB_STATE` after every change when that is set (as `omni-dev.sh` does), so
a restart remembers them. Without the file a restart forgets everything, and the gateway
marks its own rows `gone` (opening one answers `404 not_found`, `gone: true`). The test
suite drives the same code through the client's fetch seam, with no file.

**It copies a real Hermes** (v0.20.5): the frames, the transcript rows, the error codes and
the odd rules below were read from Hermes' source and observed on a running one, and the
same checks run against both (`scripts/omni-contract.ts`). It no longer agrees with the
gateway merely because one author wrote both.

What a turn does is chosen by a marker anywhere in the message the person types:

| Message contains | The turn |
|---|---|
| (no marker) | A normal answer: a few words, one read-only tool call, the final text. |
| `stub:plain` | A one-word answer, no tool. |
| `stub:slow` / `stub:slow:<seconds>` | A chunk every second (default 120), then it holds. For cancel. |
| `stub:slowstart` / `stub:slowstart:<seconds>` | As `slow`, but the run's agent takes 3 s to exist: until then a stop is answered `run_not_found`, as on a real Hermes. Cancel it at once. |
| `stub:approval` / `stub:approval:<kind>` | Plays the `omni-bridge` plugin: the `omni_propose` tool, a real `POST /api/omni/hooks/propose` with the service token and `threadId`, then the answer. Kinds: `email` (default), `email-reply`, `message`, `calendar-invite`, `tweet`, `wallet-proposal`. Drafts use `example.com` addresses. |
| `stub:command` / `stub:command:fast` | Plays a paused tool call: proposes a `command` approval (a `curl` in the terminal) through the hook, **waits** for the decision the way the plugin does, then either runs the "tool" (approved: `tool.started` / `tool.completed`, result reported, an answer that quotes the output) or answers that it was denied / withdrawn. `:fast` polls every 5 ms instead of every 250 ms (for tests). Deny it in the app, or end the turn, to see the other paths. |
| `stub:error` / `stub:error:<kind>` | The model call fails, the way Hermes reports it: its error text as the answer and no answer row. Kinds: `auth_failed` → `auth`, `rate_limit` → `usage_limit`, `budget_exceeded` → `budget`, `timeout`; none → `agent_failed`. |
| `stub:raise` | Hermes itself throws: an `error` frame → `agent_failed`. |
| `stub:empty` | The model answers with no text → `agent_failed`. |
| `stub:toolfail:<noteId>` | A note update whose tool reports an error. Hermes still says `tool.completed`; the gateway corrects the `tool_result` and builds no card. |
| `stub:blocked` | A tool call a plugin refused: nothing on the stream for it. |
| `stub:drop` | The connection breaks mid-answer → `hermes_unavailable`. |
| `stub:truncate` | The stream ends with no terminal frame → `stream_ended`. |
| `stub:http:<status>` | The chat request itself is refused (401 → `hermes_auth`, 5xx → `hermes_unavailable`). |
| `stub:card:<noteId>` | Reports a successful `prism_update_note` on that note of the dev vault, so the gateway builds a record card. The stub writes nothing. |
| `stub:followup` | A normal answer, then 3 s later a message nobody asked for, announced with `POST /api/omni/hooks/turn`. |
| `stub:silent:<seconds>` | Says nothing for that long, then answers — only keepalives in between. |

The gateway's own "revise" turn names `omni_propose`, so "Revise with Omni" produces a new
draft from the stub too.

To test the app's own reconnect, start `stub:slow`, drop the app's stream, and reattach with
`?after=<last seq>`: the turn keeps running in the gateway.

## The contract with Hermes (v0.20.5, verified)

The gateway was written against a stub. On 2026-10-09 every assumption it makes was read
against the Hermes the Mini runs (`Hermes Agent v0.20.5`, upstream `aa74e184`, local
`791e2ae3`; source `gateway/platforms/api_server.py` unless another file is named) and run
against that code on a laptop, with a fake model behind it. "Observed" = seen on that
running instance; each row is a check in `scripts/omni-contract.ts` (the id in brackets).

| # | Assumption | Truth | Evidence | What the gateway does |
|---|---|---|---|---|
| 1 | The routes exist with these shapes, behind the `api_server` platform | **True**, when a usable `API_SERVER_KEY` is set (that alone enables the platform; `gateway/config.py:2284`). Not enabled on the Mini today. | Route table `:2214`; observed [1a–1d]. A wrong key is `401 gateway_auth_failed` (`:1920`). | Unchanged. `hermes_auth` on 401. |
| 2 | `POST /api/sessions` accepts our own `omni_<hex>` id | **True** (`409 session_exists` for a taken one). **But** a title must be unique across all sessions and ≤ 100 characters, else `400 invalid_title`. | `:4304`, `:4404`; `hermes_state.py:9084`; observed [2a–2c]. | A title Hermes refuses is dropped and the session is created untitled; the gateway keeps the title itself (create and rename). Before: a second "Call Dana" failed with `hermes_rejected`. |
| 2′ | (found) The session list is the whole truth | **False.** It leaves out archived sessions, and Hermes archives old ones itself. | `:4228` (`list_sessions_rich`, no archived); observed [2e]. | `gone` is claimed only when Hermes answers `session_not_found` for that id. Before: every archived thread would have shown as "no longer available". |
| 3 | Stream event names and fields | **Partly.** Sent: `run.started`, `message.started`, `assistant.delta {delta}`, `tool.progress`, `tool.started {tool_name, preview, args}`, `tool.completed {tool_name, preview: null, args: null}`, `assistant.completed {content}`, `run.completed {messages, usage}`, `error {message}`, `done`; `run_id`, `seq`, `ts` on every frame. **Never sent:** `tool.failed`, `run.failed`, `run.cancelled`, `run.queued`, `assistant.commentary`, `approval.request`, `error {code}`. | `:4719–4975` (`_tool_progress` `:4829`, endings `:4878–4925`); observed [3a–3c]. | The normalizer is rewritten around what is sent (`src/omni/stream.ts`); the other names are still read. Text said before a tool call is closed as its own block (before: it was replaced by the final answer and lost from the live view). |
| 4 | `/v1/runs/{id}/stop` stops a chat/stream run; dropping the stream interrupts it | **Partly.** Stop works — once the run's agent exists. In the first seconds it answers `404 run_not_found`, and a hang-up then is not noticed either: the run goes on to call the model and its tools. A hang-up later is noticed only at Hermes' next write. A stopped run ends as `run.completed` with the text so far. | `:8215`; `:4928` (chat runs are not in `_active_run_tasks`); `:4977`; observed [4a–4c]. | Cancel hangs up AND asks to stop until Hermes accepts (`OMNI_HERMES_STOP_RETRY_MS`); a cancel before the first frame waits for the run id. A run the gateway abandons (idle limit, turn ceiling, a server restart) is stopped too. Before: one stop request, lost if it came early. |
| 5 | Hanging up right after `run.completed` can lose the last message | **No.** The transcript is written before `assistant.completed` is sent. | `:4855–4902` (frames follow `_run_agent`'s return); observed [5]. | It now reads to Hermes' own `done` + close anyway (2 s at most), so Hermes logs no interrupted run for a finished turn. |
| 6 | Tool pairing without call ids; `tool.failed` marks a failure | **Half true.** No call id on the stream — and **no failure signal at all**: a failed tool sends the same `tool.completed`; a call a plugin vetoed sends nothing. The outcome is only in the stored tool row (`run.completed.messages`, and the transcript), which also carries the call id and the result. With tool search on (default), an MCP or plugin tool is stored as a call of the `tool_call` bridge; the stream and the row name the real tool. MCP names are `mcp__server__tool`. | `agent/tool_executor.py:1857–1863` (`is_error` is passed, `_tool_progress` drops it); `agent/display.py:1335`; `tools/tool_search.py`; observed [6a, 6b]. | Tool rows are read and paired with the calls (same name, same arguments first): a wrong `ok` is corrected with a second `tool_result`, and a write becomes a card only once its row says it worked. Before: a failed note write produced a card. A create's id is now taken from the tool's result. |
| 7 | `order=latest&limit=N` → the newest N, oldest first; `role`, `content`, `tool_name`, `timestamp` | **True.** `timestamp` is seconds (float); ids are integers. Assistant rows that only carry a tool call have empty content. | `:4495`; observed [7a, 7b]. | Empty assistant rows, `(empty)` placeholders and hidden rows are not shown; tool names lose their `mcp__server__` prefix. |
| 8 | A failed run carries an error code | **False.** A failed model call ends as `assistant.completed` whose content is Hermes' error text, then `run.completed` — success-shaped. The only tell: `messages` holds no assistant answer (and the transcript has only the user's message). An empty model answer is stored as `(empty)`. Hermes itself throwing is `error {message}`, no code. | `agent/conversation_loop.py:6525`; `:4878`, `:4922`; observed [8a, 8b]. | The final text is held until `run.completed`; no answer row → `result {ok: false}` with a code matched from the text, which is never forwarded. Before: Hermes' error text was shown as the agent's answer on a "successful" turn. |
| 9 | Keepalives vs `OMNI_HERMES_STREAM_IDLE_MS` | **True**, every 30 s of silence (the stub said 15). | `:264`, `:4954`; observed [9]: first keepalive 30 s into a 45 s silence. | Unchanged (300 s limit); the stub now sends them every 30 s. |
| 10 | A second message on a busy session | Hermes runs **both at once** on the same session: no queue, no refusal. | `_handle_session_chat_stream` has no per-session lock; observed [10]. | Unchanged: the gateway's own one-turn-per-thread rule (409) is what prevents it. A turn started on the same session from another surface is not prevented by anyone. |
| 11 | Job field names; what pause changes; `include_disabled=true` | **Partly.** `schedule` is an object `{kind, expr, display}`; pause sets `enabled: false`, `state: "paused"`, `paused_at` (there is no `paused` field) and the job is listed only with `include_disabled=true`; create answers 200; **`skill` is ignored** (only `skills`, a list); a bad schedule or an empty job is a **500** with the reason as text. | `:6591–6800`; `cron/jobs.py:2383`; observed [11]. | Sends `skills: [skill]`; maps those 500s to `400 hermes_rejected`; documents the shape. Before: a job made from a skill failed as `hermes_unavailable`. |
| 12 | The `omni-bridge` plugin can call the hooks during and after a turn, with the session id as `threadId` | **True**, and built: agent repo `hermes/plugins/omni-bridge`. A plugin tool sees the turn's platform and session through `gateway.session_context`; `on_session_end` carries `platform` and `session_id`. | `hermes_cli/plugins.py` (`register_tool`, `VALID_HOOKS`); `:7164`; `agent/turn_finalizer.py:828`. Ran end to end on the laptop (`omni-dev.sh walkthrough`, 23 steps). | — |
| 13 | (found) "Omni turns run without a terminal" | **False.** The API server's default toolset is the full one: terminal, process, code execution, file writes, cron, delegation. | `toolsets.py:438`; observed (the tools the model was offered). | Not the gateway's to fix: the plugin's tool policy governs those turns (sandboxed shell, senders refused, risky calls on a `command` approval card — agent repo `docs/omni/tool-policy.md`), and the runbook decides which toolset `platform_toolsets.api_server` offers. |

### Testing against a real Hermes

Nothing below touches `~/.hermes`, a provider, or the network beyond loopback.

```bash
# 1. The exact Hermes source, in its own virtualenv, with its own home.
git clone <the Hermes checkout> ~/dev/hermes-src-mini
UV_PROJECT_ENVIRONMENT=~/.hermes-dev/venv uv sync --frozen --no-dev --extra messaging --python 3.11   # in that clone

# 2. ~/.hermes-dev/config.yaml: a custom OpenAI-compatible endpoint = the fake model.
#      model: {provider: custom, base_url: http://127.0.0.1:18661/v1, default: fake-1, api_key: fake-not-a-secret, context_length: 131072}
#      security: {allow_lazy_installs: false}     memory: {memory_enabled: false}
#    ~/.hermes-dev/.env (mode 600): API_SERVER_KEY=<openssl rand -hex 32>, API_SERVER_HOST=127.0.0.1,
#      API_SERVER_PORT=18660, OMNI_SERVICE_TOKEN=<openssl rand -hex 32>, OMNI_GATEWAY_URL=http://127.0.0.1:8799
#    The plugin: python3 hermes/install.py --plugins-only --apply --hermes-home ~/.hermes-dev   (agent repo)

# 3. The fake model, then Hermes with a clean environment (no real HOME, no credentials).
OMNI_FAKE_LLM_PORT=18661 node --import tsx scripts/omni-fake-llm.ts &
env -i HOME=$HOME/.hermes-dev/home HERMES_HOME=$HOME/.hermes-dev PATH=$HOME/.hermes-dev/venv/bin:/usr/bin:/bin \
  $HOME/.hermes-dev/venv/bin/python -m hermes_cli.main gateway run &

# 4. The contract, straight at Hermes (key from its .env, never printed):
OMNI_HERMES_URL=http://127.0.0.1:18660 OMNI_HERMES_KEY="$(sed -n 's/^API_SERVER_KEY=//p' ~/.hermes-dev/.env)" \
  node --import tsx scripts/omni-contract.ts --full --driver fake --jobs --keepalive

# 3b. For the full-tools part of the walk-through: a fake vault MCP and a stand-in `gog`.
#    OMNI_FAKE_MCP_PORT=18663 node --import tsx scripts/omni-fake-mcp.ts &
#    config.yaml:  mcp_servers: {parachute: {url: "http://127.0.0.1:18663/mcp", headers: {Authorization: "Bearer fake-vault-token"}}}
#                  platform_toolsets: {api_server: [omni-full, omni]}     (the plugin's own toolset — as on the Mini)
#    .env:         OMNI_BRIDGE_WORKSPACE=<a directory outside ~/.hermes-dev>   OMNI_BRIDGE_APPROVAL_WAIT_S=120
#    A `gog` on Hermes' PATH that prints two fixed events for `gog calendar events …` (it stands in for the real CLI).

# 5. The gateway on top of it, and the walk-through (sign-in → turns → cancel → the plugin's
#    proposal → decide → executor_disabled → FULL TOOLS: usefulness, approvals, an
#    adversarial model → a notice from the Hermes CLI):
OMNI_DEV_HERMES_HOME=~/.hermes-dev OMNI_DEV_PORT=8799 scripts/omni-dev.sh
OMNI_DEV_HERMES_HOME=~/.hermes-dev OMNI_DEV_PORT=8799 scripts/omni-dev.sh walkthrough
```

`scripts/omni-fake-llm.ts` is a deterministic OpenAI-compatible server (markers `fake:slow`,
`fake:tool:<name> <json>`, `fake:echo` (the answer repeats the start of the tool's result),
`fake:propose`, `fake:error:<status>`, `fake:empty`, `fake:silent:<s>`; see its header).
`scripts/omni-fake-mcp.ts` is an in-memory MCP server with the Parachute vault's tool names
(`query-notes`, `create-note`, `update-note`, `delete-note`, `vault-info`), so a dev Hermes
makes real MCP calls through its tool-search bridge.

**The full-tools walk-through** (REAL mode only; `fullPower()` in
`scripts/omni-walkthrough.ts`) drives the real Hermes with the fake model playing, in turn,
a useful assistant and a hostile one:

- First it checks the dev Hermes offers Omni `[omni-full, omni]` and that the plugin's log
  says the sandbox is on and its self-test passed.
- *Useful*: a calendar read through the stand-in `gog` (a trusted reader, no card); a vault
  query and a note write through the MCP (a record card; a delete asks); a read-only shell
  command, `write_file` in the workspace, a script run; a guarded command that pauses on a
  card, is approved, runs, and whose output arrives in the thread; network egress denied
  then approved, counted by a listener the script owns.
- *Hostile*: about sixty attempts, each of which must end **refused** (the policy named the
  rule), **contained** (it ran and the OS sandbox refused the read / write / connection), or
  **on a card that is then denied** — reading the dev Hermes' real `.env` a dozen ways
  (including `search_files` over the whole home directory), sending by every sender,
  switching the guard off, leaving the sandbox (a launchd job, an AppleEvent, `open`,
  `crontab`, a local socket, the clipboard, a local port), other tools (`vision_analyze` /
  the browser on a secret or a local address, an MCP server handed a local file), a cron
  job, `execute_code`, a sub-agent, and **the swap race**: a background process flips a
  workspace file into a link to the secret while `read_file` reads it, twelve times. After every attempt the script checks that neither of the dev Hermes' two
  real secrets appears anywhere in the stream, that its listener saw no request, and that
  the files an attack aimed at are unchanged. `scripts/omni-contract.ts` has three depths: the default
makes no model call and is safe against production (it creates one `omni_contract_…`
session and deletes it); `--turn` adds one short message to the model; `--full` needs
`--driver stub|fake`. It refuses a host that is not loopback unless `--allow-remote` (then
https only), and prints no key, header or response body.

What this still cannot tell: speed, cost and a real model's choices (will it reach for
`omni_propose` through Hermes' tool-search bridge without being told to), the Mini's own
config, the real vault, and the real `gog` under the sandbox (the agent repo's runbook has
that check: `scripts/omni_policy_check.py --run 'gog calendar events …'` on the Mini).

## Not built yet (deferred, with reasons)

- `/nudges*` (M3), `POST /tasks/:id/dispatch` (M2,
  needs the task write-back design), voice (M4).
- `tweet` / `wallet-proposal` executors (their scripts live in the agent repo).
- Switching it on in production: the steps are `docs/omni/row10-runbook.md` in the agent repo.

### Exact-event calendar RSVP activation

`calendar-rsvp` proposals contain only `{eventId, response}`; response is `accepted`, `declined` or `tentative`. The native card shows the exact Google occurrence ID and response. Proposing sends nothing. A signed-in human Send decision with matching digest executes the existing audited `/api/actions/calendar/rsvp` route once. Invite creation stays separate. Direct shell RSVP commands redirect to this card.

After reviewed tagged server/agent deploy, back up server environment with mode0600 and change only `OMNI_EXECUTOR_KINDS=email,email-reply,calendar-rsvp`. Preserve `ACTIONS_CALENDAR_ENABLED=true`, email executor configuration and Matrix/invite restrictions. Restart through named tagged deploy. Activation grants no RSVP itself: owner must approve the exact event and response card. Rollback restores backup or removes `calendar-rsvp`; `OMNI_EXECUTORS=off` disables all non-command executors.

### Owner recurring-job editor

The native Recurring screen can create agent jobs and edit their name, schedule and
instructions. `POST /api/omni/jobs` requires `Idempotency-Key`; new jobs always deliver
locally and use a dedicated, accessible scheduled owner conversation. The server sends
its selected `X-Omni-Thread` to the managed Hermes adapter and checks the returned origin.
An uncertain creation retains its reservation and conversation: refresh Recurring before
creating another job. A routing-verification failure explicitly reports `created: true`
and attempts to pause that already-created job; retrying the same key replays the result.

`PUT /jobs/:id` accepts only name, schedule and prompt; other runner fields and delivery
remain unchanged. `DELETE /jobs/:id` removes the schedule, preserving conversation history.
Editing, resuming and running require local delivery and an existing, nonarchived Omni
owner conversation in the `api_server` origin. Legacy jobs without that routing need an
explicit migration. Script, no-agent and monitor jobs are shown as read-only runners;
viewing, pausing and deleting remain available, but this initial editor does not run or
resume them. Existing active scripts are not changed by listing them.

Run Now is accepted only when Hermes reports `executed: true` and
`execution_mode: "background"`. This confirms dispatch, not successful completion; an
old reschedule-only response is an error. All endpoints retain the module's owner-only
access and capped JSON handling. Physical-device interaction checks remain pending.

### Installed skills

The owner-only native Skills screen (Settings → Agent) reads and edits existing local
`SKILL.md` documents. Routes `/skills`, `/skills/:id` and `PUT /skills/:id` use a configured
server-side root, opaque IDs, bounded reads and revision-checked saves. Linked repository
sources remain read-only; no client can choose a host path. Unconfigured roots fail
visibly. Configuration, limits and the trusted local-admin filesystem boundary are in
[the skills runbook](runbook/omni-skills.md). Physical interaction and live activation
remain rollout checks; no installed skill was modified during implementation.

Reviewed M3 schedules can expose Run, Resume and name/schedule editing when `OMNI_REVIEWED_JOB_SCRIPTS_DIR` points to the local Hermes scripts directory. The server rechecks the three known wrapper basenames and SHA-256 bytes at every operation; symlinks, changed wrappers, monitors and nonlocal delivery fail closed. Prompt, script and delivery remain immutable. The six unrelated legacy script jobs remain read-only apart from Pause/Delete. Capabilities returned by `/jobs` drive the native controls; a successful Run receipt indicates background dispatch, not successful completion. Local filesystem administrators are trusted; this pinning is not an OS sandbox against concurrent privileged filesystem replacement.
