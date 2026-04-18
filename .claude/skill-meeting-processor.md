# Skill: meeting-processor

## Metadata

```json
{
  "skillName": "meeting-processor",
  "enabled": true,
  "intervalSecs": 1800,
  "description": "Process transcripts with project routing, entity extraction, action item detection, and person profile enrichment"
}
```

## Prompt

```
Process unprocessed meeting transcripts. Extract entities, route to projects, create tasks, and enrich person profiles.

## Step 1: Get unprocessed transcripts

Use search-notes:
- tags: ["transcript"]
- exclude_tags: ["processed"]
- include_content: false
- limit: 10
- sort: "desc"

If none found, output "No unprocessed transcripts" and stop.

## Step 2: For each transcript

Read the full content with get-note, then perform ALL of the following:

### 2a. Project matching (weighted scoring)

Score this transcript against project notes in the vault. Query: search-notes with tags ["project"], include_content true.

For each project, calculate a match score:

| Signal | Points |
|--------|--------|
| Project name appears in transcript title | +5 |
| Project name appears in transcript body | +3 |
| Project keyword (from project's keywords metadata) in transcript | +2 per keyword (max 6) |
| A project collaborator is listed as an attendee | +3 per person |
| A project collaborator's name appears in transcript text | +2 per person |
| Project's organization name appears in transcript | +3 |
| Project tag appears in transcript tags | +1 |

Decision thresholds:
- Score >= 8: Assign to project (high confidence)
- Score 4-7: Assign to project but note medium confidence in metadata
- Score < 4: Leave unassigned (external meeting or unclear)

If assigned, add the project's slug as a tag and set metadata "project" to the slug.
Link the transcript to the project note with relationship "belongs-to".

### 2b. Attendee extraction and person matching

Extract all speaker names and attendees from the transcript. For each person:

1. Search for existing person note: search-notes with their name, tags ["person"]
2. If found: update last_contact date, add link from transcript to person with relationship "attended-by"
3. If NOT found: create a new person note at vault/people/{Full Name}
   - Tag: "person"
   - Metadata: role (if mentioned), organization (if mentioned)
   - Content: "Person first encountered in [[{transcript path}]] on {date}"
   - Link to transcript with relationship "attended-by"
   - If their email appears in transcript metadata, add it to contact info

### 2c. Action item extraction

Scan the transcript for commitments and action items using these patterns:

Explicit patterns:
- "[Name] will [verb]..."
- "[Name] to [verb]..."
- "Action item: ..."
- "TODO: ..."
- "Next step: ..."
- "By [date], [name] should..."
- "Can you [verb]..." (implies commitment from addressee)
- "I'll [verb]..." or "I will [verb]..." (Benjamin's commitment if he's speaking)
- "Let's [verb]..." followed by agreement (shared commitment)

For each action item, create a task note at vault/tasks/active/{slug}:
- Tag: "task" + project slug if known
- Content: the action item description with context
- Metadata:
  - status: "pending"
  - type: "meeting-action-item" if Benjamin committed, "followup-expected" if someone else committed TO Benjamin
  - requester: the person who assigned or is waiting on it
  - project: project slug from 2a
  - deadline: resolve any relative dates ("next week", "by Friday") to ISO-8601 using the meeting date as reference
  - confidence: "high" if clear assignee + action verb + deadline, "medium" if assignee + verb, "low" if vague
- Link to transcript with relationship "extracted-from"

Only create tasks with medium or high confidence. Skip low-confidence items.

### 2d. Decision and topic extraction

Identify key decisions made during the meeting. Add them to the transcript summary.

Decisions are statements like:
- "We decided to..."
- "The plan is to..."
- "We agreed that..."
- Explicit votes or consensus moments

### 2e. Write summary

Prepend a structured summary to the transcript content using update-note:

```
## Summary
[2-3 sentence overview of what was discussed and decided]

## Attendees
- Name (role/org if known)

## Key Decisions
- Decision 1
- Decision 2

## Action Items
- [assignee] Task description (deadline if any)

## Topics Discussed
- Topic 1
- Topic 2

---
[original transcript content below]
```

### 2f. Mark as processed

Add the "processed" tag to the transcript.

## Step 3: Link to calendar events

For each processed transcript, search for matching meeting notes:
- search-notes with tags ["meeting"], filter by date (transcript date +/- 1 day)
- Match by: attendee overlap, title similarity
- If found, create bidirectional links:
  - meeting → transcript: relationship "has-transcript"
  - Update meeting metadata with transcriptNoteId

## Output

Summarize what was processed:
- Number of transcripts processed
- Project assignments made (with confidence levels)
- Tasks created (with types: action-item vs followup-expected)
- Person notes created or updated
- Calendar events linked
```
