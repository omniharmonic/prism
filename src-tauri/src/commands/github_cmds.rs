use std::collections::HashMap;
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

// ─── Managed state ──────────────────────────────────────────

/// Holds all active GitHub directory-sync configurations, keyed by config id.
pub struct GitHubSyncState {
    pub configs: Mutex<HashMap<String, DirectorySyncConfig>>,
}

impl GitHubSyncState {
    pub fn new() -> Self {
        Self {
            configs: Mutex::new(HashMap::new()),
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
        file_extension: "md".to_string(),
        id_map: HashMap::new(),
    };

    // Clone / fetch the repository.
    github::init_clone(&config).await?;

    // Perform initial sync: push existing vault notes into the repo.
    let notes = parachute
        .list_notes(&ListNotesParams {
            path: Some(config.vault_path.clone()),
            ..Default::default()
        })
        .await?;

    if !notes.is_empty() {
        let _result = github::sync_directory(&config, &notes, &parachute).await?;
    }

    // Update last_synced and persist config in managed state.
    let mut config = config;
    config.last_synced = chrono::Utc::now().to_rfc3339();
    github_state
        .configs
        .lock()
        .map_err(|e| PrismError::Other(format!("Lock poisoned: {e}")))?
        .insert(id.clone(), config);

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

    // Fetch notes whose path starts with the vault_path prefix.
    let notes = parachute
        .list_notes(&ListNotesParams {
            path: Some(config.vault_path.clone()),
            ..Default::default()
        })
        .await?;

    let result = github::sync_directory(&config, &notes, &parachute).await?;

    // Update last_synced timestamp.
    config.last_synced = chrono::Utc::now().to_rfc3339();
    github_state
        .configs
        .lock()
        .map_err(|e| PrismError::Other(format!("Lock poisoned: {e}")))?
        .insert(config_id, config);

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
    github::push_single_file(&config, &note).await?;

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
    let removed = github_state
        .configs
        .lock()
        .map_err(|e| PrismError::Other(format!("Lock poisoned: {e}")))?
        .remove(&config_id);

    if removed.is_none() {
        return Err(PrismError::Other(format!(
            "No sync config found for id '{config_id}'"
        )));
    }

    Ok(())
}
