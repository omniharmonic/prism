use async_trait::async_trait;
use crate::clients::google::GoogleClient;
use crate::error::PrismError;
use crate::models::note::Note;
use crate::models::sync_config::{SyncConfig, SyncResult};
use super::SyncAdapter;

/// Sync adapter for Google Docs.
///
/// All Google operations are delegated to the `gog` CLI via `GoogleClient`,
/// which handles OAuth through its own keyring — Prism never manages tokens
/// directly. (See CLAUDE.md: "All external API calls happen in Rust clients".)
///
/// MVP approach: full content replacement (not diff-based).
pub struct GoogleDocsAdapter {
    client: GoogleClient,
    account: String,
}

impl GoogleDocsAdapter {
    pub fn new(client: GoogleClient, account: String) -> Self {
        Self { client, account }
    }
}

#[async_trait]
impl SyncAdapter for GoogleDocsAdapter {
    async fn push(&self, note: &Note, config: &SyncConfig) -> Result<SyncResult, PrismError> {
        // `gog docs write --replace` swaps the entire doc body in one call,
        // so there is no separate delete-then-insert dance to manage.
        self.client
            .docs_write(&self.account, &config.remote_id, &note.content)?;

        Ok(SyncResult::Pushed {
            content: note.content.clone(),
        })
    }

    async fn pull(&self, _note: &Note, config: &SyncConfig) -> Result<SyncResult, PrismError> {
        let content = self.client.docs_read(&self.account, &config.remote_id)?;
        Ok(SyncResult::Pulled { content })
    }

    async fn create_remote(&self, note: &Note) -> Result<String, PrismError> {
        let title = note
            .path
            .as_ref()
            .and_then(|p| p.split('/').last())
            .map(|name| name.trim_end_matches(".md"))
            .filter(|name| !name.is_empty())
            .unwrap_or("Untitled");

        let doc_id = self.client.docs_create(&self.account, title)?;

        // Seed the new doc with the note's content.
        if !note.content.is_empty() {
            self.client
                .docs_write(&self.account, &doc_id, &note.content)?;
        }

        Ok(doc_id)
    }

    async fn remote_modified_since(&self, config: &SyncConfig) -> Result<bool, PrismError> {
        let info = self.client.docs_info(&self.account, &config.remote_id)?;

        // `gog docs info --json` returns Drive file metadata. Depending on
        // gog's version the fields may be flat or nested under "file".
        let modified = info
            .get("modifiedTime")
            .or_else(|| info.get("file").and_then(|f| f.get("modifiedTime")))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        Ok(is_remote_newer(modified, &config.last_synced))
    }

    async fn get_remote_content(&self, config: &SyncConfig) -> Result<String, PrismError> {
        self.client.docs_read(&self.account, &config.remote_id)
    }
}

/// Returns true if the Google Doc has been modified since Prism last synced it.
///
/// Both inputs are RFC 3339 timestamps. `remote_modified` is empty if the
/// metadata call returned nothing useful; `last_synced` is empty on a config
/// that has never completed a sync.
///
/// Semantics chosen here (conservative — favours a redundant pull/conflict
/// check over silently missing a remote edit):
///   - empty `last_synced` (never synced) → treat remote as newer
///   - empty `remote_modified` (unknown)  → treat remote as newer
///   - otherwise compare as parsed instants, falling back to string compare
fn is_remote_newer(remote_modified: &str, last_synced: &str) -> bool {
    if last_synced.is_empty() || remote_modified.is_empty() {
        return true;
    }
    match (
        chrono::DateTime::parse_from_rfc3339(remote_modified),
        chrono::DateTime::parse_from_rfc3339(last_synced),
    ) {
        (Ok(remote), Ok(synced)) => remote > synced,
        // Unparseable timestamp — fall back to lexical compare rather than
        // claiming "unchanged" and risking a missed edit.
        _ => remote_modified > last_synced,
    }
}
