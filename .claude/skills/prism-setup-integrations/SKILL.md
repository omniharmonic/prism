---
name: Prism Setup — Integrations
description: "Connect Prism's optional integrations one at a time: Matrix messages, Proton Mail Bridge email, Google Calendar and Gmail, meeting transcripts (Fireflies, Fathom), ClickUp, Notion and GitHub. Each is a checklist step integration:<kind>. Connection details are stored encrypted on the server and entered in the app, never in the conversation."
version: 0.3.0
---

# Prism Setup — Integrations

Every integration is **off until its connection is stored**, and none is
required. Connect only what the person asks for.

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

Syncing for calendar, Gmail and Proton is also switched on by a server setting
(`CALENDAR_SYNC_ENABLED`, `GMAIL_SYNC_ENABLED`, `PROTON_SYNC_ENABLED`); sending
email or changing a calendar from Prism is a further, separate switch
(`ACTIONS_*_ENABLED`). Leave sending off unless the person asks for it.

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
