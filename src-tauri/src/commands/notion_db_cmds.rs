use std::collections::HashMap;
use tauri::State;
use serde::{Serialize, Deserialize};

use crate::commands::config::AppConfig;
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::sync::adapters::notion_db::{
    NotionDatabaseAdapter, NotionDatabaseInfo, NotionDbSyncConfig,
    NotionDbSyncResult, PropertyMapping, PropertySchema,
};

// ─── Managed state ──────────────────────────────────────────

pub struct NotionDbSyncState {
    pub configs: std::sync::Mutex<HashMap<String, NotionDbSyncConfig>>,
}

impl NotionDbSyncState {
    pub fn new() -> Self {
        Self {
            configs: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

// ─── Response types ─────────────────────────────────────────

/// Schema and auto-discovered property mappings for a Notion database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionDbSchemaResponse {
    pub properties: Vec<PropertySchema>,
    pub suggested_mappings: Vec<PropertyMapping>,
}

/// Summary info for an active database sync configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionDbSyncInfo {
    pub id: String,
    pub notion_database_name: String,
    pub parachute_tag: String,
    pub last_synced: String,
    pub auto_sync: bool,
    pub synced_count: usize,
}

// ─── Commands ───────────────────────────────────────────────

/// List all Notion databases accessible to the configured integration.
#[tauri::command]
pub async fn notion_db_list(
    app_config: State<'_, AppConfig>,
) -> Result<Vec<NotionDatabaseInfo>, PrismError> {
    if app_config.notion_api_key.is_empty() {
        return Err(PrismError::Notion("Notion API key not configured".into()));
    }

    let adapter = NotionDatabaseAdapter::new(app_config.notion_api_key.clone());
    adapter.list_databases().await
}

/// Get the schema of a Notion database along with auto-discovered property mappings.
#[tauri::command]
pub async fn notion_db_schema(
    app_config: State<'_, AppConfig>,
    database_id: String,
) -> Result<NotionDbSchemaResponse, PrismError> {
    if app_config.notion_api_key.is_empty() {
        return Err(PrismError::Notion("Notion API key not configured".into()));
    }

    let adapter = NotionDatabaseAdapter::new(app_config.notion_api_key.clone());
    let properties = adapter.get_database_schema(&database_id).await?;
    let suggested_mappings = adapter.auto_discover_mappings(&database_id).await?;

    Ok(NotionDbSchemaResponse {
        properties,
        suggested_mappings,
    })
}

/// Initialize a new Notion database sync configuration.
/// Returns the generated config ID.
#[tauri::command]
pub async fn notion_db_sync_init(
    sync_state: State<'_, NotionDbSyncState>,
    database_id: String,
    database_name: String,
    parachute_tag: String,
    parachute_path_prefix: String,
    property_map: Vec<PropertyMapping>,
    title_property: String,
    content_property: Option<String>,
    sync_direction: String,
    conflict_strategy: String,
    auto_sync: bool,
) -> Result<String, PrismError> {
    let id = uuid::Uuid::new_v4().to_string();

    let config = NotionDbSyncConfig {
        id: id.clone(),
        notion_database_id: database_id,
        notion_database_name: database_name,
        parachute_tag,
        parachute_path_prefix,
        property_map,
        title_property,
        content_property,
        sync_direction,
        conflict_strategy,
        last_synced: String::new(),
        auto_sync,
        id_map: HashMap::new(),
    };

    let mut configs = sync_state.configs.lock()
        .map_err(|e| PrismError::Other(format!("Failed to lock sync state: {}", e)))?;
    configs.insert(id.clone(), config);

    Ok(id)
}

/// Run sync for a configured Notion database.
/// Calls pull, push, or both based on the configured sync_direction.
#[tauri::command]
pub async fn notion_db_sync(
    sync_state: State<'_, NotionDbSyncState>,
    app_config: State<'_, AppConfig>,
    parachute: State<'_, ParachuteClient>,
    config_id: String,
) -> Result<NotionDbSyncResult, PrismError> {
    if app_config.notion_api_key.is_empty() {
        return Err(PrismError::Notion("Notion API key not configured".into()));
    }

    // Clone config out of the lock so we can use it across await points
    let mut config = {
        let configs = sync_state.configs.lock()
            .map_err(|e| PrismError::Other(format!("Failed to lock sync state: {}", e)))?;
        configs.get(&config_id)
            .cloned()
            .ok_or_else(|| PrismError::Other(format!("Sync config '{}' not found", config_id)))?
    };

    let adapter = NotionDatabaseAdapter::new(app_config.notion_api_key.clone());
    let direction = config.sync_direction.clone();

    let mut result = NotionDbSyncResult {
        created: 0,
        updated: 0,
        deleted: 0,
        conflicts: 0,
        errors: Vec::new(),
    };

    // Pull phase
    if direction == "pull" || direction == "bidirectional" {
        match adapter.pull_from_notion(&mut config, &parachute).await {
            Ok(pull_result) => {
                result.created += pull_result.created;
                result.updated += pull_result.updated;
                result.deleted += pull_result.deleted;
                result.conflicts += pull_result.conflicts;
                result.errors.extend(pull_result.errors);
            }
            Err(e) => {
                result.errors.push(format!("Pull failed: {}", e));
            }
        }
    }

    // Push phase
    if direction == "push" || direction == "bidirectional" {
        match adapter.push_to_notion(&mut config, &parachute).await {
            Ok(push_result) => {
                result.created += push_result.created;
                result.updated += push_result.updated;
                result.deleted += push_result.deleted;
                result.conflicts += push_result.conflicts;
                result.errors.extend(push_result.errors);
            }
            Err(e) => {
                result.errors.push(format!("Push failed: {}", e));
            }
        }
    }

    // Update last_synced and store the (possibly mutated) config back
    config.last_synced = chrono::Utc::now().to_rfc3339();
    {
        let mut configs = sync_state.configs.lock()
            .map_err(|e| PrismError::Other(format!("Failed to lock sync state: {}", e)))?;
        configs.insert(config_id, config);
    }

    Ok(result)
}

/// Get status info for all active Notion database sync configurations.
#[tauri::command]
pub async fn notion_db_sync_status(
    sync_state: State<'_, NotionDbSyncState>,
) -> Result<Vec<NotionDbSyncInfo>, PrismError> {
    let configs = sync_state.configs.lock()
        .map_err(|e| PrismError::Other(format!("Failed to lock sync state: {}", e)))?;

    Ok(configs.values().map(|c| NotionDbSyncInfo {
        id: c.id.clone(),
        notion_database_name: c.notion_database_name.clone(),
        parachute_tag: c.parachute_tag.clone(),
        last_synced: c.last_synced.clone(),
        auto_sync: c.auto_sync,
        synced_count: c.id_map.len(),
    }).collect())
}

/// Remove a Notion database sync configuration by ID.
#[tauri::command]
pub async fn notion_db_sync_remove(
    sync_state: State<'_, NotionDbSyncState>,
    config_id: String,
) -> Result<(), PrismError> {
    let mut configs = sync_state.configs.lock()
        .map_err(|e| PrismError::Other(format!("Failed to lock sync state: {}", e)))?;

    if configs.remove(&config_id).is_none() {
        return Err(PrismError::Other(format!("Sync config '{}' not found", config_id)));
    }

    Ok(())
}
