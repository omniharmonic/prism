# Skill: meeting-processor

## Metadata

```json
{
  "skillName": "meeting-processor",
  "enabled": true,
  "intervalSecs": 1800,
  "description": "Process transcripts with project routing, entity/concept extraction, action item detection, wikilink-rich summaries, structured meeting notes, and person profile enrichment"
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

Extract all speaker names and attendees from the transcript. **Also extract people who are mentioned by name in the discussion** even if they weren't present — these are important graph connections.

For each **attendee** (present in meeting):

1. Search for existing person note: search-notes with their name, tags ["person"]
2. If found: update last_contact date, add link from transcript to person with relationship "attended-by"
3. If NOT found: create a new person note at vault/people/{Full Name}
   - Tag: "person"
   - Metadata: role (if mentioned), organization (if mentioned)
   - Content: "Person first encountered in [[{transcript path}]] on {date}"
   - Link to transcript with relationship "attended-by"
   - If their email appears in transcript metadata, add it to contact info

For each **mentioned person** (discussed but not present):

1. Search for existing person note
2. If found: add link from transcript to person with relationship "mentions"
3. If NOT found AND they are clearly a real person with a full name (not a vague reference): create a person note with what context is available
   - Content: "Mentioned in [[{transcript path}]] — {brief context of how they were discussed}"
   - Link to transcript with relationship "mentions"

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

### 2e. Concept and entity extraction

Identify key concepts, frameworks, organizations, and initiatives discussed in the transcript. These enrich the graph by creating connective tissue between meetings that share themes.

For each notable concept or entity:
1. Search for an existing note at `wiki/concepts/{concept-slug}` or `vault/organizations/{org-slug}`
2. If found: add link from transcript to concept with relationship "discusses"
3. If NOT found AND the concept is substantive (not a throwaway mention):
   - For **organizations/initiatives** (e.g. "Regen Commons", "Gitcoin", "Edge City"): create at `vault/organizations/{slug}` with tag "organization"
   - For **concepts/frameworks** (e.g. "knowledge commons", "bioregional coordination", "coordination failures"): create at `wiki/concepts/{slug}` with tag "concept"
   - Content: brief 1-2 sentence description based on context from the transcript
   - Link to transcript with relationship "discussed-in"

Focus on entities that are:
- Named organizations, DAOs, foundations, or projects
- Recurring concepts or frameworks in Benjamin's work
- Geographic or event references (conferences, locations)
- Skip generic terms ("meeting", "email", "funding" in abstract)

### 2f. Write wikilink-rich summary

Prepend a structured summary to the transcript content using update-note. **All entity references MUST use `[[wikilinks]]`** — people, projects, tasks, and concepts should be clickable links, not plain text.

```
## Prism Summary
*Processed: {today's date}*

> **Project:** [[vault/projects/{project-slug}]] (omit if unassigned)
> **Participants:** [[vault/people/{Full Name}|{First Name}]], [[vault/people/{Full Name}|{First Name}]]

**Key Topics:**
- **{Topic 1}:** 1-2 sentence summary mentioning [[vault/people/{Name}]] where relevant
- **{Topic 2}:** 1-2 sentence summary

**Key Decisions:**
- Decision 1
- Decision 2

**Action Items:**
- [ ] {description} → [[vault/tasks/active/{task-slug}]]
- [ ] {description} → [[vault/tasks/active/{task-slug}]]

## Wiki-Links

### People
- [[vault/people/{Full Name}]]
(list ALL people mentioned — attendees AND people discussed)

### Projects
- [[vault/projects/{project-slug}]]

### Concepts
- [[wiki/concepts/{concept-slug}]]
(list key concepts, frameworks, organizations, or initiatives discussed — e.g. knowledge-commons, regen-commons, bioregional-coordination)

---
[original transcript content below]
```

The Wiki-Links section is critical for graph growth. Cast a wide net: include not just attendees but anyone mentioned by name, any project or initiative referenced, and any notable concept or framework discussed. These wikilinks will be resolved into graph edges by the wikilink resolver.

### 2g. Create structured meeting note (if substantive)

If the transcript has enough substance (clear topic, decisions, or action items), create a separate meeting note that serves as the "clean" record of the meeting. This is distinct from the raw transcript.

**Path:** If project-assigned: `vault/projects/{project-slug}/meetings/{date}-{title-slug}`. Otherwise: `vault/meetings/{date}/{title-slug}` (skip if a calendar meeting note already exists at this path).

**Tags:** `"meeting"`, `"processed"`, plus project slug if assigned.

**Content structure — use wikilinks throughout:**
```
# {Meeting Title}

> **Project:** [[vault/projects/{project-slug}]]
> **Date:** {date}
> **Source:** {Fathom/Meetily} (recording {id})
> **Participants:** [[vault/people/{Name}|{First}]], [[vault/people/{Name}|{First}]]

## Summary
{2-3 sentence overview}

## Key Insights
- {Non-obvious takeaway 1}
- {Non-obvious takeaway 2}

## Action Items
- [ ] @{Name} — {description} → [[vault/tasks/active/{slug}]]

## Decisions Made
1. {Decision with context}

## Topics Discussed
### {Topic heading}
{Paragraph summary of this topic thread, with [[vault/people/{Name}]] mentions inline}

## Wiki-Links

### People
- [[vault/people/{Name}]]

### Projects
- [[vault/projects/{slug}]]

### Concepts
- [[wiki/concepts/{concept}]]
```

**Links to create:**
- meeting note → transcript: relationship `"sourced-from"`
- meeting note → project: relationship `"belongs-to"`
- meeting note → each attendee person note: relationship `"attended-by"`
- If a calendar event was linked in Step 3, also link: calendar event → this meeting note with relationship `"has-notes"`

### 2h. Mark as processed

Add the "processed" tag to the transcript. Also set metadata `processed_meeting` to the path of the meeting note created in 2g (if one was created).

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
- Concept/organization notes created
- Meeting notes created
- Calendar events linked
- Total wikilinks embedded (approximate count)
```
