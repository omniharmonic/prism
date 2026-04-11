use tauri::State;
use crate::clients::parachute::ParachuteClient;
use crate::clients::google::GoogleClient;
use crate::commands::config::AppConfig;
use crate::error::PrismError;
use crate::models::sync_config::*;
use crate::models::note::UpdateNoteParams;
use crate::sync::adapters::SyncAdapter;
use crate::sync::adapters::notion::NotionAdapter;

/// Trigger sync for all configured destinations on a note.
/// For Google Docs: converts HTML→markdown, creates doc if needed, pushes content.
/// Direction logic: "push" = local→remote, "pull" = remote→local, "bidirectional" = push (use pull_from_remote for pull).
#[tauri::command]
pub async fn sync_trigger(
    parachute: State<'_, ParachuteClient>,
    google_client: State<'_, GoogleClient>,
    config: State<'_, AppConfig>,
    note_id: String,
) -> Result<Vec<SyncResult>, PrismError> {
    // Re-read note fresh each time to avoid stale data
    let note = parachute.get_note(&note_id).await?;
    let sync_configs: Vec<SyncConfig> = note.metadata.as_ref()
        .and_then(|m| m.as_object())
        .and_then(|m| m.get("sync"))
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    if sync_configs.is_empty() {
        return Err(PrismError::Other("No sync destinations configured".into()));
    }

    // Convert content from HTML to markdown for external services
    let markdown_content = if note.content.contains('<') {
        let md = htmd::convert(&note.content).unwrap_or_default();
        if md.is_empty() { note.content.clone() } else { md }
    } else {
        note.content.clone()
    };

    let mut results = Vec::new();
    for sync_config in &sync_configs {
        let result = match sync_config.adapter.as_str() {
            "google-docs" => {
                sync_google_docs(
                    &google_client, &parachute, &config,
                    &note_id, &markdown_content, sync_config,
                ).await
            }
            "notion" => {
                if config.notion_api_key.is_empty() {
                    SyncResult::Error { message: "Notion API key not configured".into() }
                } else if sync_config.remote_id.is_empty() {
                    SyncResult::Error {
                        message: "Notion sync needs a parent page ID. Set remote_id first.".into(),
                    }
                } else {
                    let adapter = NotionAdapter::new(config.notion_api_key.clone());
                    match adapter.push(&note, sync_config).await {
                        Ok(r) => {
                            save_sync_timestamp(&parachute, &note_id, sync_config).await;
                            r
                        }
                        Err(e) => SyncResult::Error { message: e.to_string() },
                    }
                }
            }
            other => SyncResult::Error {
                message: format!("Adapter '{}' not implemented", other),
            },
        };
        results.push(result);
    }

    Ok(results)
}

/// Google Docs sync: create or push
async fn sync_google_docs(
    google: &GoogleClient,
    parachute: &ParachuteClient,
    config: &AppConfig,
    note_id: &str,
    content: &str,
    sync_config: &SyncConfig,
) -> SyncResult {
    let account = &config.google_account_primary;

    if sync_config.remote_id.is_empty() {
        // First sync — create new Google Doc
        let note = match parachute.get_note(note_id).await {
            Ok(n) => n,
            Err(e) => return SyncResult::Error { message: format!("Read failed: {}", e) },
        };
        let title = note.path.as_deref()
            .and_then(|p| p.split('/').last())
            .unwrap_or("Untitled");

        match google.docs_create(account, title) {
            Ok(doc_id) => {
                // Write content
                if let Err(e) = google.docs_write(account, &doc_id, content) {
                    return SyncResult::Error { message: format!("Write failed: {}", e) };
                }
                // Save the doc ID back to the note — do this with a fresh read to avoid conflicts
                if let Err(e) = save_remote_id(parachute, note_id, "google-docs", &doc_id).await {
                    log::error!("Failed to save remote_id: {}", e);
                }
                SyncResult::Pushed { content: content.to_string() }
            }
            Err(e) => SyncResult::Error { message: format!("Create failed: {}", e) },
        }
    } else {
        // Existing doc — push content
        match google.docs_write(account, &sync_config.remote_id, content) {
            Ok(()) => {
                save_sync_timestamp(parachute, note_id, sync_config).await;
                SyncResult::Pushed { content: content.to_string() }
            }
            Err(e) => SyncResult::Error { message: format!("Push failed: {}", e) },
        }
    }
}

/// Pull content from Google Docs into local note
#[tauri::command]
pub async fn sync_pull(
    parachute: State<'_, ParachuteClient>,
    google_client: State<'_, GoogleClient>,
    config: State<'_, AppConfig>,
    note_id: String,
) -> Result<SyncResult, PrismError> {
    let note = parachute.get_note(&note_id).await?;
    let sync_configs: Vec<SyncConfig> = note.metadata.as_ref()
        .and_then(|m| m.as_object())
        .and_then(|m| m.get("sync"))
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    // Find the first sync config with a remote_id (try google-docs first, then notion)
    let sync_config = sync_configs.iter()
        .find(|c| !c.remote_id.is_empty());

    match sync_config {
        Some(sc) => match sc.adapter.as_str() {
            "google-docs" => {
                let account = &config.google_account_primary;
                match google_client.docs_read(account, &sc.remote_id) {
                    Ok(remote_content) => {
                        parachute.update_note(&note_id, &UpdateNoteParams {
                            content: Some(remote_content.clone()),
                            ..Default::default()
                        }).await?;
                        save_sync_timestamp(&parachute, &note_id, sc).await;
                        Ok(SyncResult::Pulled { content: remote_content })
                    }
                    Err(e) => Ok(SyncResult::Error { message: format!("Pull failed: {}", e) }),
                }
            }
            "notion" => {
                if config.notion_api_key.is_empty() {
                    return Ok(SyncResult::Error { message: "Notion API key not configured".into() });
                }
                let adapter = NotionAdapter::new(config.notion_api_key.clone());
                match adapter.pull(&note, sc).await {
                    Ok(SyncResult::Pulled { content }) => {
                        parachute.update_note(&note_id, &UpdateNoteParams {
                            content: Some(content.clone()),
                            ..Default::default()
                        }).await?;
                        save_sync_timestamp(&parachute, &note_id, sc).await;
                        Ok(SyncResult::Pulled { content })
                    }
                    Ok(other) => Ok(other),
                    Err(e) => Ok(SyncResult::Error { message: format!("Notion pull failed: {}", e) }),
                }
            }
            other => Ok(SyncResult::Error { message: format!("Pull not supported for {}", other) }),
        },
        None => Ok(SyncResult::Error {
            message: "No sync destination configured with a remote ID".into(),
        }),
    }
}

/// Save the remote_id back to the note's sync config.
/// Re-reads the note fresh to avoid overwriting concurrent changes.
async fn save_remote_id(
    parachute: &ParachuteClient,
    note_id: &str,
    adapter: &str,
    remote_id: &str,
) -> Result<(), PrismError> {
    let note = parachute.get_note(note_id).await?;
    let mut meta = note.metadata.clone().unwrap_or(serde_json::json!({}));
    if let Some(obj) = meta.as_object_mut() {
        let mut configs: Vec<SyncConfig> = obj
            .get("sync")
            .and_then(|s| serde_json::from_value(s.clone()).ok())
            .unwrap_or_default();

        // Find the matching config and update its remote_id
        if let Some(c) = configs.iter_mut().find(|c| c.adapter == adapter && c.remote_id.is_empty()) {
            c.remote_id = remote_id.to_string();
            c.last_synced = chrono::Utc::now().to_rfc3339();
        }

        // Deduplicate: remove configs with same adapter and empty remote_id if one has a real ID
        let has_real_id: Vec<String> = configs.iter()
            .filter(|c| !c.remote_id.is_empty())
            .map(|c| c.adapter.clone())
            .collect();
        configs.retain(|c| !c.remote_id.is_empty() || !has_real_id.contains(&c.adapter));

        obj.insert("sync".to_string(), serde_json::to_value(&configs)?);
        parachute.update_note(note_id, &UpdateNoteParams {
            metadata: Some(meta),
            ..Default::default()
        }).await?;
    }
    Ok(())
}

/// Update the last_synced timestamp on a sync config
async fn save_sync_timestamp(parachute: &ParachuteClient, note_id: &str, sync_config: &SyncConfig) {
    if let Ok(note) = parachute.get_note(note_id).await {
        let mut meta = note.metadata.clone().unwrap_or(serde_json::json!({}));
        if let Some(obj) = meta.as_object_mut() {
            let mut configs: Vec<SyncConfig> = obj
                .get("sync")
                .and_then(|s| serde_json::from_value(s.clone()).ok())
                .unwrap_or_default();

            if let Some(c) = configs.iter_mut().find(|c| c.adapter == sync_config.adapter && c.remote_id == sync_config.remote_id) {
                c.last_synced = chrono::Utc::now().to_rfc3339();
            }

            obj.insert("sync".to_string(), serde_json::to_value(&configs).unwrap_or_default());
            let _ = parachute.update_note(note_id, &UpdateNoteParams {
                metadata: Some(meta),
                ..Default::default()
            }).await;
        }
    }
}

// ─── Unchanged commands below ────────────────────────────

#[tauri::command]
pub async fn sync_status(
    parachute: State<'_, ParachuteClient>,
    note_id: String,
) -> Result<Vec<SyncStatus>, PrismError> {
    let note = parachute.get_note(&note_id).await?;
    let sync_configs: Vec<SyncConfig> = note.metadata.as_ref()
        .and_then(|m| m.as_object())
        .and_then(|m| m.get("sync"))
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    Ok(sync_configs.iter().map(|c| SyncStatus {
        adapter: c.adapter.clone(),
        remote_id: c.remote_id.clone(),
        state: if c.last_synced.is_empty() { SyncState::NeverSynced } else { SyncState::Synced },
        last_synced: if c.last_synced.is_empty() { None } else { Some(c.last_synced.clone()) },
        error: None,
    }).collect())
}

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

    let mut configs: Vec<SyncConfig> = obj
        .get("sync")
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    // Don't add duplicate adapters
    if configs.iter().any(|c| c.adapter == adapter) {
        return Ok(()); // Already configured
    }

    configs.push(SyncConfig {
        adapter,
        remote_id: String::new(),
        last_synced: String::new(),
        direction: direction.unwrap_or_else(|| "bidirectional".into()),
        conflict_strategy: "ask".into(),
        auto_sync: auto_sync.unwrap_or(false),
    });

    obj.insert("sync".to_string(), serde_json::to_value(&configs)?);
    parachute.update_note(&note_id, &UpdateNoteParams {
        metadata: Some(meta),
        ..Default::default()
    }).await?;

    Ok(())
}

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

    let mut configs: Vec<SyncConfig> = obj
        .get("sync")
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default();

    configs.retain(|c| !(c.adapter == adapter && c.remote_id == remote_id));
    obj.insert("sync".to_string(), serde_json::to_value(&configs)?);

    parachute.update_note(&note_id, &UpdateNoteParams {
        metadata: Some(meta),
        ..Default::default()
    }).await?;

    Ok(())
}

#[tauri::command]
pub async fn sync_resolve_conflict(
    parachute: State<'_, ParachuteClient>,
    note_id: String,
    _adapter: String,
    resolution: String,
    merged_content: Option<String>,
) -> Result<(), PrismError> {
    if resolution == "keep-remote" || resolution == "merge" {
        if let Some(content) = merged_content {
            parachute.update_note(&note_id, &UpdateNoteParams {
                content: Some(content),
                ..Default::default()
            }).await?;
        }
    }
    Ok(())
}
