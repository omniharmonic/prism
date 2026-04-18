# Skill: intelligence-scan

## Metadata

```json
{
  "skillName": "intelligence-scan",
  "enabled": true,
  "intervalSecs": 86400,
  "runAtHour": 6,
  "description": "Graduated task escalation, slot opportunity detection, commitment tracking, pattern analysis"
}
```

## Prompt

```
Run intelligence analysis on the vault. You are looking for patterns, escalations, and opportunities that Benjamin needs to know about. This output feeds directly into the daily briefing.

## Analyzer 1: Task Escalation (Graduated Urgency)

Query all active tasks: search-notes with tags ["task"], include_content false, limit 500

For each task with a deadline that isn't "no-deadline" or "recurring":
- Calculate days overdue = (today - deadline)
- Assign escalation level:

  | Days Overdue | Level | Action |
  |-------------|-------|--------|
  | 1-2 days | MENTION | Include in briefing |
  | 3-6 days | ALERT | Prominent in briefing |
  | 7-13 days | CRITICAL | Telegram alert recommended |
  | 14+ days | EMERGENCY | Requires immediate attention |

Sort by severity (emergency first), then by days overdue within each level.

## Analyzer 2: Slot Opportunities

Query today's and tomorrow's meeting notes: search-notes with tags ["meeting"], filter by date.

Identify free blocks during working hours (9 AM - 6 PM MST):
- Blocks longer than 1 hour are "available slots"
- For each slot, find matching overdue tasks that could be tackled:
  - High-priority overdue tasks matching projects with meetings nearby
  - Research or writing tasks that need focused time
- Output: "You have 2 free hours between 1-3 PM. Consider tackling: [overdue task X from project Y]"

## Analyzer 3: Commitment Tracker

Query tasks with type "followup-expected" that are still pending.

For each, calculate days since the task was created or last updated.
Flag commitments aging:
- 7-13 days: "Consider a gentle nudge"
- 14+ days: "Likely forgotten — follow up directly"

Sort by age, oldest first. These are things OTHER PEOPLE promised Benjamin.

## Analyzer 4: Pattern Detection

Analyze the full task set for systemic patterns:

### Stalled Projects
Group tasks by project. If ALL active tasks in a project are overdue:
- Flag as "STALLED: {project name} — all {N} tasks overdue"
- This means the project needs a decision: escalate, pause, or reschedule

### Overdue Saturation
Calculate: (overdue tasks / total active tasks) * 100
- If > 60%: Flag "OVERDUE SATURATION: {X}% of active tasks are past deadline. Consider a task triage session."
- If > 40%: Flag "OVERDUE WARNING: {X}% approaching saturation"

### Zombie Tasks
Find tasks with no update in 21+ days AND status is still "pending" or "todo":
- Flag as "ZOMBIE: {task description} — no activity in {N} days"
- Suggest: archive, reschedule, or explicitly decide to keep

### Forgotten Follow-ups
Find "followup-expected" tasks older than 14 days:
- These are commitments from others that were never fulfilled
- Flag: "{person} committed to {task} on {date} — {N} days ago, no update"

## Output Format

Write results to vault/agent/insights/{{today}} with tag "agent-insight" and metadata date={{today}}.

Structure:

```
INTELLIGENCE SCAN - {{today}}

SUMMARY
- Total active tasks: N
- Escalations: N emergency, N critical, N alert, N mention
- Commitments pending follow-up: N
- Patterns detected: N

EMERGENCY (14+ days overdue)
- [task] — project — N days overdue

CRITICAL (7-13 days overdue)
- [task] — project — N days overdue

SLOT OPPORTUNITIES
- [time block]: suggested tasks to tackle

AGING COMMITMENTS (others owe Benjamin)
- [person]: [commitment] — N days, suggest: [nudge/escalate]

PATTERN WARNINGS
- [stalled/saturation/zombie alerts]
```

Keep the output factual and structured. No filler. The briefing skill will consume this note and present it to Benjamin.
```
