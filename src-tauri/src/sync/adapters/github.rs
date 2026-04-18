//! GitHub sync adapter for directory-level vault synchronization.
//!
//! Unlike the note-level `SyncAdapter` trait, this module syncs an entire
//! directory of Parachute vault notes to/from a GitHub repository, committing
//! changes on each sync cycle.
//!
//! Uses the `git` and `gh` CLI tools instead of libgit2. Auth is handled by
//! `gh auth` — no PAT tokens stored in Prism.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use log::{debug, info};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::PrismError;
use crate::models::note::Note;

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

/// Configuration for a directory-level GitHub sync binding.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DirectorySyncConfig {
    /// Unique identifier for this sync binding.
    pub id: String,
    /// Vault path prefix to sync, e.g. `"vault/projects/prism-docs"`.
    pub vault_path: String,
    /// Remote repository URL, e.g. `"https://github.com/omniharmonic/prism-docs"`.
    pub remote_url: String,
    /// Branch to track, e.g. `"main"`.
    pub branch: String,
    /// Local filesystem path where the repo is cloned.
    pub local_clone_path: PathBuf,
    /// How commits are grouped.
    pub commit_strategy: CommitStrategy,
    /// Conflict resolution: `"local-wins"` or `"remote-wins"`.
    pub conflict_strategy: String,
    /// ISO-8601 timestamp of last successful sync.
    pub last_synced: String,
    /// Whether to sync automatically on changes.
    pub auto_sync: bool,
    /// File extension appended to notes that lack one (default `".md"`).
    pub file_extension: String,
    /// Mapping of note IDs to repo-relative file paths.
    pub id_map: HashMap<String, String>,
}

/// Determines how file changes are grouped into commits.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum CommitStrategy {
    /// One commit per save operation.
    PerSave,
    /// Multiple changes batched into a single commit.
    Batched,
    /// User must explicitly trigger commits.
    Manual,
}

/// Result of a directory sync operation.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DirectorySyncResult {
    /// Repo-relative paths that were pushed (local -> remote).
    pub pushed: Vec<String>,
    /// Repo-relative paths that were pulled (remote -> local).
    pub pulled: Vec<String>,
    /// Files where local and remote diverged.
    pub conflicts: Vec<FileSyncConflict>,
    /// `(path, error_message)` pairs for files that failed.
    pub errors: Vec<(String, String)>,
}

/// A conflict detected during sync.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileSyncConflict {
    /// Repo-relative file path.
    pub path: String,
    /// Content from the local vault note.
    pub local_content: String,
    /// Content from the remote repository file.
    pub remote_content: String,
}

/// Status of GitHub CLI authentication.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitHubAuthStatus {
    /// Whether the user is authenticated via `gh auth`.
    pub authenticated: bool,
    /// The GitHub username if authenticated.
    pub username: Option<String>,
    /// Human-readable status message.
    pub message: String,
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/// Build a clean PATH that includes common binary locations (homebrew, etc.)
/// so CLI tools are found even when launched from macOS Dock.
fn enriched_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let extra = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        &home.join(".npm-global/bin").to_string_lossy().to_string(),
        &home.join(".bun/bin").to_string_lossy().to_string(),
        &home.join(".local/bin").to_string_lossy().to_string(),
    ];
    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<&str> = Vec::new();
    for p in &extra {
        if !current.contains(*p) {
            parts.push(p);
        }
    }
    parts.push(&current);
    parts.join(":")
}

/// Run a `git` CLI command in the given working directory.
async fn run_git(args: &[&str], work_dir: &Path) -> Result<String, PrismError> {
    debug!("git {}", args.join(" "));
    let output = Command::new("git")
        .args(args)
        .current_dir(work_dir)
        .env("PATH", enriched_path())
        .output()
        .await
        .map_err(|e| PrismError::Git(format!("Failed to run git: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(PrismError::Git(format!(
            "git {} failed: {stderr}",
            args.join(" ")
        )))
    }
}

/// Run a `gh` CLI command (not directory-specific).
async fn run_gh(args: &[&str]) -> Result<String, PrismError> {
    debug!("gh {}", args.join(" "));
    let output = Command::new("gh")
        .args(args)
        .env("PATH", enriched_path())
        .output()
        .await
        .map_err(|e| PrismError::Git(format!("Failed to run gh: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(PrismError::Git(format!(
            "gh {} failed: {stderr}",
            args.join(" ")
        )))
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Check whether the user is authenticated via `gh auth`.
pub async fn check_gh_auth() -> Result<GitHubAuthStatus, PrismError> {
    // `gh auth status` exits 0 when authenticated, 1 otherwise.
    // We also try `gh api user` to get the username cleanly.
    let output = Command::new("gh")
        .args(["auth", "status"])
        .env("PATH", enriched_path())
        .output()
        .await
        .map_err(|e| PrismError::Git(format!("Failed to run gh: {e}")))?;

    if output.status.success() {
        // Try to get the username
        let username = match Command::new("gh")
            .args(["api", "user", "--jq", ".login"])
            .env("PATH", enriched_path())
            .output()
            .await
        {
            Ok(o) if o.status.success() => {
                let name = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if name.is_empty() { None } else { Some(name) }
            }
            _ => None,
        };

        let msg = match &username {
            Some(u) => format!("Authenticated as @{u}"),
            None => "Authenticated".to_string(),
        };

        Ok(GitHubAuthStatus {
            authenticated: true,
            username,
            message: msg,
        })
    } else {
        Ok(GitHubAuthStatus {
            authenticated: false,
            username: None,
            message: "Not authenticated. Run `gh auth login` in your terminal.".to_string(),
        })
    }
}

/// Clone the repository (or fetch/pull if it already exists) and check out the
/// configured branch.
pub async fn init_clone(config: &DirectorySyncConfig) -> Result<(), PrismError> {
    if config.local_clone_path.exists() {
        info!(
            "Repo already cloned at {:?}, fetching latest",
            config.local_clone_path
        );
        // Fetch and checkout may fail on empty repos (no commits/branches yet) — that's fine.
        let _ = run_git(&["fetch", "origin"], &config.local_clone_path).await;
        let _ = run_git(&["checkout", &config.branch], &config.local_clone_path).await;
        let _ = run_git(&["pull", "--ff-only"], &config.local_clone_path).await;
        return Ok(());
    }

    // Fresh clone
    info!(
        "Cloning {} -> {:?}",
        config.remote_url, config.local_clone_path
    );

    // Ensure parent directory exists
    if let Some(parent) = config.local_clone_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let clone_path_str = config.local_clone_path.to_string_lossy().to_string();

    // Clone without specifying branch — the repo might be empty (no branches yet).
    // We'll checkout the target branch after if it exists.
    run_gh(&["repo", "clone", &config.remote_url, &clone_path_str])
        .await?;

    // If the repo isn't empty, try checking out the desired branch.
    // For empty repos this will fail silently, which is fine — the first
    // push will create the branch.
    let _ = run_git(&["checkout", &config.branch], &config.local_clone_path).await;

    info!("Clone complete");
    Ok(())
}

/// Perform a full bidirectional sync of the configured vault directory against
/// the GitHub repository.
///
/// Steps:
/// 1. Fetch and fast-forward from remote.
/// 2. For each note under `vault_path`, compare with the on-disk file.
/// 3. Write changed notes to disk and stage them.
/// 4. Detect files on disk with no matching note (pulled candidates).
/// 5. Commit staged changes and push.
pub async fn sync_directory(
    config: &DirectorySyncConfig,
    notes: &[Note],
    _parachute: &crate::clients::parachute::ParachuteClient,
) -> Result<DirectorySyncResult, PrismError> {
    let clone_path = &config.local_clone_path;

    // 1. Fetch and fast-forward (may fail on empty repos with no commits yet)
    let _ = run_git(&["fetch", "origin"], clone_path).await;
    let _ = run_git(&["pull", "--ff-only"], clone_path).await;

    let mut result = DirectorySyncResult {
        pushed: Vec::new(),
        pulled: Vec::new(),
        conflicts: Vec::new(),
        errors: Vec::new(),
    };

    let mut staged_any = false;

    // Collect repo-relative paths from notes for later diffing
    let mut note_repo_paths: HashMap<String, &Note> = HashMap::new();

    // 2-3. Process each note
    for note in notes {
        let note_path = match &note.path {
            Some(p) => p.as_str(),
            None => continue,
        };

        // Only sync notes under the configured vault path
        if !note_path.starts_with(&config.vault_path) {
            continue;
        }

        let repo_rel = map_vault_path_to_repo_path(note_path, config);
        note_repo_paths.insert(repo_rel.clone(), note);

        let disk_path = clone_path.join(&repo_rel);

        // Read existing file content (if any)
        let disk_content = if disk_path.exists() {
            match fs::read_to_string(&disk_path) {
                Ok(c) => Some(c),
                Err(e) => {
                    result
                        .errors
                        .push((repo_rel.clone(), format!("Read error: {e}")));
                    continue;
                }
            }
        } else {
            None
        };

        match disk_content {
            Some(existing) if existing == note.content => {
                // No change
                debug!("No change for {repo_rel}");
            }
            Some(_existing) => {
                // Content differs — decide based on conflict strategy
                if config.conflict_strategy == "remote-wins" {
                    result.pulled.push(repo_rel.clone());
                } else {
                    // local-wins: overwrite disk, stage
                    write_file(clone_path, &repo_rel, &note.content)?;
                    run_git(&["add", &repo_rel], clone_path).await?;
                    result.pushed.push(repo_rel.clone());
                    staged_any = true;
                }
            }
            None => {
                // New file — write and stage
                write_file(clone_path, &repo_rel, &note.content)?;
                run_git(&["add", &repo_rel], clone_path).await?;
                result.pushed.push(repo_rel.clone());
                staged_any = true;
            }
        }
    }

    // 4. Detect files in repo not matching any note (pulled candidates)
    scan_unmatched_files(
        clone_path,
        clone_path,
        &note_repo_paths,
        &config.file_extension,
        &mut result.pulled,
    )?;

    // 5. Commit and push if there are staged changes
    if staged_any {
        let message = format!(
            "Prism sync: {} file(s) updated",
            result.pushed.len()
        );
        run_git(&["commit", "-m", &message, "--author", "Prism Sync <prism@local>"], clone_path).await?;

        // Try normal push first; if it fails (e.g. empty repo with no upstream),
        // fall back to setting the upstream branch.
        let push_target = format!("HEAD:{}", config.branch);
        if run_git(&["push", "origin", &config.branch], clone_path).await.is_err() {
            run_git(&["push", "-u", "origin", &push_target], clone_path).await?;
        }
        info!("Pushed {} file(s) to remote", result.pushed.len());
    } else {
        debug!("No staged changes to commit");
    }

    Ok(result)
}

/// Push a single note to the repository immediately (used with `PerSave`
/// commit strategy).
pub async fn push_single_file(
    config: &DirectorySyncConfig,
    note: &Note,
) -> Result<(), PrismError> {
    let note_path = note
        .path
        .as_deref()
        .ok_or_else(|| PrismError::Git("Note has no path".into()))?;

    let clone_path = &config.local_clone_path;
    let repo_rel = map_vault_path_to_repo_path(note_path, config);

    write_file(clone_path, &repo_rel, &note.content)?;
    run_git(&["add", &repo_rel], clone_path).await?;

    let filename = Path::new(&repo_rel)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| repo_rel.clone());

    let message = format!("Update {filename}");
    run_git(&["commit", "-m", &message, "--author", "Prism Sync <prism@local>"], clone_path).await?;

    // Handle empty repo case where upstream branch doesn't exist yet.
    let push_target = format!("HEAD:{}", config.branch);
    if run_git(&["push", "origin", &config.branch], clone_path).await.is_err() {
        run_git(&["push", "-u", "origin", &push_target], clone_path).await?;
    }

    info!("Pushed single file: {repo_rel}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Map a vault note path to a repo-relative file path.
///
/// Strips the `config.vault_path` prefix and appends `config.file_extension`
/// when the remaining path has no extension.
fn map_vault_path_to_repo_path(vault_path: &str, config: &DirectorySyncConfig) -> String {
    let stripped = vault_path
        .strip_prefix(&config.vault_path)
        .unwrap_or(vault_path)
        .trim_start_matches('/');

    let p = Path::new(stripped);
    if p.extension().is_some() {
        stripped.to_string()
    } else {
        format!("{stripped}{}", config.file_extension)
    }
}

/// Write content to a file on disk, creating parent directories as needed.
fn write_file(clone_root: &Path, repo_rel: &str, content: &str) -> Result<(), PrismError> {
    let disk_path = clone_root.join(repo_rel);

    if let Some(parent) = disk_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(&disk_path, content)?;
    Ok(())
}

/// Recursively scan files in the clone directory and collect paths that don't
/// correspond to any known vault note (candidates for pulling into the vault).
fn scan_unmatched_files(
    root: &Path,
    dir: &Path,
    known: &HashMap<String, &Note>,
    extension: &str,
    pulled: &mut Vec<String>,
) -> Result<(), PrismError> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    for entry in entries {
        let entry = entry?;
        let path = entry.path();

        // Skip the .git directory
        if path
            .file_name()
            .map(|n| n == ".git")
            .unwrap_or(false)
        {
            continue;
        }

        if path.is_dir() {
            scan_unmatched_files(root, &path, known, extension, pulled)?;
        } else {
            // Only consider files with the expected extension
            let ext_match = path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()) == extension)
                .unwrap_or(false);

            if !ext_match {
                continue;
            }

            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            if !known.contains_key(&rel) {
                pulled.push(rel);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_map_vault_path_strips_prefix() {
        let config = DirectorySyncConfig {
            id: "test".into(),
            vault_path: "vault/projects/docs".into(),
            remote_url: String::new(),
            branch: "main".into(),
            local_clone_path: PathBuf::from("/tmp/test"),
            commit_strategy: CommitStrategy::Batched,
            conflict_strategy: "local-wins".into(),
            last_synced: String::new(),
            auto_sync: false,
            file_extension: ".md".into(),
            id_map: HashMap::new(),
        };

        assert_eq!(
            map_vault_path_to_repo_path("vault/projects/docs/readme", &config),
            "readme.md"
        );
        assert_eq!(
            map_vault_path_to_repo_path("vault/projects/docs/sub/page", &config),
            "sub/page.md"
        );
        assert_eq!(
            map_vault_path_to_repo_path("vault/projects/docs/file.txt", &config),
            "file.txt"
        );
    }

    #[test]
    fn test_map_vault_path_handles_leading_slash() {
        let config = DirectorySyncConfig {
            id: "test".into(),
            vault_path: "vault/docs".into(),
            remote_url: String::new(),
            branch: "main".into(),
            local_clone_path: PathBuf::from("/tmp/test"),
            commit_strategy: CommitStrategy::PerSave,
            conflict_strategy: "local-wins".into(),
            last_synced: String::new(),
            auto_sync: false,
            file_extension: ".md".into(),
            id_map: HashMap::new(),
        };

        assert_eq!(
            map_vault_path_to_repo_path("vault/docs/intro", &config),
            "intro.md"
        );
    }
}
