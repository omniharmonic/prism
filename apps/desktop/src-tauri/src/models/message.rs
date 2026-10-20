use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MatrixRoom {
    pub room_id: String,
    pub name: String,
    pub platform: String,
    pub is_dm: bool,
    pub unread_count: u32,
    pub last_message: Option<LastMessage>,
    pub avatar_url: Option<String>,
    pub member_count: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LastMessage {
    pub sender: String,
    pub body: String,
    pub timestamp: u64,
    pub event_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MatrixMessage {
    pub event_id: String,
    pub sender: String,
    pub sender_name: Option<String>,
    pub body: String,
    pub msg_type: String,
    pub timestamp: u64,
    pub is_outgoing: bool,
    pub media_url: Option<String>,
    pub media_info: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MessageBatch {
    pub messages: Vec<MatrixMessage>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub has_more: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MatrixMember {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SearchResult {
    pub room_id: String,
    pub room_name: String,
    pub event_id: String,
    pub sender: String,
    pub body: String,
    pub timestamp: u64,
}
