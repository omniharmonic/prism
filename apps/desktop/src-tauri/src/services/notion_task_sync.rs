use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::watch;
use crate::clients::parachute::ParachuteClient;
use crate::services::ServiceStatus;
use crate::sync::adapters::notion_db::{
    NotionDatabaseAdapter, NotionDbSyncConfig, PropertyMapping,
};

const SYNC_INTERVAL_SECS: u64 = 300; // Check every 5 minutes
const INITIAL_DELAY_SECS: u64 = 30;

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

/// Background service for Notion database task sync.
/// Periodically syncs configured databases with auto_sync enabled.
pub async fn run(
    parachute: Arc<ParachuteClient>,
    notion_api_key: String,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<std::sync::Mutex<ServiceStatus>>,
) {
    log::info!("Notion task sync starting");

    {
        let mut s = status.lock().unwrap();
        s.running = true;
    }

    // Initial delay to let other services stabilize
    tokio::time::sleep(tokio::time::Duration::from_secs(INITIAL_DELAY_SECS)).await;

    loop {
        if *shutdown.borrow() {
            break;
        }

        let mut configs = load_configs();

        // Only sync configs with auto_sync enabled
        let auto_configs: Vec<String> = configs
            .iter()
            .filter(|(_, c)| c.auto_sync)
            .map(|(id, _)| id.clone())
            .collect();

        if !auto_configs.is_empty() {
            let adapter = NotionDatabaseAdapter::new(notion_api_key.clone());

            for config_id in &auto_configs {
                if let Some(config) = configs.get_mut(config_id) {
                    // Check if enough time has passed since last sync (at least 1 hour)
                    let should_sync = config.last_synced.is_empty() || {
                        chrono::DateTime::parse_from_rfc3339(&config.last_synced)
                            .map(|last| {
                                let elapsed = chrono::Utc::now() - last.with_timezone(&chrono::Utc);
                                elapsed.num_seconds() >= 3600
                            })
                            .unwrap_or(true)
                    };

                    if !should_sync {
                        continue;
                    }

                    log::info!(
                        "Notion task sync: syncing '{}' ({})",
                        config.notion_database_name,
                        config.sync_direction
                    );

                    let direction = config.sync_direction.clone();
                    let mut items = 0u64;

                    // Pull phase
                    if direction == "pull" || direction == "bidirectional" {
                        match adapter.pull_from_notion(config, &parachute).await {
                            Ok(result) => {
                                items += result.created as u64 + result.updated as u64;
                                if !result.errors.is_empty() {
                                    log::warn!(
                                        "Notion pull had {} errors: {:?}",
                                        result.errors.len(),
                                        &result.errors[..result.errors.len().min(3)]
                                    );
                                }
                            }
                            Err(e) => {
                                log::warn!("Notion pull failed for '{}': {}", config.notion_database_name, e);
                                let mut s = status.lock().unwrap();
                                s.last_error = Some(format!("Pull failed: {}", e));
                            }
                        }
                    }

                    // Push phase
                    if direction == "push" || direction == "bidirectional" {
                        match adapter.push_to_notion(config, &parachute).await {
                            Ok(result) => {
                                items += result.created as u64 + result.updated as u64;
                                if !result.errors.is_empty() {
                                    log::warn!(
                                        "Notion push had {} errors: {:?}",
                                        result.errors.len(),
                                        &result.errors[..result.errors.len().min(3)]
                                    );
                                }
                            }
                            Err(e) => {
                                log::warn!("Notion push failed for '{}': {}", config.notion_database_name, e);
                                let mut s = status.lock().unwrap();
                                s.last_error = Some(format!("Push failed: {}", e));
                            }
                        }
                    }

                    config.last_synced = chrono::Utc::now().to_rfc3339();

                    let mut s = status.lock().unwrap();
                    s.last_run = Some(chrono::Utc::now().to_rfc3339());
                    s.items_processed += items;
                    s.last_error = None;

                    log::info!(
                        "Notion task sync: '{}' complete, {} items processed",
                        config.notion_database_name,
                        items
                    );
                }
            }

            // Persist updated configs (id_map, last_synced)
            save_configs(&configs);
        }

        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(SYNC_INTERVAL_SECS)) => {},
            _ = shutdown.changed() => {
                if *shutdown.borrow() { break; }
            }
        }
    }

    let mut s = status.lock().unwrap();
    s.running = false;
    log::info!("Notion task sync stopped");
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
