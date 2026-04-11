use reqwest::Client;
use crate::error::PrismError;

/// Google API client handling Gmail, Calendar, Docs, Slides, Sheets.
/// Gets fresh OAuth2 access tokens via the `gog` CLI tool (already authenticated
/// by the OmniHarmonic agent). This avoids managing tokens directly.
pub struct GoogleClient {
    client: Client,
}

impl GoogleClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }

    /// Get a fresh access token for an account via `gog token <account>`.
    /// The gog CLI handles token refresh automatically.
    fn get_token(&self, account: &str) -> Result<String, PrismError> {
        let output = std::process::Command::new("gog")
            .args(["token", account])
            .output()
            .map_err(|e| PrismError::Auth(format!(
                "Failed to run 'gog token {}': {}. Is gog installed?", account, e
            )))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(PrismError::Auth(format!(
                "gog token failed for {}: {}. Run 'gog auth login' to re-authenticate.",
                account, stderr.trim()
            )));
        }

        let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if token.is_empty() {
            return Err(PrismError::Auth(format!(
                "Empty token from gog for {}. Run 'gog auth login' to re-authenticate.",
                account
            )));
        }

        Ok(token)
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
