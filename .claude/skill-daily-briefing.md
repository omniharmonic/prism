# Skill: daily-briefing

## Metadata

```json
{
  "skillName": "daily-briefing",
  "enabled": true,
  "intervalSecs": 86400,
  "runAtHour": 7,
  "description": "Generate morning briefing with escalations, tasks, schedule, meeting prep, email highlights, and pattern warnings"
}
```

## Prompt

```
Generate Benjamin's daily briefing for {{today}}. This is his primary situational awareness tool — it must be concise, actionable, and complete.

## Data gathering

Query the vault for each section below. Use search-notes and get-note MCP tools.

## Section 1: ESCALATION ALERTS

Query the latest agent-insight note (tags ["agent-insight"], limit 1, sort desc).
If it exists and was generated today or yesterday, extract any emergency or critical items.
If no recent insight exists, scan tasks directly:

Query all tasks: search-notes with tags ["task"], include_content false, limit 200

Calculate days overdue for each task with a deadline:
- 14+ days overdue → EMERGENCY (flag with !!)
- 7-13 days overdue → CRITICAL (flag with !)
- 3-6 days overdue → ALERT

List emergencies and criticals at the top of the briefing. These are the first things Benjamin sees.

## Section 2: OVERDUE & URGENT

From the task query above, list:
- All tasks past deadline (grouped by days overdue, worst first)
- Tasks due today
- Tasks due tomorrow
- High-priority tasks approaching deadline (within 48h)

Format each as: [status] description (X days overdue) — project

## Section 3: TODAY'S SCHEDULE

Query meeting notes for today: search-notes with tags ["meeting"], metadata date={{today}}.
Also check for meeting notes dated tomorrow for the HEADS UP section.

For each meeting today, list:
- Time and duration
- Title and attendees
- Meet/Zoom link if available

## Section 4: MEETING PREP

For each meeting in the next 8 hours:
- Find related tasks: search by project tag or attendee names
- Find the last meeting with the same people: search-notes with tags ["meeting", "processed"], search by attendee name, limit 3
- Find recent email threads with attendees: search-notes with tags ["email"], search by attendee name, limit 3
- List: open questions, pending items from last meeting, relevant tasks

This section helps Benjamin walk into meetings prepared.

## Section 5: FOLLOW-UP NEEDED

Query tasks with type "followup-expected" that are still pending:
- search-notes with tags ["task"], include_content false
- Filter for metadata type="followup-expected" and status="pending"

These are things OTHER PEOPLE committed to Benjamin. List them sorted by age (oldest first).
Flag any that are 7+ days old — these need a nudge.

## Section 6: EMAIL & MESSAGE HIGHLIGHTS (Last 24h)

Query recent urgent and action-required items:
- search-notes with tags ["email", "urgent"], limit 10
- search-notes with tags ["email", "action-required"], limit 10
- search-notes with tags ["message-thread", "urgent"], limit 5
- search-notes with tags ["message-thread", "action-required"], limit 5

List action-required items with sender and subject.
Note total unread count if available.

## Section 7: HEADS UP

- Tomorrow's schedule (meetings, deadlines)
- Tasks due this week
- Pattern warnings from the latest agent-insight note (stalled projects, overdue saturation)

## Output format

Write the briefing to vault/agent/briefings/{{today}} with tag "briefing" and metadata date={{today}}.

Use this structure (plain text, no markdown formatting that won't render in Telegram):

```
DAILY BRIEFING - [Day, Month Date, Year]

ESCALATION ALERTS
[Emergency/critical items — these are the fire alarms]

OVERDUE & URGENT
[Past-deadline tasks, sorted worst-first]

TODAY'S SCHEDULE
[Time — Title — Attendees — Link]

MEETING PREP
[For each upcoming meeting: context, related tasks, last meeting recap]

FOLLOW-UP NEEDED
[Things others owe Benjamin, sorted by age]

EMAIL & MESSAGE HIGHLIGHTS
[Urgent and action-required items from last 24h]

HEADS UP
[Tomorrow + this week + pattern warnings]
```

Keep each section concise. Use bullet points, not paragraphs. If a section has no items, write "None" and move on. The entire briefing should be readable in 2 minutes.
```
