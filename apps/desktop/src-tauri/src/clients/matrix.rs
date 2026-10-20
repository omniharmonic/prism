use reqwest::Client;
use crate::error::PrismError;

/// Matrix Client-Server API client for Synapse at localhost:8008.
/// All messaging platforms (WhatsApp, Telegram, Discord, etc.) are bridged
/// into Matrix via mautrix bridges — this single client handles all of them.
pub struct MatrixClient {
    homeserver: String,
    access_token: String,
    user_id: String,
    client: Client,
}

impl MatrixClient {
    pub fn new(homeserver: &str, access_token: &str, user_id: &str) -> Self {
        Self {
            homeserver: homeserver.to_string(),
            access_token: access_token.to_string(),
            user_id: user_id.to_string(),
            client: Client::new(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/_matrix/client/v3{}", self.homeserver, path)
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.access_token)
    }

    /// Long-poll the /sync endpoint for new events
    pub async fn sync(
        &self,
        since: Option<&str>,
        timeout: Option<u64>,
    ) -> Result<serde_json::Value, PrismError> {
        let mut url = self.url("/sync");
        let mut params = vec![];
        if let Some(s) = since {
            params.push(format!("since={}", s));
        }
        if let Some(t) = timeout {
            params.push(format!("timeout={}", t));
        }
        // Only get room messages, state, and read receipts
        params.push("filter={\"room\":{\"timeline\":{\"limit\":20}}}".to_string());
        if !params.is_empty() {
            url = format!("{}?{}", url, params.join("&"));
        }

        let resp = self.client
            .get(&url)
            .header("Authorization", self.auth_header())
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Matrix(format!("sync failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Get joined room IDs
    pub async fn get_joined_rooms(&self) -> Result<Vec<String>, PrismError> {
        let resp = self.client
            .get(self.url("/joined_rooms"))
            .header("Authorization", self.auth_header())
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Matrix(format!("joined_rooms failed: {}", resp.status())));
        }

        let data: serde_json::Value = resp.json().await?;
        let rooms = data["joined_rooms"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        Ok(rooms)
    }

    /// Get room state (name, avatar, members, etc.)
    pub async fn get_room_state(&self, room_id: &str) -> Result<serde_json::Value, PrismError> {
        let url = self.url(&format!("/rooms/{}/state", urlencoding::encode(room_id)));
        let resp = self.client
            .get(&url)
            .header("Authorization", self.auth_header())
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Matrix(format!("room_state failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Get paginated messages from a room
    pub async fn get_messages(
        &self,
        room_id: &str,
        limit: u32,
        from: Option<&str>,
        dir: &str,
    ) -> Result<serde_json::Value, PrismError> {
        let mut url = self.url(&format!("/rooms/{}/messages", urlencoding::encode(room_id)));
        let mut params = vec![
            format!("limit={}", limit),
            format!("dir={}", dir),
        ];
        if let Some(f) = from {
            params.push(format!("from={}", f));
        }
        url = format!("{}?{}", url, params.join("&"));

        let resp = self.client
            .get(&url)
            .header("Authorization", self.auth_header())
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Matrix(format!("messages failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Send a text message to a room
    pub async fn send_message(
        &self,
        room_id: &str,
        body: &str,
        msg_type: &str,
    ) -> Result<String, PrismError> {
        let txn_id = uuid::Uuid::new_v4().to_string();
        let url = self.url(&format!(
            "/rooms/{}/send/m.room.message/{}",
            urlencoding::encode(room_id),
            txn_id,
        ));

        let payload = serde_json::json!({
            "msgtype": msg_type,
            "body": body,
        });

        let resp = self.client
            .put(&url)
            .header("Authorization", self.auth_header())
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Matrix(format!("send failed: {}", resp.status())));
        }

        let data: serde_json::Value = resp.json().await?;
        Ok(data["event_id"].as_str().unwrap_or("").to_string())
    }

    /// Mark a message as read
    pub async fn mark_read(&self, room_id: &str, event_id: &str) -> Result<(), PrismError> {
        let url = self.url(&format!(
            "/rooms/{}/read_markers",
            urlencoding::encode(room_id),
        ));

        let payload = serde_json::json!({
            "m.fully_read": event_id,
            "m.read": event_id,
        });

        let resp = self.client
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Matrix(format!("mark_read failed: {}", resp.status())));
        }
        Ok(())
    }

    /// Search messages across rooms
    pub async fn search(&self, query: &str) -> Result<serde_json::Value, PrismError> {
        let url = self.url("/search");
        let payload = serde_json::json!({
            "search_categories": {
                "room_events": {
                    "search_term": query,
                    "order_by": "recent",
                }
            }
        });

        let resp = self.client
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Matrix(format!("search failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
    }
}

/// Detect which messaging platform a Matrix room is bridged to,
/// based on the bridge bot user ID patterns from mautrix bridges.
pub fn detect_platform(members: &[String]) -> String {
    for member in members {
        if member.contains("@whatsappbot:") || member.starts_with("@whatsapp_") {
            return "whatsapp".to_string();
        }
        if member.contains("@telegrambot:") || member.starts_with("@telegram_") {
            return "telegram".to_string();
        }
        if member.contains("@discordbot:") || member.starts_with("@_discord_") {
            return "discord".to_string();
        }
        if member.contains("@linkedinbot:") || member.starts_with("@linkedin_") {
            return "linkedin".to_string();
        }
        if member.contains("@instagrambot:") || member.starts_with("@instagram_") {
            return "instagram".to_string();
        }
        if member.contains("@facebookbot:") || member.starts_with("@messenger_") {
            return "messenger".to_string();
        }
        if member.contains("@twitterbot:") || member.starts_with("@twitter_") {
            return "twitter".to_string();
        }
        if member.contains("@signalbot:") || member.starts_with("@signal_") {
            return "signal".to_string();
        }
    }
    "matrix".to_string()
}
