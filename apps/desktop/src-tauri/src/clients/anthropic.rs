use serde::Deserialize;
use crate::clients::claude_args::{
    build_claude_args, ClaudeRunner, ClaudeUse, OutputFormat, Persistence, RunMcpConfig, VaultMcpTarget,
};
use crate::error::PrismError;

/// Claude Code CLI client — spawns hardened `claude -p` processes for the
/// interactive agent features (edit / chat / transform / generate).
///
/// Every spawn goes through [`crate::clients::claude_args`] (Arch v2 WP0.1d): no
/// built-in tools, ONLY the active vault's MCP (a per-run 0600 config), an
/// explicit per-feature tool allowlist under `--permission-mode dontAsk`, no
/// settings sources, a fixed EMPTY cwd under the app-data dir, and an env
/// allowlist. Chat keeps multi-turn continuity via `--session-id`/`--resume`.
pub struct ClaudeClient {
    runner: ClaudeRunner,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ClaudeJsonResponse {
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub is_error: bool,
}

impl ClaudeClient {
    pub fn new() -> Self {
        Self { runner: ClaudeRunner::from_host() }
    }

    /// Run a one-shot claude command in print mode (text output, no session).
    /// `use_` picks the tool allowlist (edit/transform/generate are read-only).
    pub async fn run(
        &self,
        use_: ClaudeUse,
        prompt: &str,
        model: &str,
        timeout_secs: u64,
    ) -> Result<String, PrismError> {
        // Dropped when this fn returns (any path) → the token file is deleted.
        let mcp = RunMcpConfig::create(&VaultMcpTarget::active()?)?;
        let args = build_claude_args(use_, model, OutputFormat::Text, &Persistence::OneShot, mcp.path(), prompt)?;
        let mut cmd = self.runner.command(&args)?;

        // kill_on_drop: a timeout drops the output future and kills the child.
        let result = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output())
            .await
            .map_err(|_| PrismError::Agent(format!("Claude timed out after {}s", timeout_secs)))?
            .map_err(|e| PrismError::Agent(format!("Failed to spawn claude: {}", e)))?;

        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            return Err(PrismError::Agent(format!(
                "Claude exited {}: {}",
                result.status.code().unwrap_or(-1),
                stderr.chars().take(500).collect::<String>()
            )));
        }

        Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
    }

    /// Run claude (chat allowlist) with JSON output and session continuity.
    /// `session_id = None` starts a new session under a freshly minted uuid
    /// (`--session-id`); a known id is `--resume`d. Sessions are tracked per
    /// context (per document or global) by the caller. The CLI keeps the
    /// transcript under `~/.claude/projects/<agent-cwd slug>/`, so the cwd itself
    /// stays empty — and every turn must run from that same cwd.
    pub async fn run_conversational(
        &self,
        prompt: &str,
        model: &str,
        session_id: Option<&str>,
        timeout_secs: u64,
    ) -> Result<ClaudeJsonResponse, PrismError> {
        let persistence = match session_id {
            Some(sid) => Persistence::Resume(sid.to_string()),
            None => Persistence::NewSession(uuid::Uuid::new_v4().to_string()),
        };
        let mcp = RunMcpConfig::create(&VaultMcpTarget::active()?)?;
        let args = build_claude_args(ClaudeUse::Chat, model, OutputFormat::Json, &persistence, mcp.path(), prompt)?;
        let mut cmd = self.runner.command(&args)?;

        let result = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output())
            .await
            .map_err(|_| PrismError::Agent(format!("Claude timed out after {}s", timeout_secs)))?
            .map_err(|e| PrismError::Agent(format!("Failed to spawn claude: {}", e)))?;

        let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();

        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            return Ok(ClaudeJsonResponse {
                result: format!("Error: {}", stderr.chars().take(500).collect::<String>()),
                session_id: None,
                is_error: true,
            });
        }

        // Try to parse as JSON; fall back to plain text
        match serde_json::from_str::<ClaudeJsonResponse>(&stdout) {
            Ok(resp) => Ok(resp),
            Err(_) => Ok(ClaudeJsonResponse {
                result: stdout,
                session_id: None,
                is_error: false,
            }),
        }
    }
}
