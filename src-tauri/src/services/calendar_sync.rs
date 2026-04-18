use std::sync::Arc;
use tokio::sync::watch;
use crate::clients::google::GoogleClient;
use crate::clients::parachute::ParachuteClient;
use crate::models::note::{CreateNoteParams, UpdateNoteParams, ListNotesParams};
use crate::services::ServiceStatus;
use crate::services::person_linker;

const SYNC_INTERVAL_SECS: u64 = 300; // 5 minutes

/// Continuous Google Calendar → Parachute sync.
pub async fn run(
    google: Arc<GoogleClient>,
    parachute: Arc<ParachuteClient>,
    account: String,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<std::sync::Mutex<ServiceStatus>>,
) {
    log::info!("Calendar sync service starting for account: {}", account);

    {
        let mut s = status.lock().unwrap();
        s.running = true;
    }

    // Initial delay
    tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

    loop {
        if *shutdown.borrow() {
            break;
        }

        match sync_upcoming(&google, &parachute, &account).await {
            Ok(count) => {
                let mut s = status.lock().unwrap();
                s.last_run = Some(chrono::Utc::now().to_rfc3339());
                s.items_processed += count;
                s.last_error = None;
            }
            Err(e) => {
                log::warn!("Calendar sync error: {}", e);
                let mut s = status.lock().unwrap();
                s.last_error = Some(e.to_string());
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(SYNC_INTERVAL_SECS)) => {},
            _ = shutdown.changed() => {
                if *shutdown.borrow() { break; }
            }
        }
    }

    let mut s = status.lock().unwrap();
    s.running = false;
    log::info!("Calendar sync service stopped");
}

/// Sync upcoming events (background service uses this).
async fn sync_upcoming(
    google: &GoogleClient,
    parachute: &ParachuteClient,
    account: &str,
) -> Result<u64, crate::error::PrismError> {
    let events_data = tokio::task::spawn_blocking({
        let google = google.clone();
        let account = account.to_string();
        move || google.calendar_list_events(&account, 50)
    }).await
        .map_err(|e| crate::error::PrismError::Google(format!("spawn error: {}", e)))??;

    sync_events_data(parachute, &events_data).await
}

/// Sync a single event into Parachute. Called by both the background service
/// and the on-demand `calendar_sync_range` command.
pub async fn sync_single_event(
    parachute: &ParachuteClient,
    event: &serde_json::Value,
) -> Result<(), crate::error::PrismError> {
    let event_id = event.get("id").and_then(|v| v.as_str())
        .ok_or_else(|| crate::error::PrismError::Google("Event missing id".into()))?;

    let summary = event.get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled Event");

    let description = event.get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let location = event.get("location")
        .and_then(|v| v.as_str());

    let start = event.get("start")
        .and_then(|s| s.get("dateTime").or(s.get("date")))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let end = event.get("end")
        .and_then(|s| s.get("dateTime").or(s.get("date")))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let attendees: Vec<String> = event.get("attendees")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter().filter_map(|a| {
                a.get("displayName").or(a.get("email"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
            }).collect()
        })
        .unwrap_or_default();

    let attendee_emails: Vec<String> = event.get("attendees")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter().filter_map(|a| {
                a.get("email").and_then(|v| v.as_str()).map(String::from)
            }).collect()
        })
        .unwrap_or_default();

    let meet_url = event.get("hangoutLink")
        .and_then(|v| v.as_str())
        .or_else(|| event.get("conferenceData")
            .and_then(|c| c.get("entryPoints"))
            .and_then(|e| e.as_array())
            .and_then(|arr| arr.first())
            .and_then(|e| e.get("uri"))
            .and_then(|v| v.as_str()));

    let html_link = event.get("htmlLink")
        .and_then(|v| v.as_str());

    let status_str = event.get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("confirmed");

    let date_part = if start.len() >= 10 { &start[..10] } else { "unknown" };
    let slug = sanitize_path(summary);
    let path = format!("vault/meetings/{}/{}", date_part, slug);

    let metadata = serde_json::json!({
        "type": "meeting",
        "calendarEventId": event_id,
        "date": date_part,
        "start": start,
        "end": end,
        "attendees": attendees,
        "location": location,
        "meetLink": meet_url,
        "htmlLink": html_link,
        "status": status_str,
    });

    // Check if note already exists for this event (by calendarEventId or path)
    let existing = find_meeting_note(parachute, event_id, &path).await?;

    let note_id = if let Some(note) = existing {
        parachute.update_note(&note.id, &UpdateNoteParams {
            content: None, // Don't overwrite user's meeting notes
            path: None,
            metadata: Some(metadata),
        }).await?;
        note.id
    } else {
        let mut content = format!("# {}\n\n", summary);
        content.push_str(&format!("**Date:** {}\n", date_part));
        content.push_str(&format!("**Time:** {} — {}\n", start, end));
        if let Some(loc) = location {
            content.push_str(&format!("**Location:** {}\n", loc));
        }
        if let Some(meet) = meet_url {
            content.push_str(&format!("**Meet:** {}\n", meet));
        }
        if !attendees.is_empty() {
            content.push_str(&format!("**Attendees:** {}\n", attendees.join(", ")));
        }
        if !description.is_empty() {
            content.push_str(&format!("\n---\n\n{}\n", description));
        }
        content.push_str("\n---\n\n## Meeting Notes\n\n");

        match parachute.create_note(&CreateNoteParams {
            content,
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["meeting".into()]),
        }).await {
            Ok(note) => note.id,
            Err(e) => {
                log::debug!("Calendar sync: create failed for '{}': {}", summary, e);
                return Err(e);
            }
        }
    };

    // Link to attendee person notes
    for (i, name) in attendees.iter().enumerate() {
        let email = attendee_emails.get(i).map(|s| s.as_str());
        if let Ok(person_id) = person_linker::find_or_create_person(
            parachute, name, email, None, None,
        ).await {
            let _ = person_linker::link_to_person(
                parachute, &note_id, &person_id, "attended-by",
            ).await;
        }
    }

    // Check for existing unlinked transcripts matching this meeting
    link_meeting_to_transcripts(parachute, &note_id, summary, date_part, &attendees).await;

    Ok(())
}

/// Parse events from gog response and sync each one.
async fn sync_events_data(
    parachute: &ParachuteClient,
    events_data: &serde_json::Value,
) -> Result<u64, crate::error::PrismError> {
    let empty_arr = vec![];
    let events = if let Some(arr) = events_data.as_array() {
        arr
    } else {
        events_data.get("events")
            .or_else(|| events_data.get("items"))
            .and_then(|v| v.as_array())
            .unwrap_or(&empty_arr)
    };

    let mut processed = 0u64;
    for event in events {
        match sync_single_event(parachute, event).await {
            Ok(_) => processed += 1,
            Err(e) => {
                log::debug!("Calendar sync: event error: {}", e);
            }
        }
    }

    Ok(processed)
}

/// Find an existing meeting note by calendarEventId or path.
async fn find_meeting_note(
    parachute: &ParachuteClient,
    event_id: &str,
    path: &str,
) -> Result<Option<crate::models::note::Note>, crate::error::PrismError> {
    // Search for the event ID in meeting-tagged notes
    let results = parachute.search(event_id, &["meeting".into()], 5).await.unwrap_or_default();
    if let Some(note) = results.into_iter().find(|n| {
        n.metadata.as_ref()
            .and_then(|m| m.get("calendarEventId"))
            .and_then(|v| v.as_str())
            == Some(event_id)
    }) {
        return Ok(Some(note));
    }

    // Also check by path
    let slug = path.split('/').last().unwrap_or("");
    if !slug.is_empty() {
        let results = parachute.search(slug, &["meeting".into()], 5).await.unwrap_or_default();
        if let Some(note) = results.into_iter().find(|n| {
            n.path.as_deref() == Some(path)
        }) {
            return Ok(Some(note));
        }
    }

    Ok(None)
}

/// When a meeting note is created/updated, check for existing transcript notes
/// that match and create links if not already linked.
async fn link_meeting_to_transcripts(
    parachute: &ParachuteClient,
    meeting_note_id: &str,
    meeting_title: &str,
    meeting_date: &str,
    meeting_attendees: &[String],
) {
    // Check if already linked
    if let Ok(links) = parachute.get_links(&crate::models::link::GetLinksParams {
        note_id: Some(meeting_note_id.to_string()),
        relationship: Some("has-transcript".into()),
    }).await {
        if !links.is_empty() {
            return; // Already has a transcript link
        }
    }

    // Search for transcript notes on the same date
    let transcripts = parachute.search(meeting_date, &["transcript".into()], 20)
        .await
        .unwrap_or_default();

    if transcripts.is_empty() {
        return;
    }

    let norm_meeting_attendees: Vec<String> = meeting_attendees.iter()
        .map(|a| normalize_attendee(a))
        .filter(|a| !a.is_empty())
        .collect();

    let meeting_words = significant_words(meeting_title);

    for transcript in &transcripts {
        let meta = match &transcript.metadata {
            Some(m) => m,
            None => continue,
        };

        // Check date match
        let transcript_date = meta.get("date").and_then(|v| v.as_str()).unwrap_or("");
        if transcript_date != meeting_date {
            // Allow ±1 day for timezone differences
            let parse = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
            match (parse(meeting_date), parse(transcript_date)) {
                (Some(md), Some(td)) if (md - td).num_days().unsigned_abs() <= 1 => {},
                _ => continue,
            }
        }

        // Check if this transcript is already linked to any meeting
        if meta.get("meetingNoteId").and_then(|v| v.as_str()).is_some() {
            continue;
        }

        let mut score: u32 = 1; // Base score for date match

        // Attendee overlap
        let transcript_attendees: Vec<String> = meta.get("attendees")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|a| a.as_str().map(|s| normalize_attendee(s))).collect())
            .unwrap_or_default();

        for ma in &norm_meeting_attendees {
            for ta in &transcript_attendees {
                if ma == ta || ma.contains(ta) || ta.contains(ma) {
                    score += 3;
                }
            }
        }

        // Title overlap
        let transcript_title = meta.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let transcript_words = significant_words(transcript_title);
        for mw in &meeting_words {
            if transcript_words.contains(mw) {
                score += 1;
            }
        }

        if score >= 2 {
            log::info!(
                "Calendar sync: linking meeting '{}' → transcript '{}' (score: {})",
                meeting_title,
                transcript.path.as_deref().unwrap_or(&transcript.id),
                score
            );

            let _ = parachute.create_link(&crate::models::link::CreateLinkParams {
                source_id: meeting_note_id.to_string(),
                target_id: transcript.id.clone(),
                relationship: "has-transcript".into(),
                metadata: None,
            }).await;

            // Update meeting metadata
            let _ = parachute.update_note(meeting_note_id, &UpdateNoteParams {
                content: None,
                path: None,
                metadata: Some(serde_json::json!({ "transcriptNoteId": transcript.id })),
            }).await;

            // Update transcript metadata
            let _ = parachute.update_note(&transcript.id, &UpdateNoteParams {
                content: None,
                path: None,
                metadata: Some(serde_json::json!({ "meetingNoteId": meeting_note_id })),
            }).await;

            break; // Link to best/first match only
        }
    }
}

fn normalize_attendee(name: &str) -> String {
    let s = name.trim().to_lowercase();
    if let Some(at_pos) = s.find('@') {
        return s[..at_pos].replace('.', " ").replace('_', " ").replace('-', " ");
    }
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn significant_words(title: &str) -> Vec<String> {
    let skip = ["meeting", "call", "sync", "the", "and", "with", "for", "a", "an", "of", "in", "on", "at", "to"];
    title.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 2 && !skip.contains(w))
        .map(String::from)
        .collect()
}

fn sanitize_path(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .replace(' ', "-")
        .to_lowercase()
}
