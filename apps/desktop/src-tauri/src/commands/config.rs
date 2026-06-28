use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::error::PrismError;

/// Default vault name when the config predates the `parachute_vault` field.
fn default_vault_name() -> String {
    "default".into()
}

/// Default base URL for the local OpenAI-compatible AI server.
/// LM Studio serves its OpenAI-compatible API at port 1234 under `/v1`.
/// (Ollama's equivalent is `http://localhost:11434/v1`.)
fn default_local_ai_base_url() -> String {
    "http://localhost:1234/v1".into()
}

/// Default provider for background (recurring) skill dispatches.
/// `"claude"` spawns `claude -p` (legacy); `"local"` routes to the
/// OpenAI-compatible local server. Defaults to `"claude"` so existing
/// installs keep their current behavior until the user opts in.
fn default_background_skill_provider() -> String {
    "claude".into()
}

/// Default Prism Server collab WebSocket endpoint (same machine, default port).
fn default_collab_url() -> String {
    "ws://localhost:8787/collab".into()
}

/// App configuration — loaded from prism-config.json, falling back to
/// omniharmonic .env, falling back to defaults.
/// Serializable so it can be persisted and updated at runtime.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    // Core services
    pub matrix_homeserver: String,
    pub matrix_user: String,
    pub matrix_access_token: String,
    pub matrix_device_id: String,
    pub notion_api_key: String,
    pub google_account_primary: String,
    pub google_account_agent: String,
    pub anthropic_api_key: String,
    pub parachute_url: String,
    #[serde(default)]
    pub parachute_api_key: String,
    /// Vault name for the scoped REST/MCP URLs (`/vault/{name}/...`). Almost
    /// always "default" for a single-vault install. Custom serde default so
    /// pre-existing config files (written before this field existed) resolve
    /// to "default" rather than an empty string.
    #[serde(default = "default_vault_name")]
    pub parachute_vault: String,

    // Transcript data sources
    #[serde(default)]
    pub fathom_api_key: String,
    #[serde(default)]
    pub meetily_db_path: String,
    #[serde(default)]
    pub readai_api_key: String,
    #[serde(default)]
    pub otter_api_key: String,
    #[serde(default)]
    pub fireflies_api_key: String,

    // ── Local AI (OpenAI-compatible: LM Studio, Ollama /v1, llama.cpp, vLLM) ──
    /// Base URL of the local OpenAI-compatible server, including the `/v1` path
    /// segment (e.g. `http://localhost:1234/v1`). Used for recurring-skill
    /// processing and as a local provider in the model router.
    #[serde(default = "default_local_ai_base_url")]
    pub local_ai_base_url: String,
    /// Model identifier to request from the local server (the id it exposes via
    /// `/v1/models`, e.g. `"qwen2.5-14b-instruct"`). Empty = none configured.
    #[serde(default)]
    pub local_ai_model: String,
    /// Which provider runs background (recurring) skills: `"claude"` (spawn
    /// `claude -p`, legacy) or `"local"` (OpenAI-compatible server, with a
    /// `claude -p` fallback when the local server is unavailable).
    #[serde(default = "default_background_skill_provider")]
    pub background_skill_provider: String,

    // ── Real-time collaboration (Prism Server /collab) ──
    /// WebSocket URL of the Prism Server's Hocuspocus endpoint. The desktop app
    /// connects here so its edits sync live with web/phone sessions. Defaults to
    /// the local server; point elsewhere if the Prism Server runs on another host.
    #[serde(default = "default_collab_url")]
    pub collab_url: String,
    /// Dedicated owner token presented to /collab (must match the Prism Server's
    /// COLLAB_TOKEN). Kept separate from the vault token. Empty = collab disabled
    /// on desktop (falls back to the offline autosave editor).
    #[serde(default)]
    pub collab_token: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            matrix_homeserver: "http://localhost:8008".into(),
            matrix_user: "@prism:localhost".into(),
            matrix_access_token: String::new(),
            matrix_device_id: "PRISM".into(),
            notion_api_key: String::new(),
            google_account_primary: String::new(),
            google_account_agent: String::new(),
            anthropic_api_key: String::new(),
            parachute_url: "http://localhost:1940".into(),
            parachute_api_key: String::new(),
            parachute_vault: "default".into(),
            fathom_api_key: String::new(),
            meetily_db_path: String::new(),
            readai_api_key: String::new(),
            otter_api_key: String::new(),
            fireflies_api_key: String::new(),
            local_ai_base_url: default_local_ai_base_url(),
            local_ai_model: String::new(),
            background_skill_provider: default_background_skill_provider(),
            collab_url: default_collab_url(),
            collab_token: String::new(),
        }
    }
}

impl AppConfig {
    /// Load config from prism-config.json, falling back to defaults.
    ///
    /// On first launch the config file won't exist — we create it with defaults
    /// so Settings UI always has a file to read/write. Users configure
    /// everything through Settings; no external .env required.
    pub fn load() -> Result<Self, PrismError> {
        let config_path = Self::config_path();
        log::debug!("Loading config from {:?} (exists: {})", config_path, config_path.exists());

        // Try loading existing config
        if config_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                if let Ok(mut config) = serde_json::from_str::<AppConfig>(&content) {
                    // Try macOS Keychain for Anthropic key if not in config
                    if config.anthropic_api_key.is_empty() {
                        if let Some(key) = try_keychain_anthropic() {
                            config.anthropic_api_key = key;
                        }
                    }
                    // Auto-discover Meetily if not configured
                    if config.meetily_db_path.is_empty() {
                        config.meetily_db_path = auto_discover_meetily().unwrap_or_default();
                    }
                    return Ok(config);
                }
            }
        }

        // First launch — check for legacy omniharmonic .env to migrate from
        log::info!("No existing config found, checking for legacy .env to migrate");
        let mut config = Self::default();
        if let Some(env_path) = Self::find_legacy_env() {
            if let Ok(vars) = load_env_file(&env_path) {
                log::info!("Migrating config from legacy .env at {:?}", env_path);
                if let Some(v) = vars.get("MATRIX_HOMESERVER") { config.matrix_homeserver = v.clone(); }
                if let Some(v) = vars.get("MATRIX_USER") { config.matrix_user = v.clone(); }
                if let Some(v) = vars.get("MATRIX_ACCESS_TOKEN") { config.matrix_access_token = v.clone(); }
                if let Some(v) = vars.get("MATRIX_DEVICE_ID") { config.matrix_device_id = v.clone(); }
                if let Some(v) = vars.get("NOTION_API_KEY") { config.notion_api_key = v.clone(); }
                if let Some(v) = vars.get("GOOGLE_ACCOUNT_BENJAMIN").or(vars.get("GOOGLE_ACCOUNT_PRIMARY")) {
                    config.google_account_primary = v.clone();
                }
                if let Some(v) = vars.get("GOOGLE_ACCOUNT_AGENT") { config.google_account_agent = v.clone(); }
                if let Some(v) = vars.get("PARACHUTE_URL") { config.parachute_url = v.clone(); }
                if let Some(v) = vars.get("PARACHUTE_API_KEY") { config.parachute_api_key = v.clone(); }
                if let Some(v) = vars.get("PARACHUTE_VAULT") { config.parachute_vault = v.clone(); }
                if let Some(v) = vars.get("FATHOM_API_KEY") { config.fathom_api_key = v.clone(); }
                if let Some(v) = vars.get("MEETILY_DB_PATH") { config.meetily_db_path = v.clone(); }
                if let Some(v) = vars.get("COLLAB_URL") { config.collab_url = v.clone(); }
                if let Some(v) = vars.get("COLLAB_TOKEN") { config.collab_token = v.clone(); }
            }
        }

        // Try keychain for Anthropic key
        if config.anthropic_api_key.is_empty() {
            if let Some(key) = try_keychain_anthropic() {
                config.anthropic_api_key = key;
            }
        }

        // Auto-discover Meetily
        if config.meetily_db_path.is_empty() {
            config.meetily_db_path = auto_discover_meetily().unwrap_or_default();
        }

        // Always persist so the file exists for future launches
        match config.save() {
            Ok(_) => log::info!("Created initial config at {:?}", config_path),
            Err(e) => log::error!("Failed to save initial config to {:?}: {}", config_path, e),
        }

        Ok(config)
    }

    /// Save config to prism-config.json
    pub fn save(&self) -> Result<(), PrismError> {
        let path = Self::config_path();
        log::debug!("Saving config to {:?}", path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| PrismError::Io(format!("Create config dir {:?}: {}", parent, e)))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| PrismError::Other(format!("Serialize config: {}", e)))?;
        std::fs::write(&path, json)
            .map_err(|e| PrismError::Io(format!("Write config to {:?}: {}", path, e)))?;
        Ok(())
    }

    fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
            .join("prism")
            .join("prism-config.json")
    }

    /// Search common locations for a legacy omniharmonic .env file (one-time migration).
    fn find_legacy_env() -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        let candidates = [
            "iCloud Drive (Archive)/Documents/cursor projects/omniharmonic_agent/.env",
            "omniharmonic_agent/.env",
            "Documents/omniharmonic_agent/.env",
        ];
        for candidate in &candidates {
            let path = home.join(candidate);
            if path.exists() {
                return Some(path);
            }
        }
        None
    }
}

fn load_env_file(path: &std::path::Path) -> Result<HashMap<String, String>, PrismError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| PrismError::Io(format!("Read .env: {}", e)))?;
    let mut vars = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if let Some((key, value)) = line.split_once('=') {
            vars.insert(key.trim().to_string(), value.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    Ok(vars)
}

/// Auto-discover Meetily's SQLite database on macOS.
fn auto_discover_meetily() -> Option<String> {
    let home = dirs::home_dir()?;
    let candidates = [
        "Library/Application Support/com.meetily.ai/meeting_minutes.sqlite",
        "Library/Application Support/ai.meetily.app/meeting_minutes.sqlite",
        "Library/Application Support/meetily/meeting_minutes.sqlite",
        "Library/Application Support/com.meetily.ai/meetily.db",
    ];
    for candidate in &candidates {
        let path = home.join(candidate);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

fn try_keychain_anthropic() -> Option<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "com.prism.anthropic", "-w"])
        .output().ok()?;
    if output.status.success() {
        let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !key.is_empty() { return Some(key); }
    }
    None
}

// ─── Tauri Commands ──────────────────────────────────

/// Real-time collab connection config for the webview: the Prism Server's
/// WebSocket URL and the dedicated owner token. The token is intentionally
/// surfaced to the (trusted) webview ONLY for the local collab connection — it is
/// the dedicated COLLAB_TOKEN, never the vault token. `enabled` is false when no
/// token is configured, so the UI stays on the offline editor.
#[tauri::command]
pub fn get_collab_config(
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    Ok(serde_json::json!({
        "url": config.collab_url,
        "token": config.collab_token,
        "enabled": !config.collab_token.is_empty(),
    }))
}

#[tauri::command]
pub fn get_config_status(
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    // Read fresh from disk so just-saved keys report accurately (see get_full_config).
    let config = AppConfig::load().unwrap_or_else(|_| config.inner().clone());
    Ok(serde_json::json!({
        "matrix": {
            "configured": !config.matrix_access_token.is_empty(),
            "homeserver": config.matrix_homeserver,
            "user": config.matrix_user,
        },
        "notion": {
            "configured": !config.notion_api_key.is_empty(),
        },
        "anthropic": {
            "configured": !config.anthropic_api_key.is_empty(),
        },
        "google": {
            "primary": config.google_account_primary,
            "agent": config.google_account_agent,
        },
        "parachute": {
            "url": config.parachute_url,
            "configured": !config.parachute_api_key.is_empty(),
        },
    }))
}

#[tauri::command]
pub fn set_anthropic_key(key: String) -> Result<(), PrismError> {
    let status = std::process::Command::new("security")
        .args(["add-generic-password", "-s", "com.prism.anthropic", "-a", "default", "-w", &key, "-U"])
        .status()
        .map_err(|e| PrismError::Other(format!("Keychain: {}", e)))?;
    if !status.success() {
        return Err(PrismError::Auth("Failed to store in Keychain".into()));
    }
    Ok(())
}

/// Health snapshot of the *effective* (currently configured) Parachute vault.
/// Unlike `test_parachute` (which probes an arbitrary URL the Settings form is
/// editing), this validates the config the app would actually use: it reports
/// the resolved `parachute_url` / `parachute_vault`, whether an API key is
/// present (never the key itself), and whether the vault answered `/health`.
#[derive(Clone, Debug, Serialize)]
pub struct ConfigHealth {
    /// Effective Parachute server root the app is configured to use.
    pub parachute_url: String,
    /// Effective vault name for the scoped REST/MCP URLs.
    pub parachute_vault: String,
    /// Whether a Parachute API key (Bearer hub JWT) is configured. Never the key.
    pub api_key_present: bool,
    /// Whether `${parachute_url}/health` responded with a success status.
    pub reachable: bool,
    /// Human-readable detail (error string or status) when not reachable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Validate the live config: ping the configured vault's `/health` and surface
/// the effective connection settings. Reads fresh from disk (like
/// `get_full_config`) so a key saved this session reports accurately, falling
/// back to the launch-time managed state on read error.
#[tauri::command]
pub async fn validate_config(
    config: tauri::State<'_, AppConfig>,
) -> Result<ConfigHealth, PrismError> {
    let config = AppConfig::load().unwrap_or_else(|_| config.inner().clone());

    let (reachable, detail) = match reqwest::Client::new()
        .get(format!("{}/health", config.parachute_url))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => (true, None),
        Ok(resp) => (false, Some(format!("vault returned {}", resp.status()))),
        Err(e) => (false, Some(format!("unreachable: {e}"))),
    };

    Ok(ConfigHealth {
        parachute_url: config.parachute_url,
        parachute_vault: config.parachute_vault,
        api_key_present: !config.parachute_api_key.is_empty(),
        reachable,
        detail,
    })
}

/// Test if Parachute is reachable at a given URL
#[tauri::command]
pub async fn test_parachute(url: String) -> Result<serde_json::Value, PrismError> {
    let resp = reqwest::Client::new()
        .get(format!("{}/health", url))
        .timeout(std::time::Duration::from_secs(5))
        .send().await?;
    if resp.status().is_success() {
        Ok(resp.json().await?)
    } else {
        Err(PrismError::ServiceUnavailable(format!("Parachute at {} returned {}", url, resp.status())))
    }
}

/// Test Matrix connection
#[tauri::command]
pub async fn test_matrix(homeserver: String, access_token: String) -> Result<serde_json::Value, PrismError> {
    let resp = reqwest::Client::new()
        .get(format!("{}/_matrix/client/v3/joined_rooms", homeserver))
        .header("Authorization", format!("Bearer {}", access_token))
        .timeout(std::time::Duration::from_secs(5))
        .send().await?;
    if resp.status().is_success() {
        let data: serde_json::Value = resp.json().await?;
        let count = data["joined_rooms"].as_array().map(|a| a.len()).unwrap_or(0);
        Ok(serde_json::json!({ "ok": true, "rooms": count }))
    } else {
        Err(PrismError::Auth(format!("Matrix auth failed: {}", resp.status())))
    }
}

/// Test Notion connection
#[tauri::command]
pub async fn test_notion(api_key: String) -> Result<serde_json::Value, PrismError> {
    let resp = reqwest::Client::new()
        .post("https://api.notion.com/v1/search")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"query":"","page_size":1}))
        .timeout(std::time::Duration::from_secs(10))
        .send().await?;
    if resp.status().is_success() {
        Ok(serde_json::json!({ "ok": true }))
    } else {
        Err(PrismError::Auth(format!("Notion auth failed: {}", resp.status())))
    }
}

/// Check if claude CLI is installed
#[tauri::command]
pub fn check_claude_cli() -> Result<serde_json::Value, PrismError> {
    let output = std::process::Command::new("which").arg("claude").output();
    match output {
        Ok(o) if o.status.success() => {
            let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            Ok(serde_json::json!({ "installed": true, "path": path }))
        }
        _ => Ok(serde_json::json!({ "installed": false })),
    }
}

/// Mint a collaboration share link for a note via the Prism Server's /acl API —
/// the same path the web app uses, so links live on the real domain and join the
/// current real-time collab. Authenticates as the owner with the dedicated
/// COLLAB_TOKEN (Bearer); the server signs a note-scoped capability and returns
/// the full public link (built from its APP_ORIGIN).
#[tauri::command]
pub async fn create_collab_share_link(
    note_id: String,
    config: tauri::State<'_, AppConfig>,
) -> Result<String, PrismError> {
    if config.collab_token.is_empty() {
        return Err(PrismError::Config(
            "No COLLAB_TOKEN configured — set it in prism-config.json to share from the desktop app".into(),
        ));
    }
    // HTTP base of the Prism Server, derived from the collab WS url.
    let http_base = config
        .collab_url
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1)
        .trim_end_matches("/collab")
        .trim_end_matches('/')
        .to_string();

    let resp = reqwest::Client::new()
        .post(format!("{http_base}/acl/notes/{}/links", urlencoding::encode(&note_id)))
        .bearer_auth(&config.collab_token)
        .json(&serde_json::json!({ "level": "edit", "expiresInDays": 30 }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| PrismError::Other(format!("share-link request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(PrismError::Other(format!("share-link failed: {}", resp.status())));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| PrismError::Other(format!("share-link parse failed: {e}")))?;
    body.get("url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| PrismError::Other("share-link missing url in response".into()))
}

/// Generic proxy to the Prism Server's owner-only `/acl` API, authenticated with
/// the desktop COLLAB_TOKEN (Bearer). This is the single bridge that lets the
/// desktop frontend drive the *full* Google-Docs-style share surface (people
/// grants, capability links, tag-grants) without ever holding the token — the
/// same ACL surface the web app reaches over its session cookie. The frontend
/// builds `path` (e.g. `/notes/123/people`) and `method`; we return the parsed
/// JSON body (null for an empty 2xx, e.g. a 204 on DELETE).
#[tauri::command]
pub async fn acl_request(
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    if config.collab_token.is_empty() {
        return Err(PrismError::Config(
            "No COLLAB_TOKEN configured — set it in prism-config.json to share from the desktop app".into(),
        ));
    }
    // HTTP base of the Prism Server, derived from the collab WS url.
    let http_base = config
        .collab_url
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1)
        .trim_end_matches("/collab")
        .trim_end_matches('/')
        .to_string();

    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| PrismError::Other(format!("invalid HTTP method: {method}")))?;
    let mut req = reqwest::Client::new()
        .request(m, format!("{http_base}/acl{path}"))
        .bearer_auth(&config.collab_token)
        .timeout(std::time::Duration::from_secs(15));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| PrismError::Other(format!("acl request failed: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(PrismError::Other(format!("acl {method} {path} → {status}")));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| PrismError::Other(format!("acl parse failed: {e}")))
}

/// Get full config (for Settings UI to populate fields).
/// Masks sensitive keys for display.
#[tauri::command]
pub fn get_full_config(
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    // Read fresh from disk: `update_config` persists to disk but does NOT mutate
    // the in-memory managed state, so the launch-time `config` would otherwise
    // show stale "not set" for any key saved during this session (the app process
    // outlives a closed window on macOS). Fall back to managed state on read error.
    let config = AppConfig::load().unwrap_or_else(|_| config.inner().clone());

    fn mask(s: &str) -> String {
        if s.is_empty() { return String::new(); }
        if s.len() <= 8 { return "*".repeat(s.len()); }
        format!("{}...{}", &s[..4], &s[s.len()-4..])
    }

    Ok(serde_json::json!({
        "matrix_homeserver": config.matrix_homeserver,
        "matrix_user": config.matrix_user,
        "matrix_access_token": mask(&config.matrix_access_token),
        "matrix_access_token_set": !config.matrix_access_token.is_empty(),
        "notion_api_key": mask(&config.notion_api_key),
        "notion_api_key_set": !config.notion_api_key.is_empty(),
        "google_account_primary": config.google_account_primary,
        "google_account_agent": config.google_account_agent,
        "anthropic_api_key": mask(&config.anthropic_api_key),
        "anthropic_api_key_set": !config.anthropic_api_key.is_empty(),
        "parachute_url": config.parachute_url,
        "parachute_vault": config.parachute_vault,
        "parachute_api_key": mask(&config.parachute_api_key),
        "parachute_api_key_set": !config.parachute_api_key.is_empty(),
        "fathom_api_key": mask(&config.fathom_api_key),
        "fathom_api_key_set": !config.fathom_api_key.is_empty(),
        "meetily_db_path": config.meetily_db_path,
        "readai_api_key": mask(&config.readai_api_key),
        "readai_api_key_set": !config.readai_api_key.is_empty(),
        "otter_api_key": mask(&config.otter_api_key),
        "otter_api_key_set": !config.otter_api_key.is_empty(),
        "fireflies_api_key": mask(&config.fireflies_api_key),
        "fireflies_api_key_set": !config.fireflies_api_key.is_empty(),
        "local_ai_base_url": config.local_ai_base_url,
        "local_ai_model": config.local_ai_model,
        "background_skill_provider": config.background_skill_provider,
    }))
}

/// Update config fields and persist. Only non-null fields are updated.
/// Hot-reloads the Parachute API key into the running client so it takes
/// effect immediately without restarting the app.
#[tauri::command]
pub fn update_config(
    config: tauri::State<'_, AppConfig>,
    parachute: tauri::State<'_, crate::clients::parachute::ParachuteClient>,
    updates: serde_json::Value,
) -> Result<(), PrismError> {
    let mut new_config = config.inner().clone();

    if let Some(obj) = updates.as_object() {
        if let Some(v) = obj.get("matrix_homeserver").and_then(|v| v.as_str()) { new_config.matrix_homeserver = v.to_string(); }
        if let Some(v) = obj.get("matrix_user").and_then(|v| v.as_str()) { new_config.matrix_user = v.to_string(); }
        if let Some(v) = obj.get("matrix_access_token").and_then(|v| v.as_str()) { new_config.matrix_access_token = v.to_string(); }
        if let Some(v) = obj.get("notion_api_key").and_then(|v| v.as_str()) { new_config.notion_api_key = v.to_string(); }
        if let Some(v) = obj.get("google_account_primary").and_then(|v| v.as_str()) { new_config.google_account_primary = v.to_string(); }
        if let Some(v) = obj.get("anthropic_api_key").and_then(|v| v.as_str()) { new_config.anthropic_api_key = v.to_string(); }
        if let Some(v) = obj.get("parachute_url").and_then(|v| v.as_str()) { new_config.parachute_url = v.to_string(); }
        // Note: changing the vault name requires an app restart — the scoped
        // base URL is baked into ParachuteClient at construction.
        if let Some(v) = obj.get("parachute_vault").and_then(|v| v.as_str()) { new_config.parachute_vault = v.to_string(); }
        if let Some(v) = obj.get("parachute_api_key").and_then(|v| v.as_str()) { new_config.parachute_api_key = v.to_string(); }
        if let Some(v) = obj.get("fathom_api_key").and_then(|v| v.as_str()) { new_config.fathom_api_key = v.to_string(); }
        if let Some(v) = obj.get("meetily_db_path").and_then(|v| v.as_str()) { new_config.meetily_db_path = v.to_string(); }
        if let Some(v) = obj.get("readai_api_key").and_then(|v| v.as_str()) { new_config.readai_api_key = v.to_string(); }
        if let Some(v) = obj.get("otter_api_key").and_then(|v| v.as_str()) { new_config.otter_api_key = v.to_string(); }
        if let Some(v) = obj.get("fireflies_api_key").and_then(|v| v.as_str()) { new_config.fireflies_api_key = v.to_string(); }
        // Local AI (OpenAI-compatible). Changing these takes effect on the next
        // app restart — the LocalAgent + DispatchManager wiring is built at launch.
        if let Some(v) = obj.get("local_ai_base_url").and_then(|v| v.as_str()) { new_config.local_ai_base_url = v.to_string(); }
        if let Some(v) = obj.get("local_ai_model").and_then(|v| v.as_str()) { new_config.local_ai_model = v.to_string(); }
        if let Some(v) = obj.get("background_skill_provider").and_then(|v| v.as_str()) { new_config.background_skill_provider = v.to_string(); }
    }

    // Hot-reload Parachute API key into the running client
    let new_key = if new_config.parachute_api_key.is_empty() { None } else { Some(new_config.parachute_api_key.clone()) };
    parachute.set_api_key(new_key);

    new_config.save()?;
    log::info!("Config updated and saved (parachute api_key hot-reloaded)");
    Ok(())
}

/// Auto-discover Meetily database path.
#[tauri::command]
pub fn discover_meetily_path() -> Result<serde_json::Value, PrismError> {
    match auto_discover_meetily() {
        Some(path) => Ok(serde_json::json!({ "found": true, "path": path })),
        None => Ok(serde_json::json!({ "found": false })),
    }
}

/// Check if gog CLI is installed
#[tauri::command]
pub fn check_google_cli() -> Result<serde_json::Value, PrismError> {
    let output = std::process::Command::new("which").arg("gog").output();
    match output {
        Ok(o) if o.status.success() => {
            let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            Ok(serde_json::json!({ "installed": true, "path": path }))
        }
        _ => Ok(serde_json::json!({ "installed": false })),
    }
}
