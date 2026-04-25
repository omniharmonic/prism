use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::ListNotesParams;
use crate::sync::adapters::github::{
    self, check_gh_auth, CommitStrategy, DirectorySyncConfig, DirectorySyncResult,
    GitHubAuthStatus,
};

// ─── Persistence ────────────────────────────────────────────

/// Path to the JSON file that stores GitHub sync configurations.
fn configs_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("prism")
        .join("github-sync-configs.json")
}

/// Load persisted GitHub sync configurations from disk.
/// Returns an empty map if the file doesn't exist or fails to parse —
/// failure to load should never block app startup.
fn load_configs() -> HashMap<String, DirectorySyncConfig> {
    let path = configs_path();
    if !path.exists() {
        return HashMap::new();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log::warn!("Failed to parse GitHub sync configs ({path:?}): {e}");
            HashMap::new()
        }),
        Err(e) => {
            log::warn!("Failed to read GitHub sync configs: {e}");
            HashMap::new()
        }
    }
}

/// Persist GitHub sync configurations to disk. Logs but does not propagate
/// errors — failure to save shouldn't fail the user-facing command.
fn save_configs(configs: &HashMap<String, DirectorySyncConfig>) {
    let path = configs_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(configs) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::warn!("Failed to save GitHub sync configs: {e}");
            }
        }
        Err(e) => log::warn!("Failed to serialize GitHub sync configs: {e}"),
    }
}

// ─── Managed state ──────────────────────────────────────────

/// Holds all active GitHub directory-sync configurations, keyed by config id.
pub struct GitHubSyncState {
    pub configs: Mutex<HashMap<String, DirectorySyncConfig>>,
}

impl GitHubSyncState {
    pub fn new() -> Self {
        // Restore configurations persisted from a previous session so syncs
        // survive app restarts.
        let configs = load_configs();
        if !configs.is_empty() {
            log::info!("Loaded {} GitHub sync config(s) from disk", configs.len());
        }
        Self {
            configs: Mutex::new(configs),
        }
    }
}

// ─── Serialisable view returned by `github_sync_status` ─────

/// Lightweight summary of a sync configuration for the frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSyncInfo {
    pub id: String,
    pub vault_path: String,
    pub remote_url: String,
    pub branch: String,
    pub last_synced: String,
    pub auto_sync: bool,
}

// ─── Commands ───────────────────────────────────────────────

/// Check whether the user is authenticated via `gh auth`.
#[tauri::command]
pub async fn github_check_auth() -> Result<GitHubAuthStatus, PrismError> {
    check_gh_auth().await
}

/// Initialise a new GitHub directory sync.
///
/// Clones (or fetches) the remote repository into a local cache directory
/// under `~/.config/prism/sync/github/<repo-name>` and stores the
/// configuration so subsequent push/pull operations can use it.
///
/// Auth is handled by `gh` CLI — no token parameter needed.
///
/// Returns the generated config id.
#[tauri::command]
pub async fn github_sync_init(
    github_state: State<'_, GitHubSyncState>,
    parachute: State<'_, ParachuteClient>,
    vault_path: String,
    remote_url: String,
    branch: String,
    commit_strategy: String,
    conflict_strategy: String,
    auto_sync: bool,
) -> Result<String, PrismError> {
    // Verify gh auth before proceeding
    let auth = check_gh_auth().await?;
    if !auth.authenticated {
        return Err(PrismError::Auth(
            "GitHub CLI not authenticated. Run `gh auth login` in your terminal.".into(),
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();

    // Derive a human-friendly repo directory name from the remote URL.
    // e.g. "https://github.com/user/my-repo.git" -> "my-repo"
    let repo_name = remote_url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("repo")
        .trim_end_matches(".git")
        .to_string();

    let local_clone_path = dirs::config_dir()
        .ok_or_else(|| PrismError::Config("Could not determine config directory".into()))?
        .join("prism")
        .join("sync")
        .join("github")
        .join(&repo_name);

    let strategy = match commit_strategy.as_str() {
        "per_save" => CommitStrategy::PerSave,
        "batched" => CommitStrategy::Batched,
        "manual" => CommitStrategy::Manual,
        other => {
            return Err(PrismError::Config(format!(
                "Unknown commit strategy: '{other}'. Expected per_save, batched, or manual."
            )));
        }
    };

    let config = DirectorySyncConfig {
        id: id.clone(),
        vault_path,
        remote_url,
        branch,
        local_clone_path,
        commit_strategy: strategy,
        conflict_strategy,
        last_synced: String::new(),
        auto_sync,
        file_extension: ".md".to_string(),
        id_map: HashMap::new(),
    };

    // Clone / fetch the repository.
    github::init_clone(&config).await?;

    // Perform initial sync: push existing vault notes into the repo.
    // Parachute's path param is exact-match, not prefix — so we list all
    // notes and filter by path prefix in Rust.
    let all_notes = parachute
        .list_notes(&ListNotesParams {
            limit: Some(10000),
            include_content: true,
            ..Default::default()
        })
        .await?;

    let notes: Vec<_> = all_notes
        .into_iter()
        .filter(|n| {
            n.path
                .as_deref()
                .map(|p| p.starts_with(&config.vault_path))
                .unwrap_or(false)
        })
        .collect();

    log::info!("GitHub sync init: {} notes match path prefix '{}'", notes.len(), config.vault_path);

    if !notes.is_empty() {
        let _result = github::sync_directory(&config, &notes, &parachute).await?;
    }

    // Update last_synced and persist config in managed state + on disk.
    let mut config = config;
    config.last_synced = chrono::Utc::now().to_rfc3339();
    {
        let mut configs = github_state
            .configs
            .lock()
            .map_err(|e| PrismError::Other(format!("Lock poisoned: {e}")))?;
        configs.insert(id.clone(), config);
        save_configs(&configs);
    }

    Ok(id)
}

/// Push all notes under the configured vault path to the GitHub repository.
///
/// Lists matching notes from Parachute, writes them as files to the local
/// clone, commits, and pushes. Returns a summary of pushed/pulled/conflicted
/// files.
#[tauri::command]
pub async fn github_sync_push(
    github_state: State<'_, GitHubSyncState>,
    parachute: State<'_, ParachuteClient>,
    config_id: String,
) -> Result<DirectorySyncResult, PrismError> {
    // Retrieve the config (clone it so we can release the lock quickly).
    let mut config = {
        let configs = github_state
            .configs
            .lock()
            .map_err(|e| PrismError::Other(format!("Lock poisoned: {e}")))?;
        configs
            .get(&config_id)
            .cloned()
            .ok_or_else(|| PrismError::Other(format!("No sync config found for id '{config_id}'")))?
    };

    // Parachute path param is exact-match — list all and filter by prefix.
    let all_notes = parachute
        .list_notes(&ListNotesParams {
            limit: Some(10000),
            include_content: true,
            ..Default::default()
        })
        .await?;

    let notes: Vec<_> = all_notes
        .into_iter()
        .filter(|n| {
            n.path
                .as_deref()
                .map(|p| p.starts_with(&config.vault_path))
                .unwrap_or(false)
        })
        .collect();

    let result = github::sync_directory(&config, &notes, &parachute).await?;

    // Update last_synced timestamp and persist.
    config.last_synced = chrono::Utc::now().to_rfc3339();
    {
        let mut configs = github_state
            .configs
            .lock()
            .map_err(|e| PrismError::Other(format!("Lock poisoned: {e}")))?;
        configs.insert(config_id, config);
        save_configs(&configs);
    }

    Ok(result)
}

/// Push a single note to the GitHub repository (useful for auto-sync on save).
#[tauri::command]
pub async fn github_sync_push_file(
    github_state: State<'_, GitHubSyncState>,
    parachute: State<'_, ParachuteClient>,
    config_id: String,
    note_id: String,
) -> Result<(), PrismError> {
    let config = {
        let configs = github_state
            .configs
            .lock()
            .map_err(|e| PrismError::Other(format!("Lock poisoned: {e}")))?;
        configs
            .get(&config_id)
            .cloned()
            .ok_or_else(|| PrismError::Other(format!("No sync config found for id '{config_id}'")))?
    };

    let note = parachute.get_note(&note_id).await?;

    // Fetch siblings under the same vault path so wikilink resolution can find
    // them. We use a list with include_content=false to keep this cheap —
    // serialize_note_to_markdown only needs paths/tags/title for lookup.
    let siblings = parachute
        .list_notes(&ListNotesParams {
            limit: Some(10000),
            ..Default::default()
        })
        .await
        .unwrap_or_default();

    github::push_single_file(&config, &note, &siblings).await?;

    Ok(())
}

/// Return a summary of every configured GitHub sync.
#[tauri::command]
pub async fn github_sync_status(
    github_state: State<'_, GitHubSyncState>,
) -> Result<Vec<GitHubSyncInfo>, PrismError> {
    let configs = github_state
        .configs
        .lock()
        .map_err(|e| PrismError::Other(format!("Lock poisoned: {e}")))?;

    let infos = configs
        .values()
        .map(|c| GitHubSyncInfo {
            id: c.id.clone(),
            vault_path: c.vault_path.clone(),
            remote_url: c.remote_url.clone(),
            branch: c.branch.clone(),
            last_synced: c.last_synced.clone(),
            auto_sync: c.auto_sync,
        })
        .collect();

    Ok(infos)
}

/// Remove a GitHub sync configuration by id.
#[tauri::command]
pub async fn github_sync_remove(
    github_state: State<'_, GitHubSyncState>,
    config_id: String,
) -> Result<(), PrismError> {
    let mut configs = github_state
        .configs
        .lock()
        .map_err(|e| PrismError::Other(format!("Lock poisoned: {e}")))?;

    if configs.remove(&config_id).is_none() {
        return Err(PrismError::Other(format!(
            "No sync config found for id '{config_id}'"
        )));
    }

    save_configs(&configs);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// `DirectorySyncConfig` must round-trip cleanly through `serde_json` so
    /// the persistence file is forward-compatible. This test guards against
    /// accidentally adding a non-serializable field.
    #[test]
    fn directory_sync_config_round_trips_through_json() {
        let mut id_map = HashMap::new();
        id_map.insert("note-123".to_string(), "people/peter-thiel.md".to_string());

        let config = DirectorySyncConfig {
            id: "abc-123".into(),
            vault_path: "vault/research/thiel-karp-genealogy".into(),
            remote_url: "https://github.com/omniharmonic/thiel-karp-geneology".into(),
            branch: "main".into(),
            local_clone_path: PathBuf::from("/tmp/clone"),
            commit_strategy: CommitStrategy::Batched,
            conflict_strategy: "local-wins".into(),
            last_synced: "2026-04-25T00:00:00Z".into(),
            auto_sync: false,
            file_extension: ".md".into(),
            id_map,
        };

        let mut original = HashMap::new();
        original.insert(config.id.clone(), config);

        let json = serde_json::to_string_pretty(&original).expect("serialize");
        let restored: HashMap<String, DirectorySyncConfig> =
            serde_json::from_str(&json).expect("deserialize");

        assert_eq!(restored.len(), 1);
        let r = restored.get("abc-123").expect("missing config");
        assert_eq!(r.vault_path, "vault/research/thiel-karp-genealogy");
        assert_eq!(r.local_clone_path, PathBuf::from("/tmp/clone"));
        assert_eq!(r.id_map.get("note-123").unwrap(), "people/peter-thiel.md");
    }
}
