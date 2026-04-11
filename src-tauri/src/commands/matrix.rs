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

    let messages = data["chunk"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|e| e["type"] == "m.room.message")
                .filter_map(|event| {
                    Some(MatrixMessage {
                        event_id: event["event_id"].as_str()?.to_string(),
                        sender: event["sender"].as_str()?.to_string(),
                        sender_name: None,
                        body: event["content"]["body"].as_str().unwrap_or("").to_string(),
                        msg_type: event["content"]["msgtype"]
                            .as_str()
                            .unwrap_or("m.text")
                            .to_string(),
                        timestamp: event["origin_server_ts"].as_u64()?,
                        is_outgoing: event["sender"].as_str()? == client.user_id(),
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
