use tauri::State;
use crate::clients::matrix::MatrixClient;
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::{CreateNoteParams, UpdateNoteParams};

/// Index recent Matrix conversations as Parachute notes tagged `message-thread`.
/// This makes messages searchable in the vault and linkable in the knowledge graph.
///
/// For each Matrix room with recent messages:
/// - Creates or updates a Parachute note at `vault/_inbox/messages/{room_name}`
/// - Tags it with `message-thread`
/// - Stores last 20 messages as content
/// - Metadata includes: platform, participants, lastMessageAt, unreadCount
#[tauri::command]
pub async fn index_messages(
    matrix: State<'_, MatrixClient>,
    parachute: State<'_, ParachuteClient>,
) -> Result<serde_json::Value, PrismError> {
    let room_ids = matrix.get_joined_rooms().await?;
    let mut indexed = 0;
    let mut errors = 0;

    for room_id in &room_ids {
        match index_room(&matrix, &parachute, room_id).await {
            Ok(true) => indexed += 1,
            Ok(false) => {} // skipped (no messages)
            Err(e) => {
                log::warn!("Failed to index room {}: {}", room_id, e);
                errors += 1;
            }
        }
    }

    Ok(serde_json::json!({
        "indexed": indexed,
        "errors": errors,
        "total": room_ids.len(),
    }))
}

async fn index_room(
    matrix: &MatrixClient,
    parachute: &ParachuteClient,
    room_id: &str,
) -> Result<bool, PrismError> {
    // Get room state for name and members
    let state = matrix.get_room_state(room_id).await?;
    let empty = vec![];
    let state_arr = state.as_array().unwrap_or(&empty);

    let name = state_arr
        .iter()
        .find(|e| e["type"] == "m.room.name")
        .and_then(|e| e["content"]["name"].as_str())
        .unwrap_or("Unknown Room")
        .to_string();

    let members: Vec<String> = state_arr
        .iter()
        .filter(|e| e["type"] == "m.room.member" && e["content"]["membership"] == "join")
        .filter_map(|e| {
            let display = e["content"]["displayname"].as_str();
            let key = e["state_key"].as_str();
            Some(display.unwrap_or(key?).to_string())
        })
        .collect();

    let platform = crate::clients::matrix::detect_platform(
        &state_arr.iter()
            .filter(|e| e["type"] == "m.room.member" && e["content"]["membership"] == "join")
            .filter_map(|e| e["state_key"].as_str().map(String::from))
            .collect::<Vec<_>>(),
    );

    // Get last 20 messages
    let msgs = matrix.get_messages(room_id, 20, None, "b").await?;
    let msg_arr = msgs["chunk"].as_array().unwrap_or(&empty);

    if msg_arr.is_empty() {
        return Ok(false);
    }

    // Build content from messages
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

    let content = format!("# {}\n\n{}", name, lines.join("\n"));
    let path = format!("vault/_inbox/messages/{}", sanitize_path(&name));

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

    // Check if a note already exists for this room
    let existing = parachute.search(&name, &[], 5).await.ok();
    let existing_note = existing.as_ref().and_then(|notes| {
        notes.iter().find(|n| {
            let meta = n.metadata.as_ref().and_then(|m| m.as_object());
            meta.map(|m| m.get("matrixRoomId").and_then(|v| v.as_str()) == Some(room_id))
                .unwrap_or(false)
        })
    });

    if let Some(note) = existing_note {
        // Update existing note
        let params = UpdateNoteParams {
            content: Some(content),
            path: None,
            metadata: Some(metadata),
        };
        parachute.update_note(&note.id, &params).await?;
    } else {
        // Create new note
        let params = CreateNoteParams {
            content,
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["message-thread".to_string()]),
        };
        parachute.create_note(&params).await?;
    }

    Ok(true)
}

fn sanitize_path(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .replace(' ', "-")
        .to_lowercase()
}
