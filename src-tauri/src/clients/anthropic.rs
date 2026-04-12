use std::collections::HashMap;
use std::path::PathBuf;
use serde::Deserialize;
use crate::error::PrismError;

/// Claude Code CLI client — spawns `claude` processes for AI operations.
///
/// This mirrors how the OmniHarmonic agent works:
/// - Uses `claude -p` (print mode) for non-interactive output
/// - Runs in the Prism project directory to pick up `.mcp.json` (Parachute MCP)
/// - Has access to vault data via the parachute-vault MCP tools
/// - Uses `--resume` for multi-turn conversations with session continuity
/// - Strips CLAUDECODE env var to avoid nested session detection
///
/// The Parachute MCP connection means Claude can:
/// - Search notes via `mcp__parachute-vault__search-notes`
/// - Read notes via `mcp__parachute-vault__get-note`
/// - Create/update notes via `mcp__parachute-vault__create-note` / `update-note`
/// - Traverse the knowledge graph via `mcp__parachute-vault__traverse-links`
/// - Query by tags via `mcp__parachute-vault__search-notes` with tag filters
/// - Use semantic search via `mcp__parachute-vault__semantic-search`
pub struct ClaudeClient {
    claude_bin: String,
    /// Prism project root — where .mcp.json lives, so Claude gets Parachute MCP access
    prism_root: PathBuf,
    /// Omniharmonic project root — for access to CLAUDE.md agent context
    omniharmonic_root: PathBuf,
    env: HashMap<String, String>,
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
    pub fn new(prism_root: PathBuf, omniharmonic_root: PathBuf) -> Self {
        // Resolve claude binary
        let claude_bin = std::process::Command::new("which")
            .arg("claude")
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
                let home = dirs::home_dir().unwrap_or_default();
                let npm_global = home.join(".npm-global/bin/claude");
                if npm_global.exists() {
                    return npm_global.to_string_lossy().to_string();
                }
                "claude".to_string()
            });

        // Build clean env: strip CLAUDECODE to avoid nested session detection
        let env: HashMap<String, String> = std::env::vars()
            .filter(|(k, _)| k != "CLAUDECODE")
            .collect();

        Self {
            claude_bin,
            prism_root,
            omniharmonic_root,
            env,
        }
    }

    /// Run a claude command in print mode.
    /// Runs in the Prism project directory so .mcp.json is picked up,
    /// giving Claude access to Parachute vault MCP tools.
    pub async fn run(
        &self,
        prompt: &str,
        model: &str,
        timeout_secs: u64,
    ) -> Result<String, PrismError> {
        let mcp_config = self.prism_root.join(".mcp.json");
        let mut args = vec![
            "-p".to_string(),
            "--model".to_string(),
            model.to_string(),
            "--dangerously-skip-permissions".to_string(),
        ];
        if mcp_config.exists() {
            args.push("--mcp-config".to_string());
            args.push(mcp_config.to_string_lossy().to_string());
        }
        // Use -- to separate flags from prompt (prevents --mcp-config from consuming it)
        args.push("--".to_string());
        args.push(prompt.to_string());

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            tokio::process::Command::new(&self.claude_bin)
                .args(&args)
                .current_dir(&self.prism_root)
                .envs(&self.env)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output(),
        )
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

    /// Run claude with JSON output and optional session resumption.
    /// Sessions are maintained per-context (per document or global) for
    /// multi-turn conversations.
    pub async fn run_conversational(
        &self,
        prompt: &str,
        model: &str,
        session_id: Option<&str>,
        timeout_secs: u64,
    ) -> Result<ClaudeJsonResponse, PrismError> {
        let mcp_config = self.prism_root.join(".mcp.json");
        let mut args = vec![
            "-p".to_string(),
            "--model".to_string(),
            model.to_string(),
            "--dangerously-skip-permissions".to_string(),
            "--output-format".to_string(),
            "json".to_string(),
        ];
        if mcp_config.exists() {
            args.push("--mcp-config".to_string());
            args.push(mcp_config.to_string_lossy().to_string());
        }

        if let Some(sid) = session_id {
            args.push("--resume".to_string());
            args.push(sid.to_string());
        }

        // Use -- to separate flags from prompt
        args.push("--".to_string());
        args.push(prompt.to_string());

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            tokio::process::Command::new(&self.claude_bin)
                .args(&args)
                .current_dir(&self.prism_root)
                .envs(&self.env)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output(),
        )
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
