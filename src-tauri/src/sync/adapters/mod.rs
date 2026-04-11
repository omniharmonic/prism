pub mod google_docs;
pub mod notion;

use async_trait::async_trait;
use crate::models::note::Note;
use crate::models::sync_config::{SyncConfig, SyncResult};
use crate::error::PrismError;

/// Every external sync destination implements this trait.
/// The sync engine calls these methods to push/pull content.
#[async_trait]
pub trait SyncAdapter: Send + Sync {
    /// Push local content to remote
    async fn push(&self, note: &Note, config: &SyncConfig) -> Result<SyncResult, PrismError>;

    /// Pull remote content to local
    async fn pull(&self, note: &Note, config: &SyncConfig) -> Result<SyncResult, PrismError>;

    /// Create a new remote resource from a local note (first sync)
    async fn create_remote(&self, note: &Note) -> Result<String, PrismError>;

    /// Check if remote has changed since last sync
    async fn remote_modified_since(&self, config: &SyncConfig) -> Result<bool, PrismError>;

    /// Get remote content for conflict resolution
    async fn get_remote_content(&self, config: &SyncConfig) -> Result<String, PrismError>;
}
