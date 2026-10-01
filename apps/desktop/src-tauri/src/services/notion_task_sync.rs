//! Notion DB sync config persistence + presets. The idle background loop that
//! used to live here was retired in WP1.4; syncs now run only when the user
//! invokes `notion_db_sync` (commands/notion_db_cmds.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use crate::sync::adapters::notion_db::{NotionDbSyncConfig, PropertyMapping};

/// Persistent storage for Notion DB sync configurations.
fn configs_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("prism")
        .join("notion-sync-configs.json")
}

pub fn load_configs() -> HashMap<String, NotionDbSyncConfig> {
    let path = configs_path();
    if !path.exists() {
        return HashMap::new();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(e) => {
            log::warn!("Failed to load Notion sync configs: {}", e);
            HashMap::new()
        }
    }
}

pub fn save_configs(configs: &HashMap<String, NotionDbSyncConfig>) {
    let path = configs_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(configs) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::warn!("Failed to save Notion sync configs: {}", e);
            }
        }
        Err(e) => log::warn!("Failed to serialize Notion sync configs: {}", e),
    }
}

/// Create a pre-configured sync for a Notion tasks database.
/// Returns the config ID. Call `save_configs` after to persist.
pub fn create_task_sync_config(
    database_id: &str,
    database_name: &str,
    status_value_map: HashMap<String, String>,
) -> NotionDbSyncConfig {
    let id = uuid::Uuid::new_v4().to_string();

    // Standard task property mappings
    let property_map = vec![
        PropertyMapping {
            notion_property: "Status".into(),
            notion_type: "status".into(),
            parachute_field: "status".into(),
            transform: "value_map".into(),
            value_map: status_value_map,
            relationship_type: None,
        },
        PropertyMapping {
            notion_property: "Priority".into(),
            notion_type: "select".into(),
            parachute_field: "priority".into(),
            transform: "slugify".into(),
            value_map: HashMap::new(),
            relationship_type: None,
        },
        PropertyMapping {
            notion_property: "Due date".into(),
            notion_type: "date".into(),
            parachute_field: "due".into(),
            transform: "date_extract".into(),
            value_map: HashMap::new(),
            relationship_type: None,
        },
        PropertyMapping {
            notion_property: "Description".into(),
            notion_type: "rich_text".into(),
            parachute_field: "context".into(),
            transform: "identity".into(),
            value_map: HashMap::new(),
            relationship_type: None,
        },
    ];

    NotionDbSyncConfig {
        id,
        notion_database_id: database_id.to_string(),
        notion_database_name: database_name.to_string(),
        parachute_tag: "task".into(),
        parachute_path_prefix: "vault/tasks/active".into(),
        property_map,
        title_property: "Task name".into(),
        content_property: Some("Description".into()),
        sync_direction: "bidirectional".into(),
        conflict_strategy: "notion-wins".into(),
        last_synced: String::new(),
        auto_sync: true,
        id_map: HashMap::new(),
    }
}
