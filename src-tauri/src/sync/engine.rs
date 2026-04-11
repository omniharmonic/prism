use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::{Note, UpdateNoteParams};
use crate::models::sync_config::{SyncConfig, SyncResult};
use super::adapters::SyncAdapter;

/// Core sync coordinator. Handles the four-way sync matrix:
/// - No change: skip
/// - Local only: push to remote
/// - Remote only: pull to local
/// - Both changed: resolve conflict per config strategy
pub async fn sync_note(
    note: &Note,
    config: &SyncConfig,
    adapter: &dyn SyncAdapter,
    parachute: &ParachuteClient,
) -> Result<SyncResult, PrismError> {
    let local_changed = note
        .updated_at
        .as_ref()
        .map(|u| u > &config.last_synced)
        .unwrap_or(false);

    let remote_changed = adapter.remote_modified_since(config).await?;

    match (local_changed, remote_changed) {
        // Nothing changed
        (false, false) => Ok(SyncResult::NoChange),

        // Only local changed — push
        (true, false) => adapter.push(note, config).await,

        // Only remote changed — pull and update local
        (false, true) => {
            let result = adapter.pull(note, config).await?;
            if let SyncResult::Pulled { ref content } = result {
                parachute
                    .update_note(
                        &note.id,
                        &UpdateNoteParams {
                            content: Some(content.clone()),
                            path: None,
                            metadata: None,
                        },
                    )
                    .await?;
            }
            Ok(result)
        }

        // Both changed — conflict
        (true, true) => match config.conflict_strategy.as_str() {
            "local-wins" => adapter.push(note, config).await,
            "remote-wins" => {
                let result = adapter.pull(note, config).await?;
                if let SyncResult::Pulled { ref content } = result {
                    parachute
                        .update_note(
                            &note.id,
                            &UpdateNoteParams {
                                content: Some(content.clone()),
                                path: None,
                                metadata: None,
                            },
                        )
                        .await?;
                }
                Ok(result)
            }
            _ => {
                // "ask" — return conflict with both versions for user resolution
                let remote = adapter.get_remote_content(config).await?;
                Ok(SyncResult::Conflict {
                    local: note.content.clone(),
                    remote,
                })
            }
        },
    }
}
