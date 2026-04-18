//! GitHub sync adapter for directory-level vault synchronization.
//!
//! Unlike the note-level `SyncAdapter` trait, this module syncs an entire
//! directory of Parachute vault notes to/from a GitHub repository, committing
//! changes on each sync cycle.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{Cred, FetchOptions, PushOptions, RemoteCallbacks, Repository};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};

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
    /// GitHub personal access token (passed in from keychain).
    pub auth_token: String,
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

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/// Build `RemoteCallbacks` that authenticate via a GitHub PAT.
fn make_callbacks(token: &str) -> RemoteCallbacks<'_> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(|_url, _username, _allowed| {
        Cred::userpass_plaintext("x-access-token", token)
    });
    callbacks
}

/// Build `FetchOptions` with token-based auth.
fn make_fetch_options(token: &str) -> FetchOptions<'_> {
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(make_callbacks(token));
    fo
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Clone the repository (or fetch if it already exists) and check out the
/// configured branch.
///
/// This should be called once when a sync binding is first set up, and can
/// safely be called again later to ensure the local clone is up to date.
pub fn init_clone(config: &DirectorySyncConfig) -> Result<(), PrismError> {
    if config.local_clone_path.exists() {
        info!(
            "Repo already cloned at {:?}, fetching latest",
            config.local_clone_path
        );
        let repo = Repository::open(&config.local_clone_path)
            .map_err(|e| PrismError::Git(format!("Failed to open repo: {e}")))?;

        // Fetch from origin
        let mut remote = repo
            .find_remote("origin")
            .map_err(|e| PrismError::Git(format!("No remote 'origin': {e}")))?;

        let mut fo = make_fetch_options(&config.auth_token);
        remote
            .fetch(&[&config.branch], Some(&mut fo), None)
            .map_err(|e| PrismError::Git(format!("Fetch failed: {e}")))?;

        checkout_branch(&repo, &config.branch)?;
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

    let mut builder = git2::build::RepoBuilder::new();
    let mut fo = make_fetch_options(&config.auth_token);
    builder.fetch_options(fo);
    builder.branch(&config.branch);

    builder
        .clone(&config.remote_url, &config.local_clone_path)
        .map_err(|e| PrismError::Git(format!("Clone failed: {e}")))?;

    info!("Clone complete");
    Ok(())
}

/// Perform a full bidirectional sync of the configured vault directory against
/// the GitHub repository.
///
/// Steps:
/// 1. Fetch latest from remote.
/// 2. For each note under `vault_path`, compare with the on-disk file.
/// 3. Write changed notes to disk and stage them.
/// 4. Detect files on disk with no matching note (pulled candidates).
/// 5. Commit staged changes and push.
pub fn sync_directory(
    config: &DirectorySyncConfig,
    notes: &[Note],
    _parachute: &crate::clients::parachute::ParachuteClient,
) -> Result<DirectorySyncResult, PrismError> {
    let repo = Repository::open(&config.local_clone_path)
        .map_err(|e| PrismError::Git(format!("Failed to open repo: {e}")))?;

    // 1. Fetch
    {
        let mut remote = repo
            .find_remote("origin")
            .map_err(|e| PrismError::Git(format!("No remote 'origin': {e}")))?;
        let mut fo = make_fetch_options(&config.auth_token);
        remote
            .fetch(&[&config.branch], Some(&mut fo), None)
            .map_err(|e| PrismError::Git(format!("Fetch failed: {e}")))?;
    }

    // Fast-forward local branch to FETCH_HEAD if possible
    fast_forward_to_fetch_head(&repo, &config.branch)?;

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

        let disk_path = config.local_clone_path.join(&repo_rel);

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
            Some(existing) => {
                // Content differs — decide based on conflict strategy
                // For now, local (vault) wins by default
                if config.conflict_strategy == "remote-wins" {
                    // Remote content is newer; flag as pulled
                    result.pulled.push(repo_rel.clone());
                } else {
                    // local-wins: overwrite disk, stage
                    write_and_stage(&repo, &config.local_clone_path, &repo_rel, &note.content)?;
                    result.pushed.push(repo_rel.clone());
                    staged_any = true;
                }
            }
            None => {
                // New file — write and stage
                write_and_stage(&repo, &config.local_clone_path, &repo_rel, &note.content)?;
                result.pushed.push(repo_rel.clone());
                staged_any = true;
            }
        }
    }

    // 4. Detect files in repo not matching any note (pulled candidates)
    scan_unmatched_files(
        &config.local_clone_path,
        &config.local_clone_path,
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
        create_commit(&repo, &message, config)?;
        push_to_remote(&repo, &config.branch, &config.auth_token)?;
        info!("Pushed {} file(s) to remote", result.pushed.len());
    } else {
        debug!("No staged changes to commit");
    }

    Ok(result)
}

/// Push a single note to the repository immediately (used with `PerSave`
/// commit strategy).
///
/// Opens the repo, writes the note content to the mapped file, commits, and
/// pushes in one shot.
pub fn push_single_file(
    config: &DirectorySyncConfig,
    note: &Note,
) -> Result<(), PrismError> {
    let note_path = note
        .path
        .as_deref()
        .ok_or_else(|| PrismError::Git("Note has no path".into()))?;

    let repo = Repository::open(&config.local_clone_path)
        .map_err(|e| PrismError::Git(format!("Failed to open repo: {e}")))?;

    let repo_rel = map_vault_path_to_repo_path(note_path, config);

    write_and_stage(&repo, &config.local_clone_path, &repo_rel, &note.content)?;

    let filename = Path::new(&repo_rel)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| repo_rel.clone());

    let message = format!("Update {filename}");
    create_commit(&repo, &message, config)?;
    push_to_remote(&repo, &config.branch, &config.auth_token)?;

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

/// Write content to a file on disk and stage it in the repository index.
fn write_and_stage(
    repo: &Repository,
    clone_root: &Path,
    repo_rel: &str,
    content: &str,
) -> Result<(), PrismError> {
    let disk_path = clone_root.join(repo_rel);

    // Ensure parent directories exist
    if let Some(parent) = disk_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(&disk_path, content)?;

    let mut index = repo
        .index()
        .map_err(|e| PrismError::Git(format!("Failed to get index: {e}")))?;

    index
        .add_path(Path::new(repo_rel))
        .map_err(|e| PrismError::Git(format!("Failed to stage {repo_rel}: {e}")))?;

    index
        .write()
        .map_err(|e| PrismError::Git(format!("Failed to write index: {e}")))?;

    Ok(())
}

/// Create a commit on the current branch from the current index state.
///
/// Committer and author are both set to `"Prism Sync" <prism@local>`.
fn create_commit(
    repo: &Repository,
    message: &str,
    _config: &DirectorySyncConfig,
) -> Result<git2::Oid, PrismError> {
    let sig = git2::Signature::now("Prism Sync", "prism@local")
        .map_err(|e| PrismError::Git(format!("Failed to create signature: {e}")))?;

    let mut index = repo
        .index()
        .map_err(|e| PrismError::Git(format!("Failed to get index: {e}")))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| PrismError::Git(format!("Failed to write tree: {e}")))?;

    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| PrismError::Git(format!("Failed to find tree: {e}")))?;

    // Get parent commit (HEAD), if any
    let parent_commit = match repo.head() {
        Ok(head) => {
            let oid = head
                .target()
                .ok_or_else(|| PrismError::Git("HEAD has no target".into()))?;
            Some(
                repo.find_commit(oid)
                    .map_err(|e| PrismError::Git(format!("Failed to find HEAD commit: {e}")))?,
            )
        }
        Err(_) => None,
    };

    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| PrismError::Git(format!("Commit failed: {e}")))?;

    debug!("Created commit {oid}");
    Ok(oid)
}

/// Push the current branch to the `origin` remote.
fn push_to_remote(
    repo: &Repository,
    branch: &str,
    token: &str,
) -> Result<(), PrismError> {
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| PrismError::Git(format!("No remote 'origin': {e}")))?;

    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");

    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(make_callbacks(token));

    remote
        .push(&[&refspec], Some(&mut push_opts))
        .map_err(|e| PrismError::Git(format!("Push failed: {e}")))?;

    Ok(())
}

/// Check out a local branch, creating it from the remote tracking branch if it
/// doesn't exist yet.
fn checkout_branch(repo: &Repository, branch: &str) -> Result<(), PrismError> {
    let refname = format!("refs/heads/{branch}");

    // If the branch doesn't exist locally, create it from origin/<branch>
    if repo.find_reference(&refname).is_err() {
        let remote_ref = format!("refs/remotes/origin/{branch}");
        let remote_oid = repo
            .find_reference(&remote_ref)
            .map_err(|e| PrismError::Git(format!("Remote branch not found: {e}")))?
            .target()
            .ok_or_else(|| PrismError::Git("Remote ref has no target".into()))?;

        let commit = repo
            .find_commit(remote_oid)
            .map_err(|e| PrismError::Git(format!("Failed to find commit: {e}")))?;

        repo.branch(branch, &commit, false)
            .map_err(|e| PrismError::Git(format!("Failed to create branch: {e}")))?;
    }

    // Set HEAD and checkout
    repo.set_head(&refname)
        .map_err(|e| PrismError::Git(format!("Failed to set HEAD: {e}")))?;

    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(|e| PrismError::Git(format!("Checkout failed: {e}")))?;

    Ok(())
}

/// Attempt a fast-forward merge of the local branch to match FETCH_HEAD.
fn fast_forward_to_fetch_head(repo: &Repository, branch: &str) -> Result<(), PrismError> {
    let fetch_head = match repo.find_reference("FETCH_HEAD") {
        Ok(r) => r,
        Err(_) => {
            debug!("No FETCH_HEAD found, skipping fast-forward");
            return Ok(());
        }
    };

    let fetch_oid = match fetch_head.target() {
        Some(oid) => oid,
        None => return Ok(()),
    };

    let refname = format!("refs/heads/{branch}");
    let local_ref = match repo.find_reference(&refname) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };

    let local_oid = match local_ref.target() {
        Some(oid) => oid,
        None => return Ok(()),
    };

    if local_oid == fetch_oid {
        return Ok(());
    }

    // Check if fast-forward is possible (local is ancestor of fetch)
    let can_ff = repo
        .graph_descendant_of(fetch_oid, local_oid)
        .unwrap_or(false);

    if can_ff {
        let mut reference = repo
            .find_reference(&refname)
            .map_err(|e| PrismError::Git(format!("Ref lookup failed: {e}")))?;
        reference
            .set_target(fetch_oid, "fast-forward from Prism sync")
            .map_err(|e| PrismError::Git(format!("Fast-forward failed: {e}")))?;

        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .map_err(|e| PrismError::Git(format!("Checkout after ff failed: {e}")))?;

        info!("Fast-forwarded {branch} to {fetch_oid}");
    } else {
        warn!("Cannot fast-forward {branch}; local and remote have diverged");
    }

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
            auth_token: String::new(),
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
            auth_token: String::new(),
            commit_strategy: CommitStrategy::PerSave,
            conflict_strategy: "local-wins".into(),
            last_synced: String::new(),
            auto_sync: false,
            file_extension: ".md".into(),
            id_map: HashMap::new(),
        };

        // After stripping "vault/docs" from "vault/docs/intro", we get "/intro"
        // which should be trimmed to "intro"
        assert_eq!(
            map_vault_path_to_repo_path("vault/docs/intro", &config),
            "intro.md"
        );
    }
}
