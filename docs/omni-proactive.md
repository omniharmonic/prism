# Proactive private preparation bridge

`POST /api/omni/hooks/proactive` uses the existing Omni hook guard: Omni enabled, trusted loopback, and the service bearer token. It cannot approve or execute outward actions. The Python coordinator must run in shadow until separately activated; this endpoint itself performs no reasoning.

```json
{
  "decisionId": "deliberation_123",
  "sourceId": "note123",
  "sourceRevision": "2026-10-11T12:00:00Z",
  "evidence": [{"sourceId": "note123", "revision": "2026-10-11T12:00:00Z"}],
  "title": "Dana needs the project date",
  "summary": "A reply would unblock planning",
  "body": "Dana asked about Friday. I prepared a reply for your review…",
  "kind": "reply-owed",
  "expiresAt": 1791723600000,
  "baseScore": 0.65,
  "priority": 0.4,
  "deadline": null,
  "urgentAt": null
}
```

Revisions are exact Parachute `updatedAt` strings, not content hashes or detector timestamps. Every preparation must include its source revision among evidence. Up to 20 evidence sources, 20,000 body characters, and seven days of validity are accepted. All existing nudge kinds are accepted, including calendar/travel reasoning anchored to actual vault sources. Operational job/health namespaces continue to use their existing dedicated hook.

Successful publication returns `{decisionId,threadId,nudgeId,replayed}` with 201 for a new commit or 200 for an identical replay. The source/revision/boundary tuple is unique, independent of decision ID. Optional `boundary` defaults to `change`; bounded labels such as `day`, `hour`, `week`, `overdue`, `conflict` and `watch:<hash>` permit distinct preparations for real deadline boundaries without opening another conversation. Reusing a decision ID with changed content, submitting another decision for an already prepared revision, stale evidence, expiry, or a dismissed/resolved/archived source returns 409. Unavailable, trashed or revisionless evidence returns 422; malformed input returns 400.

Session IDs are stable per owner/source. A lost session-create response is recovered by looking up the same ID; receipts, nudge binding, text event and unread state commit in one SQLite transaction. Evidence is freshly read both before and after remote session creation. Final ledger checks catch concurrent duplicates and human dismissal during the remote operation.

Prepared assistant content is gateway-owned, with source links and durable native history. Hermes has an actual session but does not contain that synthetic assistant row. The gateway merges preparation into history and adds the latest still-valid preparation as evidence-only context to a subsequent user turn, freshly checking revisions again. Stale preparation remains historical context in the UI but is not injected into a new model turn.

Publication sends no APNs alert and calls no external action executor. The same nudge queue handles attention via existing quiet hours, meeting suppression, digest timing, feedback and interruption limits. Exact sends still require the existing human review/approval path. A preparation body is not an executable approval payload.

Local verification: server typecheck and `omni-proactive`, `omni-nudge-routes`, `omni-gateway` tests. Test correspondence uses the Hermes stub; no real correspondence is sent.

## Internal management scope

`POST /api/omni/hooks/proactive/owner-intent` accepts `{threadId,sessionId,toolCallId?,change}` with the same loopback service authentication. It returns `{authorized:true,turn_id,owner_id,scope:"current_owner_turn"}` only while a live gateway turn was started by the owner's session/device with human origin, has a Hermes run, and its session ID matches the thread. Scheduled, downgraded agent-origin, ended and unverified compacted/subagent sessions cannot mint scope. The durable scope ledger is attached to the turn, not supplied by the model.

This verifies current owner turn scope; it does not prove that a model interpretation exactly matches the user's words or that a specific tool call exists. The owner has authorized bounded internal preference/watcher maintenance in this scope. The management service must enforce its allowlisted operations, immutable budget/privilege boundaries and source validation. Outward communications and guarded job mutations still follow their separate authorization paths. Semantic suggestions do not expand these boundaries.

## Attention preference sync

`POST /api/omni/hooks/proactive/preferences` accepts `{version,preferences}` under the same service authentication. `version` is the monotonic sum of preference row versions in the management ledger; the coordinator reads it and the complete snapshot in one transaction. Supported values are `notification_style: "concise"|"detailed"`, `deadline_only: boolean`, and `quiet_hours: "HH:MM-HH:MM"` in America/Denver. Missing keys reset their overrides, including undo to the prior default. Empty snapshots are valid. Unknown keys, invalid values and version conflicts are refused. Same-version equal snapshots replay; older versions cannot overwrite newer preferences.

Unset preferences preserve existing attention behavior. Explicit quiet hours replace the default quiet interval and hold all notifications, including urgent ones, inside the requested interval. Equal endpoints mean a full day of quiet. Deadline-only suppresses items without a deadline. `notification_style` still chooses the wording of the generic sentence. What else an alert shows is each device's own preview setting: since Omni Phase 1 the default is `title_preview` (a concise headline and a plain summary of at most 180 characters, see `docs/omni-nudges.md`); a device set to `generic` keeps the content-free sentence, and `title` shows the headline only. Both single-item and digest claims consult the durable owner preferences, so changing the preview decision cannot bypass claim-time enforcement.

## Completed and canceled sources

`POST /api/omni/hooks/proactive/resolve` accepts `{sources:[{sourceId,sourceRevision}]}` with at most 100 distinct source references. The trusted collector calls it only for confirmed completed/canceled/inactive sources, never because an active source merely fell outside a detector's eligibility window. The gateway ignores sources without a previously published preparation and freshly checks each current vault revision. Partial failures return `{resolved,ignored,rejected}`; unknown source health or revision mismatch cannot resolve an item.

Resolution removes the existing nudge from attention delivery and withholds preparation from future model turns. An idle conversation becomes done and read; an active user turn keeps its current state. Durable assistant history remains available. The hook makes no push, deletes no history, and executes no outward action.

The hourly deterministic nudge sweep still owns candidate scoring and deadlines. Its producer submits a natural-language title and a short plain summary (and the gateway makes any slug title or markdown preview readable on upsert) without a preparation revision, so the gateway freshly reads the source and retains the latest prepared title/summary only while the receipt is unexpired and all evidence revisions still match. The readable presentation is stored with the receipt, surviving restarts and prior candidate refreshes. A changed or unavailable supporting source releases this presentation override; a new valid preparation replaces it.

## Reviewed job management

The five generated Mini wrappers (`hourly`, `morning`, `evening`, `tweet`, `nightly-review`) have exact basename/SHA-256 pins in `reviewed-jobs.ts`. These bytes use the reviewed Mini repository/home paths and `gpt-5.6-sol` through `openai-codex`; changing the model, provider, paths or wrapper code requires new operator review and pins. Existing non-symlink file checks and local/script-only/no-monitor requirements remain in force. An exact pinned wrapper permits owner app name/schedule edits and run/resume; prompt, script and monitor mutations remain refused. An unrecognized wrapper remains visible and pausable/deletable.

The coordinator checks canonical Sent evidence immediately before publication and resolves confirmed replied sources during reconciliation. An inbound note's revision alone cannot detect a separate sent message. Continuation explicitly requires rereading current thread/Sent evidence before proposing a reply. This release does not add a new gateway mail-query executor; a reply after the last check can invalidate private preparation, and exact human approval remains necessary before any outward send.


`POST /api/omni/hooks/proactive/suppressed` accepts `{sourceIds:[...]}` with at most 500 bounded note IDs and returns only `{suppressedSourceIds:[...]}`. The service-authenticated coordinator uses this before reasoning/budget reservation to skip owner-dismissed, resolved, or archived-thread sources. Another owner's attention rows are excluded; caller-supplied owner identity is ignored. The check reads only the local attention ledger, never note contents, and does not change dismissal or resolution state.


`POST /api/omni/hooks/proactive/source-health` accepts `{}` under the service hook guard. It returns `{sources:[{name,status,kind,lastSuccessAt,staleAfterMs,failureStreak,reconcileOwed,reconcileStuck}],checkedAt}` from the existing worker health registry, filtered to the configured Omni primary vault. Only the three explicit nonnegative count fields accompany the health fields; invalid count data marks coverage failing. No errors, arbitrary detail fields, credentials, message contents or secondary-vault rows leave this endpoint. The coordinator treats unhealthy or unknown channel coverage as a reason to hold that channel's reasoning and report a coverage warning; healthy task sources can still proceed. A healthy vault does not establish a healthy Matrix or mail ingest.

## Cards mode (the understanding step, 2026-10-15)

Item runs (`--reconcile`, `--event-intake`) ask the reasoner for one decision per event, with a
**card** for every `surface`/`work` decision (agent repo `scripts/proactive_intelligence/cards.py`:
`SYSTEM_CARDS`, `validate_card`). Cards are published to `POST /api/omni/hooks/cards`; see
`docs/omni-module.md` § Item cards for the card and the routes.

Context the reasoner gets:

- Person notes for everyone on the item, matched by **strong key only**: an exact email address or
  an exact Matrix id (no case folding) claimed by exactly one person note. Benjamin's own addresses
  are excluded, and tombstoned or non-human notes are never matched.
- His calendar. The window is the item's time anchor (a deadline or a time written in the item)
  clamped to now minus 7 days ... now plus 30 days, then 7 days either side, and it always includes
  now ... now plus 7 days, so an old item still sees the coming week. An unreadable or possibly
  incomplete calendar is reported, never guessed.
- Linked tasks and projects, and up to three other open, unresolved items with the same people.

The Hermes run for cards:

- Memory is READ-ONLY: the model can recall, but nothing from the run is saved (email and chat text
  must not enter Hermes memory). If Hermes has a memory method the guard does not know, the run
  refuses to start.
- Only the read-only vault tools are allowed: `query_notes`, `find_path`, `vault_info`, under either
  name (`mcp__parachute__*` on the Mini, `mcp_parachute_*` on older Hermes). At most 6 tool calls.
- Time limit 90 seconds, plus a 15 second grace after which the parent stops the run.
- Any other tool call is refused and the run fails.
- If Hermes offers none of the vault tools, the run still happens without them, logs a warning and
  is counted in the job receipt (`cardsRunsWithoutVaultTools`; named refusals in `runRefusals`).

A context fact that cites no supplied source is dropped. A bad card drops only that card: the
decision stays a plain nudge with `cardError` recorded, and the run succeeds.

Publish outcomes:

| Answer | Result |
|---|---|
| 201 / 200 | published |
| 400 `invalid_*`, `headline_not_readable` | `refused`. On the first attempt only, and only when no card for that source was ever published, the decision is published once as a legacy nudge so Benjamin still hears about it. |
| 409 `stale_evidence` | `stale` |
| 409 `source_suppressed` | `suppressed` |
| other 409 | final |
| 422, 5xx | retried up to 3 times |

The resolve sweep reports open cards' source keys as well as nudge sources, so a card whose item was
answered elsewhere closes. It never closes a card by age: a card on an item older than about 8 days
is left for Benjamin to close, and a sweep that cannot read the card list skips cards instead of
aborting.

Rollback: `--legacy-publish`, or `OMNI_PROACTIVE_LEGACY=1` in `~/.hermes/.env`. The next run
publishes private preparations to `/hooks/proactive` exactly as before. Daily routines (morning,
evening, tweet, nightly review) are unchanged in Phase 1.

Quality: `tests/test_proactive_card_quality.py` grades 32 synthetic items (8 each: email, chat,
invite, task) with a fake reasoner. `python -m proactive_intelligence.card_quality` runs the real
model over the same items, by hand on the Mini; it publishes and sends nothing.
