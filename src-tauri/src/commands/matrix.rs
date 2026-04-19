use tauri::State;
use crate::clients::matrix::{MatrixClient, detect_platform};
use crate::error::PrismError;
use crate::models::message::*;

#[tauri::command]
pub async fn matrix_get_rooms(
    client: State<'_, MatrixClient>,
) -> Result<Vec<MatrixRoom>, PrismError> {
    let room_ids = client.get_joined_rooms().await?;
    let mut rooms = Vec::new();

    for room_id in &room_ids {
        match build_room_info(&client, room_id).await {
            Ok(room) => rooms.push(room),
            Err(e) => {
                log::warn!("Failed to get room info for {}: {}", room_id, e);
            }
        }
    }

    // Sort by last message timestamp (newest first)
    rooms.sort_by(|a, b| {
        let a_ts = a.last_message.as_ref().map(|m| m.timestamp).unwrap_or(0);
        let b_ts = b.last_message.as_ref().map(|m| m.timestamp).unwrap_or(0);
        b_ts.cmp(&a_ts)
    });

    Ok(rooms)
}

async fn build_room_info(
    client: &MatrixClient,
    room_id: &str,
) -> Result<MatrixRoom, PrismError> {
    let state = client.get_room_state(room_id).await?;
    let empty = vec![];
    let state_arr = state.as_array().unwrap_or(&empty);

    // Extract room name
    let name = state_arr
        .iter()
        .find(|e| e["type"] == "m.room.name")
        .and_then(|e| e["content"]["name"].as_str())
        .unwrap_or("Unknown Room")
        .to_string();

    // Extract members for platform detection
    let members: Vec<String> = state_arr
        .iter()
        .filter(|e| e["type"] == "m.room.member" && e["content"]["membership"] == "join")
        .filter_map(|e| e["state_key"].as_str().map(String::from))
        .collect();

    let platform = detect_platform(&members);
    let member_count = members.len() as u32;
    let is_dm = member_count <= 2;

    // Get last message via /messages endpoint
    let msgs = client.get_messages(room_id, 1, None, "b").await?;
    let last_message = msgs["chunk"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|event| {
            Some(LastMessage {
                sender: event["sender"].as_str()?.to_string(),
                body: event["content"]["body"].as_str().unwrap_or("").to_string(),
                timestamp: event["origin_server_ts"].as_u64()?,
                event_id: event["event_id"].as_str()?.to_string(),
            })
        });

    Ok(MatrixRoom {
        room_id: room_id.to_string(),
        name,
        platform,
        is_dm,
        unread_count: 0, // Updated via /sync in the poller
        last_message,
        avatar_url: None,
        member_count,
    })
}

#[tauri::command]
pub async fn matrix_get_messages(
    client: State<'_, MatrixClient>,
    room_id: String,
    limit: Option<u32>,
    from: Option<String>,
) -> Result<MessageBatch, PrismError> {
    let data = client
        .get_messages(&room_id, limit.unwrap_or(50), from.as_deref(), "b")
        .await?;

    // Fetch room state to resolve display names
    let state = client.get_room_state(&room_id).await.ok();
    let empty_arr = vec![];
    let state_arr = state.as_ref().and_then(|s| s.as_array()).unwrap_or(&empty_arr);

    // Build sender → display name map from room members
    let mut display_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for event in state_arr {
        if event["type"] == "m.room.member" && event["content"]["membership"] == "join" {
            if let (Some(user_id), Some(name)) = (
                event["state_key"].as_str(),
                event["content"]["displayname"].as_str(),
            ) {
                display_names.insert(user_id.to_string(), name.to_string());
            }
        }
    }

    // Detect the user's bridge puppet IDs
    let user_id = client.user_id().to_string();
    let user_display = display_names.get(&user_id).cloned().unwrap_or_default();
    let user_display_lower = user_display.trim().to_lowercase();

    // Pre-compute set of all sender IDs that belong to the user.
    // This includes the Matrix user ID and any bridge ghost whose display name
    // matches (case-insensitive, also matching if one name contains the other).
    let mut self_senders: std::collections::HashSet<String> = std::collections::HashSet::new();
    self_senders.insert(user_id.clone());
    if !user_display_lower.is_empty() {
        for (sender_id, name) in &display_names {
            if sender_id == &user_id { continue; }
            let name_lower = name.trim().to_lowercase();
            if name_lower == user_display_lower
                || name_lower.contains(&user_display_lower)
                || user_display_lower.contains(&name_lower)
            {
                log::debug!("is_user match: {} ({}) matches user display '{}'", sender_id, name, user_display);
                self_senders.insert(sender_id.clone());
            }
        }
    }

    log::debug!(
        "matrix_get_messages room={}: user_id={}, user_display='{}', display_names={:?}, self_senders={:?}",
        room_id, user_id, user_display, display_names, self_senders
    );

    let is_user = |sender: &str| -> bool {
        self_senders.contains(sender)
    };

    let messages = data["chunk"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|e| e["type"] == "m.room.message")
                .filter_map(|event| {
                    let sender = event["sender"].as_str()?.to_string();
                    let sender_name = display_names.get(&sender).cloned();
                    Some(MatrixMessage {
                        event_id: event["event_id"].as_str()?.to_string(),
                        sender: sender.clone(),
                        sender_name,
                        body: event["content"]["body"].as_str().unwrap_or("").to_string(),
                        msg_type: event["content"]["msgtype"]
                            .as_str()
                            .unwrap_or("m.text")
                            .to_string(),
                        timestamp: event["origin_server_ts"].as_u64()?,
                        is_outgoing: is_user(&sender),
                        media_url: event["content"]["url"].as_str().map(String::from),
                        media_info: event["content"]["info"].as_object().map(|o| {
                            serde_json::Value::Object(o.clone())
                        }),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(MessageBatch {
        messages,
        start: data["start"].as_str().map(String::from),
        end: data["end"].as_str().map(String::from),
        has_more: data["end"].as_str().is_some(),
    })
}

#[tauri::command]
pub async fn matrix_send_message(
    client: State<'_, MatrixClient>,
    room_id: String,
    body: String,
    msg_type: Option<String>,
) -> Result<String, PrismError> {
    client.send_message(&room_id, &body, &msg_type.unwrap_or("m.text".to_string())).await
}

#[tauri::command]
pub async fn matrix_get_room_members(
    client: State<'_, MatrixClient>,
    room_id: String,
) -> Result<Vec<MatrixMember>, PrismError> {
    let state = client.get_room_state(&room_id).await?;
    let members = state
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter(|e| e["type"] == "m.room.member" && e["content"]["membership"] == "join")
        .filter_map(|e| {
            Some(MatrixMember {
                user_id: e["state_key"].as_str()?.to_string(),
                display_name: e["content"]["displayname"].as_str().map(String::from),
                avatar_url: e["content"]["avatar_url"].as_str().map(String::from),
            })
        })
        .collect();
    Ok(members)
}

#[tauri::command]
pub async fn matrix_mark_read(
    client: State<'_, MatrixClient>,
    room_id: String,
    event_id: String,
) -> Result<(), PrismError> {
    client.mark_read(&room_id, &event_id).await
}

#[tauri::command]
pub async fn matrix_search_messages(
    client: State<'_, MatrixClient>,
    query: String,
) -> Result<Vec<SearchResult>, PrismError> {
    let data = client.search(&query).await?;

    let results = data["search_categories"]["room_events"]["results"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let event = &r["result"];
                    Some(SearchResult {
                        room_id: event["room_id"].as_str()?.to_string(),
                        room_name: String::new(), // Would need room name lookup
                        event_id: event["event_id"].as_str()?.to_string(),
                        sender: event["sender"].as_str()?.to_string(),
                        body: event["content"]["body"].as_str().unwrap_or("").to_string(),
                        timestamp: event["origin_server_ts"].as_u64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(results)
}
