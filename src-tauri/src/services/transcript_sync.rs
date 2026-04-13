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
        path: None,
        limit: Some(500),
        offset: None,
    }).await.unwrap_or_default();

    let mut ingested = 0u64;

    for meeting in &meetings {
        let meeting_id = meeting.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let title = meeting.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled Meeting");
        let date = meeting.get("date").and_then(|v| v.as_str()).unwrap_or("");
        let transcript = meeting.get("transcript").and_then(|v| v.as_str()).unwrap_or("");
        let summary = meeting.get("summary").and_then(|v| v.as_str()).unwrap_or("");

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
        });

        match parachute.create_note(&CreateNoteParams {
            content,
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["transcript".into(), "meetily".into()]),
        }).await {
            Ok(_) => ingested += 1,
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
                }));
            }
        }
    }

    log::info!("Meetily: found {} meetings in last 30 days", meetings.len());
    Ok(meetings)
}

fn get_meetily_transcript(conn: &rusqlite::Connection, meeting_id: &str) -> String {
    let result = conn.prepare("SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY timestamp")
        .and_then(|mut stmt| {
            let rows: Vec<(String, String)> = stmt.query_map(
                rusqlite::params![meeting_id],
                |row| {
                    let speaker: String = row.get::<_, String>(row.as_ref().column_index("speaker").unwrap_or(0)).unwrap_or_default();
                    let text: String = row.get::<_, String>(row.as_ref().column_index("text").unwrap_or(
                        row.as_ref().column_index("transcript").unwrap_or(1)
                    )).unwrap_or_default();
                    Ok((speaker, text))
                },
            )?.filter_map(|r| r.ok()).collect();
            Ok(rows)
        });

    match result {
        Ok(rows) => rows.iter()
            .map(|(speaker, text)| format!("**{}**: {}", speaker, text))
            .collect::<Vec<_>>()
            .join("\n\n"),
        Err(_) => String::new(),
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
        path: None,
        limit: Some(500),
        offset: None,
    }).await.unwrap_or_default();

    let mut ingested = 0u64;

    for meeting in &items {
        let recording_id = meeting.get("recording_id").and_then(|v| v.as_str())
            .or_else(|| meeting.get("id").and_then(|v| v.as_str()))
            .unwrap_or("");

        let title = meeting.get("title")
            .or(meeting.get("meeting_title"))
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled Meeting");

        let date = meeting.get("scheduled_at")
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
                == Some(recording_id)
        });

        if already_exists {
            continue;
        }

        // Fetch summary
        let summary = if !recording_id.is_empty() {
            fetch_fathom_summary(&client, api_key, recording_id).await.unwrap_or_default()
        } else {
            String::new()
        };

        // Fetch transcript
        let transcript = if !recording_id.is_empty() {
            fetch_fathom_transcript(&client, api_key, recording_id).await.unwrap_or_default()
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

fn sanitize_path(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .replace(' ', "-")
        .to_lowercase()
}
