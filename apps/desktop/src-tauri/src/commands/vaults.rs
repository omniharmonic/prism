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

/// Switch the active vault and repoint the ENTIRE live stack with no restart:
/// the REST `ParachuteClient`, the managed MCP config that `claude -p` agents read,
/// the background `DispatchManager` (report-note writer), and the optional
/// local-model agent's MCP session. After this returns, both interactive reads and
/// background agent runs target the newly-selected vault.
#[tauri::command]
pub fn vault_set_active(
    id: String,
    config: tauri::State<'_, AppConfig>,
    parachute: tauri::State<'_, ParachuteClient>,
    dispatch: tauri::State<'_, std::sync::Arc<crate::services::agent_dispatch::DispatchManager>>,
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

    // 1. Repoint the live REST client so reads/writes immediately hit the new vault.
    parachute.set_vault(&entry.url, &entry.vault, Some(entry.token.clone()));

    // 2. Rewrite the managed MCP config so the NEXT `claude -p` agent run targets
    //    the new vault (the file path is stable; only its contents change).
    if let Err(e) =
        AppConfig::write_managed_mcp_config(&entry.url, &entry.vault, &entry.token)
    {
        log::warn!("vault switch: failed to rewrite managed MCP config: {e}");
    }

    // 3. Repoint the background dispatch stack (report-note writer + local MCP).
    dispatch.set_vault(&entry.url, &entry.vault, Some(entry.token.clone()));
    let root = entry.url.trim_end_matches('/');
    let root = root.strip_suffix("/api").unwrap_or(root);
    let mcp_url = format!("{}/vault/{}/mcp", root, entry.vault);
    let token = entry.token.clone();
    let dispatch_inner = dispatch.inner().clone();
    tauri::async_runtime::block_on(async move {
        dispatch_inner.reconnect_local_mcp(&mcp_url, Some(&token)).await;
    });

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

    // Shell out to the Parachute CLI with ARGS ARRAYS (never a shell string) so the
    // vault name can't be a shell-injection vector. Two steps on purpose:
    //   1. create the vault, then
    //   2. mint a LONG-LIVED (1-year) write token via `parachute auth mint-token`.
    // We mint separately rather than rely on `create --mint`, whose token defaults
    // to a ~90-day TTL — a desktop-created vault would otherwise silently stop
    // authenticating after 90 days, with no obvious cause for a non-technical user.
    let create = std::process::Command::new("parachute-vault")
        .args(["create", &name, "--no-mirror", "--json"])
        .output()
        .map_err(|e| {
            PrismError::Config(format!(
                "failed to run parachute-vault (is the CLI installed?): {e}"
            ))
        })?;
    if !create.status.success() {
        // Never echo stdout (defensive); creation precedes any token mint anyway.
        let stderr = String::from_utf8_lossy(&create.stderr);
        return Err(PrismError::Config(format!(
            "parachute-vault create failed: {}",
            stderr.trim()
        )));
    }

    // Mint a 1-year (31536000s) write token. `mint-token` prints the bare JWT on stdout.
    let scope = format!("vault:{name}:write");
    let mint = std::process::Command::new("parachute")
        .args(["auth", "mint-token", "--scope", &scope, "--expires-in", "31536000"])
        .output()
        .map_err(|e| PrismError::Config(format!("failed to run parachute auth mint-token: {e}")))?;
    if !mint.status.success() {
        let stderr = String::from_utf8_lossy(&mint.stderr);
        return Err(PrismError::Config(format!(
            "parachute auth mint-token failed: {}",
            stderr.trim()
        )));
    }
    let token = String::from_utf8_lossy(&mint.stdout).trim().to_string();
    // Sanity-check it's a JWT (Parachute 0.5.x+ rejects legacy pvt_* opaque tokens).
    if token.is_empty() || !token.starts_with("eyJ") {
        return Err(PrismError::Config(
            "parachute auth mint-token returned no JWT".into(),
        ));
    }

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

    // Seed starter tag schemas on the new vault (idempotent + additive). Mirrors
    // the web/server `seedTagSchemas`; the canonical schema is bundled into the
    // binary (see `schema_seed`). Best-effort: a seeding failure never fails the
    // create — the vault is already registered and usable.
    if seed_schemas.unwrap_or(true) {
        // Normalize the configured URL to a bare server root (tolerate a legacy
        // `/api` suffix / trailing slash), matching `ParachuteClient::compute_urls`.
        let root = entry.url.trim_end_matches('/');
        let root = root.strip_suffix("/api").unwrap_or(root).to_string();
        let seed_vault = entry.vault.clone();
        let seed_token = entry.token.clone();
        match tauri::async_runtime::block_on(crate::commands::schema_seed::seed_tag_schemas(
            &root,
            &seed_vault,
            &seed_token,
        )) {
            Ok(s) => log::info!(
                "vault_create('{}'): seeded schemas — {} created, {} updated, {} unchanged",
                name,
                s.created.len(),
                s.updated.len(),
                s.unchanged
            ),
            Err(e) => log::warn!(
                "vault_create('{}'): schema seeding failed (vault still usable): {}",
                name, e
            ),
        }
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
