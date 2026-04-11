use tauri::State;
use crate::clients::parachute::ParachuteClient;
use crate::commands::config::AppConfig;
use crate::error::PrismError;
use crate::models::sync_config::*;
use crate::models::note::UpdateNoteParams;
use crate::sync::adapters::SyncAdapter;
use crate::sync::adapters::notion::NotionAdapter;
use crate::sync::engine::sync_note;

/// Trigger sync for all configured destinations on a note
#[tauri::command]
pub async fn sync_trigger(
    parachute: State<'_, ParachuteClient>,
    config: State<'_, AppConfig>,
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
    for sync_config in &sync_configs {
        let result = match sync_config.adapter.as_str() {
            "notion" => {
                if config.notion_api_key.is_empty() {
                    SyncResult::Error {
                        message: "Notion API key not configured. Check omniharmonic .env".into(),
                    }
                } else {
                    let adapter = NotionAdapter::new(config.notion_api_key.clone());
                    // If no remote_id yet, create the remote resource first
                    if sync_config.remote_id.is_empty() {
                        match adapter.create_remote(&note).await {
                            Ok(remote_id) => {
                                // Update the sync config with the new remote_id
                                let mut updated_config = sync_config.clone();
                                updated_config.remote_id = remote_id;
                                updated_config.last_synced = chrono::Utc::now().to_rfc3339();
                                update_sync_config(&parachute, &note_id, &note, &updated_config).await?;
                                SyncResult::Pushed { content: note.content.clone() }
                            }
                            Err(e) => SyncResult::Error { message: format!("Create failed: {}", e) },
                        }
                    } else {
                        match sync_note(&note, sync_config, &adapter, &parachute).await {
                            Ok(r) => r,
                            Err(e) => SyncResult::Error { message: e.to_string() },
                        }
                    }
                }
            }
            "google-docs" => {
                // Google Docs uses gog CLI for tokens — adapter's get_token needs fixing
                SyncResult::Error {
                    message: "Google Docs sync requires OAuth setup. Run 'gog auth login' first.".into(),
                }
            }
            other => SyncResult::Error {
                message: format!("Sync adapter '{}' not yet implemented.", other),
            },
        };
        results.push(result);
    }

    Ok(results)
}

/// Update a sync config in the note's metadata
async fn update_sync_config(
    parachute: &ParachuteClient,
    note_id: &str,
    note: &crate::models::note::Note,
    updated_config: &SyncConfig,
) -> Result<(), PrismError> {
    let mut meta = note.metadata.clone().unwrap_or(serde_json::json!({}));
    if let Some(obj) = meta.as_object_mut() {
        let mut configs: Vec<SyncConfig> = obj
            .get("sync")
            .and_then(|s| serde_json::from_value(s.clone()).ok())
            .unwrap_or_default();

        // Replace the matching config
        if let Some(existing) = configs.iter_mut().find(|c| c.adapter == updated_config.adapter) {
            *existing = updated_config.clone();
        }

        obj.insert("sync".to_string(), serde_json::to_value(&configs)?);
        parachute.update_note(note_id, &UpdateNoteParams {
            content: None, path: None, metadata: Some(meta),
        }).await?;
    }
    Ok(())
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
