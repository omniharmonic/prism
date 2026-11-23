---
name: Prism Setup — Integrations
description: "Connect Prism's optional integrations one at a time: Matrix messages, Proton Mail Bridge email, Google Calendar and Gmail, meeting transcripts (Fireflies, Fathom, and the Minutes app: step minutes), ClickUp, Notion and GitHub. Each is a checklist step integration:<kind>. Connection details are stored encrypted on the server and entered in the app, never in the conversation."
version: 0.5.0
---

# Prism Setup — Integrations

Every integration is **off until its connection is stored**, and none is
required. Connect only what the person asks for. `prism setup` ends with the
`integrations` step: it lists what is connected and is `skipped` when nothing
is — ask the person whether they want any, and stop if they don't.

## What every integration needs first

- The `secrets` step is done (`SECRETS_KEY` set). Without it the server refuses
  to store any connection.
- The person is signed in as the server's owner.

## Where the details go

In the app: **Workspace settings → Server → Connections**. Each connection has
its own fields and a status. Details are write-only: the app and the server
never show a stored value again, only whether one is stored.

Do not collect a password, token or API key in this conversation. Your part is
to get the prerequisite working, tell the person which field to fill, and check
the result.

## The integrations

| Step | What it brings | What must exist first | Person's action |
|---|---|---|---|
| `integration:matrix` | Messages from chat networks, in one inbox | A Matrix homeserver they can log in to (bridges for other networks are their own setup) | Log in to get an access token; enter homeserver, user and token |
| `integration:proton-bridge` | Email, read and (if enabled) sent | Proton Mail Bridge running on the server's computer | Enter the Bridge's host, ports, username and its Bridge password; confirm the certificate the app shows |
| `integration:google` | Calendar and Gmail | The `gog` command installed and signed in to their Google account on the server's computer | Complete Google's consent screen in `gog`; enter the account |
| `integration:fireflies` | Meeting transcripts | A Fireflies account | Create an API key in Fireflies; enter it |
| `integration:fathom` | Meeting transcripts | A Fathom account | Create an API key in Fathom; enter it |
| `integration:clickup` | Tasks | A ClickUp workspace | Create an API token; enter it and choose the lists |
| `integration:notion` | Notion databases | A Notion integration shared with the databases | Create the integration in Notion, share the databases with it; enter its secret |
| `integration:github` | Folders kept in step with a repository | A GitHub account | Create a token with access to the repository; enter it |
| `integration:bluebubbles` | iMessage and SMS in Comms | BlueBubbles Server on a Mac signed in to Messages | See `prism-setup-comms` § iMessage and SMS |

Syncing for calendar, Gmail and Proton is also switched on by a server setting:
`prism config set CALENDAR_SYNC_ENABLED=true` (or `GMAIL_SYNC_ENABLED`,
`PROTON_SYNC_ENABLED`; never both Gmail and Proton). Use `prism config`, not a hand edit of
`.env`.

**Sending is separate, and it is the owner's decision.** Sending email
(`ACTIONS_EMAIL_ENABLED`, `COMMS_EMAIL_SEND_ENABLED`) or changing a calendar
(`ACTIONS_CALENDAR_ENABLED`) are the checklist's `send:*` steps. Every message
any app sends leaves through these switches (the one door), and they stay off
until the owner says yes to that exact switch; `prism config set` refuses one
without `--confirm-send`. Follow `prism-setup-comms` § Sending. Off is a fine
answer.

## Minutes (`minutes`)

Minutes is a separate meeting recorder for Mac and iPhone (on-device
transcription, no Minutes server). It writes each meeting into the vault as a
note tagged `meeting`, `transcript` and `minutes` (default folder
`vault/_inbox/transcripts/minutes`). The step ticks when one such note exists.

1. The person installs Minutes (Mac: the notarized download; iPhone: the
   public TestFlight beta) and allows Microphone and Speech Recognition; on a
   Mac, recording a call needs Screen & System Audio Recording (audio only).
2. In Minutes' settings they connect it to **this** Parachute vault (Minutes
   opens the vault's own sign-in in the browser; you never handle that token)
   and choose the folder.
3. They export one meeting, or turn on automatic export. The `minutes` step
   ticks within a minute.

Minutes needs nothing from `prism config`.

## Check

- The connection shows as connected in **Connections**, and its checklist step
  has ticked.
- **Workspace settings → Server → Sync health** shows the source as "ok" with a
  recent time after its first run. "Disabled" for a source the person did not
  connect is correct, not a failure.

## Limits

- You cannot complete a consent screen or create a key in a vendor's dashboard.
- Prism does not install a Matrix homeserver or its bridges.
- The Google sign-in lives in `gog`'s own keychain entry on the server's
  computer; it must be done in a desktop session on that computer.
