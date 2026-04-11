use reqwest::Client;
use crate::error::PrismError;

/// Google API client handling Gmail, Calendar, Docs, Slides, Sheets.
/// Uses OAuth2 access tokens stored in the macOS Keychain.
pub struct GoogleClient {
    client: Client,
    /// Access tokens keyed by account email
    tokens: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl GoogleClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            tokens: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Set an access token for an account (called after OAuth2 flow or token refresh)
    pub fn set_token(&self, account: &str, token: &str) {
        self.tokens.lock().unwrap().insert(account.to_string(), token.to_string());
    }

    fn get_token(&self, account: &str) -> Result<String, PrismError> {
        self.tokens
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .ok_or_else(|| PrismError::Auth(format!("No token for account: {}", account)))
    }

    // ─── Gmail ───────────────────────────────────────────────

    /// List Gmail threads with optional search query
    pub async fn gmail_list_threads(
        &self,
        account: &str,
        query: Option<&str>,
        max_results: u32,
        page_token: Option<&str>,
    ) -> Result<serde_json::Value, PrismError> {
        let token = self.get_token(account)?;
        let mut url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults={}",
            max_results,
        );
        if let Some(q) = query {
            url.push_str(&format!("&q={}", urlencoding::encode(q)));
        }
        if let Some(pt) = page_token {
            url.push_str(&format!("&pageToken={}", pt));
        }

        let resp = self.client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!("gmail list_threads: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Get a full Gmail thread with all messages
    pub async fn gmail_get_thread(
        &self,
        account: &str,
        thread_id: &str,
    ) -> Result<serde_json::Value, PrismError> {
        let token = self.get_token(account)?;
        let url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/threads/{}?format=full",
            thread_id,
        );

        let resp = self.client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!("gmail get_thread: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Send an email via Gmail API
    pub async fn gmail_send(
        &self,
        account: &str,
        raw_message: &str,
    ) -> Result<serde_json::Value, PrismError> {
        let token = self.get_token(account)?;
        let url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(raw_message.as_bytes());

        let payload = serde_json::json!({ "raw": encoded });

        let resp = self.client
            .post(url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!("gmail send: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Archive a thread (remove INBOX label)
    pub async fn gmail_archive(
        &self,
        account: &str,
        thread_id: &str,
    ) -> Result<(), PrismError> {
        let token = self.get_token(account)?;
        let url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/threads/{}/modify",
            thread_id,
        );

        let payload = serde_json::json!({
            "removeLabelIds": ["INBOX"],
        });

        let resp = self.client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!("gmail archive: {}", resp.status())));
        }
        Ok(())
    }

    /// Modify labels on a thread
    pub async fn gmail_label(
        &self,
        account: &str,
        thread_id: &str,
        add_labels: &[String],
        remove_labels: &[String],
    ) -> Result<(), PrismError> {
        let token = self.get_token(account)?;
        let url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/threads/{}/modify",
            thread_id,
        );

        let payload = serde_json::json!({
            "addLabelIds": add_labels,
            "removeLabelIds": remove_labels,
        });

        let resp = self.client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!("gmail label: {}", resp.status())));
        }
        Ok(())
    }
}

/// Build a raw RFC 2822 email message for sending via Gmail API
pub fn build_raw_email(
    from: &str,
    to: &[String],
    cc: &[String],
    subject: &str,
    body: &str,
    in_reply_to: Option<&str>,
) -> String {
    let mut headers = vec![
        format!("From: {}", from),
        format!("To: {}", to.join(", ")),
        format!("Subject: {}", subject),
        "MIME-Version: 1.0".to_string(),
        "Content-Type: text/plain; charset=utf-8".to_string(),
    ];

    if !cc.is_empty() {
        headers.push(format!("Cc: {}", cc.join(", ")));
    }

    if let Some(reply_to) = in_reply_to {
        headers.push(format!("In-Reply-To: {}", reply_to));
        headers.push(format!("References: {}", reply_to));
    }

    format!("{}\r\n\r\n{}", headers.join("\r\n"), body)
}

use base64::Engine;

// ─── Calendar ────────────────────────────────────────────

impl GoogleClient {
    pub async fn calendar_list_events(
        &self,
        account: &str,
        time_min: &str,
        time_max: &str,
        calendar_id: &str,
    ) -> Result<serde_json::Value, PrismError> {
        let token = self.get_token(account)?;
        let url = format!(
            "https://www.googleapis.com/calendar/v3/calendars/{}/events?timeMin={}&timeMax={}&singleEvents=true&orderBy=startTime&maxResults=50",
            urlencoding::encode(calendar_id),
            urlencoding::encode(time_min),
            urlencoding::encode(time_max),
        );

        let resp = self.client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!("calendar list: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn calendar_create_event(
        &self,
        account: &str,
        calendar_id: &str,
        event: &serde_json::Value,
    ) -> Result<serde_json::Value, PrismError> {
        let token = self.get_token(account)?;
        let url = format!(
            "https://www.googleapis.com/calendar/v3/calendars/{}/events?conferenceDataVersion=1",
            urlencoding::encode(calendar_id),
        );

        let resp = self.client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(event)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!("calendar create: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn calendar_update_event(
        &self,
        account: &str,
        calendar_id: &str,
        event_id: &str,
        event: &serde_json::Value,
    ) -> Result<serde_json::Value, PrismError> {
        let token = self.get_token(account)?;
        let url = format!(
            "https://www.googleapis.com/calendar/v3/calendars/{}/events/{}",
            urlencoding::encode(calendar_id),
            event_id,
        );

        let resp = self.client
            .patch(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(event)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!("calendar update: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn calendar_delete_event(
        &self,
        account: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<(), PrismError> {
        let token = self.get_token(account)?;
        let url = format!(
            "https://www.googleapis.com/calendar/v3/calendars/{}/events/{}",
            urlencoding::encode(calendar_id),
            event_id,
        );

        let resp = self.client
            .delete(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!("calendar delete: {}", resp.status())));
        }
        Ok(())
    }
}
