use std::sync::Arc;
use tokio::sync::watch;
use chrono::Timelike;
use crate::clients::parachute::ParachuteClient;
use crate::models::note::{CreateNoteParams, UpdateNoteParams, ListNotesParams};
use crate::services::agent_dispatch::DispatchManager;
use crate::services::ServiceStatus;

const CHECK_INTERVAL_SECS: u64 = 60; // Check for due skills every minute

/// Default skills to create on first run if no agent-skill notes exist.
/// Tuple: (name, prompt, interval_secs, enabled, description, run_at_hour, depends_on)
const DEFAULT_SKILLS: &[(&str, &str, u64, bool, &str, Option<u64>, Option<&str>)] = &[
    (
        "message-triage",
        "Triage recent unclassified emails and messages. Surface what matters, filter noise.\n\n\
## Step 1: Gather unclassified items\n\n\
Query for email notes WITHOUT importance tags:\n\
  query-notes: tags [\"email\"], exclude_tags [\"urgent\", \"action-required\", \"informational\", \"low\", \"triaged\"], limit 30, include_content true\n\n\
Query for message threads WITHOUT importance tags:\n\
  query-notes: tags [\"message-thread\"], exclude_tags [\"urgent\", \"action-required\", \"informational\", \"low\", \"triaged\"], limit 20, include_content true\n\n\
## Step 2: Classify each item\n\n\
Apply ONE importance tag per item:\n\n\
URGENT (tag: \"urgent\") — needs response within hours:\n\
- Explicit deadline today or tomorrow\n\
- Direct request from a key collaborator (check person notes with relationship_type \"collaborator\" or \"stakeholder\")\n\
- Time-sensitive opportunity with closing window\n\
- System outage, legal notice, or financial deadline\n\n\
ACTION-REQUIRED (tag: \"action-required\") — needs response within 1-3 days:\n\
- Direct question requiring input or decision\n\
- Meeting request or scheduling coordination\n\
- Review or approval request\n\
- Task assignment or delegation\n\n\
INFORMATIONAL (tag: \"informational\") — good to know, no action:\n\
- Status update, newsletter, FYI CC, community announcement\n\
- Automated notification (GitHub, Notion, etc.)\n\n\
LOW (tag: \"low\") — ignore or batch-process:\n\
- Marketing, spam, social media notifications, duplicate alerts\n\n\
## Step 3: Sender context boost\n\n\
Before finalizing, check if sender has a person note (query-notes with sender name, tags [\"person\"]).\n\
If person is linked to an active project or has relationship_type \"collaborator\"/\"stakeholder\", boost importance one tier.\n\n\
## Step 4: Extract action items\n\n\
For URGENT or ACTION-REQUIRED items with actionable requests, create task notes:\n\
  create-note at vault/tasks/active/{slug}\n\
  Tags: [\"task\"] + project tag if identifiable\n\
  Metadata: status=\"todo\", type based on content, assigned=sender name\n\
  Link task to source note with relationship \"extracted-from\"\n\n\
For commitments someone made TO the vault owner:\n\
  Create task with type=\"followup-expected\" — tracks what others owe.\n\n\
## Step 5: Tag and summarize\n\n\
Add the importance tag + \"triaged\" tag to each note using update-note with tags.add.\n\n\
Output summary: count by category, list urgent items with sender/subject, note any tasks created.",
        3600, // 1 hour
        false, // disabled by default
        "Classify message importance and extract action items",
        None,
        None,
    ),
    (
        "meeting-processor",
        "Process unprocessed meeting transcripts. Extract entities, route to projects, create tasks, enrich person profiles.\n\n\
## Step 1: Get unprocessed transcripts\n\n\
query-notes: tags [\"transcript\"], exclude_tags [\"processed\"], include_content false, limit 10, sort desc\n\n\
If none found, output \"No unprocessed transcripts\" and stop.\n\n\
## Step 2: For each transcript\n\n\
Read full content with query-notes (pass the note path), then:\n\n\
### 2a. Project matching (weighted scoring)\n\n\
Score against project notes (query-notes: tags [\"project\"], include_content true).\n\n\
Scoring: project name in title +5, in body +3, keyword match +2 each (max 6),\n\
collaborator as attendee +3 each, collaborator in text +2 each, org name in text +3.\n\n\
Score >= 8: assign to project (high confidence). 4-7: assign with medium confidence. <4: unassigned.\n\
If assigned, add project slug as tag and set metadata \"project\". Link to project with \"belongs-to\".\n\n\
### 2b. Attendee extraction and person matching\n\n\
For each speaker/attendee:\n\
1. Search existing person notes: query-notes with name, tags [\"person\"]\n\
2. If found: update last-contact date, link transcript to person with \"attended-by\"\n\
3. If NOT found: create person note at vault/people/{Full Name}\n\
   Tags: [\"person\"], metadata: role, organizations (if mentioned)\n\
   Link to transcript with \"attended-by\"\n\n\
### 2c. Action item extraction\n\n\
Look for: \"[Name] will...\", \"[Name] to...\", \"Action item:...\", \"TODO:...\",\n\
\"Next step:...\", \"Can you...\", \"I'll...\", \"Let's...\" + agreement.\n\n\
For each action item, create task at vault/tasks/active/{slug}:\n\
  Tags: [\"task\"] + project slug if known\n\
  Metadata: status=\"todo\", type=\"meeting-action-item\" (owner's commitment) or\n\
  \"followup-expected\" (someone else's commitment TO owner), assigned=person,\n\
  project=slug, due=resolve relative dates to ISO-8601, confidence=high/medium\n\
  Link to transcript with \"extracted-from\"\n\
Only create medium or high confidence tasks.\n\n\
### 2d. Summary\n\n\
Prepend structured summary to transcript content using update-note:\n\
## Summary, ## Attendees, ## Key Decisions, ## Action Items, ## Topics Discussed\n\n\
### 2e. Mark processed\n\n\
Add \"processed\" tag via update-note with tags.add.\n\n\
## Step 3: Link to calendar events\n\n\
For each processed transcript, search meeting notes (query-notes: tags [\"meeting\"], search by date).\n\
Match by attendee overlap and title similarity. Link: meeting → transcript with \"has-transcript\".\n\n\
Summarize: transcripts processed, project assignments, tasks created, person notes created/updated.",
        1800, // 30 minutes
        false,
        "Process meeting transcripts, extract action items, link to calendar events",
        None,
        None,
    ),
    (
        "daily-briefing",
        "Generate the daily briefing for {{today}}. This is the primary situational awareness tool — concise, actionable, complete.\n\n\
## Section 1: ESCALATION ALERTS\n\n\
Check latest agent-insight note (query-notes: tags [\"agent-insight\"], limit 1, sort desc).\n\
If recent (today or yesterday), extract emergency/critical items.\n\
Otherwise scan tasks directly: query-notes: tags [\"task\"], include_content false, limit 200.\n\
Calculate days overdue for each task with a due date:\n\
- 14+ days → EMERGENCY (!!) | 7-13 days → CRITICAL (!) | 3-6 days → ALERT\n\n\
## Section 2: OVERDUE & URGENT\n\n\
From tasks: all past-due grouped by days overdue (worst first), due today, due tomorrow,\n\
high-priority approaching (within 48h).\n\
Format: [status] description (X days overdue) — project\n\n\
## Section 3: TODAY'S SCHEDULE\n\n\
query-notes: tags [\"meeting\"], search for {{today}}. List time, title, attendees, meet link.\n\n\
## Section 4: MEETING PREP\n\n\
For each meeting in next 8 hours:\n\
- Find related tasks by project tag or attendee names\n\
- Find last meeting with same people (query-notes: tags [\"meeting\", \"processed\"], search by attendee)\n\
- Find recent email threads with attendees\n\
- List: open questions, pending items, relevant tasks\n\n\
## Section 5: FOLLOW-UP NEEDED\n\n\
Query tasks with type=\"followup-expected\" and status=\"todo\".\n\
These are things OTHER PEOPLE committed to the vault owner. Sort by age, oldest first.\n\
Flag any 7+ days old.\n\n\
## Section 6: EMAIL & MESSAGE HIGHLIGHTS (Last 24h)\n\n\
query-notes: tags [\"email\", \"urgent\"], limit 10\n\
query-notes: tags [\"email\", \"action-required\"], limit 10\n\
query-notes: tags [\"message-thread\", \"urgent\"], limit 5\n\
List action-required items with sender and subject.\n\n\
## Section 7: HEADS UP\n\n\
Tomorrow's schedule, tasks due this week, pattern warnings from latest agent-insight.\n\n\
## Output\n\n\
Write briefing to vault/agent/briefings/{{today}} with tag \"briefing\" and metadata date={{today}}.\n\
Use plain text with section headers. Each section: bullet points, not paragraphs.\n\
If a section has no items, write \"None\". Entire briefing readable in 2 minutes.",
        86400, // 24 hours
        false,
        "Morning briefing with escalations, tasks, schedule, meeting prep, and pattern warnings",
        Some(7),
        Some("intelligence-scan"),
    ),
    (
        "intelligence-scan",
        "Run intelligence analysis on the vault. Look for patterns, escalations, and opportunities.\n\
This output feeds into the daily briefing.\n\n\
## Analyzer 1: Task Escalation (Graduated Urgency)\n\n\
Query all active tasks: query-notes: tags [\"task\"], include_content false, limit 500.\n\
For each task with a due date that isn't empty:\n\
  Calculate days overdue = (today - due date)\n\
  1-2 days → MENTION | 3-6 days → ALERT | 7-13 days → CRITICAL | 14+ days → EMERGENCY\n\
Sort by severity then by days overdue.\n\n\
## Analyzer 2: Slot Opportunities\n\n\
Query today's and tomorrow's meeting notes. Identify free blocks during 9AM-6PM.\n\
Blocks >1 hour are available slots. For each, find matching overdue tasks.\n\
Output: \"You have 2 free hours between 1-3 PM. Consider: [overdue task X from project Y]\"\n\n\
## Analyzer 3: Commitment Tracker\n\n\
Query tasks with type=\"followup-expected\" and status=\"todo\".\n\
For each, calculate days since created or last updated.\n\
7-13 days: \"Consider a gentle nudge\" | 14+ days: \"Likely forgotten — follow up directly\"\n\n\
## Analyzer 4: Pattern Detection\n\n\
### Stalled Projects\n\
Group tasks by project. If ALL active tasks in a project are overdue:\n\
\"STALLED: {project} — all {N} tasks overdue. Decide: escalate, pause, or reschedule.\"\n\n\
### Overdue Saturation\n\
(overdue / total active) * 100. >60%: SATURATION warning. >40%: APPROACHING warning.\n\n\
### Zombie Tasks\n\
Tasks with no update in 21+ days and status still \"todo\":\n\
\"ZOMBIE: {task} — no activity in {N} days. Suggest: archive, reschedule, or keep.\"\n\n\
### Forgotten Follow-ups\n\
followup-expected tasks older than 14 days:\n\
\"{person} committed to {task} on {date} — {N} days ago, no update.\"\n\n\
## Output\n\n\
Write to vault/agent/insights/{{today}} with tag \"agent-insight\" and metadata date={{today}}.\n\
Structure: SUMMARY (counts), EMERGENCY, CRITICAL, SLOT OPPORTUNITIES, AGING COMMITMENTS, PATTERN WARNINGS.\n\
Keep factual and structured. No filler.",
        86400, // 24 hours
        false,
        "Graduated task escalation, slot detection, commitment tracking, pattern analysis",
        Some(6),
        None,
    ),
];

/// Skill scheduler: reads agent-skill notes from Parachute and dispatches
/// them when their interval has elapsed.
pub async fn run(
    parachute: Arc<ParachuteClient>,
    dispatch_manager: Arc<DispatchManager>,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<std::sync::Mutex<ServiceStatus>>,
) {
    log::info!("Skill scheduler starting");

    {
        let mut s = status.lock().unwrap();
        s.running = true;
    }

    // Initial delay
    tokio::time::sleep(tokio::time::Duration::from_secs(20)).await;

    // Ensure default skills exist
    if let Err(e) = ensure_default_skills(&parachute).await {
        log::warn!("Skill scheduler: failed to create default skills: {}", e);
    }

    loop {
        if *shutdown.borrow() {
            break;
        }

        match check_and_dispatch(&parachute, &dispatch_manager).await {
            Ok(dispatched) => {
                let mut s = status.lock().unwrap();
                s.last_run = Some(chrono::Utc::now().to_rfc3339());
                s.items_processed += dispatched;
                s.last_error = None;
            }
            Err(e) => {
                log::warn!("Skill scheduler error: {}", e);
                let mut s = status.lock().unwrap();
                s.last_error = Some(e.to_string());
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(CHECK_INTERVAL_SECS)) => {},
            _ = shutdown.changed() => {
                if *shutdown.borrow() { break; }
            }
        }
    }

    let mut s = status.lock().unwrap();
    s.running = false;
    log::info!("Skill scheduler stopped");
}

/// Check all enabled skills and dispatch any that are due.
async fn check_and_dispatch(
    parachute: &ParachuteClient,
    dispatch_manager: &DispatchManager,
) -> Result<u64, crate::error::PrismError> {
    let skills = parachute.list_notes(&ListNotesParams {
        tag: Some("agent-skill".into()),
        path: None,
        limit: Some(100),
        offset: None,
        include_content: true,
    }).await?;

    let now = chrono::Utc::now();
    let mut dispatched = 0u64;

    for skill in &skills {
        let meta = match &skill.metadata {
            Some(m) => m,
            None => continue,
        };

        let enabled = meta.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        if !enabled {
            continue;
        }

        let interval_secs = meta.get("intervalSecs").and_then(|v| v.as_u64()).unwrap_or(3600);
        let run_at_hour = meta.get("runAtHour").and_then(|v| v.as_u64());
        let last_run = meta.get("lastRun").and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));

        let is_due = if interval_secs >= 86400 && run_at_hour.is_some() {
            // Daily skill with specific hour: check if we're past the target hour
            // and haven't run today yet
            let target_hour = run_at_hour.unwrap() as u32;
            let local_now = chrono::Local::now();
            let current_hour = local_now.hour();
            let ran_today = last_run.map(|lr| {
                let local_lr = lr.with_timezone(&chrono::Local);
                local_lr.date_naive() == local_now.date_naive()
            }).unwrap_or(false);

            current_hour >= target_hour && !ran_today
        } else {
            match last_run {
                Some(lr) => (now - lr).num_seconds() as u64 >= interval_secs,
                None => true, // Never run → due
            }
        };

        if !is_due {
            continue;
        }

        // Check dependsOn: if this skill depends on another, ensure it ran today
        let depends_on = meta.get("dependsOn").and_then(|v| v.as_str());
        if let Some(dep_name) = depends_on {
            let dep_ran_today = skills.iter().any(|s| {
                let s_meta = match &s.metadata { Some(m) => m, None => return false };
                let s_name = s_meta.get("skillName").and_then(|v| v.as_str()).unwrap_or("");
                if s_name != dep_name { return false; }
                s_meta.get("lastRun").and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&chrono::Local).date_naive() == chrono::Local::now().date_naive())
                    .unwrap_or(false)
            });
            if !dep_ran_today {
                log::debug!("Skill '{}' waiting on dependency '{}'",
                    meta.get("skillName").and_then(|v| v.as_str()).unwrap_or("?"), dep_name);
                continue;
            }
        }

        let skill_name = meta.get("skillName").and_then(|v| v.as_str()).unwrap_or("unknown");
        let prompt = skill.content.clone();

        // Resolve template variables
        let today = now.format("%Y-%m-%d").to_string();
        let resolved_prompt = prompt
            .replace("{{today}}", &today)
            .replace("{{yesterday}}", &(now - chrono::Duration::days(1)).format("%Y-%m-%d").to_string())
            .replace("{{now}}", &now.to_rfc3339());

        log::info!("Skill scheduler: dispatching '{}' (last run: {:?})", skill_name, last_run);

        match dispatch_manager.dispatch(skill_name, &resolved_prompt, None).await {
            Ok(_id) => {
                // Update lastRun in the skill note
                let mut updated_meta = meta.clone();
                if let Some(obj) = updated_meta.as_object_mut() {
                    obj.insert("lastRun".into(), serde_json::json!(now.to_rfc3339()));
                }
                let _ = parachute.update_note(&skill.id, &UpdateNoteParams {
                    content: None,
                    path: None,
                    metadata: Some(updated_meta),
                }).await;
                dispatched += 1;
            }
            Err(e) => {
                log::warn!("Skill scheduler: failed to dispatch '{}': {}", skill_name, e);
            }
        }
    }

    Ok(dispatched)
}

/// Create default skill notes if none exist.
async fn ensure_default_skills(parachute: &ParachuteClient) -> Result<(), crate::error::PrismError> {
    let existing = parachute.list_notes(&ListNotesParams {
        tag: Some("agent-skill".into()),
        limit: Some(100),
        ..Default::default()
    }).await?;

    if !existing.is_empty() {
        return Ok(());
    }

    log::info!("Skill scheduler: creating {} default skills", DEFAULT_SKILLS.len());

    for (name, prompt, interval, enabled, description, run_at_hour, depends_on) in DEFAULT_SKILLS {
        let path = format!("vault/agent/skills/{}", name);
        let metadata = serde_json::json!({
            "type": "agent-skill",
            "skillName": name,
            "description": description,
            "intervalSecs": interval,
            "enabled": enabled,
            "lastRun": null,
            "runAtHour": run_at_hour,
            "dependsOn": depends_on,
        });

        parachute.create_note(&CreateNoteParams {
            content: prompt.to_string(),
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["agent-skill".into()]),
        }).await?;
    }

    Ok(())
}
