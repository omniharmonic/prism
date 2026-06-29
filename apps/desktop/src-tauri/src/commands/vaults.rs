//! Desktop-native multi-vault registry commands.
//!
//! The desktop app talks to Parachute directly (not through the cloud Prism
//! Server), so it carries its OWN vault registry in `prism-config.json`
//! (`AppConfig.vaults`) and switches the live `ParachuteClient` at runtime with no
//! app restart. This mirrors the web/server multi-vault surface, but local.
//!
//! Security: vault tokens live only in the config file + the in-process client.
//! NONE of these commands return a token to the frontend — `VaultSummary` is the
//! only shape that crosses the IPC boundary, and it carries `{id,label,vault,active}`.
//!
//! Mutation pattern: the managed `AppConfig` state is the launch-time snapshot and
//! is never mutated in place (matching `update_config`). Each mutation loads the
//! current config fresh from disk, normalizes the registry, applies the change,
//! persists, and — where it affects the active vault — repoints the live client.

use serde::Serialize;
use uuid::Uuid;

use crate::clients::parachute::ParachuteClient;
use crate::commands::config::{AppConfig, VaultEntry};
use crate::error::PrismError;

/// Token-free projection of a `VaultEntry` for the frontend. NEVER add `url`/`token`.
#[derive(Clone, Debug, Serialize)]
pub struct VaultSummary {
    pub id: String,
    pub label: String,
    pub vault: String,
    pub active: bool,
}

impl VaultSummary {
    fn from_entry(entry: &VaultEntry, active_id: &str) -> Self {
        Self {
            id: entry.id.clone(),
            label: entry.label.clone(),
            vault: entry.vault.clone(),
            active: entry.id == active_id,
        }
    }
}

/// Lowercase slug derived from a label (matches the server's `vaultSlug`):
/// non-alphanumerics → `-`, trimmed, capped at 48 chars.
fn vault_slug(label: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in label.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    trimmed.chars().take(48).collect()
}

/// A registry-unique id derived from the label (random suffix on collision).
fn unique_vault_id(label: &str, existing: &[VaultEntry]) -> String {
    let base = {
        let s = vault_slug(label);
        if s.is_empty() {
            Uuid::new_v4().to_string()[..8].to_string()
        } else {
            s
        }
    };
    let taken: std::collections::HashSet<&str> = existing.iter().map(|v| v.id.as_str()).collect();
    if !taken.contains(base.as_str()) {
        return base;
    }
    let stem = {
        let s = vault_slug(label);
        if s.is_empty() { "vault".to_string() } else { s }
    };
    loop {
        let candidate = format!("{}-{}", stem, &Uuid::new_v4().to_string()[..4]);
        if !taken.contains(candidate.as_str()) {
            return candidate;
        }
    }
}

/// Load the current config fresh from disk and normalize the registry. Falls back
/// to the launch-time managed state on read error (same pattern as `get_full_config`).
fn load_normalized(config: &tauri::State<'_, AppConfig>) -> AppConfig {
    let mut cfg = AppConfig::load().unwrap_or_else(|_| config.inner().clone());
    cfg.normalize_vaults();
    cfg
}

/// List the known vaults (token-free). `active` flags the current one.
#[tauri::command]
pub fn vault_list(config: tauri::State<'_, AppConfig>) -> Result<Vec<VaultSummary>, PrismError> {
    let cfg = load_normalized(&config);
    Ok(cfg
        .vaults
        .iter()
        .map(|e| VaultSummary::from_entry(e, &cfg.active_vault_id))
        .collect())
}

/// Switch the active vault and repoint the live `ParachuteClient` with no restart.
#[tauri::command]
pub fn vault_set_active(
    id: String,
    config: tauri::State<'_, AppConfig>,
    parachute: tauri::State<'_, ParachuteClient>,
) -> Result<(), PrismError> {
    let mut cfg = load_normalized(&config);
    let entry = cfg
        .vaults
        .iter()
        .find(|v| v.id == id)
        .cloned()
        .ok_or_else(|| PrismError::Config(format!("unknown vault id: {id}")))?;

    cfg.active_vault_id = id;
    // Mirror the chosen entry into the legacy parachute_* fields (normalize does
    // this from active_vault_id) and persist.
    cfg.normalize_vaults();
    cfg.save()?;

    // Repoint the live client so reads/writes immediately hit the new vault.
    parachute.set_vault(&entry.url, &entry.vault, Some(entry.token));
    log::info!("Active vault switched to '{}' ({})", entry.label, entry.vault);
    Ok(())
}

/// Create a brand-new local vault via the Parachute CLI, register it, and (best
/// effort) seed tag schemas. The freshly minted token is stored in the registry
/// but NEVER returned to the frontend.
#[tauri::command]
pub fn vault_create(
    label: String,
    name: String,
    seed_schemas: Option<bool>,
    config: tauri::State<'_, AppConfig>,
    parachute: tauri::State<'_, ParachuteClient>,
) -> Result<VaultSummary, PrismError> {
    let label = label.trim().to_string();
    let name = name.trim().to_string();
    if label.is_empty() || name.is_empty() {
        return Err(PrismError::Config("label and name are required".into()));
    }
    // Defense-in-depth: validate the vault name before it reaches the CLI args.
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        return Err(PrismError::Config(
            "name must match ^[a-z0-9_-]+$".into(),
        ));
    }

    let mut cfg = load_normalized(&config);
    let url = cfg.parachute_url.clone();

    // Shell out to the Parachute CLI with an ARGS ARRAY (never a shell string) so
    // the vault name can't be a shell-injection vector.
    let output = std::process::Command::new("parachute-vault")
        .args(["create", &name, "--mint", "--scope", "write", "--no-mirror", "--json"])
        .output()
        .map_err(|e| {
            PrismError::Config(format!(
                "failed to run parachute-vault (is the CLI installed?): {e}"
            ))
        })?;
    if !output.status.success() {
        // The failure happens BEFORE any token is minted, so stderr can't carry a
        // token; still keep it terse and never echo stdout.
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(PrismError::Config(format!(
            "parachute-vault create failed: {}",
            stderr.trim()
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| PrismError::Config("parachute-vault create did not return JSON".into()))?;
    let token = parsed
        .get("token")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| PrismError::Config("parachute-vault create returned no token".into()))?;

    let id = unique_vault_id(&label, &cfg.vaults);
    let entry = VaultEntry {
        id: id.clone(),
        label: label.clone(),
        url,
        vault: name.clone(),
        token,
    };
    cfg.vaults.push(entry.clone());
    cfg.save()?;

    // Best-effort schema seed via the same client, repointed at the new vault.
    // Deferred: the desktop has no Rust seeder, so we note this rather than ship a
    // half-seed. (The web/server path seeds via seedTagSchemas; on desktop the
    // `prism-setup-schema` skill / CLI handles seeding.)
    if seed_schemas.unwrap_or(true) {
        log::info!(
            "vault_create('{}'): schema seeding deferred — run prism-setup-schema against '{}'",
            name, name
        );
    }

    let summary = VaultSummary::from_entry(&entry, &cfg.active_vault_id);
    // Touch `parachute` so the param isn't flagged unused; we intentionally do NOT
    // switch to the new vault on create (parity with the web, which returns active:false).
    let _ = &parachute;
    Ok(summary)
}

/// Link an EXISTING (possibly remote) vault by url/vault/token. No CLI — just
/// validates and persists the connection.
#[tauri::command]
pub fn vault_link(
    label: String,
    url: String,
    vault: String,
    token: String,
    config: tauri::State<'_, AppConfig>,
) -> Result<VaultSummary, PrismError> {
    let label = label.trim().to_string();
    let url = url.trim().trim_end_matches('/').to_string();
    let vault = vault.trim().to_string();
    let token = token.trim().to_string();
    if label.is_empty() || vault.is_empty() || token.is_empty() {
        return Err(PrismError::Config(
            "label, vault and token are required".into(),
        ));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(PrismError::Config("url must be http(s)".into()));
    }

    let mut cfg = load_normalized(&config);
    let id = unique_vault_id(&label, &cfg.vaults);
    let entry = VaultEntry {
        id,
        label,
        url,
        vault,
        token,
    };
    cfg.vaults.push(entry.clone());
    cfg.save()?;
    Ok(VaultSummary::from_entry(&entry, &cfg.active_vault_id))
}

/// Remove a vault from the registry. Refuses the active vault and the last vault.
#[tauri::command]
pub fn vault_remove(
    id: String,
    config: tauri::State<'_, AppConfig>,
) -> Result<(), PrismError> {
    let mut cfg = load_normalized(&config);
    if !cfg.vaults.iter().any(|v| v.id == id) {
        return Err(PrismError::Config(format!("unknown vault id: {id}")));
    }
    if id == cfg.active_vault_id {
        return Err(PrismError::Config(
            "cannot remove the active vault — switch to another vault first".into(),
        ));
    }
    if cfg.vaults.len() <= 1 {
        return Err(PrismError::Config(
            "cannot remove the only vault".into(),
        ));
    }
    cfg.vaults.retain(|v| v.id != id);
    cfg.normalize_vaults();
    cfg.save()?;
    Ok(())
}
