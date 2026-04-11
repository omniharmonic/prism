use std::collections::HashMap;
use std::path::PathBuf;
use crate::error::PrismError;

/// App configuration loaded from the omniharmonic agent's .env file
/// and augmented with Prism-specific settings.
#[derive(Clone, Debug)]
pub struct AppConfig {
    pub matrix_homeserver: String,
    pub matrix_user: String,
    pub matrix_access_token: String,
    pub matrix_device_id: String,
    pub notion_api_key: String,
    pub google_account_primary: String,
    pub google_account_agent: String,
    pub anthropic_api_key: String,
    pub omniharmonic_root: PathBuf,
}

impl AppConfig {
    /// Load configuration from the omniharmonic agent's .env file
    pub fn load() -> Result<Self, PrismError> {
        let omni_root = dirs::home_dir()
            .unwrap_or_default()
            .join("iCloud Drive (Archive)/Documents/cursor projects/omniharmonic_agent");

        let env_path = omni_root.join(".env");
        let vars = load_env_file(&env_path)?;

        Ok(Self {
            matrix_homeserver: vars.get("MATRIX_HOMESERVER")
                .cloned()
                .unwrap_or_else(|| "http://localhost:8008".into()),
            matrix_user: vars.get("MATRIX_USER")
                .cloned()
                .unwrap_or_else(|| "@prism:localhost".into()),
            matrix_access_token: vars.get("MATRIX_ACCESS_TOKEN")
                .cloned()
                .unwrap_or_default(),
            matrix_device_id: vars.get("MATRIX_DEVICE_ID")
                .cloned()
                .unwrap_or_else(|| "PRISM".into()),
            notion_api_key: vars.get("NOTION_API_KEY")
                .cloned()
                .unwrap_or_default(),
            google_account_primary: vars.get("GOOGLE_ACCOUNT_BENJAMIN")
                .cloned()
                .unwrap_or_else(|| "benjamin@opencivics.co".into()),
            google_account_agent: vars.get("GOOGLE_ACCOUNT_AGENT")
                .cloned()
                .unwrap_or_else(|| "omniharmonicagent@gmail.com".into()),
            anthropic_api_key: vars.get("ANTHROPIC_API_KEY")
                .cloned()
                .or_else(|| try_keychain_anthropic())
                .unwrap_or_default(),
            omniharmonic_root: omni_root,
        })
    }
}

/// Parse a .env file into a HashMap
fn load_env_file(path: &std::path::Path) -> Result<HashMap<String, String>, PrismError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| PrismError::Io(format!("Failed to read .env at {:?}: {}", path, e)))?;

    let mut vars = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim().to_string();
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            vars.insert(key, value);
        }
    }
    Ok(vars)
}

/// Try to read the Anthropic API key from macOS Keychain
fn try_keychain_anthropic() -> Option<String> {
    // Try reading from Keychain via security CLI
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "com.prism.anthropic", "-w"])
        .output()
        .ok()?;

    if output.status.success() {
        let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    None
}

// Tauri commands for config management

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
    }))
}

#[tauri::command]
pub fn set_anthropic_key(key: String) -> Result<(), PrismError> {
    // Store in macOS Keychain
    let status = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-s", "com.prism.anthropic",
            "-a", "default",
            "-w", &key,
            "-U", // Update if exists
        ])
        .status()
        .map_err(|e| PrismError::Other(format!("Keychain error: {}", e)))?;

    if !status.success() {
        return Err(PrismError::Auth("Failed to store API key in Keychain".into()));
    }
    Ok(())
}
