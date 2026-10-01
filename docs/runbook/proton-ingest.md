# Proton Mail ingest on the Prism Server (WP1.2b)

Email does not come from Gmail. It comes from Proton Mail Bridge, which serves the
mailbox as IMAP on loopback. Until now an agent-repo script (`proton_mail.py sync`,
a launchd job every 5 minutes) wrote it into the vault. `apps/server/src/worker/proton.ts`
ports that script into the Prism Server worker. It writes the **same notes**, so it
converges on the ones that already exist. It does this with one vault list per pass
and no writes when nothing changed.

Code: `worker/proton.ts` (IMAP, the pass, modes, intents, runner) and
`worker/proton-parse.ts` (a pure port of the script's message → note logic).
Tests: `test/proton-ingest.test.ts`. The tests use a fake IMAP source and a fake
vault. The parity fixtures were produced by the script's own functions running on
synthetic messages.

## What the script does (ported)

| Aspect | Behaviour |
|---|---|
| Connection | IMAP `127.0.0.1:1143`, STARTTLS. Bridge's self-signed certificate is **pinned** by the SHA-256 of its DER. |
| Credentials | Password in the macOS Keychain. Login user = the Bridge account address. |
| Mailboxes | `INBOX` only. Opened **read-only** (EXAMINE). Bodies fetched with `BODY.PEEK[]`, so the mailbox is never changed. |
| Window | Every run: `UID SEARCH SINCE <UTC date of now − 7 days>`. No UID high-water mark, because Bridge assigns UIDs backwards during backfill. |
| Cap | More than 200 new messages → the 200 **highest** UIDs this run. The rest are picked up on later runs. |
| Notes | **One note per message**, tag `email`. |
| Note path | `vault/messages/email/<slugify(subject)[:80] or no-subject>-<sha256(Message-ID)[:8]>` |
| Content | `# subject`, then `**From:**`, `**To:**`, `**Cc:**`, `**Date:**` (host-local `YYYY-MM-DD HH:MM`) and `**Attachments:**` (names only), then `---` and the body. The body is the text/plain parts, or else stripped HTML. It is capped at 20 000 characters. |
| Metadata (in this order) | `type, subject, from, to, date, isUnread, labels, messageCount (1), threadId, messageId, lastMessageAt, source ("proton-bridge"), account, mailbox, uid` |
| `labels` | The folder, `UNREAD`, and header-derived labels: `BULK / AUTOMATED / SOCIAL / CHAT / PROMOTIONS / TRANSACTIONAL / DIRECT`. The `message-classify` skill shortcuts on these. |
| `threadId` | The root of the References chain. `@protonmail.internalid` entries are skipped. |
| Flags | Read/unread only. It refreshes `{isUnread, labels}` for the about 500 most recently synced messages, with one GET per note. `\Flagged` is never stored. |
| Never | Deletes notes, mirrors moves or deletes, links people, sets tags, or downloads attachments. |

These script commands are **not ingest** and stay in the script: `setup`, `health`,
`search`, and `sent_thread_ids()` (used for the agent's reply detection).

## Deliberate deviations

All of them write less, read less, or fail closed.

1. **State lives in the vault.** Existing notes come from **one** lean list per pass:
   `tag=email`, `path_prefix=vault/messages/email/`, `include_metadata=source,messageId,mailbox,uid,isUnread,labels`,
   and no content. Notes are matched by Message-ID, which is the value the path hash
   is built from. There are no per-note GETs and no get-by-path → create fallback,
   so no 409 storm.
2. **Header-only window fetch.** One fetch per mailbox, of
   `BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]` plus FLAGS. Full sources are fetched only
   for messages that have no note yet. A UIDVALIDITY change therefore costs nothing.
   The script re-fetched and rewrote the whole window in that case.
3. **Flag refresh** covers the SINCE window and matches notes by Message-ID. It sends
   `PATCH {isUnread, labels}` with `if_updated_at`. On a 409 it re-reads the note
   once and retries. The label rule is the same as the script's. When one Message-ID
   has two UIDs, the higher UID wins, so the two cannot fight over the note.
4. **A stale `uid`** on a known note (same mailbox) is corrected in the same PATCH.
   Nothing else is rewritten.
5. **Creates** use `if_exists: "ignore"`. If the path is held by a note we cannot
   identify as this message, the note is left alone and a `skip-collision` intent is
   recorded.
6. **Existing content is never rewritten.** The script only rewrote content after a
   hand-cleared state file, as a parser-fix backfill.
7. **Person linking is off.** It is off by default because the script never linked.
   With `PROTON_LINK_PEOPLE=true`, a **new** note is linked `email-from` to an
   **existing** person note. Person notes are never created.
8. **The cert pin is required** in the credential. There is no trust-on-first-use,
   so a lost pin fails closed. The host must be loopback.
9. **Bounded work** (security review).
   - Messages over `PROTON_MAX_MESSAGE_BYTES` (10 MB, by RFC822.SIZE) are never
     downloaded. They get a `skip-too-large` intent and **no note**. The script did
     ingest them; raise the cap if that matters. We skip them rather than fetch only
     the text parts, because rebuilding a note from IMAP's re-encoded part metadata
     would break byte-parity for every message, to save only the rare large one.
   - Each text part is cut at 500 KB before parsing. The note keeps 20 000 chars,
     so this only matters for HTML whose first 500 KB yields less text than that.
   - The HTML stripper and all whitespace strips are linear scanners. The regex
     forms were quadratic: a crafted mail could block the server for minutes.
   - A message that fails to parse 3 times is skip-listed per (mailbox, UIDVALIDITY),
     and so are oversize messages and path collisions. None of them is re-downloaded
     every pass.

The parser follows Python's `email` package semantics wherever the stored output
depends on them. The parity tests pin this. Remaining gaps are exotic header edge
cases. Those can only change the text of a **new** note. They can never cause a
rewrite, because existing notes are matched by Message-ID.

## Configuration

`apps/server/.env`. Restart pm2 `prism-server` after any change.

| Variable | Default | Meaning |
|---|---|---|
| `PROTON_SYNC_ENABLED` | `false` | Run the ingest live. |
| `PROTON_SHADOW` | `false` | Connect, fetch, diff and record intents, but **no vault writes**. Wins over `PROTON_SYNC_ENABLED`. |
| `PROTON_INTERVAL_MS` | `300000` | The script's launchd `StartInterval`. |
| `PROTON_SINCE_DAYS` | `7` | The SINCE window. |
| `PROTON_MAX_PER_PASS` | `200` | New messages per mailbox per pass. |
| `PROTON_MAILBOXES` | `INBOX` | Comma-separated. |
| `PROTON_TIMEZONE` | *(empty = process zone)* | Zone for the `date` field and the `**Date:**` line. It must equal the zone the launchd job ran in. |
| `PROTON_LINK_PEOPLE` | `false` | See deviation 7. |
| `PROTON_INTENTS_KEEP` | `500` | Intents kept for the comparison. |
| `PROTON_IMAP_TIMEOUT_MS` | `30000` | Connection and greeting timeout. The socket timeout is 4× this. |
| `PROTON_MAX_MESSAGE_BYTES` | `10485760` | Larger messages are not downloaded (`skip-too-large`). `0` = no cap. |
| `WORKER_STALE_PROTON_MS` | `3600000` | Health goes stale after this long with no successful pass. |

### Credential

Credential kind `proton-bridge`. It is encrypted with `SECRETS_KEY`, like the
`google` and `clickup` credentials, and is per vault. It is set by
`PUT /api/integrations/proton-bridge`. All `/proton-bridge*` routes are
**server-owner only**; a vault admin gets 403.

```json
{ "host": "127.0.0.1", "port": 1143, "username": "<bridge account address>",
  "password": "<bridge password>", "security": "starttls", "certSha256": "<64 hex>" }
```

- `certSha256` uses the same format as the script's pinned `certFingerprint`
  (in its state file). Colon or uppercase forms are accepted. To read it fresh:
  `openssl s_client -starttls imap -connect 127.0.0.1:1143 </dev/null 2>/dev/null | openssl x509 -outform DER | shasum -a 256`.
- `username` must be the **same address the script logged in with**. It is stored
  as `metadata.account`, so a different value makes every note differ.
- Keep the password out of argv. Write the JSON to a `chmod 600` file, send it with
  `curl --data-binary @file`, then delete the file. The password is the per-account
  Bridge password: Bridge → account → Mailbox details.
- `GET` reports `configured` and the non-secret fields. It never returns the
  password.
- A `PUT` may omit `password` only when nothing else changes. Changing host, port,
  security, username or `certSha256` requires the password again, otherwise 400.
- `POST /api/integrations/proton-bridge/sync` forces one pass. It honours shadow
  mode. It returns 409 while the ingest is off, and 409 `busy` while a pass is
  running; passes never queue.

The pin is checked inside imapflow's `authenticate()`. That runs after the TLS
handshake and **before** the LOGIN that carries the password, so a mismatch aborts
the connection without sending it. Tests prove this against a real loopback TLS
stub IMAP server, over both STARTTLS and direct TLS:
- with a wrong pin, and with a server that lacks STARTTLS, the stub receives zero
  LOGIN or AUTHENTICATE bytes;
- with the right pin, the connection reaches LOGIN.

Errors, log lines and intents are scrubbed of the password and of note paths, whose
slug is the subject. Intents carry only ids, UIDs and hashes.

## Cutover runbook (overseer only)

0. **Precondition.** `GMAIL_SYNC_ENABLED` stays off. `assertConfig` refuses to start
   the server with both `GMAIL_SYNC_ENABLED` and `PROTON_SYNC_ENABLED` set, because
   both would write `vault/messages/email/`. Shadow mode never affects Gmail.
   Back up first with `scripts/backup-parachute.sh proton-cutover`.

1. **Shadow for at least 24 h alongside the script.**
   - Store the credential.
   - Set `PROTON_SHADOW=true`. Set `PROTON_TIMEZONE` only if the pm2 process zone
     differs from the Mac's.
   - Restart pm2.
   - Check that `GET /acl/workers` shows `proton` as `ok` and that the log line
     `[proton] primary since … [shadow]: INBOX Nw/Nn/Nk → … (1 vault list)` appears
     every 5 minutes.
   - Every few hours, pull `GET /acl/workers/proton/intents?verify=1`.
   - **Agreement** looks like this:
     - every `create` intent's `verify.now` turns `match` within one script interval
       (the script wrote the identical note);
     - every `update-flags` intent turns `match`;
     - there are no `failed` effects.
   - **Disagreement** means you stop and investigate:
     - `differs` lists the differing metadata key names, or `content`. Values are
       never shown. Compare the two notes by hand. `date` alone means a timezone
       mismatch, so set `PROTON_TIMEZONE`;
     - a `create` that stays `missing` for more than 10 minutes means the script did
       not write it, or wrote it at a different path;
     - persistent `skip-collision` intents.
   - Most messages are written by the script before the server sees them. They show
     up as `known` (`k`) in the log line, with no intent. That is expected.

2. **Retire the script's sync job.** It is the launchd user agent
   `com.omniharmonic.proton-mail` (`~/Library/LaunchAgents/com.omniharmonic.proton-mail.plist`,
   `StartInterval 300`, `RunAtLoad`):

   ```sh
   launchctl bootout gui/$(id -u)/com.omniharmonic.proton-mail
   launchctl disable gui/$(id -u)/com.omniharmonic.proton-mail   # stays off across logins
   ```

   Do **not** delete `proton_mail.py`, its Keychain item or its state file.
   `sent_thread_ids()` (reply detection), `health` and `search` still use them.

   Note that the agent's `check_oauth.py` alerts once the script's `lastSync` is
   older than 6 h. Point it at `GET /acl/workers` (`proton`), or drop that check,
   in the agent repo.

3. **Go live.**
   - Set `PROTON_SHADOW=false` and `PROTON_SYNC_ENABLED=true`, then restart pm2.
   - Watch two intervals (about 10 minutes):
     - `+created` should appear only for genuinely new mail;
     - `~flags` should appear only when you read or unread mail in Proton;
     - `(1 vault list)` should appear on every pass;
     - `GET /acl/workers` should show `proton` as `ok`. The inferred `email` source
       disappears.
   - **Duplicate check.** This must print nothing:

     ```sh
     curl -s -H "Authorization: Bearer $T" "$VAULT/api/notes?tag=email&limit=50000&include_metadata=source,messageId" \
       | jq -r '.[] | select(.metadata.source=="proton-bridge") | .metadata.messageId' | sort | uniq -d
     ```

     Or in SQLite:
     `SELECT json_extract(metadata,'$.messageId') m, count(*) FROM notes WHERE path LIKE 'vault/messages/email/%' AND json_extract(metadata,'$.source')='proton-bridge' GROUP BY m HAVING count(*) > 1;`

**Rollback.**
1. Set `PROTON_SYNC_ENABLED=false` and restart pm2.
2. Run `launchctl enable gui/$(id -u)/com.omniharmonic.proton-mail`, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.omniharmonic.proton-mail.plist`.

Nothing to clean up: the server writes the same notes the script reads back.
**Never run both writers live.**
