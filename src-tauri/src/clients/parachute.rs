use std::sync::RwLock;
use reqwest::{Client, RequestBuilder};
use crate::error::PrismError;
use crate::models::note::*;
use crate::models::link::*;

/// HTTP client for Parachute Vault v2 API (9 consolidated tools).
///
/// All mutations (tags, links) flow through `PATCH /api/notes/:id`.
/// Search is absorbed into `GET /api/notes?search=...`.
/// Stats come from `GET /api/vault?include_stats=true`.
///
/// The `api_key` is wrapped in `RwLock` so it can be updated at runtime
/// (e.g. when the user changes it in Settings) without restarting the app.
pub struct ParachuteClient {
    base_url: String,
    api_key: RwLock<Option<String>>,
    client: Client,
}

impl ParachuteClient {
    pub fn new(base_url: &str, api_key: Option<String>) -> Self {
        // Strip trailing slash, then append /api if not already present
        let url = base_url.trim_end_matches('/');
        let api_url = if url.ends_with("/api") {
            url.to_string()
        } else {
            format!("{}/api", url)
        };
        Self {
            base_url: api_url,
            api_key: RwLock::new(api_key),
            client: Client::new(),
        }
    }

    /// Update the API key at runtime (called when user changes config).
    pub fn set_api_key(&self, key: Option<String>) {
        if let Ok(mut guard) = self.api_key.write() {
            *guard = key;
        }
    }

    fn authed(&self, req: RequestBuilder) -> RequestBuilder {
        let key = self.api_key.read().ok().and_then(|g| g.clone());
        if let Some(key) = key {
            req.header("Authorization", format!("Bearer {}", key))
        } else {
            log::warn!("ParachuteClient: making request WITHOUT api_key");
            req
        }
    }

    pub async fn health(&self) -> Result<serde_json::Value, PrismError> {
        // /health lives at the server root, not /api — strip /api suffix.
        let url = self.base_url.trim_end_matches("/api").to_string() + "/health";
        let resp = self.client.get(&url).send().await?.json().await?;
        Ok(resp)
    }

    /// List or query notes. v2: `GET /api/notes` with query params.
    ///
    /// Defaults to `sort=desc` so the newest notes are always returned first —
    /// without this, parachute defaults to ascending and any cap on `limit`
    /// silently hides the most recent content as the vault grows.
    pub async fn list_notes(&self, params: &ListNotesParams) -> Result<Vec<Note>, PrismError> {
        let url = format!("{}/notes", self.base_url);
        let limit = params.limit.unwrap_or(50000);
        let mut qp: Vec<(&str, String)> = vec![
            ("limit", limit.to_string()),
            ("sort", "desc".into()),
        ];
        if params.include_content {
            qp.push(("include_content", "true".into()));
        }
        if let Some(ref tag) = params.tag {
            qp.push(("tag", tag.clone()));
        }
        if let Some(ref path) = params.path {
            qp.push(("path", path.clone()));
        }
        if let Some(offset) = params.offset {
            qp.push(("offset", offset.to_string()));
        }

        let resp = self.authed(self.client.get(&url)).query(&qp).send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            log::error!("list_notes {} — body: {} — api_key_present: {}", status, body, self.api_key.read().ok().map(|g| g.is_some()).unwrap_or(false));
            return Err(PrismError::Parachute(format!("list_notes failed: {}", status)));
        }
        let text = resp.text().await?;
        let notes: Vec<Note> = serde_json::from_str(&text)
            .map_err(|e| PrismError::Parachute(format!("JSON parse error: {} (response size: {} bytes)", e, text.len())))?;
        Ok(notes)
    }

    /// Lean variant of `list_notes` for tree/index views. Same endpoint, but
    /// deserializes into `NoteTreeEntry` (id/path/tags/metadata only) so the
    /// Rust→JS payload skips content/timestamps/preview/byteSize. Used by
    /// ProjectTree, which renders ~13k+ entries on app start.
    pub async fn list_tree(&self) -> Result<Vec<NoteTreeEntry>, PrismError> {
        let url = format!("{}/notes", self.base_url);
        let qp: Vec<(&str, String)> = vec![
            ("limit", "50000".into()),
            ("sort", "desc".into()),
        ];
        let resp = self.authed(self.client.get(&url)).query(&qp).send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            log::error!("list_tree {} — body: {}", status, body);
            return Err(PrismError::Parachute(format!("list_tree failed: {}", status)));
        }
        let text = resp.text().await?;
        let entries: Vec<NoteTreeEntry> = serde_json::from_str(&text)
            .map_err(|e| PrismError::Parachute(format!("JSON parse error: {} (response size: {} bytes)", e, text.len())))?;
        Ok(entries)
    }

    /// Get a single note by ID or path. v2: `GET /api/notes/:id`.
    pub async fn get_note(&self, id: &str) -> Result<Note, PrismError> {
        let resp = self.authed(self.client.get(format!("{}/notes/{}", self.base_url, id)))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_note failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn create_note(&self, params: &CreateNoteParams) -> Result<Note, PrismError> {
        // Refuse empty pathless creates. A note with no content AND no path is
        // never legitimate — it shows up as an "Unsorted" empty entry in the
        // tree and fattens list_tree responses with garbage. We had a leak
        // (parachute-vault#213) where ~7k of these accumulated overnight from
        // a buggy MCP caller; this guard makes Prism unable to contribute.
        let has_content = !params.content.trim().is_empty();
        let has_path = params.path.as_deref().map(|p| !p.trim().is_empty()).unwrap_or(false);
        if !has_content && !has_path {
            return Err(PrismError::Parachute(
                "create_note refused: empty content and missing path".into()
            ));
        }
        log::debug!(
            "create_note: path={:?} content_len={} tags={:?}",
            params.path,
            params.content.len(),
            params.tags,
        );
        let resp = self.authed(self.client.post(format!("{}/notes", self.base_url)).json(params))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("create_note failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn update_note(&self, id: &str, params: &UpdateNoteParams) -> Result<Note, PrismError> {
        let resp = self.authed(self.client.patch(format!("{}/notes/{}", self.base_url, id)).json(params))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("update_note failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn delete_note(&self, id: &str) -> Result<(), PrismError> {
        let resp = self.authed(self.client.delete(format!("{}/notes/{}", self.base_url, id)))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("delete_note failed: {}", resp.status())));
        }
        Ok(())
    }

    /// Search notes. v2: absorbed into `GET /api/notes?search=...`.
    pub async fn search(&self, query: &str, tags: &[String], limit: u32) -> Result<Vec<Note>, PrismError> {
        let url = format!("{}/notes", self.base_url);
        let mut qp: Vec<(&str, String)> = vec![
            ("search", query.into()),
            ("limit", limit.to_string()),
            ("include_content", "true".into()),
        ];
        for tag in tags {
            qp.push(("tag", tag.clone()));
        }
        let resp = self.authed(self.client.get(&url)).query(&qp).send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("search failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// List all tags. v2: `GET /api/tags` (unchanged).
    pub async fn get_tags(&self) -> Result<Vec<TagCount>, PrismError> {
        let resp = self.authed(self.client.get(format!("{}/tags", self.base_url)))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_tags failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Add tags to a note. v2: `PATCH /api/notes/:id` with `tags.add`.
    pub async fn add_tags(&self, id: &str, tags: &[String]) -> Result<(), PrismError> {
        let body = serde_json::json!({ "tags": { "add": tags } });
        let resp = self.authed(self.client.patch(format!("{}/notes/{}", self.base_url, id)).json(&body))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("add_tags failed: {}", resp.status())));
        }
        Ok(())
    }

    /// Remove tags from a note. v2: `PATCH /api/notes/:id` with `tags.remove`.
    pub async fn remove_tags(&self, id: &str, tags: &[String]) -> Result<(), PrismError> {
        let body = serde_json::json!({ "tags": { "remove": tags } });
        let resp = self.authed(self.client.patch(format!("{}/notes/{}", self.base_url, id)).json(&body))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("remove_tags failed: {}", resp.status())));
        }
        Ok(())
    }

    /// Get links for a note. v2: `GET /api/notes/:id?include_links=true`.
    /// The response includes inbound and outbound links on the note object.
    pub async fn get_links(&self, params: &GetLinksParams) -> Result<Vec<Link>, PrismError> {
        let note_id = params.note_id.as_ref()
            .ok_or_else(|| PrismError::Parachute("get_links requires note_id".into()))?;
        let url = format!("{}/notes/{}", self.base_url, note_id);
        let resp = self.authed(self.client.get(&url))
            .query(&[("include_links", "true")])
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_links failed: {}", resp.status())));
        }
        // Parse response and extract links array
        let note: serde_json::Value = resp.json().await?;
        let links_json = note.get("links").cloned().unwrap_or(serde_json::json!([]));
        let links: Vec<Link> = serde_json::from_value(links_json)
            .map_err(|e| PrismError::Parachute(format!("links parse error: {}", e)))?;
        // Filter by relationship if requested
        let filtered = if let Some(ref rel) = params.relationship {
            links.into_iter().filter(|l| l.relationship == *rel).collect()
        } else {
            links
        };
        Ok(filtered)
    }

    /// Create a link. v2: `PATCH /api/notes/:source_id` with `links.add`.
    pub async fn create_link(&self, params: &CreateLinkParams) -> Result<Link, PrismError> {
        let body = serde_json::json!({
            "links": {
                "add": [{
                    "target": params.target_id,
                    "relationship": params.relationship,
                }]
            }
        });
        let resp = self.authed(self.client.patch(format!("{}/notes/{}", self.base_url, params.source_id)).json(&body))
            .send().await?;
        if !resp.status().is_success() {
            let err = resp.text().await.unwrap_or_default();
            return Err(PrismError::Parachute(format!("create_link failed: {}", err)));
        }
        // Response is the updated note; synthesize a Link for return shape compatibility.
        Ok(Link {
            source_id: params.source_id.clone(),
            target_id: params.target_id.clone(),
            relationship: params.relationship.clone(),
            metadata: params.metadata.clone(),
            created_at: None,
        })
    }

    /// Delete a link. v2: `PATCH /api/notes/:source_id` with `links.remove`.
    pub async fn delete_link(&self, params: &DeleteLinkParams) -> Result<(), PrismError> {
        let body = serde_json::json!({
            "links": {
                "remove": [{
                    "target": params.target_id,
                    "relationship": params.relationship,
                }]
            }
        });
        let resp = self.authed(self.client.patch(format!("{}/notes/{}", self.base_url, params.source_id)).json(&body))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("delete_link failed: {}", resp.status())));
        }
        Ok(())
    }

    /// Get the full graph. v2: `GET /api/notes?format=graph&include_links=true`.
    /// Response shape: `{ nodes: [...], edges: [...] }`.
    ///
    /// Semantic note: v2 only honors `depth` in combination with a `near`
    /// anchor (graph neighborhood). Without `center_id`, the response is the
    /// full graph; `depth` is ignored. This is a behavior change from v1 where
    /// `depth` applied globally.
    pub async fn get_graph(&self, params: &GetGraphParams) -> Result<Graph, PrismError> {
        let url = format!("{}/notes", self.base_url);
        let mut qp: Vec<(&str, String)> = vec![
            ("format", "graph".into()),
            ("include_links", "true".into()),
            ("limit", "10000".into()),
        ];
        if let Some(ref center_id) = params.center_id {
            qp.push(("near", center_id.clone()));
            if let Some(depth) = params.depth {
                qp.push(("depth", depth.to_string()));
            }
        }
        // If the caller passed `depth` without `center_id`, it's silently
        // dropped — v2 doesn't support depth-bounded full-graph queries.
        let resp = self.authed(self.client.get(&url)).query(&qp).send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_graph failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Get vault stats. v2: `GET /api/vault?include_stats=true`.
    pub async fn get_stats(&self) -> Result<VaultStats, PrismError> {
        let url = format!("{}/vault", self.base_url);
        let resp = self.authed(self.client.get(&url))
            .query(&[("include_stats", "true")])
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_stats failed: {}", resp.status())));
        }
        let full: serde_json::Value = resp.json().await?;
        let stats_obj = full.get("stats").cloned().unwrap_or(serde_json::json!({}));
        let stats: VaultStats = serde_json::from_value(stats_obj)
            .map_err(|e| PrismError::Parachute(format!("stats parse error: {}", e)))?;
        Ok(stats)
    }

    /// Get vault info including description. v2: `GET /api/vault`.
    pub async fn get_vault_info(&self) -> Result<VaultInfo, PrismError> {
        let url = format!("{}/vault", self.base_url);
        let resp = self.authed(self.client.get(&url))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_vault_info failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Update vault description. v2: `PATCH /api/vault`.
    pub async fn update_vault_description(&self, description: &str) -> Result<VaultInfo, PrismError> {
        let url = format!("{}/vault", self.base_url);
        let body = serde_json::json!({ "description": description });
        let resp = self.authed(self.client.patch(&url).json(&body))
            .send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("update_vault_description failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }
}
