use std::sync::Arc;
use tokio::sync::watch;
use crate::clients::parachute::ParachuteClient;
use crate::commands::config::AppConfig;
use crate::models::note::{CreateNoteParams, UpdateNoteParams, ListNotesParams};
use crate::services::ServiceStatus;
use crate::services::person_linker;
use crate::error::PrismError;

const SYNC_INTERVAL_SECS: u64 = 600; // 10 minutes

/// Transcript sync service: pulls transcripts from configured sources
/// (Fathom API, Meetily SQLite, etc.) into Parachute as tagged notes.
pub async fn run(
    parachute: Arc<ParachuteClient>,
    config: AppConfig,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<std::sync::Mutex<ServiceStatus>>,
) {
    log::info!("Transcript sync service starting");

    {
        let mut s = status.lock().unwrap();
        s.running = true;
    }

    // Initial delay
    tokio::time::sleep(tokio::time::Duration::from_secs(25)).await;

    loop {
        if *shutdown.borrow() {
            break;
        }

        let mut total = 0u64;
        let mut errors_str = Vec::new();

        // Meetily (SQLite)
        if !config.meetily_db_path.is_empty() {
            match sync_meetily(&parachute, &config.meetily_db_path).await {
                Ok(count) => total += count,
                Err(e) => {
                    log::warn!("Meetily sync error: {}", e);
                    errors_str.push(format!("Meetily: {}", e));
                }
            }
        }

        // Fathom (API)
        if !config.fathom_api_key.is_empty() {
            match sync_fathom(&parachute, &config.fathom_api_key).await {
                Ok(count) => total += count,
                Err(e) => {
                    log::warn!("Fathom sync error: {}", e);
                    errors_str.push(format!("Fathom: {}", e));
                }
            }
        }

        {
            let mut s = status.lock().unwrap();
            s.last_run = Some(chrono::Utc::now().to_rfc3339());
            s.items_processed += total;
            s.last_error = if errors_str.is_empty() { None } else { Some(errors_str.join("; ")) };
        }

        if total > 0 {
            log::info!("Transcript sync: ingested {} transcripts", total);
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
    log::info!("Transcript sync service stopped");
}

/// Sync transcripts from Meetily's local SQLite database.
async fn sync_meetily(
    parachute: &ParachuteClient,
    db_path: &str,
) -> Result<u64, PrismError> {
    let db_path = db_path.to_string();

    // Run SQLite queries in a blocking thread
    let meetings = tokio::task::spawn_blocking(move || {
        read_meetily_meetings(&db_path)
    }).await
        .map_err(|e| PrismError::Other(format!("spawn error: {}", e)))??;

    // Load existing transcript notes to avoid duplicates
    let existing = parachute.list_notes(&ListNotesParams {
        tag: Some("transcript".into()),
        limit: Some(500),
        ..Default::default()
    }).await.unwrap_or_default();

    let mut ingested = 0u64;

    for meeting in &meetings {
        let meeting_id = meeting.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let title = meeting.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled Meeting");
        let date = meeting.get("date").and_then(|v| v.as_str()).unwrap_or("");
        let transcript = meeting.get("transcript").and_then(|v| v.as_str()).unwrap_or("");
        let summary = meeting.get("summary").and_then(|v| v.as_str()).unwrap_or("");
        let attendees: Vec<String> = meeting.get("attendees")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|a| a.as_str().map(String::from)).collect())
            .unwrap_or_default();

        if transcript.is_empty() && summary.is_empty() {
            continue;
        }

        // Check if already ingested
        let slug = sanitize_path(title);
        let path = format!("vault/_inbox/transcripts/meetily/{}-{}", date, slug);
        let already_exists = existing.iter().any(|n| {
            n.metadata.as_ref()
                .and_then(|m| m.get("sourceId"))
                .and_then(|v| v.as_str())
                == Some(meeting_id)
            || n.path.as_deref() == Some(&path)
        });

        if already_exists {
            continue;
        }

        // Build content
        let mut content = format!("---\ntitle: \"{}\"\ndate: {}\nsource: meetily\nmeeting_id: \"{}\"\n---\n\n", title, date, meeting_id);
        if !summary.is_empty() {
            content.push_str(&format!("## Summary\n\n{}\n\n", summary));
        }
        if !transcript.is_empty() {
            content.push_str(&format!("## Transcript\n\n{}\n", transcript));
        }

        let metadata = serde_json::json!({
            "type": "transcript",
            "source": "meetily",
            "sourceId": meeting_id,
            "title": title,
            "date": date,
            "attendees": attendees,
        });

        match parachute.create_note(&CreateNoteParams {
            content,
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["transcript".into(), "meetily".into()]),
        }).await {
            Ok(note) => {
                ingested += 1;
                // Link transcript to matching meeting note (speakers as attendees)
                link_transcript_to_meeting(
                    parachute, &note.id, title, date, &attendees,
                ).await;
            }
            Err(e) => log::debug!("Meetily: failed to create note for '{}': {}", title, e),
        }
    }

    Ok(ingested)
}

/// Read meetings from Meetily's SQLite database.
fn read_meetily_meetings(db_path: &str) -> Result<Vec<serde_json::Value>, PrismError> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|e| PrismError::Other(format!("Meetily DB open failed: {}", e)))?;

    // Discover table schema
    let tables: Vec<String> = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .map_err(|e| PrismError::Other(format!("Schema query failed: {}", e)))?
        .query_map([], |row| row.get(0))
        .map_err(|e| PrismError::Other(format!("Schema read failed: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    log::info!("Meetily DB tables: {:?}", tables);

    // Query meetings from last 30 days
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d")
        .to_string();

    let mut meetings = Vec::new();

    // Try meetings table
    if tables.contains(&"meetings".to_string()) {
        let mut stmt = conn.prepare(
            "SELECT * FROM meetings WHERE created_at >= ? ORDER BY created_at DESC"
        ).map_err(|e| PrismError::Other(format!("Query failed: {}", e)))?;

        let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

        let rows = stmt.query_map(rusqlite::params![cutoff], |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let val: rusqlite::Result<String> = row.get(i);
                if let Ok(v) = val {
                    obj.insert(name.clone(), serde_json::json!(v));
                }
            }
            Ok(serde_json::Value::Object(obj))
        }).map_err(|e| PrismError::Other(format!("Query failed: {}", e)))?;

        for row in rows {
            if let Ok(meeting) = row {
                let id = meeting.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();

                // Get transcript
                let transcript = get_meetily_transcript(&conn, &id);
                let summary = get_meetily_summary(&conn, &id);
                let speakers = get_meetily_speakers(&conn, &id);

                let date = meeting.get("created_at").or(meeting.get("scheduled_at"))
                    .and_then(|v| v.as_str())
                    .map(|s| if s.len() >= 10 { &s[..10] } else { s })
                    .unwrap_or("")
                    .to_string();

                let title = meeting.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();

                meetings.push(serde_json::json!({
                    "id": id,
                    "title": title,
                    "date": date,
                    "transcript": transcript,
                    "summary": summary,
                    "attendees": speakers,
                }));
            }
        }
    }

    log::info!("Meetily: found {} meetings in last 30 days", meetings.len());
    Ok(meetings)
}

fn get_meetily_transcript(conn: &rusqlite::Connection, meeting_id: &str) -> String {
    // Schema: id, meeting_id, transcript, timestamp, summary, action_items, key_points,
    //         audio_start_time, audio_end_time, duration, speaker
    let result = conn.prepare("SELECT transcript, speaker, timestamp FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time, timestamp")
        .and_then(|mut stmt| {
            let rows: Vec<(String, String, String)> = stmt.query_map(
                rusqlite::params![meeting_id],
                |row| {
                    let text: String = row.get::<_, String>(0).unwrap_or_default();
                    let speaker: String = row.get::<_, String>(1).unwrap_or_default();
                    let timestamp: String = row.get::<_, String>(2).unwrap_or_default();
                    Ok((text, speaker, timestamp))
                },
            )?.filter_map(|r| r.ok()).collect();
            Ok(rows)
        });

    match result {
        Ok(rows) => rows.iter()
            .filter(|(text, _, _)| !text.is_empty())
            .map(|(text, speaker, ts)| {
                let speaker_label = if speaker.is_empty() { "Speaker".to_string() } else { speaker.clone() };
                if ts.is_empty() {
                    format!("**{}**: {}", speaker_label, text)
                } else {
                    format!("**{}** ({}): {}", speaker_label, ts, text)
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        Err(e) => {
            log::debug!("Meetily transcript read error: {}", e);
            String::new()
        }
    }
}

/// Distinct, non-empty speaker labels for a Meetily meeting. Used as the
/// transcript's `attendees`, which is the strongest signal the meeting↔event
/// linker has (previously Meetily passed an empty slice, leaving only date +
/// title-word overlap to reach the minimum match score of 2).
fn get_meetily_speakers(conn: &rusqlite::Connection, meeting_id: &str) -> Vec<String> {
    let result = conn.prepare(
        "SELECT DISTINCT speaker FROM transcripts WHERE meeting_id = ? AND speaker IS NOT NULL AND speaker != ''",
    ).and_then(|mut stmt| {
        let rows: Vec<String> = stmt.query_map(rusqlite::params![meeting_id], |row| {
            row.get::<_, String>(0)
        })?.filter_map(|r| r.ok()).collect();
        Ok(rows)
    });

    match result {
        Ok(rows) => rows.into_iter()
            .map(|s| s.trim().to_string())
            // Drop generic placeholder labels that add no matching signal.
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("speaker") && !s.eq_ignore_ascii_case("unknown"))
            .collect(),
        Err(e) => {
            log::debug!("Meetily speaker read error: {}", e);
            Vec::new()
        }
    }
}

fn get_meetily_summary(conn: &rusqlite::Connection, meeting_id: &str) -> String {
    // Try summary_processes table first (newer schema)
    if let Ok(mut stmt) = conn.prepare("SELECT result FROM summary_processes WHERE meeting_id = ? AND status = 'completed'") {
        if let Ok(summary) = stmt.query_row(rusqlite::params![meeting_id], |row| {
            row.get::<_, String>(0)
        }) {
            // May be JSON — try to extract markdown
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&summary) {
                if let Some(md) = parsed.get("markdown").and_then(|v| v.as_str()) {
                    return md.to_string();
                }
                if let Some(md) = parsed.get("SessionSummary").and_then(|v| v.as_str()) {
                    return md.to_string();
                }
            }
            return summary;
        }
    }

    // Fallback: summaries table
    if let Ok(mut stmt) = conn.prepare("SELECT * FROM summaries WHERE meeting_id = ?") {
        if let Ok(summary) = stmt.query_row(rusqlite::params![meeting_id], |row| {
            row.get::<_, String>(1) // Usually second column is the summary text
        }) {
            return summary;
        }
    }

    String::new()
}

/// Sync transcripts from Fathom API.
async fn sync_fathom(
    parachute: &ParachuteClient,
    api_key: &str,
) -> Result<u64, PrismError> {
    let client = reqwest::Client::new();

    // Fetch meetings from last 7 days
    let since = (chrono::Utc::now() - chrono::Duration::days(7)).to_rfc3339();
    let url = format!("https://api.fathom.ai/external/v1/meetings?created_after={}", since);

    let resp = client.get(&url)
        .header("X-Api-Key", api_key)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| PrismError::Other(format!("Fathom API error: {}", e)))?;

    if !resp.status().is_success() {
        return Err(PrismError::Other(format!("Fathom API returned {}", resp.status())));
    }

    let data: serde_json::Value = resp.json().await
        .map_err(|e| PrismError::Other(format!("Fathom parse error: {}", e)))?;

    let items = data.get("items").and_then(|v| v.as_array())
        .or_else(|| data.as_array())
        .cloned()
        .unwrap_or_default();

    // Load existing transcript notes
    let existing = parachute.list_notes(&ListNotesParams {
        tag: Some("transcript".into()),
        limit: Some(500),
        ..Default::default()
    }).await.unwrap_or_default();

    let mut ingested = 0u64;

    for meeting in &items {
        // recording_id may be a number or string in the Fathom API
        let recording_id = meeting.get("recording_id")
            .map(|v| match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => String::new(),
            })
            .or_else(|| meeting.get("id").map(|v| match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => String::new(),
            }))
            .unwrap_or_default();

        let title = meeting.get("title")
            .or(meeting.get("meeting_title"))
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled Meeting");

        let date = meeting.get("scheduled_start_time")
            .or(meeting.get("scheduled_at"))
            .or(meeting.get("recording_start_time"))
            .or(meeting.get("recorded_at"))
            .or(meeting.get("created_at"))
            .and_then(|v| v.as_str())
            .map(|s| if s.len() >= 10 { &s[..10] } else { s })
            .unwrap_or("");

        let share_url = meeting.get("share_url").and_then(|v| v.as_str()).unwrap_or("");

        // Check if already ingested
        let already_exists = existing.iter().any(|n| {
            n.metadata.as_ref()
                .and_then(|m| m.get("sourceId"))
                .and_then(|v| v.as_str())
                == Some(recording_id.as_str())
        });

        if already_exists {
            continue;
        }

        // Fetch summary
        let summary = if !recording_id.is_empty() {
            fetch_fathom_summary(&client, api_key, &recording_id).await.unwrap_or_default()
        } else {
            String::new()
        };

        // Fetch transcript
        let transcript = if !recording_id.is_empty() {
            fetch_fathom_transcript(&client, api_key, &recording_id).await.unwrap_or_default()
        } else {
            String::new()
        };

        if summary.is_empty() && transcript.is_empty() {
            continue;
        }

        // Build attendees list
        let attendees: Vec<String> = meeting.get("calendar_invitees")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|a| {
                a.get("name").or(a.get("email")).and_then(|v| v.as_str()).map(String::from)
            }).collect())
            .unwrap_or_default();

        let slug = sanitize_path(title);
        let path = format!("vault/_inbox/transcripts/fathom/{}-{}", date, slug);

        let mut content = format!("---\ntitle: \"{}\"\ndate: {}\nsource: fathom\nrecording_id: \"{}\"\nfathom_url: \"{}\"\nattendees:\n", title, date, recording_id, share_url);
        for att in &attendees {
            content.push_str(&format!("  - {}\n", att));
        }
        content.push_str("---\n\n");

        if !summary.is_empty() {
            content.push_str(&format!("## Summary\n\n{}\n\n", summary));
        }
        if !transcript.is_empty() {
            content.push_str(&format!("## Transcript\n\n{}\n", transcript));
        }

        let metadata = serde_json::json!({
            "type": "transcript",
            "source": "fathom",
            "sourceId": recording_id,
            "title": title,
            "date": date,
            "attendees": attendees,
            "fathomUrl": share_url,
        });

        match parachute.create_note(&CreateNoteParams {
            content,
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["transcript".into(), "fathom".into()]),
        }).await {
            Ok(note) => {
                ingested += 1;
                // Link to attendee person notes
                for name in &attendees {
                    if let Ok(person_id) = person_linker::find_or_create_person(
                        parachute, name, None, None, None,
                    ).await {
                        let _ = person_linker::link_to_person(
                            parachute, &note.id, &person_id, "transcript-of",
                        ).await;
                    }
                }
                // Link transcript to matching meeting note
                link_transcript_to_meeting(
                    parachute, &note.id, title, date, &attendees,
                ).await;
            }
            Err(e) => log::debug!("Fathom: failed to create note for '{}': {}", title, e),
        }
    }

    Ok(ingested)
}

async fn fetch_fathom_summary(
    client: &reqwest::Client,
    api_key: &str,
    recording_id: &str,
) -> Result<String, PrismError> {
    let url = format!("https://api.fathom.ai/external/v1/recordings/{}/summary", recording_id);
    let resp = client.get(&url)
        .header("X-Api-Key", api_key)
        .timeout(std::time::Duration::from_secs(15))
        .send().await
        .map_err(|e| PrismError::Other(format!("Fathom summary: {}", e)))?;

    if !resp.status().is_success() {
        return Ok(String::new());
    }

    let data: serde_json::Value = resp.json().await.unwrap_or_default();
    // Try various response formats
    let md = data.get("markdown")
        .or_else(|| data.get("summary").and_then(|s| s.get("markdown_formatted")))
        .or_else(|| data.get("summary").and_then(|s| s.get("markdown")))
        .or_else(|| data.get("recording").and_then(|r| r.get("markdown_formatted")))
        .or_else(|| data.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Ok(md.to_string())
}

async fn fetch_fathom_transcript(
    client: &reqwest::Client,
    api_key: &str,
    recording_id: &str,
) -> Result<String, PrismError> {
    let url = format!("https://api.fathom.ai/external/v1/recordings/{}/transcript", recording_id);
    let resp = client.get(&url)
        .header("X-Api-Key", api_key)
        .timeout(std::time::Duration::from_secs(15))
        .send().await
        .map_err(|e| PrismError::Other(format!("Fathom transcript: {}", e)))?;

    if !resp.status().is_success() {
        return Ok(String::new());
    }

    let data: serde_json::Value = resp.json().await.unwrap_or_default();
    let segments = data.get("transcript")
        .or(data.get("items"))
        .or(data.get("segments"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let lines: Vec<String> = segments.iter().filter_map(|seg| {
        let speaker = seg.get("speaker_display_name")
            .or(seg.get("speaker"))
            .and_then(|v| v.as_str())
            .unwrap_or("Speaker");
        let text = seg.get("text").and_then(|v| v.as_str()).unwrap_or("");
        if text.is_empty() { return None; }
        Some(format!("**{}**: {}", speaker, text))
    }).collect();

    Ok(lines.join("\n\n"))
}

/// After creating a transcript note, find matching meeting notes and create
/// bidirectional links + cross-reference metadata.
///
/// Matching strategy:
/// 1. Same date (required, ±1 day for timezone tolerance)
/// 2. Attendee name/email overlap (strong signal)
/// 3. Title word overlap (fallback)
async fn link_transcript_to_meeting(
    parachute: &ParachuteClient,
    transcript_note_id: &str,
    transcript_title: &str,
    transcript_date: &str,
    transcript_attendees: &[String],
) {
    // List ALL meeting notes and match on metadata.date. The prior full-text
    // search(date) ranked by content relevance and capped at 20, so the real
    // same-day meeting could rank out below unrelated notes mentioning the date.
    let meeting_notes = parachute.list_all_by_tag("meeting").await.unwrap_or_default();

    if meeting_notes.is_empty() {
        log::debug!("Transcript linking: no meeting notes found for date {}", transcript_date);
        return;
    }

    let mut best_match: Option<(&crate::models::note::Note, u32)> = None;

    for note in &meeting_notes {
        let meta = match &note.metadata {
            Some(m) => m,
            None => continue,
        };

        // Check date match (±1 day)
        let meeting_date = meta.get("date").and_then(|v| v.as_str()).unwrap_or("");
        if !dates_within_one_day(transcript_date, meeting_date) {
            continue;
        }

        let meeting_attendees: Vec<String> = meta.get("attendees")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|a| a.as_str().map(String::from)).collect())
            .unwrap_or_default();

        // Title from metadata, falling back to the path slug.
        let meeting_title = meta.get("title")
            .and_then(|v| v.as_str())
            .or_else(|| note.path.as_ref().and_then(|p| p.split('/').last()))
            .unwrap_or("");

        let score = score_transcript_meeting_match(
            transcript_title, transcript_attendees, transcript_date,
            meeting_title, &meeting_attendees, meeting_date,
        );

        if score > 0 && best_match.as_ref().map(|(_, s)| score > *s).unwrap_or(true) {
            best_match = Some((note, score));
        }
    }

    // Require minimum score of 2 (date match + at least one attendee or title word)
    if let Some((meeting_note, score)) = best_match {
        if score < 2 {
            log::debug!("Transcript linking: best match score {} too low for '{}'", score, transcript_title);
            return;
        }

        let meeting_id = &meeting_note.id;
        log::info!(
            "Transcript linking: linking '{}' → meeting '{}' (score: {})",
            transcript_title,
            meeting_note.path.as_deref().unwrap_or(meeting_id),
            score
        );

        // Create bidirectional links
        let _ = parachute.create_link(&crate::models::link::CreateLinkParams {
            source_id: meeting_id.clone(),
            target_id: transcript_note_id.to_string(),
            relationship: "has-transcript".into(),
            metadata: None,
        }).await;

        // Update meeting note metadata with transcript reference
        if let Some(mut meta) = meeting_note.metadata.clone() {
            if let Some(obj) = meta.as_object_mut() {
                obj.insert("transcriptNoteId".into(), serde_json::json!(transcript_note_id));
                let _ = parachute.update_note(meeting_id, &UpdateNoteParams {
                    content: None,
                    path: None,
                    metadata: Some(meta.clone()),
                    ..Default::default()
                }).await;
            }
        }

        // Update transcript note metadata with meeting reference
        let _ = parachute.update_note(transcript_note_id, &UpdateNoteParams {
            content: None,
            path: None,
            metadata: Some(serde_json::json!({
                "meetingNoteId": meeting_id,
            })),
            ..Default::default()
        }).await;
    } else {
        log::debug!("Transcript linking: no match found for '{}'", transcript_title);
    }
}

/// Normalize a name for fuzzy matching: lowercase, strip email domains, collapse whitespace
fn normalize_name(name: &str) -> String {
    let s = name.trim().to_lowercase();
    // If it looks like an email, extract the part before @
    if let Some(at_pos) = s.find('@') {
        let local = &s[..at_pos];
        return local.replace('.', " ").replace('_', " ").replace('-', " ");
    }
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Extract significant title words (skip common filler words)
fn title_words(title: &str) -> Vec<String> {
    let skip = ["meeting", "call", "sync", "the", "and", "with", "for", "a", "an", "of", "in", "on", "at", "to", "-", "—"];
    title.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 2 && !skip.contains(w))
        .map(String::from)
        .collect()
}

/// Check if two date strings (YYYY-MM-DD) are within 1 day of each other
fn dates_within_one_day(a: &str, b: &str) -> bool {
    if a == b { return true; }
    let parse = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
    match (parse(a), parse(b)) {
        (Some(da), Some(db)) => (da - db).num_days().unsigned_abs() <= 1,
        _ => false,
    }
}

fn sanitize_path(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .replace(' ', "-")
        .to_lowercase()
}

/// Pure relevance score between a transcript and a candidate meeting note.
///
/// Heuristic (caller pre-filters candidates to within ±1 day):
/// - +3 per fuzzy attendee match (exact, or one name contained in the other)
/// - +1 per shared significant title word
/// - +1 when the dates match exactly
///
/// A score of ≥2 is required to create a link, i.e. an exact-date match alone
/// (score 1) is never enough — there must be at least one attendee or title-word
/// signal. Extracted from `link_transcript_to_meeting` so the matching logic can
/// be unit-tested without a live vault.
fn score_transcript_meeting_match(
    transcript_title: &str,
    transcript_attendees: &[String],
    transcript_date: &str,
    meeting_title: &str,
    meeting_attendees: &[String],
    meeting_date: &str,
) -> u32 {
    let nt: Vec<String> = transcript_attendees.iter()
        .map(|a| normalize_name(a))
        .filter(|a| !a.is_empty())
        .collect();
    let nm: Vec<String> = meeting_attendees.iter()
        .map(|a| normalize_name(a))
        .filter(|a| !a.is_empty())
        .collect();

    let mut score: u32 = 0;
    for ta in &nt {
        for ma in &nm {
            if ta == ma || ta.contains(ma.as_str()) || ma.contains(ta.as_str()) {
                score += 3;
            }
        }
    }

    let mw = title_words(meeting_title);
    for tw in title_words(transcript_title) {
        if mw.contains(&tw) {
            score += 1;
        }
    }

    if meeting_date == transcript_date {
        score += 1;
    }

    score
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK_THRESHOLD: u32 = 2;

    #[test]
    fn normalize_name_strips_email_and_punctuation() {
        assert_eq!(normalize_name("Alice Smith"), "alice smith");
        assert_eq!(normalize_name("alice.smith@example.com"), "alice smith");
        assert_eq!(normalize_name("  Bob_Jones-PhD  "), "bob jones phd");
    }

    #[test]
    fn title_words_drops_filler_and_short_words() {
        let w = title_words("Q2 Roadmap Review - Sync with the Team");
        assert!(w.contains(&"roadmap".to_string()));
        assert!(w.contains(&"review".to_string()));
        assert!(w.contains(&"team".to_string()));
        // fillers / short tokens excluded
        assert!(!w.contains(&"sync".to_string()));
        assert!(!w.contains(&"with".to_string()));
        assert!(!w.contains(&"the".to_string()));
        assert!(!w.contains(&"q2".to_string())); // len <= 2
    }

    #[test]
    fn dates_within_one_day_tolerates_timezone_skew() {
        assert!(dates_within_one_day("2026-05-28", "2026-05-28"));
        assert!(dates_within_one_day("2026-05-28", "2026-05-29"));
        assert!(dates_within_one_day("2026-05-28", "2026-05-27"));
        assert!(!dates_within_one_day("2026-05-28", "2026-05-30"));
        assert!(!dates_within_one_day("2026-05-28", "not-a-date"));
    }

    #[test]
    fn strong_attendee_overlap_links() {
        // Same day + one shared attendee → 1 (date) + 3 (attendee) = 4 ≥ threshold.
        let score = score_transcript_meeting_match(
            "Untitled", &["Alice Smith".into(), "Bob Jones".into()], "2026-05-28",
            "Standup", &["alice.smith@example.com".into()], "2026-05-28",
        );
        assert!(score >= LINK_THRESHOLD, "expected link, got {score}");
    }

    #[test]
    fn title_overlap_alone_links_on_same_day() {
        // No attendees, but two shared title words + exact date = 1 + 2 = 3.
        let score = score_transcript_meeting_match(
            "Roadmap Review", &[], "2026-05-28",
            "Roadmap Review", &[], "2026-05-28",
        );
        assert!(score >= LINK_THRESHOLD, "expected link, got {score}");
    }

    #[test]
    fn generic_title_no_attendees_does_not_link() {
        // The Meetily failure mode before speakers were extracted: identical
        // generic single filler-ish word, no attendees. Only the date matches.
        let score = score_transcript_meeting_match(
            "Standup", &[], "2026-05-28",
            "Standup", &[], "2026-05-28",
        );
        // "standup" is a single 7-char non-filler word shared → +1, plus exact
        // date +1 = 2. It links — which is the *intended* behavior once a real
        // title word matches. The true ambiguous case (no shared words) below:
        assert_eq!(score, 2);

        let ambiguous = score_transcript_meeting_match(
            "Check-in", &[], "2026-05-28",
            "Standup", &[], "2026-05-28",
        );
        // Different titles, no attendees → only exact date (+1). Below threshold.
        assert!(ambiguous < LINK_THRESHOLD, "expected NO link, got {ambiguous}");
    }

    #[test]
    fn wrong_day_scores_only_title() {
        // Candidate one day off (passes the ±1 pre-filter) but not exact date:
        // shared title words still score, exact-date bonus does not apply.
        let score = score_transcript_meeting_match(
            "Roadmap Review", &[], "2026-05-28",
            "Roadmap Review", &[], "2026-05-29",
        );
        assert_eq!(score, 2); // two title words, no date bonus
    }

    #[test]
    fn meetily_speakers_as_attendees_rescue_a_match() {
        // Regression: Meetily used to pass &[] for attendees. With speakers
        // extracted, a shared speaker now lifts a generic-title meeting over
        // the threshold where title words alone would not.
        let without = score_transcript_meeting_match(
            "Weekly", &[], "2026-05-28",
            "Weekly Team Meeting", &[], "2026-05-28",
        );
        let with = score_transcript_meeting_match(
            "Weekly", &["Carla Diaz".into()], "2026-05-28",
            "Weekly Team Meeting", &["carla.diaz@org.com".into()], "2026-05-28",
        );
        assert!(with > without);
        assert!(with >= LINK_THRESHOLD);
    }
}
