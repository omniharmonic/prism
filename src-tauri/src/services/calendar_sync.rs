use std::sync::Arc;
use tokio::sync::watch;
use crate::clients::google::GoogleClient;
use crate::clients::parachute::ParachuteClient;
use crate::models::note::{CreateNoteParams, UpdateNoteParams, ListNotesParams};
use crate::services::ServiceStatus;
use crate::services::person_linker;

const SYNC_INTERVAL_SECS: u64 = 300; // 5 minutes

/// Continuous Google Calendar → Parachute sync.
///
/// Every 5 minutes: fetch upcoming events → create/update meeting notes
/// in Parachute tagged `meeting` → link to attendee person notes.
pub async fn run(
    google: Arc<GoogleClient>,
    parachute: Arc<ParachuteClient>,
    account: String,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<std::sync::Mutex<ServiceStatus>>,
) {
    log::info!("Calendar sync service starting for account: {}", account);

    // Initial delay
    tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

    loop {
        // Check shutdown
        if *shutdown.borrow() {
            break;
        }

        {
            let mut s = status.lock().unwrap();
            s.running = true;
        }

        match sync_calendar(&google, &parachute, &account).await {
            Ok(count) => {
                let mut s = status.lock().unwrap();
                s.last_run = Some(chrono::Utc::now().to_rfc3339());
                s.items_processed += count;
                s.last_error = None;
                if count > 0 {
                    log::info!("Calendar sync: processed {} events", count);
                }
            }
            Err(e) => {
                log::warn!("Calendar sync error: {}", e);
                let mut s = status.lock().unwrap();
                s.last_error = Some(e.to_string());
            }
        }

        // Wait for interval or shutdown
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

async fn sync_calendar(
    google: &GoogleClient,
    parachute: &ParachuteClient,
    account: &str,
) -> Result<u64, crate::error::PrismError> {
    // Fetch events — gog returns upcoming events
    let events_data = tokio::task::spawn_blocking({
        let google = google.clone();
        let account = account.to_string();
        move || google.calendar_list_events(&account, 50)
    }).await
        .map_err(|e| crate::error::PrismError::Google(format!("spawn error: {}", e)))??;

    let empty_arr = vec![];
    let events = if let Some(arr) = events_data.as_array() {
        arr
    } else {
        // gog wraps in { "events": [...] } or { "items": [...] }
        events_data.get("events")
            .or_else(|| events_data.get("items"))
            .and_then(|v| v.as_array())
            .unwrap_or(&empty_arr)
    };

    // Load existing meeting notes to avoid duplicates
    let existing_notes = parachute.list_notes(&ListNotesParams {
        tag: Some("meeting".into()),
        path: None,
        limit: Some(500),
        offset: None,
    }).await.unwrap_or_default();

    let mut processed = 0u64;

    for event in events {
        let event_id = match event.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => continue,
        };

        let summary = event.get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled Event");

        let description = event.get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let location = event.get("location")
            .and_then(|v| v.as_str());

        // Parse start/end times
        let start = event.get("start")
            .and_then(|s| s.get("dateTime").or(s.get("date")))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let end = event.get("end")
            .and_then(|s| s.get("dateTime").or(s.get("date")))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Parse attendees
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

        // Meet/Zoom link
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

        // Extract date for path
        let date_part = if start.len() >= 10 { &start[..10] } else { "unknown" };

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

        // Check if we already have a note for this calendar event
        let existing = existing_notes.iter().find(|n| {
            n.metadata.as_ref()
                .and_then(|m| m.get("calendarEventId"))
                .and_then(|v| v.as_str())
                == Some(event_id)
        });

        let note_id = if let Some(note) = existing {
            // Update metadata (event may have been rescheduled, attendees changed)
            parachute.update_note(&note.id, &UpdateNoteParams {
                content: None, // Don't overwrite user's meeting notes
                path: None,
                metadata: Some(metadata),
            }).await?;
            note.id.clone()
        } else {
            // Create new meeting note
            let slug = sanitize_path(summary);
            let path = format!("vault/meetings/{}/{}", date_part, slug);

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

            let note = parachute.create_note(&CreateNoteParams {
                content,
                path: Some(path),
                metadata: Some(metadata),
                tags: Some(vec!["meeting".into()]),
            }).await?;
            note.id
        };

        // Link to attendee person notes
        for (i, name) in attendees.iter().enumerate() {
            let email = attendee_emails.get(i).map(|s| s.as_str());
            match person_linker::find_or_create_person(
                parachute, name, email, None, None,
            ).await {
                Ok(person_id) => {
                    let _ = person_linker::link_to_person(
                        parachute, &note_id, &person_id, "attended-by",
                    ).await;
                }
                Err(e) => {
                    log::debug!("Calendar sync: failed to link attendee {}: {}", name, e);
                }
            }
        }

        processed += 1;
    }

    Ok(processed)
}

fn sanitize_path(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .replace(' ', "-")
        .to_lowercase()
}

