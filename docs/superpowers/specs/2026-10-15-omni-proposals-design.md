# Omni: proposals, dispatch, scheduling and memory — design

Date: 2026-10-15 · Status: draft for owner review · Repos: `prism` (server + Omni app), `omniharmonic_agent` (Hermes, skills, scripts)

## 1. Intent

**What the owner said (2026-10-14/15).**
- Omni dumps information and is not genuinely proactive. It should read an incoming email, calendar invite, task or message *in context*, interpret it, put the pieces together, and **propose**: "You got this email. It's asking for X. How would you like me to handle it?" — with a few ready approaches plus "something else".
- Proposals and dispatched work are **cards** you act on, not plain text. The email approval card is the model he likes.
- **Card → chat → card**: a card can open into a conversation while things are worked out, and the result comes back as a tight card.
- Dispatching should feel robust: "draft replies to these 5", then approve each.
- **Nothing is sent to another person without his approval of that exact message.** Certainty, not policy.
- **Needs you** must be reconceived: today the layout, button padding and purpose are unclear.
- Scope is **all four sources at once** — email, calendar, tasks, messages — because they are contextually related.
- **Scheduling** must be something he can dispatch and trust.
- **Memory**: Hermes should keep a comprehensive, current picture of his life so it understands context.
- "More usability than utility."

**Assumptions (owner approved the recommendations 2026-10-15).**
- One card per item, changing state as it moves (proposed → chosen → working → draft ready → sent → delivered).
- Needs you holds only decisions that need him; work in progress is visible but out of the way.
- Interpretation and options are prepared *before* the card appears — he never waits on the model to think.

**Success.** He opens Omni, sees a handful of cards, handles each in one or two taps with confidence, and nothing leaves without his approval. Weekly audit: every personal message he owes a reply to was surfaced.

## 2. Ground truth (research 2026-10-15)

- **Send safety.** The Omni app path is code-enforced (agent proposes; human-origin, digest-bound approval; exact payload executed). Legacy paths bypassed it; the autonomous scheduling heartbeat was paused 2026-10-15 and the "one door" work (§4) is in progress on branch `safety/one-door`.
- **Proactive pipeline.** `omni_nudges.py` is deterministic (no model). The proactive coordinator makes **one** model call, no tools, no Hermes memory (`skip_memory=True`), ≤ 12 related notes × 1,800 chars, and returns `surface|work|wait|ignore` with at most one draft, appended as plain text to a thread. No step produces options.
- **App.** Needs you = nudge cards (title, summary, reasons, "Draft reply"/"Start working", More menu) then approval cards. The timeline has no proposal/option message type and no quick replies. The approval card (header · field grid · full body · Send/Edit/Revise/Cancel) is the shape to keep.
- **Memory.** Five unconnected stores. Hermes MEMORY.md/USER.md (USER.md full at 1.4k chars), a 5.4 GB session archive reachable only by search, repo memory files Hermes never reads, and vault person/project notes whose relationship/project fields were backfilled once (21 people). Nothing learns from approve/revise/discard.
- **Scheduling.** Three paths with no shared state; slot finder reads one calendar, fixed 9–17, mislabels DST; holds are JSON only; reply detection by thread id/day; counter-proposals ignored; no re-check before booking; follow-ups and booking confirmation sent without approval.

## 3. Concepts

| Term | Meaning |
|---|---|
| **Item** | One thing that arrived or is due: an email thread, a chat thread, a calendar invite/event, a task. |
| **Card** | Omni's understanding of one item plus what to do about it. Has a state, a thread, and zero or more drafts. Replaces "nudge" in the UI. |
| **Option** | A concrete way to handle an item ("Reply yes, offer Thu 2pm", "Ask Kevin", "Decline politely", "Add a task for Friday"). Each option is a plan; if it involves sending, executing it produces a draft. |
| **Draft** | An exact outbound payload awaiting approval (existing approval kinds + new ones). |
| **Dispatch** | Handing Omni one or more items with an option or an instruction; it works in a thread and returns drafts. |
| **Life model** | The vault notes that describe the owner's world (people, projects, commitments, preferences, routines), kept current by Omni and read for every card. |

## 4. Safety: the one door (prerequisite, in progress)

Rule: **every outbound send to another person goes through the Prism approval executor**, which runs only after a human-origin, digest-matched approval and sends exactly the approved bytes.

- Send scripts (`proton_send.py`, `twitter_post.py`/`omni_tweet_send.py`, `matrix_reader.py send|send-to`, the agent-Gmail sender) refuse unless handed a **single-use send grant**: minted by the executor at approval time, ≤ 60 s, bound to (approval id, payload digest), verified and consumed by Prism over loopback.
- Every other surface (legacy Telegram bot, Buzz agents, Hermes gateway on all platforms, dashboard dispatch/cron/swarm, missions) **proposes** into Needs you instead of sending. No surface resumes a model after approval to "write the final text".
- Unrestricted agent shells (`--dangerously-skip-permissions`) are removed where the model sees untrusted text.
- Allowed without approval: messages to the owner himself (briefings to his own Telegram), changes to his own calendar that notify nobody (private holds, §7).
- Residual risk is stated in the PR: a non-agent process running as the owner can read the same credentials; the door closes the paths an *agent* can take.

## 5. Understanding: from item to card

### 5.1 Inputs (all four sources, read together)
For each new or changed item the **understanding step** assembles:
- the item itself (latest message + enough history; invite details; task fields);
- **people**: person notes for every participant (relationship, last meaningful contact, open commitments, tone, notes for agent), resolved by strong keys only;
- **calendar**: his events ±7 days around any time mentioned, free blocks, conflicts, travel;
- **tasks & projects**: open tasks and project notes linked to the people or topics;
- **related threads**: other open items with the same people or subject (so "Sam emailed and also messaged" becomes one card);
- **owner profile + preferences** (§9): working hours, communication style, standing rules, learned preferences;
- **past outcomes**: how similar cards were handled (approve/revise/discard history).

### 5.2 The step
Runs on the Mini via Hermes with **read-only tools** (vault query, people lookup, calendar free/busy, task lookup) and a step budget (default ≤ 6 tool calls, ≤ 90 s). Hermes memory is **on** for this step (today it is skipped). Output is validated JSON:

```json
{
  "itemRefs": ["vault/messages/email/…"],
  "kind": "email | message | invite | task | scheduling",
  "headline": "Sam asks whether you can review the grant budget before Friday",
  "context": [{"text": "You have Thu 2–4 free", "source": "calendar"},
              {"text": "Grant deadline is Fri 5pm", "source": "vault/projects/grant/PROJECT"}],
  "ask": "Review the budget sheet and reply with comments",
  "urgency": "today | this-week | whenever",
  "options": [
    {"id": "a", "label": "Say yes, Thursday afternoon", "plan": "Reply confirming; add a task Thu 2pm",
     "produces": ["email-reply", "task"], "draft": {…exact draft…}},
    {"id": "b", "label": "Ask to push to Monday", "plan": "Reply proposing Monday", "produces": ["email-reply"]},
    {"id": "c", "label": "Hand to Kevin", "plan": "Forward to Kevin with a note", "produces": ["email"]}
  ],
  "recommended": "a",
  "noAction": false
}
```

Rules: 2–4 options, each concrete and distinct; the recommended option carries a ready draft so the common case is one tap to review; options that send produce drafts, never sends; untrusted text (email bodies) is quoted as data, never followed as instruction; anything the model cannot ground in a source is not stated as fact. `noAction: true` items (newsletters, receipts, FYIs) do not make cards; they can appear in a digest.

### 5.3 What makes a card
The deterministic sweep (fixed per §8.4) decides **which** items deserve attention; the understanding step decides **what** they mean. Cards are created for: messages owed a reply, invites needing a response, tasks due/overdue or newly assigned, scheduling requests, and anything the step marks `today`. Related items merge into one card.

## 6. Cards, Needs you, card ↔ chat

### 6.1 Card states
`proposed` → (owner picks option or types) → `working` → `draft-ready` → (approve) → `sent` → `delivered` | `failed` · side states `waiting` (on someone else, e.g. scheduling reply), `snoozed`, `dismissed`, `done`. One card per item; state changes update the same card everywhere (Needs you, its thread, notifications).

### 6.2 Card anatomy (every source)
```
[● Email · Sam Rivera · 2h]                         [Today]
Sam asks whether you can review the grant budget before Friday
You're free Thu 2–4 · Grant due Fri 5pm · Last talked Oct 2
──────────────────────────────────────────────────────────
(★ Say yes, Thursday afternoon)   ← recommended, shows draft preview
(  Ask to push to Monday       )
(  Hand to Kevin               )
[ Something else…                                       ]
──────────────────────────────────────────────────────────
Open thread · Later · Not needed
```
- Source chip (icon + source + who + age) and an urgency tag.
- **Headline in plain language** (never a slug), one context line built from the `context` facts (tap to see sources).
- **Options as full-width buttons** (iPhone: stacked, 44 pt; Mac/iPad: wrapped chips, consistent 12 pt padding); the recommended one is marked and expands to show its draft.
- **Something else…**: a text field; submitting it dispatches with that instruction.
- Footer actions are quiet text buttons: Open thread, Later (snooze presets), Not needed (feeds learning).
- When `draft-ready`, the card becomes the existing approval layout (fields + full body, verbatim) with **Send · Edit · Revise · Discard**, plus the send-identity line (§8.2).
- When `sent`/`delivered`, it collapses to one line with a delivery check, then leaves Needs you.

### 6.3 Needs you, reconceived
Three sections, nothing else at the top level:
1. **Decide** — `proposed` cards, ordered by urgency then age.
2. **Approve** — `draft-ready` cards (drafts waiting for Send).
3. **In motion** — `working` and `waiting` cards as single-line rows (e.g. "Scheduling with Ana — waiting on reply since Tue"), collapsible.

The proactivity dial, error rows and audit move to Settings / a secondary menu. Empty state: "You're clear. N things are in motion."

### 6.4 Card ↔ chat
- Every card has a thread. "Open thread" or typing in "Something else…" continues there.
- In the thread, cards render **inline as the same card component** (new timeline item kind `card`), and the agent can post an **updated card** (new options, a new draft) via a structured event instead of prose. Quick replies under an agent question render as buttons.
- Plain prose stays for discussion; anything actionable comes back as a card. The card in Needs you and the one in the thread are the same object.

### 6.5 Notifications
Title = headline; body = context line + "N options ready" or "Draft ready to send". Tapping opens the card. No generic "needs your attention".

## 7. Dispatch

- **From a card**: pick an option or type an instruction → `working`. Omni works in the card's thread with write tools gated as today; outputs drafts.
- **Batch**: in chat or by multi-select in Needs you, "Draft replies to these 5" creates a **dispatch card** listing each item with its own progress; each finished item becomes its own `draft-ready` card. The dispatch card shows "4 of 5 ready · 1 needs you" and links them.
- **From chat**: any request that results in outbound work returns cards, never prose with an embedded draft.
- **Delivery verification**: after send, Omni confirms the message appears in Sent (email) / the room (chat) / the calendar (invite) and marks the card `delivered`; otherwise `failed` with the reason and a Retry that reuses the same idempotency key.

## 8. Sending

### 8.1 Draft kinds
Existing: `email`, `email-reply`, `message`, `calendar-invite`, `calendar-rsvp`, `tweet`. New: `calendar-update`, `calendar-cancel`, `agent-email` (sent from the agent's address), `task` (create/update a task — not outbound, approval optional per setting).

### 8.2 Send identity (per draft)
- **As Omni** — from the agent address, signed as his assistant.
- **From you, signed by Omni** — his address, "Sent by Omni on behalf of Benjamin".
- **In your voice** — his address, no AI signature; strictest review: the **agent-tell check** blocks Send until phrases like "How does that look?", "I hope this finds you well", "As an AI", em-dash-heavy filler, etc. are removed. Default list shipped; owner edits it in Settings.
Default per kind is a setting (scheduling defaults to *As Omni*). The identity line on the card is tappable to change before Send; changing it regenerates the signature, not the body.

### 8.3 Exactness
The approved payload is executed byte-for-byte (unchanged rule). Edit creates a new approval; Revise asks Omni for a new draft that needs a fresh approval.

### 8.4 Missed messages (feeds §5.3)
Fix the sweep's known misses: read `lastMessageSender` for Matrix notes; "triaged" no longer counts as resolved; unknown chat identities are scored, not capped out; lookback 14 days; run budget raised; a nightly **"who's waiting on you"** pass produces cards for anything owed. Acceptance: the weekly audit catches every owed personal reply.

## 9. Memory: the life model

### 9.1 Where it lives
The **vault is the long-term memory**; Hermes built-in memory holds only a short pointer set and session-level notes. No cloud memory provider (privacy).

| Note | Holds | Kept current by |
|---|---|---|
| **Owner profile** (`vault/agent/profile/owner`) | who he is, roles, working hours, comms style, standing rules, places, routines | weekly consolidation + his edits |
| **Person notes** (existing schema) | relationship, last meaningful contact, open commitments both ways, recent themes, tone, notes for agent | nightly upkeep from the day's email/messages/meetings |
| **Project notes** (existing) | status, heat, next milestones, his responsibilities, key people | nightly upkeep |
| **Preferences** (`vault/agent/preferences/*`) | learned rules ("declines Monday mornings", "replies to Ana same day", "prefers Meet") with evidence and confidence | outcome learning (§9.3) |
| **Commitments** (existing concern/commitment notes) | promises made and owed | understanding step + upkeep |

### 9.2 Upkeep job (nightly, Hermes, on the Mini)
- Reads the day's items per person/project (bounded), proposes field updates, writes them with compare-and-set and **provenance** (source note ids, date). Low-confidence or sensitive changes (relationship status, anything about health/finance) go to a review list instead of being written.
- Consolidates: merges duplicates, decays stale "recent themes", caps lengths so notes stay readable.
- Extracted facts from untrusted text are stored as data with their source; they are never instructions.

### 9.3 Learning from outcomes
Every card outcome (option chosen, Something-else text, Edit diff, Revise reason, Discard, Not needed, snooze) is recorded. A weekly pass turns repeated patterns into preference notes with evidence; preferences above a confidence threshold are used by §5; he can see and delete any preference ("What Omni knows", §9.5).

### 9.4 Reading
The understanding step and chat turns both get: owner profile (always), person + project notes for the item (always), relevant preferences (by match), and Hermes memory. One context assembler serves both, with a size budget that drops least-relevant facts first.

### 9.5 Visibility
A **What Omni knows** screen (Settings, and from any person in a card): profile, preferences with evidence, and per-person summary; each entry can be corrected or deleted. Corrections are the strongest learning signal.

## 10. Scheduling, rebuilt as a dispatchable workflow

One state store (an Omni thread + a versioned scheduling record in Prism), atomic, re-runnable transitions:

`request` → `slots-found` → `proposal-draft` (approval) → `proposed` → `reply-received` → `confirmed` → `invite-draft` (approval) → `booked` · plus `countered`, `follow-up-draft` (approval), `declined`, `expired`, `cancelled`.

- **Dispatch**: from a card ("Schedule this"), from chat ("find 30 min with Ana next week"), or from an invite card.
- **Slots**: all of his calendars, America/Denver with DST, working hours and buffers from the owner profile/preferences, all-day/free/declined handled, the other party's time zone when known; offered slots are **locked** across scheduling threads.
- **Holds**: real *private, attendee-free* tentative events on his calendar with a TTL; removed silently on booking, decline or expiry. (Not outbound — no approval needed; shown on the card.)
- **Replies**: matched by Message-ID/References and sender, his own addresses excluded, quotes stripped; parsed into accept / counter (concrete time, checked against his calendar) / decline / other.
- **Booking**: re-check the slot is free immediately before; the invite (with Meet link and notify flag) is a `calendar-invite` draft he approves; no separate confirmation email unless he chooses one.
- **Follow-ups**: when a reply is overdue (preference, default 72 h), Omni **drafts** a follow-up and puts it in Approve. Never sent on a timer.
- **Card** shows the whole state: proposed slots, holds, who replied, next step, and the one action needed.
- Retires: `scheduling_heartbeat.py`, the `schedule_meeting` mission, the old Claude scheduler subagent; `find_slots.py` logic moves into the new slot finder.

## 11. Briefings and routines

Morning/evening briefings and tweet-of-the-day come into Omni as **Briefing cards** on Today (and optionally a push). Tweets are drafts with options. Once in Omni, the Telegram relay for these is retired (Telegram stays as a chat surface behind the one door).

## 12. Architecture changes (summary)

- **Server (Prism)**: `omni_cards` table (card id, item refs, kind, state, headline, context, options, chosen, thread id, draft/approval ids, outcome log); card routes (`GET /cards`, `POST /cards/:id/choose`, `/something-else`, `/snooze`, `/dismiss`); card timeline event; new approval kinds (§8.1) + executors behind the one door; send-identity + agent-tell check; delivery verification worker; scheduling record + routes; outcome log for learning. Nudges migrate into cards (kept as the sweep's input).
- **Agent (Hermes)**: understanding step (tools read-only, memory on, validated output); `omni_card` tool for posting card updates from a thread; upkeep job; outcome-learning job; scheduling skill rebuilt on Prism state; one-door changes.
- **App (Omni)**: `CardView` (all states, all sources), Needs you sections, inline cards + quick replies in threads, dispatch card, send-identity line, What Omni knows, card notifications.

## 13. Phasing

0. **Safety one door** — in progress. Gate for everything else that sends.
1. **Cards end-to-end** for all four sources: card model + understanding step (reading existing person/project notes) + Needs you redesign + card ↔ chat + notifications. Sends use existing kinds/identity.
2. **Dispatch + sending**: batch dispatch, send identities + agent-tell check, delivery verification, missed-message sweep fixes.
3. **Memory**: owner profile, nightly upkeep, outcome learning, What Omni knows.
4. **Scheduling** rebuilt on cards + approvals.
5. **Briefings into Omni**; retire the Telegram relay.

Each phase ships to the Mini and the devices before the next starts.

## 14. Testing and acceptance

- **Safety**: tests that every send script refuses without a grant; grants single-use, expiring, digest-bound; legacy surfaces propose instead of send; guard on all Hermes platforms.
- **Understanding quality**: a fixture set of ≥ 30 synthetic items across the four sources (with person/project/calendar context) graded for headline accuracy, grounded context, distinct options, and draft quality; regression run on every prompt change.
- **App**: unit tests for card states; UI tests + screenshots (sample data only) for every card state on iPhone, iPad, Mac; accessibility audit.
- **Scheduling**: state-machine tests incl. DST, counters, double-booking, hold cleanup, idempotent re-runs.
- **Memory**: upkeep writes are CAS + provenance; untrusted-text injection fixtures; preference learning on synthetic outcome logs.
- **Owner acceptance**: a week of daily use; weekly audit catches every owed personal reply; zero sends without approval (audited).

## 15. Decisions taken by default (owner may override)

1. Private, attendee-free calendar holds are created without approval (they notify nobody).
2. Scheduling messages default to sending **As Omni** from the agent address.
3. 2–4 options per card; the recommended option comes with a ready draft.
4. The understanding step uses Hermes' configured model with read-only tools and memory on.
5. Low-confidence or sensitive life-model updates go to review instead of being written.
6. Follow-up default 72 h (from the written preferences, replacing the heartbeat's 48 h).
7. Agent-tell list ships with defaults; the owner's own list (requested 2026-10-14, not yet given) replaces/extends it.
