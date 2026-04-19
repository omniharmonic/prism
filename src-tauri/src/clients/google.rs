use crate::error::PrismError;

/// Google API client that delegates ALL operations to the `gog` CLI.
/// This avoids managing OAuth tokens directly — gog handles auth via its keyring.
/// Same pattern as the omniharmonic agent.
pub struct GoogleClient {
    gog_bin: String,
}

impl Clone for GoogleClient {
    fn clone(&self) -> Self {
        Self {
            gog_bin: self.gog_bin.clone(),
        }
    }
}

impl GoogleClient {
    pub fn new() -> Self {
        let gog_bin = std::process::Command::new("which")
            .arg("gog")
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| {
                // In production builds, PATH is minimal and `which` fails.
                // Check common installation paths as fallbacks.
                let home = dirs::home_dir().unwrap_or_default();
                let candidates = [
                    "/opt/homebrew/bin/gog".to_string(),
                    "/usr/local/bin/gog".to_string(),
                    format!("{}/go/bin/gog", home.display()),
                    format!("{}/.local/bin/gog", home.display()),
                ];
                for path in &candidates {
                    if std::path::Path::new(path).exists() {
                        return path.clone();
                    }
                }
                "gog".to_string()
            });

        Self { gog_bin }
    }

    /// Run a gog command and return JSON output
    fn run_gog(&self, args: &[&str], account: &str) -> Result<serde_json::Value, PrismError> {
        let mut cmd_args: Vec<&str> = args.to_vec();
        cmd_args.push("--account");
        cmd_args.push(account);
        cmd_args.push("--json");

        let output = std::process::Command::new(&self.gog_bin)
            .args(&cmd_args)
            .output()
            .map_err(|e| PrismError::Google(format!("Failed to run gog: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(PrismError::Google(format!(
                "gog {} failed: {} {}",
                args.join(" "),
                stderr.trim(),
                stdout.trim(),
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str(stdout.trim())
            .map_err(|e| PrismError::Google(format!("Failed to parse gog output: {}", e)))
    }

    /// Run a gog command and return raw text output
    fn run_gog_text(&self, args: &[&str], account: &str) -> Result<String, PrismError> {
        let mut cmd_args: Vec<&str> = args.to_vec();
        cmd_args.push("--account");
        cmd_args.push(account);

        let output = std::process::Command::new(&self.gog_bin)
            .args(&cmd_args)
            .output()
            .map_err(|e| PrismError::Google(format!("Failed to run gog: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(PrismError::Google(format!("gog failed: {}", stderr.trim())));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    /// Check if gog is authenticated for an account
    pub fn check_auth(&self, account: &str) -> bool {
        self.run_gog_text(&["gmail", "messages", "search", "in:inbox", "--max", "1"], account).is_ok()
    }

    // ─── Gmail ───────────────────────────────────────────────

    pub fn gmail_list_threads(
        &self,
        account: &str,
        query: Option<&str>,
        max_results: u32,
    ) -> Result<serde_json::Value, PrismError> {
        let max_str = max_results.to_string();
        let mut args = vec!["gmail", "messages", "search"];
        if let Some(q) = query {
            args.push(q);
        } else {
            args.push("in:inbox");
        }
        args.push("--max");
        args.push(&max_str);
        args.push("--include-body");
        self.run_gog(&args, account)
    }

    /// Fetch a thread by ID. Uses `gog gmail thread get` which returns
    /// `{ thread: { messages: [...] } }` in raw Gmail API format.
    pub fn gmail_get_thread(
        &self,
        account: &str,
        thread_id: &str,
    ) -> Result<serde_json::Value, PrismError> {
        self.run_gog(&["gmail", "thread", "get", thread_id], account)
    }

    pub fn gmail_send(
        &self,
        account: &str,
        to: &str,
        subject: &str,
        body: &str,
        thread_id: Option<&str>,
    ) -> Result<serde_json::Value, PrismError> {
        let mut args = vec!["gmail", "send", "--to", to, "--subject", subject, "--body", body];
        if let Some(tid) = thread_id {
            args.push("--thread-id");
            args.push(tid);
        }
        self.run_gog(&args, account)
    }

    // ─── Calendar ────────────────────────────────────────────

    pub fn calendar_list_events(
        &self,
        account: &str,
        max_results: u32,
    ) -> Result<serde_json::Value, PrismError> {
        let max_str = max_results.to_string();
        self.run_gog(&["calendar", "list", "--max", &max_str], account)
    }

    /// List calendar events within a specific date range.
    /// `from` and `to` are ISO date strings (e.g., "2026-04-07").
    pub fn calendar_list_events_range(
        &self,
        account: &str,
        from: &str,
        to: &str,
        max_results: u32,
    ) -> Result<serde_json::Value, PrismError> {
        let max_str = max_results.to_string();
        self.run_gog(&["calendar", "list", "--from", from, "--to", to, "--max", &max_str], account)
    }

    pub fn calendar_create_event(
        &self,
        account: &str,
        summary: &str,
        start: &str,
        end: &str,
        description: Option<&str>,
        location: Option<&str>,
        attendees: Option<&str>,
    ) -> Result<serde_json::Value, PrismError> {
        let mut args = vec!["calendar", "create", "primary", "--summary", summary, "--from", start, "--to", end];
        if let Some(desc) = description {
            args.push("--description");
            args.push(desc);
        }
        if let Some(loc) = location {
            args.push("--location");
            args.push(loc);
        }
        if let Some(att) = attendees {
            args.push("--attendees");
            args.push(att);
        }
        self.run_gog(&args, account)
    }

    pub fn calendar_update_event(
        &self,
        account: &str,
        event_id: &str,
        summary: Option<&str>,
        start: Option<&str>,
        end: Option<&str>,
        description: Option<&str>,
        location: Option<&str>,
        attendees: Option<&str>,
    ) -> Result<serde_json::Value, PrismError> {
        let mut args = vec!["calendar", "update", "primary", event_id];
        if let Some(s) = summary { args.push("--summary"); args.push(s); }
        if let Some(s) = start { args.push("--from"); args.push(s); }
        if let Some(s) = end { args.push("--to"); args.push(s); }
        if let Some(s) = description { args.push("--description"); args.push(s); }
        if let Some(s) = location { args.push("--location"); args.push(s); }
        if let Some(s) = attendees { args.push("--attendees"); args.push(s); }
        self.run_gog(&args, account)
    }

    pub fn calendar_delete_event(
        &self,
        account: &str,
        event_id: &str,
    ) -> Result<serde_json::Value, PrismError> {
        self.run_gog(&["calendar", "delete", "primary", event_id, "--send-updates", "all"], account)
    }

    // ─── Google Docs ─────────────────────────────────────────

    /// Create a new Google Doc and return its ID
    pub fn docs_create(&self, account: &str, title: &str) -> Result<String, PrismError> {
        let data = self.run_gog(&["docs", "create", title], account)?;
        // gog returns { "file": { "id": "...", ... } }
        data.get("file").and_then(|f| f.get("id"))
            .or_else(|| data.get("documentId"))
            .or_else(|| data.get("id"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| PrismError::Google(format!("No doc ID in response: {}", data)))
    }

    /// Write content to a Google Doc (replaces all content)
    pub fn docs_write(&self, account: &str, doc_id: &str, content: &str) -> Result<(), PrismError> {
        self.run_gog_text(&["docs", "write", doc_id, content, "--replace"], account)?;
        Ok(())
    }

    /// Read a Google Doc as plain text
    pub fn docs_read(&self, account: &str, doc_id: &str) -> Result<String, PrismError> {
        self.run_gog_text(&["docs", "cat", doc_id], account)
    }

    /// Get Google Doc metadata (for modification time check)
    pub fn docs_info(&self, account: &str, doc_id: &str) -> Result<serde_json::Value, PrismError> {
        self.run_gog(&["docs", "info", doc_id], account)
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
