//! Notion Database Sync Adapter
//!
//! Bidirectional sync between Notion database rows and Parachute vault notes.
//! Each database row maps to a vault note tagged with a specific tag (e.g. "task"),
//! with property values mapped to note metadata fields via configurable mappings.

use std::collections::HashMap;

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::{CreateNoteParams, ListNotesParams, UpdateNoteParams};

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

/// Configuration for syncing a single Notion database with Parachute vault notes.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NotionDbSyncConfig {
    pub id: String,
    pub notion_database_id: String,
    pub notion_database_name: String,
    /// The Parachute tag applied to all synced notes (e.g. "task").
    pub parachute_tag: String,
    /// Path prefix for created notes (e.g. "vault/tasks/prism").
    pub parachute_path_prefix: String,
    pub property_map: Vec<PropertyMapping>,
    /// The Notion property name that provides the note title (e.g. "Name").
    pub title_property: String,
    /// Optional Notion property whose value becomes note content.
    pub content_property: Option<String>,
    /// One of "bidirectional", "notion-to-parachute", "parachute-to-notion".
    pub sync_direction: String,
    /// One of "notion-wins", "parachute-wins", "newer-wins".
    pub conflict_strategy: String,
    /// ISO-8601 timestamp of the last successful sync.
    pub last_synced: String,
    pub auto_sync: bool,
    /// Maps Notion page IDs to Parachute note IDs.
    pub id_map: HashMap<String, String>,
}

/// Describes how a single Notion property maps to a Parachute metadata field.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PropertyMapping {
    pub notion_property: String,
    /// Notion property type: "title", "rich_text", "select", "multi_select",
    /// "date", "people", "checkbox", "number", "url", "relation".
    pub notion_type: String,
    pub parachute_field: String,
    /// Transform applied when converting Notion → Parachute:
    /// "identity", "slugify", "value_map", "date_extract", "people_extract",
    /// "relation_to_links".
    pub transform: String,
    /// Optional value mapping table for the "value_map" transform.
    #[serde(default)]
    pub value_map: HashMap<String, String>,
    /// If set, the adapter creates Parachute links with this relationship type.
    pub relationship_type: Option<String>,
}

/// Summary of a sync operation.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NotionDbSyncResult {
    pub created: u32,
    pub updated: u32,
    pub deleted: u32,
    pub conflicts: u32,
    pub errors: Vec<String>,
}

/// Lightweight info about a Notion database returned by search.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NotionDatabaseInfo {
    pub id: String,
    pub title: String,
    pub property_count: usize,
}

/// Schema description of a single Notion database property.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PropertySchema {
    pub name: String,
    pub property_type: String,
    /// Select / multi-select option names; empty for other types.
    pub options: Vec<String>,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTION_API_BASE: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2022-06-28";

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/// Adapter for syncing Notion *databases* (not individual pages) with the
/// Parachute vault.
pub struct NotionDatabaseAdapter {
    api_key: String,
    client: reqwest::Client,
}

impl NotionDatabaseAdapter {
    /// Create a new adapter with the given Notion integration token.
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: reqwest::Client::new(),
        }
    }

    // -- Notion HTTP helpers ------------------------------------------------

    fn auth_headers(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header("Authorization", format!("Bearer {}", self.api_key))
            .header("Notion-Version", NOTION_VERSION)
            .header("Content-Type", "application/json")
    }

    // -- Public API ---------------------------------------------------------

    /// List all Notion databases the integration has access to.
    pub async fn list_databases(&self) -> Result<Vec<NotionDatabaseInfo>, PrismError> {
        let url = format!("{}/search", NOTION_API_BASE);
        let body = serde_json::json!({
            "filter": { "value": "database", "property": "object" }
        });

        let resp = self
            .auth_headers(self.client.post(&url))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(PrismError::Notion(format!(
                "list_databases failed ({}): {}",
                status, text
            )));
        }

        let data: Value = resp.json().await?;
        let results = data["results"].as_array().cloned().unwrap_or_default();

        let databases = results
            .iter()
            .map(|db| {
                let id = db["id"].as_str().unwrap_or_default().to_string();
                let title = db["title"]
                    .as_array()
                    .and_then(|arr| arr.first())
                    .and_then(|t| t["plain_text"].as_str())
                    .unwrap_or("Untitled")
                    .to_string();
                let property_count = db["properties"]
                    .as_object()
                    .map(|o| o.len())
                    .unwrap_or(0);
                NotionDatabaseInfo {
                    id,
                    title,
                    property_count,
                }
            })
            .collect();

        Ok(databases)
    }

    /// Retrieve the property schema for a Notion database.
    pub async fn get_database_schema(
        &self,
        database_id: &str,
    ) -> Result<Vec<PropertySchema>, PrismError> {
        let url = format!("{}/databases/{}", NOTION_API_BASE, database_id);

        let resp = self
            .auth_headers(self.client.get(&url))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(PrismError::Notion(format!(
                "get_database_schema failed ({}): {}",
                status, text
            )));
        }

        let data: Value = resp.json().await?;
        let properties = data["properties"]
            .as_object()
            .cloned()
            .unwrap_or_default();

        let schemas = properties
            .iter()
            .map(|(name, prop)| {
                let property_type = prop["type"].as_str().unwrap_or("unknown").to_string();
                let options = extract_select_options(prop, &property_type);
                PropertySchema {
                    name: name.clone(),
                    property_type,
                    options,
                }
            })
            .collect();

        Ok(schemas)
    }

    /// Automatically discover property mappings by matching Notion property
    /// names to well-known Parachute metadata fields.
    pub async fn auto_discover_mappings(
        &self,
        database_id: &str,
    ) -> Result<Vec<PropertyMapping>, PrismError> {
        let schema = self.get_database_schema(database_id).await?;
        let mut mappings = Vec::new();

        for prop in &schema {
            // Skip computed properties that are read-only in Notion.
            if prop.property_type == "formula" || prop.property_type == "rollup" {
                debug!("Skipping read-only property: {} ({})", prop.name, prop.property_type);
                continue;
            }

            let lower = prop.name.to_lowercase();

            // Title properties are handled separately via title_property.
            if prop.property_type == "title" || lower == "name" || lower == "title" {
                continue;
            }

            let (parachute_field, transform) = match lower.as_str() {
                "status" => ("status".to_string(), "slugify".to_string()),
                "priority" => ("priority".to_string(), "slugify".to_string()),
                "due" | "due date" | "deadline" => ("due".to_string(), "date_extract".to_string()),
                "assignee" | "assigned" | "owner" => {
                    ("assignee".to_string(), "people_extract".to_string())
                }
                "project" => {
                    if prop.property_type == "relation" {
                        ("project".to_string(), "relation_to_links".to_string())
                    } else {
                        ("project".to_string(), "identity".to_string())
                    }
                }
                "url" | "link" => ("url".to_string(), "identity".to_string()),
                "tags" | "labels" | "category" => ("category".to_string(), "identity".to_string()),
                _ => (slugify(&prop.name), "identity".to_string()),
            };

            mappings.push(PropertyMapping {
                notion_property: prop.name.clone(),
                notion_type: prop.property_type.clone(),
                parachute_field,
                transform,
                value_map: HashMap::new(),
                relationship_type: None,
            });
        }

        info!(
            "Auto-discovered {} mappings for database {}",
            mappings.len(),
            database_id
        );
        Ok(mappings)
    }

    /// Pull rows from a Notion database into the Parachute vault.
    ///
    /// Creates new notes for rows not yet in the id_map and updates existing
    /// ones. Handles pagination (100 rows per request).
    pub async fn pull_from_notion(
        &self,
        config: &mut NotionDbSyncConfig,
        parachute: &ParachuteClient,
    ) -> Result<NotionDbSyncResult, PrismError> {
        let mut result = NotionDbSyncResult {
            created: 0,
            updated: 0,
            deleted: 0,
            conflicts: 0,
            errors: Vec::new(),
        };

        let mut start_cursor: Option<String> = None;

        loop {
            let pages = self
                .query_database(&config.notion_database_id, start_cursor.as_deref())
                .await?;

            let results = pages["results"].as_array().cloned().unwrap_or_default();

            for page in &results {
                let page_id = match page["id"].as_str() {
                    Some(id) => id.to_string(),
                    None => continue,
                };

                let properties = match page["properties"].as_object() {
                    Some(p) => p,
                    None => continue,
                };

                // Extract title
                let title = properties
                    .get(&config.title_property)
                    .map(|p| extract_property_value(p, "title"))
                    .unwrap_or_else(|| "Untitled".to_string());

                // Extract content from the configured content property
                let content = config
                    .content_property
                    .as_ref()
                    .and_then(|cp| properties.get(cp))
                    .map(|p| extract_property_value(p, "rich_text"))
                    .unwrap_or_default();

                // Build metadata from property mappings
                let mut metadata = serde_json::Map::new();
                metadata.insert(
                    "notion_page_id".to_string(),
                    Value::String(page_id.clone()),
                );
                metadata.insert("title".to_string(), Value::String(title.clone()));

                for mapping in &config.property_map {
                    if let Some(prop) = properties.get(&mapping.notion_property) {
                        let raw = extract_property_value(prop, &mapping.notion_type);
                        let transformed =
                            apply_transform(&raw, &mapping.transform, &mapping.value_map);
                        metadata.insert(
                            mapping.parachute_field.clone(),
                            Value::String(transformed),
                        );
                    }
                }

                let meta_value = Value::Object(metadata);

                // Determine whether to create or update
                if let Some(note_id) = config.id_map.get(&page_id) {
                    // Update existing note
                    let params = UpdateNoteParams {
                        content: Some(content),
                        metadata: Some(meta_value),
                        path: None,
                    };
                    match parachute.update_note(note_id, &params).await {
                        Ok(_) => result.updated += 1,
                        Err(e) => result.errors.push(format!("Update {}: {}", page_id, e)),
                    }
                } else {
                    // Create new note
                    let path = format!("{}/{}", config.parachute_path_prefix, slugify(&title));
                    let params = CreateNoteParams {
                        content,
                        path: Some(path),
                        metadata: Some(meta_value),
                        tags: Some(vec![config.parachute_tag.clone()]),
                    };
                    match parachute.create_note(&params).await {
                        Ok(note) => {
                            config.id_map.insert(page_id, note.id.clone());
                            result.created += 1;
                        }
                        Err(e) => result.errors.push(format!("Create {}: {}", title, e)),
                    }
                }
            }

            // Pagination
            let has_more = pages["has_more"].as_bool().unwrap_or(false);
            if has_more {
                start_cursor = pages["next_cursor"].as_str().map(|s| s.to_string());
            } else {
                break;
            }
        }

        config.last_synced = chrono::Utc::now().to_rfc3339();
        info!(
            "Pull complete: created={}, updated={}, errors={}",
            result.created,
            result.updated,
            result.errors.len()
        );
        Ok(result)
    }

    /// Push Parachute vault notes back to a Notion database.
    ///
    /// Creates new pages for notes not yet in the id_map (reverse lookup) and
    /// updates existing ones.
    pub async fn push_to_notion(
        &self,
        config: &mut NotionDbSyncConfig,
        parachute: &ParachuteClient,
    ) -> Result<NotionDbSyncResult, PrismError> {
        let mut result = NotionDbSyncResult {
            created: 0,
            updated: 0,
            deleted: 0,
            conflicts: 0,
            errors: Vec::new(),
        };

        // Build reverse map: parachute_note_id → notion_page_id
        let reverse_map: HashMap<String, String> = config
            .id_map
            .iter()
            .map(|(k, v)| (v.clone(), k.clone()))
            .collect();

        let params = ListNotesParams {
            tag: Some(config.parachute_tag.clone()),
            path: Some(config.parachute_path_prefix.clone()),
            limit: Some(10000),
            offset: None,
        };

        let notes = parachute.list_notes(&params).await?;

        for note in &notes {
            let note_metadata = note.metadata.clone().unwrap_or(Value::Null);
            let notion_props =
                build_notion_properties(&note_metadata, &config.property_map);

            // Build title from note metadata or path
            let title = note_metadata["title"]
                .as_str()
                .or_else(|| {
                    note.path
                        .as_ref()
                        .and_then(|p| p.split('/').last())
                })
                .unwrap_or("Untitled");

            if let Some(page_id) = reverse_map.get(&note.id) {
                // Update existing Notion page
                let payload = serde_json::json!({
                    "properties": merge_title_property(&config.title_property, title, notion_props)
                });

                match self.update_page(page_id, &payload).await {
                    Ok(_) => result.updated += 1,
                    Err(e) => result.errors.push(format!("Update page {}: {}", page_id, e)),
                }
            } else {
                // Create new Notion page
                let properties =
                    merge_title_property(&config.title_property, title, notion_props);
                let payload = serde_json::json!({
                    "parent": { "database_id": config.notion_database_id },
                    "properties": properties
                });

                match self.create_page(&payload).await {
                    Ok(page_id) => {
                        config.id_map.insert(page_id, note.id.clone());
                        result.created += 1;
                    }
                    Err(e) => result.errors.push(format!("Create page for {}: {}", note.id, e)),
                }
            }
        }

        config.last_synced = chrono::Utc::now().to_rfc3339();
        info!(
            "Push complete: created={}, updated={}, errors={}",
            result.created,
            result.updated,
            result.errors.len()
        );
        Ok(result)
    }

    // -- Private Notion API helpers -----------------------------------------

    /// Query a Notion database, returning one page of results.
    async fn query_database(
        &self,
        database_id: &str,
        start_cursor: Option<&str>,
    ) -> Result<Value, PrismError> {
        let url = format!("{}/databases/{}/query", NOTION_API_BASE, database_id);
        let mut body = serde_json::json!({ "page_size": 100 });
        if let Some(cursor) = start_cursor {
            body["start_cursor"] = Value::String(cursor.to_string());
        }

        let resp = self
            .auth_headers(self.client.post(&url))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(PrismError::Notion(format!(
                "query_database failed ({}): {}",
                status, text
            )));
        }

        Ok(resp.json().await?)
    }

    /// Create a page in Notion and return its ID.
    async fn create_page(&self, payload: &Value) -> Result<String, PrismError> {
        let url = format!("{}/pages", NOTION_API_BASE);
        let resp = self
            .auth_headers(self.client.post(&url))
            .json(payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(PrismError::Notion(format!(
                "create_page failed ({}): {}",
                status, text
            )));
        }

        let data: Value = resp.json().await?;
        data["id"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| PrismError::Notion("create_page: missing id in response".into()))
    }

    /// Update a Notion page's properties.
    async fn update_page(&self, page_id: &str, payload: &Value) -> Result<(), PrismError> {
        let url = format!("{}/pages/{}", NOTION_API_BASE, page_id);
        let resp = self
            .auth_headers(self.client.patch(&url))
            .json(payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(PrismError::Notion(format!(
                "update_page failed ({}): {}",
                status, text
            )));
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Free-standing helpers
// ---------------------------------------------------------------------------

/// Extract the raw string value from a Notion property JSON blob.
fn extract_property_value(property: &Value, prop_type: &str) -> String {
    match prop_type {
        "title" | "rich_text" => {
            let key = if prop_type == "title" { "title" } else { "rich_text" };
            property[key]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t["plain_text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default()
        }
        "select" => property["select"]["name"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        "multi_select" => property["multi_select"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|s| s["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default(),
        "date" => property["date"]["start"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        "people" => property["people"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| p["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default(),
        "checkbox" => property["checkbox"]
            .as_bool()
            .map(|b| if b { "true" } else { "false" })
            .unwrap_or("false")
            .to_string(),
        "number" => match &property["number"] {
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        },
        "url" => property["url"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        "relation" => property["relation"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| r["id"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default(),
        _ => {
            warn!("Unknown Notion property type: {}", prop_type);
            String::new()
        }
    }
}

/// Apply a forward transform (Notion → Parachute).
fn apply_transform(
    value: &str,
    transform: &str,
    value_map: &HashMap<String, String>,
) -> String {
    match transform {
        "identity" | "date_extract" | "people_extract" | "relation_to_links" => {
            value.to_string()
        }
        "slugify" => slugify(value),
        "value_map" => value_map
            .get(value)
            .cloned()
            .unwrap_or_else(|| slugify(value)),
        _ => value.to_string(),
    }
}

/// Apply a reverse transform (Parachute → Notion).
fn reverse_transform(
    value: &str,
    transform: &str,
    value_map: &HashMap<String, String>,
) -> String {
    match transform {
        "identity" | "date_extract" | "people_extract" | "relation_to_links" => {
            value.to_string()
        }
        "slugify" => title_case(value),
        "value_map" => {
            // Reverse lookup: find the key whose value matches
            value_map
                .iter()
                .find(|(_, v)| v.as_str() == value)
                .map(|(k, _)| k.clone())
                .unwrap_or_else(|| title_case(value))
        }
        _ => value.to_string(),
    }
}

/// Build a Notion-compatible properties JSON object from Parachute note
/// metadata, using the given property mappings.
fn build_notion_properties(note_metadata: &Value, mappings: &[PropertyMapping]) -> Value {
    let mut props = serde_json::Map::new();

    for mapping in mappings {
        let raw_value = match note_metadata.get(&mapping.parachute_field) {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => continue,
        };

        let notion_value = reverse_transform(&raw_value, &mapping.transform, &mapping.value_map);

        let prop_json = match mapping.notion_type.as_str() {
            "rich_text" => serde_json::json!({
                "rich_text": [{ "text": { "content": notion_value } }]
            }),
            "select" => serde_json::json!({
                "select": { "name": notion_value }
            }),
            "multi_select" => {
                let items: Vec<Value> = notion_value
                    .split(", ")
                    .filter(|s| !s.is_empty())
                    .map(|s| serde_json::json!({ "name": s.trim() }))
                    .collect();
                serde_json::json!({ "multi_select": items })
            }
            "date" => {
                if notion_value.is_empty() {
                    continue;
                }
                serde_json::json!({ "date": { "start": notion_value } })
            }
            "checkbox" => {
                serde_json::json!({ "checkbox": notion_value == "true" })
            }
            "number" => {
                if let Ok(n) = notion_value.parse::<f64>() {
                    serde_json::json!({ "number": n })
                } else {
                    continue;
                }
            }
            "url" => {
                if notion_value.is_empty() {
                    continue;
                }
                serde_json::json!({ "url": notion_value })
            }
            "relation" => {
                let ids: Vec<Value> = notion_value
                    .split(", ")
                    .filter(|s| !s.is_empty())
                    .map(|id| serde_json::json!({ "id": id.trim() }))
                    .collect();
                serde_json::json!({ "relation": ids })
            }
            // Title is handled separately; people are read-only via API.
            _ => continue,
        };

        props.insert(mapping.notion_property.clone(), prop_json);
    }

    Value::Object(props)
}

/// Merge a title property into an existing properties object.
fn merge_title_property(title_prop: &str, title: &str, mut properties: Value) -> Value {
    let title_json = serde_json::json!({
        "title": [{ "text": { "content": title } }]
    });
    if let Some(obj) = properties.as_object_mut() {
        obj.insert(title_prop.to_string(), title_json);
    }
    properties
}

/// Extract select/multi-select option names from a Notion property schema.
fn extract_select_options(prop: &Value, property_type: &str) -> Vec<String> {
    let key = match property_type {
        "select" => "select",
        "multi_select" => "multi_select",
        _ => return Vec::new(),
    };
    prop[key]["options"]
        .as_array()
        .map(|opts| {
            opts.iter()
                .filter_map(|o| o["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Convert a string to a URL-safe slug: lowercase, spaces → hyphens,
/// non-alphanumeric characters removed.
fn slugify(input: &str) -> String {
    input
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect()
}

/// Reverse of `slugify`: replace hyphens with spaces and capitalize each word.
fn title_case(input: &str) -> String {
    input
        .split('-')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(c) => {
                    let upper: String = c.to_uppercase().collect();
                    format!("{}{}", upper, chars.as_str())
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
