# Skill: message-triage

## Metadata

```json
{
  "skillName": "message-triage",
  "enabled": true,
  "intervalSecs": 3600,
  "description": "Classify email and message importance using domain-aware heuristics, extract action items, detect commitments"
}
```

## Prompt

```
Triage recent unclassified emails and messages. Your goal is to surface what actually matters to Benjamin and filter noise.

## Step 1: Gather unclassified items

Query for ALL unclassified emails and message threads in a single call:
- query-notes: tag ["email", "message-thread"], tag_match "any", exclude_tags ["urgent", "action-required", "informational", "low", "triaged"], limit 50, include_content true

This returns both email notes AND message-thread notes. Process all of them in the following steps.

## Step 2: Classify each item

For each unclassified item, apply ONE importance tag using these criteria:

URGENT (tag: "urgent") — needs response within hours:
- Explicit deadline today or tomorrow
- Direct request from a key collaborator (Tim Archer, Patricia Parkinson, Christopher Life, Sophia Life)
- Time-sensitive opportunity with a closing window
- System outage, legal notice, or financial deadline
- Message explicitly marked urgent by sender

ACTION-REQUIRED (tag: "action-required") — needs response within 1-3 days:
- Direct question requiring Benjamin's input or decision
- Meeting request or scheduling coordination
- Review or approval request
- Task assignment or delegation
- Follow-up on a commitment Benjamin made
- Invoice or payment request

INFORMATIONAL (tag: "informational") — good to know, no action:
- Status update or progress report
- Newsletter or digest from a subscribed source
- FYI CC where Benjamin is not the primary recipient
- Community announcement or event notification
- Automated notification from a tool (GitHub, Notion, etc.)

LOW (tag: "low") — ignore or batch-process:
- Marketing or promotional email
- Spam or phishing attempt
- Social media notification
- Automated digest from a service Benjamin doesn't actively use
- Duplicate notification

## Step 3: Sender context boost

Before finalizing classification, check if the sender has a person note in the vault:
- query-notes with the sender's name/email, tag ["person"]
- If the person is linked to one of Benjamin's active projects, boost importance by one tier (e.g., informational → action-required)
- If the person has relationship_type "collaborator" or "stakeholder", boost by one tier

## Step 4: Extract action items

For any URGENT or ACTION-REQUIRED item, check if it contains an actionable request. If so:
- Create a task note at vault/tasks/active/{slug}
- Tag it "task" + the project tag if identifiable
- Set metadata: status="pending", type based on content, requester=sender name
- Link the task to the email/message note with relationship "extracted-from"

For items where someone committed to do something FOR Benjamin:
- Create a task with type="followup-expected"
- This tracks what others owe Benjamin

## Step 5: Tag and summarize

After classification:
- Add the importance tag AND "triaged" tag to each note using update-note with tags add
- This prevents re-processing on the next run

Output a summary:
- Count by category (urgent/action/informational/low)
- List urgent items with sender and subject
- List action items with sender and brief description
- Note any tasks created
```
