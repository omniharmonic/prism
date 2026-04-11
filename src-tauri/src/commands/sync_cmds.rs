use tauri::State;
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::sync_config::*;

/// Trigger sync for all configured destinations on a note
#[tauri::command]
pub async fn sync_trigger(
    parachute: State<'_, ParachuteClient>,
    note_id: String,
) -> Result<Vec<SyncResult>, PrismError> {
    let note = parachute.get_note(&note_id).await?;
    let meta = note.metadata.as_ref()
        .and_then(|m| m.as_object())
        .ok_or_else(|| PrismError::Other("Note has no metadata".into()))?;

    let sync_configs: Vec<SyncConfig> = meta
        .get("sync")
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    if sync_configs.is_empty() {
        return Err(PrismError::Other("No sync destinations configured".into()));
    }

    let mut results = Vec::new();
    for config in &sync_configs {
        // In production, instantiate the correct adapter based on config.adapter
        // For now, return a placeholder result
        results.push(SyncResult::Error {
            message: format!(
                "Sync adapter '{}' not yet configured. Set up OAuth/API keys in Settings.",
                config.adapter,
            ),
        });
    }

    Ok(results)
}

/// Get sync status for all destinations on a note
#[tauri::command]
pub async fn sync_status(
    parachute: State<'_, ParachuteClient>,
    note_id: String,
) -> Result<Vec<SyncStatus>, PrismError> {
    let note = parachute.get_note(&note_id).await?;
    let meta = note.metadata.as_ref()
        .and_then(|m| m.as_object());

    let sync_configs: Vec<SyncConfig> = meta
        .and_then(|m| m.get("sync"))
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    Ok(sync_configs
        .iter()
        .map(|config| SyncStatus {
            adapter: config.adapter.clone(),
            remote_id: config.remote_id.clone(),
            state: if config.last_synced.is_empty() {
                SyncState::NeverSynced
            } else {
                SyncState::Synced
            },
            last_synced: if config.last_synced.is_empty() {
                None
            } else {
                Some(config.last_synced.clone())
            },
            error: None,
        })
        .collect())
}

/// Add a sync destination to a note
#[tauri::command]
pub async fn sync_add_config(
    parachute: State<'_, ParachuteClient>,
    note_id: String,
    adapter: String,
    direction: Option<String>,
    auto_sync: Option<bool>,
) -> Result<(), PrismError> {
    let note = parachute.get_note(&note_id).await?;
    let mut meta = note.metadata.clone().unwrap_or(serde_json::json!({}));
    let obj = meta.as_object_mut()
        .ok_or_else(|| PrismError::Other("Metadata is not an object".into()))?;

    let mut sync_configs: Vec<SyncConfig> = obj
        .get("sync")
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    let new_config = SyncConfig {
        adapter,
        remote_id: String::new(), // Will be set after first sync creates the remote
        last_synced: String::new(),
        direction: direction.unwrap_or_else(|| "bidirectional".into()),
        conflict_strategy: "ask".into(),
        auto_sync: auto_sync.unwrap_or(false),
    };

    sync_configs.push(new_config);
    obj.insert("sync".to_string(), serde_json::to_value(&sync_configs)?);

    parachute
        .update_note(
            &note_id,
            &crate::models::note::UpdateNoteParams {
                content: None,
                path: None,
                metadata: Some(meta),
            },
        )
        .await?;

    Ok(())
}

/// Remove a sync destination from a note
#[tauri::command]
pub async fn sync_remove_config(
    parachute: State<'_, ParachuteClient>,
    note_id: String,
    adapter: String,
    remote_id: String,
) -> Result<(), PrismError> {
    let note = parachute.get_note(&note_id).await?;
    let mut meta = note.metadata.clone().unwrap_or(serde_json::json!({}));
    let obj = meta.as_object_mut()
        .ok_or_else(|| PrismError::Other("Metadata is not an object".into()))?;

    let mut sync_configs: Vec<SyncConfig> = obj
        .get("sync")
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    sync_configs.retain(|c| !(c.adapter == adapter && c.remote_id == remote_id));
    obj.insert("sync".to_string(), serde_json::to_value(&sync_configs)?);

    parachute
        .update_note(
            &note_id,
            &crate::models::note::UpdateNoteParams {
                content: None,
                path: None,
                metadata: Some(meta),
            },
        )
        .await?;

    Ok(())
}

/// Resolve a sync conflict
#[tauri::command]
pub async fn sync_resolve_conflict(
    parachute: State<'_, ParachuteClient>,
    note_id: String,
    _adapter: String,
    resolution: String,
    merged_content: Option<String>,
) -> Result<(), PrismError> {
    match resolution.as_str() {
        "keep-local" => {
            // No action needed — local content stays, just trigger push
            Ok(())
        }
        "keep-remote" | "merge" => {
            if let Some(content) = merged_content {
                parachute
                    .update_note(
                        &note_id,
                        &crate::models::note::UpdateNoteParams {
                            content: Some(content),
                            path: None,
                            metadata: None,
                        },
                    )
                    .await?;
            }
            Ok(())
        }
        _ => Err(PrismError::Other(format!(
            "Unknown resolution: {}",
            resolution
        ))),
    }
}
