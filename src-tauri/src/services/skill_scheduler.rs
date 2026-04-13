use std::sync::Arc;
use tokio::sync::watch;
use chrono::Timelike;
use crate::clients::parachute::ParachuteClient;
use crate::models::note::{CreateNoteParams, UpdateNoteParams, ListNotesParams};
use crate::services::agent_dispatch::DispatchManager;
use crate::services::ServiceStatus;

const CHECK_INTERVAL_SECS: u64 = 60; // Check for due skills every minute

/// Default skills to create on first run if no agent-skill notes exist.
const DEFAULT_SKILLS: &[(&str, &str, u64, bool, &str)] = &[
    (
        "message-triage",
        "Review recent message-thread notes that don't have importance tags (urgent/action-required/informational/social). For each untagged conversation, classify its importance and add the appropriate tag. If you find action items, create linked task notes at vault/tasks/active/. Summarize what you triaged.",
        3600, // 1 hour
        false, // disabled by default
        "Classify message importance and extract action items",
    ),
    (
        "meeting-processor",
        "Find meeting notes in the vault that have transcript content (more than 500 characters) but don't have a 'processed' tag. For each:\n1. Extract attendees and match to person notes\n2. Extract action items and create linked task notes\n3. Extract key decisions and topics\n4. If the meeting note has a calendarEventId in metadata, find the corresponding calendar event note and ensure they're linked\n5. Write a concise summary at the top of the meeting note\n6. Add the 'processed' tag when done\nSummarize what you processed.",
        1800, // 30 minutes
        false,
        "Process meeting transcripts, extract action items, link to calendar events",
    ),
    (
        "daily-briefing",
        "Generate a daily briefing for today. Check:\n1. Today's calendar events (meetings with times, attendees, meet links)\n2. Overdue and due-today tasks\n3. Recent urgent/action-required messages from the last 24 hours\n4. Meetings in the next 24 hours without agendas\n5. Follow-ups from recent meetings\n\nWrite the briefing to vault/agent/briefings/{{today}} tagged 'briefing'. Be concise and actionable — bullet points, not paragraphs.",
        86400, // 24 hours
        false,
        "Morning briefing with calendar, tasks, and messages",
    ),
    (
        "intelligence-scan",
        "Analyze the vault for patterns and insights:\n1. Stalled projects (no updates in 7+ days)\n2. Overdue tasks with graduated urgency\n3. Upcoming meetings without agendas or notes\n4. Calendar gaps that match pending tasks\n5. Commitments others made in recent meetings that need follow-up\n6. Patterns in meeting density or project activity\n\nWrite insights to vault/agent/insights/{{today}} tagged 'agent-insight'. Focus on actionable findings.",
        86400, // 24 hours
        false,
        "Detect patterns, stalled projects, and opportunities",
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
        path: None,
        limit: Some(100),
        offset: None,
    }).await?;

    if !existing.is_empty() {
        return Ok(());
    }

    log::info!("Skill scheduler: creating {} default skills", DEFAULT_SKILLS.len());

    for (name, prompt, interval, enabled, description) in DEFAULT_SKILLS {
        let path = format!("vault/agent/skills/{}", name);
        let metadata = serde_json::json!({
            "type": "agent-skill",
            "skillName": name,
            "description": description,
            "intervalSecs": interval,
            "enabled": enabled,
            "lastRun": null,
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
