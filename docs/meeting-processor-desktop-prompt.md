# Meeting Processor — Claude Desktop prompt

Paste the block below into Claude Desktop (which has the local Parachute vault MCP + the ability to run shell commands). It processes every unprocessed meeting transcript, reading large bodies via the **local REST API in bounded slices** so neither the MCP response nor a command's output exceeds the token limit. All vault writes go through the parachute MCP tools.

> Requires: Parachute running locally on :1940, and a shell/command tool available in Claude Desktop.

---

Process all unprocessed meeting transcripts in my Parachute vault, end to end. The vault is local. Use the parachute-vault MCP tools for every read and write EXCEPT reading a transcript's full body — for that, use the local REST API in bounded slices (instructions below), because large transcripts exceed the MCP/Read token limit.

## Setup
- REST base: `http://localhost:1940/vault/default/api`
- Get the bearer token (run this once and reuse it):
  ```
  python3 -c "import json;print(json.load(open('/Users/benjaminlife/iCloud Drive (Archive)/Documents/cursor projects/prism/.mcp.json'))['mcpServers']['parachute-vault']['headers']['Authorization'].replace('Bearer ',''))"
  ```

## Step 1 — Find unprocessed transcripts
Call `query-notes { tag: "transcript", exclude_tags: ["processed"], include_content: false, limit: 50 }`. For each result keep its `path` and `metadata` (title, date, attendees, meetingNoteId). If none, stop and say so.

## Step 2 — Read each transcript body via REST, in slices (do NOT use query-notes content for the body)
For a transcript at PATH:
1. Fetch the note JSON to a temp file:
   ```
   curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:1940/vault/default/api/notes?path=PATH&include_content=true&limit=1" -o /tmp/txn.json
   ```
2. Extract the body to a text file and print its length:
   ```
   python3 -c "import json;d=json.load(open('/tmp/txn.json'));n=d[0] if isinstance(d,list) else d;c=n.get('content','');open('/tmp/txn.txt','w').write(c);print('LENGTH',len(c))"
   ```
3. Read the body in ~40,000-char slices (so the command output stays under the limit), advancing until you've read LENGTH chars:
   ```
   python3 -c "print(open('/tmp/txn.txt').read()[0:40000])"
   python3 -c "print(open('/tmp/txn.txt').read()[40000:80000])"
   # …continue [80000:120000], etc.
   ```
   Accumulate attendees, decisions, and action items across slices.

## Step 3 — Process each transcript (parachute MCP tools)
- **Project match:** score against existing project notes (`query-notes { tag: "project" }`). If confident, add the project slug as a tag, set `metadata.project`, and link transcript → project with relationship `belongs-to`.
- **People:** for each attendee, find or create a person note (`query-notes` by name + `tag: "person"`); update `last-contact`; link transcript → person with `attended-by`. Enrich newly-created person stubs with role/org/contact gleaned from the transcript.
- **Action items:** extract commitments; create tasks under `vault/tasks/active/` (idempotent — search existing open tasks first); set metadata status/type/assigned/due/project; link task → transcript with `extracted-from`.
- **Summary:** prepend a structured summary (`## Summary`, `## Attendees`, `## Key Decisions`, `## Action Items`, `## Topics Discussed`) to the transcript via `update-note`. Pass `include_content: false` on update-note calls so the huge body isn't echoed back.
- **Mark processed:** add the `processed` tag via `update-note`.
- **Calendar:** find the matching meeting note (`query-notes { tag: "meeting" }`, search by title/date) and link meeting → transcript with `has-transcript`.

Note: if `update-note` link writes return `"null is not an object"`, ignore it — the write commits; verify by re-reading the note.

## Step 4 — Report
For each transcript: project assigned (+confidence), people created/updated, tasks created, and confirm `processed` was set.
