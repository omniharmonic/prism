use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::error::PrismError;

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
            fathom_api_key: String::new(),
            meetily_db_path: String::new(),
            readai_api_key: String::new(),
            otter_api_key: String::new(),
            fireflies_api_key: String::new(),
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
                if let Some(v) = vars.get("FATHOM_API_KEY") { config.fathom_api_key = v.clone(); }
                if let Some(v) = vars.get("MEETILY_DB_PATH") { config.meetily_db_path = v.clone(); }
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

#[tauri::command]
pub fn get_config_status(
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
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

/// Get full config (for Settings UI to populate fields).
/// Masks sensitive keys for display.
#[tauri::command]
pub fn get_full_config(
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
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
        if let Some(v) = obj.get("parachute_api_key").and_then(|v| v.as_str()) { new_config.parachute_api_key = v.to_string(); }
        if let Some(v) = obj.get("fathom_api_key").and_then(|v| v.as_str()) { new_config.fathom_api_key = v.to_string(); }
        if let Some(v) = obj.get("meetily_db_path").and_then(|v| v.as_str()) { new_config.meetily_db_path = v.to_string(); }
        if let Some(v) = obj.get("readai_api_key").and_then(|v| v.as_str()) { new_config.readai_api_key = v.to_string(); }
        if let Some(v) = obj.get("otter_api_key").and_then(|v| v.as_str()) { new_config.otter_api_key = v.to_string(); }
        if let Some(v) = obj.get("fireflies_api_key").and_then(|v| v.as_str()) { new_config.fireflies_api_key = v.to_string(); }
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
