use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::error::PrismError;

/// App configuration — loaded from prism-config.json, falling back to
/// omniharmonic .env, falling back to defaults.
/// Serializable so it can be persisted and updated at runtime.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    pub matrix_homeserver: String,
    pub matrix_user: String,
    pub matrix_access_token: String,
    pub matrix_device_id: String,
    pub notion_api_key: String,
    pub google_account_primary: String,
    pub google_account_agent: String,
    pub anthropic_api_key: String,
    #[serde(skip)]
    pub omniharmonic_root: PathBuf,
    pub parachute_url: String,
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
            omniharmonic_root: PathBuf::new(),
            parachute_url: "http://localhost:1940".into(),
        }
    }
}

impl AppConfig {
    /// Load config: prism-config.json → omniharmonic .env → defaults
    pub fn load() -> Result<Self, PrismError> {
        // Try prism-config.json first
        let config_path = Self::config_path();
        if config_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                if let Ok(mut config) = serde_json::from_str::<AppConfig>(&content) {
                    config.omniharmonic_root = Self::find_omniharmonic_root();
                    return Ok(config);
                }
            }
        }

        // Fall back to omniharmonic .env
        let omni_root = Self::find_omniharmonic_root();
        let env_path = omni_root.join(".env");
        let vars = load_env_file(&env_path).unwrap_or_default();

        let config = Self {
            matrix_homeserver: vars.get("MATRIX_HOMESERVER")
                .cloned().unwrap_or_else(|| "http://localhost:8008".into()),
            matrix_user: vars.get("MATRIX_USER")
                .cloned().unwrap_or_else(|| "@prism:localhost".into()),
            matrix_access_token: vars.get("MATRIX_ACCESS_TOKEN")
                .cloned().unwrap_or_default(),
            matrix_device_id: vars.get("MATRIX_DEVICE_ID")
                .cloned().unwrap_or_else(|| "PRISM".into()),
            notion_api_key: vars.get("NOTION_API_KEY")
                .cloned().unwrap_or_default(),
            google_account_primary: vars.get("GOOGLE_ACCOUNT_BENJAMIN")
                .cloned().unwrap_or_default(),
            google_account_agent: vars.get("GOOGLE_ACCOUNT_AGENT")
                .cloned().unwrap_or_default(),
            anthropic_api_key: vars.get("ANTHROPIC_API_KEY")
                .cloned().or_else(try_keychain_anthropic)
                .unwrap_or_default(),
            omniharmonic_root: omni_root,
            parachute_url: "http://localhost:1940".into(),
        };

        // Save to prism-config.json for next time
        let _ = config.save();

        Ok(config)
    }

    /// Save config to prism-config.json
    pub fn save(&self) -> Result<(), PrismError> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
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

    fn find_omniharmonic_root() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_default()
            .join("iCloud Drive (Archive)/Documents/cursor projects/omniharmonic_agent")
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
        .get(format!("{}/api/health", url))
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
