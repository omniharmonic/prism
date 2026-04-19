use std::sync::Arc;
use tokio::sync::watch;
use crate::clients::matrix::MatrixClient;
use crate::clients::parachute::ParachuteClient;
use crate::models::note::{CreateNoteParams, UpdateNoteParams, ListNotesParams};
use crate::services::ServiceStatus;
use crate::services::person_linker;

const SYNC_INTERVAL_SECS: u64 = 60;
const SYNC_TIMEOUT_MS: u64 = 10_000; // 10s long-poll timeout

/// Continuous Matrix → Parachute message sync.
///
/// Uses Matrix /sync with `since` tokens for incremental updates.
/// Each cycle: get new events → update/create conversation notes in Parachute
/// → link to person notes.
pub async fn run(
    matrix: Arc<MatrixClient>,
    parachute: Arc<ParachuteClient>,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<std::sync::Mutex<ServiceStatus>>,
) {
    log::info!("Message sync service starting");

    // Mark as running immediately
    {
        let mut s = status.lock().unwrap();
        s.running = true;
    }

    // Initial delay — let the app boot up
    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

    let mut since_token: Option<String> = None;

    // Do an initial sync with no timeout to get the since token without processing all history
    match matrix.sync(None, Some(0)).await {
        Ok(resp) => {
            since_token = resp.get("next_batch")
                .and_then(|v| v.as_str())
                .map(String::from);
            log::info!("Message sync: got initial since token, starting incremental sync");
        }
        Err(e) => {
            log::warn!("Message sync: initial sync failed: {}. Will retry.", e);
            let mut s = status.lock().unwrap();
            s.last_error = Some(format!("Initial sync failed: {}", e));
        }
    }

    // First run: do a full index of existing rooms
    match full_index(&matrix, &parachute).await {
        Ok(count) => {
            let mut s = status.lock().unwrap();
            s.last_run = Some(chrono::Utc::now().to_rfc3339());
            s.items_processed = count;
            s.last_error = None;
        }
        Err(e) => {
            log::warn!("Message sync: full index failed: {}", e);
            let mut s = status.lock().unwrap();
            s.last_error = Some(e.to_string());
        }
    }

    loop {
        // Check shutdown
        if *shutdown.borrow() {
            log::info!("Message sync service shutting down");
            break;
        }

        // Wait for interval or shutdown
        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(SYNC_INTERVAL_SECS)) => {},
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    log::info!("Message sync service shutting down");
                    break;
                }
            }
        }

        // Incremental sync
        match incremental_sync(&matrix, &parachute, since_token.as_deref()).await {
            Ok((new_token, processed)) => {
                if let Some(t) = new_token {
                    since_token = Some(t);
                }
                let mut s = status.lock().unwrap();
                s.last_run = Some(chrono::Utc::now().to_rfc3339());
                s.items_processed += processed;
                s.last_error = None;
            }
            Err(e) => {
                log::warn!("Message sync error: {}", e);
                let mut s = status.lock().unwrap();
                s.last_error = Some(e.to_string());
            }
        }
    }

    let mut s = status.lock().unwrap();
    s.running = false;
}

/// Full index: get all joined rooms and create/update conversation notes.
/// Used on first run to populate the vault. Returns number of rooms indexed.
async fn full_index(
    matrix: &MatrixClient,
    parachute: &ParachuteClient,
) -> Result<u64, crate::error::PrismError> {
    let room_ids = matrix.get_joined_rooms().await?;
    log::info!("Message sync: full indexing {} rooms", room_ids.len());

    let mut indexed = 0u64;
    for room_id in &room_ids {
        match index_room(matrix, parachute, room_id).await {
            Ok(true) => indexed += 1,
            Ok(false) => {}
            Err(e) => {
                log::debug!("Message sync: skipping room {}: {}", room_id, e);
            }
        }
    }

    log::info!("Message sync: full index complete, {} rooms indexed", indexed);
    Ok(indexed)
}

/// Incremental sync: use Matrix /sync with since token to get new events.
/// Returns (new_since_token, messages_processed).
async fn incremental_sync(
    matrix: &MatrixClient,
    parachute: &ParachuteClient,
    since: Option<&str>,
) -> Result<(Option<String>, u64), crate::error::PrismError> {
    let resp = matrix.sync(since, Some(SYNC_TIMEOUT_MS)).await?;

    let next_batch = resp.get("next_batch")
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut processed = 0u64;

    // Process room events from the sync response
    if let Some(rooms) = resp.get("rooms").and_then(|r| r.get("join")).and_then(|j| j.as_object()) {
        for (room_id, room_data) in rooms {
            let timeline = match room_data.get("timeline").and_then(|t| t.get("events")).and_then(|e| e.as_array()) {
                Some(events) if !events.is_empty() => events,
                _ => continue,
            };

            // Filter to actual messages (not state events, reactions, etc.)
            let messages: Vec<&serde_json::Value> = timeline.iter()
                .filter(|e| {
                    e.get("type").and_then(|t| t.as_str()) == Some("m.room.message")
                })
                .collect();

            if messages.is_empty() {
                continue;
            }

            // Process new messages for this room
            match process_room_messages(matrix, parachute, room_id, &messages).await {
                Ok(count) => processed += count,
                Err(e) => {
                    log::debug!("Message sync: error processing room {}: {}", room_id, e);
                }
            }
        }
    }

    if processed > 0 {
        log::info!("Message sync: processed {} new messages", processed);
    }

    Ok((next_batch, processed))
}

/// Process new messages for a single room: append to conversation note.
async fn process_room_messages(
    matrix: &MatrixClient,
    parachute: &ParachuteClient,
    room_id: &str,
    messages: &[&serde_json::Value],
) -> Result<u64, crate::error::PrismError> {
    // Get room info
    let state = matrix.get_room_state(room_id).await?;
    let empty = vec![];
    let state_arr = state.as_array().unwrap_or(&empty);

    let room_name = state_arr.iter()
        .find(|e| e["type"] == "m.room.name")
        .and_then(|e| e["content"]["name"].as_str())
        .unwrap_or("Unknown Room")
        .to_string();

    let members: Vec<String> = state_arr.iter()
        .filter(|e| e["type"] == "m.room.member" && e["content"]["membership"] == "join")
        .filter_map(|e| {
            let display = e["content"]["displayname"].as_str();
            let key = e["state_key"].as_str();
            Some(display.unwrap_or(key?).to_string())
        })
        .collect();

    let member_ids: Vec<String> = state_arr.iter()
        .filter(|e| e["type"] == "m.room.member" && e["content"]["membership"] == "join")
        .filter_map(|e| e["state_key"].as_str().map(String::from))
        .collect();

    let platform = crate::clients::matrix::detect_platform(&member_ids);

    // Format new messages
    let new_lines: Vec<String> = messages.iter().filter_map(|msg| {
        let sender = msg["sender"].as_str()?;
        let sender_name = sender.split(':').next()?.trim_start_matches('@');
        let body = msg["content"]["body"].as_str().unwrap_or("");
        let ts = msg["origin_server_ts"].as_i64().unwrap_or(0);
        let time = chrono::DateTime::from_timestamp_millis(ts)
            .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default();
        if body.is_empty() { return None; }
        Some(format!("[{}] {}: {}", time, sender_name, body))
    }).collect();

    if new_lines.is_empty() {
        return Ok(0);
    }

    let count = new_lines.len() as u64;

    // Find existing conversation note by matrixRoomId
    let existing = find_conversation_note(parachute, room_id).await?;

    let last_ts = messages.iter()
        .filter_map(|m| m["origin_server_ts"].as_i64())
        .max()
        .unwrap_or(0);

    if let Some(note) = existing {
        // Append new messages to existing note
        let updated_content = format!("{}\n{}", note.content.trim_end(), new_lines.join("\n"));
        let metadata = serde_json::json!({
            "type": "message-thread",
            "platform": platform,
            "participants": members,
            "matrixRoomId": room_id,
            "lastMessageAt": last_ts,
        });
        parachute.update_note(&note.id, &UpdateNoteParams {
            content: Some(updated_content),
            path: None,
            metadata: Some(metadata),
        }).await?;

        // Link to person notes for participants
        link_participants(parachute, &note.id, &members, &member_ids, &platform).await;
    } else {
        // Create new conversation note
        let content = format!("# {} — {}\n\n{}", room_name, platform_label(&platform), new_lines.join("\n"));
        let path = format!("vault/messages/{}/{}", platform, sanitize_path(&room_name));
        let metadata = serde_json::json!({
            "type": "message-thread",
            "platform": platform,
            "participants": members,
            "matrixRoomId": room_id,
            "lastMessageAt": last_ts,
            "messageCount": count,
        });
        let note = match parachute.create_note(&CreateNoteParams {
            content,
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["message-thread".into()]),
        }).await {
            Ok(note) => note,
            Err(e) => {
                log::debug!("Message sync: create failed for room {}: {}", room_id, e);
                return Ok(0);
            }
        };

        // Link to person notes
        link_participants(parachute, &note.id, &members, &member_ids, &platform).await;
    }

    Ok(count)
}

/// Index a room fully (used for initial sync).
async fn index_room(
    matrix: &MatrixClient,
    parachute: &ParachuteClient,
    room_id: &str,
) -> Result<bool, crate::error::PrismError> {
    let state = matrix.get_room_state(room_id).await?;
    let empty = vec![];
    let state_arr = state.as_array().unwrap_or(&empty);

    let room_name = state_arr.iter()
        .find(|e| e["type"] == "m.room.name")
        .and_then(|e| e["content"]["name"].as_str())
        .unwrap_or("Unknown Room")
        .to_string();

    let members: Vec<String> = state_arr.iter()
        .filter(|e| e["type"] == "m.room.member" && e["content"]["membership"] == "join")
        .filter_map(|e| {
            let display = e["content"]["displayname"].as_str();
            let key = e["state_key"].as_str();
            Some(display.unwrap_or(key?).to_string())
        })
        .collect();

    let member_ids: Vec<String> = state_arr.iter()
        .filter(|e| e["type"] == "m.room.member" && e["content"]["membership"] == "join")
        .filter_map(|e| e["state_key"].as_str().map(String::from))
        .collect();

    let platform = crate::clients::matrix::detect_platform(&member_ids);

    // Get recent messages
    let msgs = matrix.get_messages(room_id, 50, None, "b").await?;
    let msg_arr = msgs["chunk"].as_array().unwrap_or(&empty);

    if msg_arr.is_empty() {
        return Ok(false);
    }

    let mut lines = Vec::new();
    for msg in msg_arr.iter().rev() {
        let sender = msg["sender"].as_str().unwrap_or("?");
        let sender_name = sender.split(':').next().unwrap_or(sender).trim_start_matches('@');
        let body = msg["content"]["body"].as_str().unwrap_or("");
        let ts = msg["origin_server_ts"].as_i64().unwrap_or(0);
        let time = chrono::DateTime::from_timestamp_millis(ts)
            .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default();
        if !body.is_empty() {
            lines.push(format!("[{}] {}: {}", time, sender_name, body));
        }
    }

    if lines.is_empty() {
        return Ok(false);
    }

    let content = format!("# {} — {}\n\n{}", room_name, platform_label(&platform), lines.join("\n"));
    let path = format!("vault/messages/{}/{}", platform, sanitize_path(&room_name));

    let last_ts = msg_arr.iter()
        .filter_map(|m| m["origin_server_ts"].as_i64())
        .max()
        .unwrap_or(0);

    let metadata = serde_json::json!({
        "type": "message-thread",
        "platform": platform,
        "participants": members,
        "matrixRoomId": room_id,
        "lastMessageAt": last_ts,
        "messageCount": lines.len(),
    });

    // Check if note already exists
    let existing = find_conversation_note(parachute, room_id).await?;

    let note_id = if let Some(note) = existing {
        parachute.update_note(&note.id, &UpdateNoteParams {
            content: Some(content),
            path: None,
            metadata: Some(metadata),
        }).await?;
        note.id
    } else {
        match parachute.create_note(&CreateNoteParams {
            content,
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["message-thread".into()]),
        }).await {
            Ok(note) => note.id,
            Err(e) => {
                log::debug!("Message sync: create failed for room {}: {}", room_id, e);
                return Ok(false);
            }
        }
    };

    // Link to person notes
    link_participants(parachute, &note_id, &members, &member_ids, &platform).await;

    Ok(true)
}

/// Find an existing conversation note by Matrix room ID.
async fn find_conversation_note(
    parachute: &ParachuteClient,
    room_id: &str,
) -> Result<Option<crate::models::note::Note>, crate::error::PrismError> {
    // Search message-thread tagged notes for this room ID
    let notes = parachute.list_notes(&ListNotesParams {
        tag: Some("message-thread".into()),
        path: None,
        limit: Some(2000),
        offset: None,
        include_content: true,
    }).await?;

    Ok(notes.into_iter().find(|n| {
        n.metadata.as_ref()
            .and_then(|m| m.get("matrixRoomId"))
            .and_then(|v| v.as_str())
            == Some(room_id)
    }))
}

/// Link conversation note to person notes for all participants.
async fn link_participants(
    parachute: &ParachuteClient,
    note_id: &str,
    display_names: &[String],
    matrix_ids: &[String],
    platform: &str,
) {
    for (i, name) in display_names.iter().enumerate() {
        let matrix_id = matrix_ids.get(i).map(|s| s.as_str());
        // Skip bridge bots
        if let Some(mid) = matrix_id {
            if mid.contains("bot:") || mid.starts_with("@_") {
                continue;
            }
        }
        match person_linker::find_or_create_person(
            parachute, name, None, matrix_id, Some(platform),
        ).await {
            Ok(person_id) => {
                if let Err(e) = person_linker::link_to_person(
                    parachute, note_id, &person_id, "messages-with",
                ).await {
                    log::debug!("Failed to link person {}: {}", name, e);
                }
            }
            Err(e) => {
                log::debug!("Failed to find/create person {}: {}", name, e);
            }
        }
    }
}

fn platform_label(platform: &str) -> &str {
    match platform {
        "whatsapp" => "WhatsApp",
        "telegram" => "Telegram",
        "discord" => "Discord",
        "linkedin" => "LinkedIn",
        "instagram" => "Instagram",
        "messenger" => "Messenger",
        "twitter" => "Twitter",
        "signal" => "Signal",
        _ => "Matrix",
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
