# Tag Schemas

These schemas define expected metadata fields for each tag. Apply them using the Parachute MCP `update-tag` tool or REST API. Claude sees these schemas when working with tagged notes, which helps it write correct metadata.

## How to apply

For each schema below, call the Parachute API:

```bash
curl -X PUT \
  -H "Authorization: Bearer $PARACHUTE_API_KEY" \
  -H "Content-Type: application/json" \
  "http://127.0.0.1:1940/api/tags/{tag-name}" \
  -d '{"description": "...", "fields": {...}}'
```

Or use MCP tool `update-tag`.

---

## task

```json
{
  "description": "Action items, commitments, and work to be done. Tasks have a lifecycle: pending → in-progress → completed/cancelled. Link tasks to the project and person they relate to.",
  "fields": {
    "status": {
      "type": "string",
      "description": "Task lifecycle status",
      "enum": ["pending", "in-progress", "blocked", "completed", "cancelled"]
    },
    "priority": {
      "type": "string",
      "description": "Priority level",
      "enum": ["high", "medium", "low"]
    },
    "type": {
      "type": "string",
      "description": "Task category. meeting-action-item = Benjamin committed to this. followup-expected = someone else committed to Benjamin.",
      "enum": ["meeting-action-item", "followup-expected", "followup", "coordination", "research", "development", "scheduling"]
    },
    "deadline": {
      "type": "string",
      "description": "ISO-8601 date/datetime, or 'no-deadline'"
    },
    "project": {
      "type": "string",
      "description": "Project slug (e.g. 'opencivics', 'spirit-of-the-front-range')"
    },
    "requester": {
      "type": "string",
      "description": "Who assigned or is waiting on this task"
    },
    "confidence": {
      "type": "string",
      "description": "Extraction confidence: high (clear assignee + deadline + verb), medium (assignee + verb), low (vague reference)",
      "enum": ["high", "medium", "low"]
    }
  }
}
```

## person

```json
{
  "description": "A person Benjamin interacts with. Store contact info, role, and relationship context. Link to their organizations and projects.",
  "fields": {
    "role": {
      "type": "string",
      "description": "Professional role or title"
    },
    "email": {
      "type": "string",
      "description": "Primary email address"
    },
    "phone": {
      "type": "string",
      "description": "Phone number"
    },
    "telegram": {
      "type": "string",
      "description": "Telegram handle"
    },
    "organization": {
      "type": "string",
      "description": "Primary organization"
    },
    "relationship_type": {
      "type": "string",
      "description": "Relationship to Benjamin",
      "enum": ["collaborator", "stakeholder", "contact", "advisor", "funder"]
    },
    "timezone": {
      "type": "string",
      "description": "IANA timezone (e.g. America/Denver)"
    },
    "last_contact": {
      "type": "string",
      "description": "ISO-8601 date of last interaction"
    }
  }
}
```

## project

```json
{
  "description": "A project Benjamin is involved in. Contains goals, status, collaborators, and links to related meetings and tasks.",
  "fields": {
    "status": {
      "type": "string",
      "description": "Project lifecycle status",
      "enum": ["active", "paused", "completed", "archived"]
    },
    "role": {
      "type": "string",
      "description": "Benjamin's role in this project",
      "enum": ["lead", "contributor", "advisor", "observer"]
    },
    "organization": {
      "type": "string",
      "description": "Parent organization"
    },
    "keywords": {
      "type": "string",
      "description": "Comma-separated keywords for matching (e.g. 'bioregional, food chain, regenerative agriculture')"
    }
  }
}
```

## transcript

```json
{
  "description": "A meeting transcript from Fathom or Meetily. Process by extracting attendees, action items, and decisions, then add the 'processed' tag.",
  "fields": {
    "source": {
      "type": "string",
      "description": "Transcript source",
      "enum": ["fathom", "meetily"]
    },
    "date": {
      "type": "string",
      "description": "Meeting date (ISO-8601)"
    },
    "title": {
      "type": "string",
      "description": "Meeting title"
    },
    "attendees": {
      "type": "string",
      "description": "Comma-separated attendee names"
    },
    "sourceId": {
      "type": "string",
      "description": "Recording ID from source platform"
    }
  }
}
```

## email

```json
{
  "description": "An email thread synced from Gmail. Classified with importance tags (urgent, action-required, informational).",
  "fields": {
    "from": {
      "type": "string",
      "description": "Sender display name and email"
    },
    "subject": {
      "type": "string",
      "description": "Email subject line"
    },
    "threadId": {
      "type": "string",
      "description": "Gmail thread ID"
    },
    "date": {
      "type": "string",
      "description": "Most recent message date"
    },
    "isUnread": {
      "type": "boolean",
      "description": "Whether the thread has unread messages"
    },
    "messageCount": {
      "type": "integer",
      "description": "Number of messages in thread"
    }
  }
}
```

## meeting

```json
{
  "description": "A calendar event or meeting note. Link to transcripts (has-transcript) and attendee person notes.",
  "fields": {
    "date": {
      "type": "string",
      "description": "Event date (ISO-8601)"
    },
    "attendees": {
      "type": "string",
      "description": "Comma-separated attendee names"
    },
    "meetLink": {
      "type": "string",
      "description": "Google Meet or Zoom link"
    },
    "transcriptNoteId": {
      "type": "string",
      "description": "Linked transcript note ID"
    }
  }
}
```

## message-thread

```json
{
  "description": "A chat conversation from WhatsApp, Telegram, or other bridged platform. Classify with importance tags.",
  "fields": {
    "platform": {
      "type": "string",
      "description": "Message platform",
      "enum": ["whatsapp", "telegram", "signal", "discord", "email"]
    },
    "participants": {
      "type": "string",
      "description": "Comma-separated participant names"
    },
    "lastMessageAt": {
      "type": "string",
      "description": "Timestamp of most recent message"
    }
  }
}
```

## briefing

```json
{
  "description": "A daily briefing generated by the intelligence system. One per day at vault/agent/briefings/{date}.",
  "fields": {
    "date": {
      "type": "string",
      "description": "Briefing date (YYYY-MM-DD)"
    }
  }
}
```

## agent-insight

```json
{
  "description": "Intelligence analysis output. Patterns, escalations, and opportunities detected by the intelligence scan.",
  "fields": {
    "date": {
      "type": "string",
      "description": "Analysis date (YYYY-MM-DD)"
    }
  }
}
```
