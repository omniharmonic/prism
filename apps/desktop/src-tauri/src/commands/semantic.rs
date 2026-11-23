//! Desktop bridge to the Prism Server's semantic-search service. The server owns
//! the vector index and the query path; the desktop reaches it the same way it
//! reaches the ACL surface — over loopback with the dedicated COLLAB_TOKEN, so
//! the powerful vault token never leaves the trusted process. The background
//! `embedding_index` service keeps the index current; these commands are the
//! interactive read (search) and a manual rebuild trigger.

use crate::commands::config::AppConfig;
use crate::error::PrismError;
use crate::models::note::Note;
use crate::services::embedding_index::http_base_from_collab;

fn server_base(config: &AppConfig) -> Result<String, PrismError> {
    if config.collab_token.is_empty() {
        return Err(PrismError::Config(
            "Semantic search needs the Prism Server (COLLAB_TOKEN) — falling back to full-text".into(),
        ));
    }
    Ok(http_base_from_collab(&config.collab_url))
}

/// Hybrid semantic search via the server. Returns ranked notes (the server's
/// extra `_score`/`_snippet` fields are ignored by the Note shape).
#[tauri::command]
pub async fn vault_semantic_search(
    query: String,
    limit: Option<u32>,
    config: tauri::State<'_, AppConfig>,
) -> Result<Vec<Note>, PrismError> {
    let base = server_base(&config)?;
    let resp = reqwest::Client::new()
        .get(format!("{base}/api/search/semantic"))
        .query(&[("q", query.as_str()), ("limit", &limit.unwrap_or(20).to_string())])
        .bearer_auth(&config.collab_token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| PrismError::Other(format!("semantic search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(PrismError::Other(format!("semantic search → {}", resp.status())));
    }
    resp.json().await.map_err(|e| PrismError::Other(format!("semantic search parse: {e}")))
}

/// Trigger a full (re)index on the server. `force` re-embeds even unchanged notes.
#[tauri::command]
pub async fn embedding_reindex(
    force: Option<bool>,
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    let base = server_base(&config)?;
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/index/rebuild"))
        .query(&[("force", if force.unwrap_or(false) { "true" } else { "false" })])
        .bearer_auth(&config.collab_token)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| PrismError::Other(format!("reindex failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(PrismError::Other(format!("reindex → {}", resp.status())));
    }
    resp.json().await.map_err(|e| PrismError::Other(format!("reindex parse: {e}")))
}

/// Project the saved canvas's authored arrows through the server's guarded
/// durable assertion ledger, using the selected vault and existing owner bridge.
#[tauri::command]
pub async fn vault_canvas_reconcile(
    canvas_id: String,
    fingerprint: String,
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    if fingerprint.len() > 200_000 {
        return Err(PrismError::Other("canvas relationship limit reached".into()));
    }
    let base = server_base(&config)?;
    let mut url = reqwest::Url::parse(&base)
        .map_err(|_| PrismError::Config("Invalid Prism Server address".into()))?;
    url.path_segments_mut()
        .map_err(|_| PrismError::Config("Invalid Prism Server address".into()))?
        .extend(["api", "canvas", canvas_id.as_str(), "relationships"]);
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(&config.collab_token)
        .header("X-Prism-Vault", &config.active_vault_id)
        .json(&serde_json::json!({"fingerprint":fingerprint}))
        .timeout(std::time::Duration::from_secs(60))
        .send().await
        .map_err(|_| PrismError::Other("canvas_relationships_unavailable".into()))?;
    if !response.status().is_success() {
        return Err(PrismError::Other(if response.status().as_u16() == 409 {
            "canvas_scene_changed".into()
        } else { "canvas_relationships_unavailable".into() }));
    }
    response.json().await.map_err(|_| PrismError::Other("Invalid canvas receipt".into()))
}
