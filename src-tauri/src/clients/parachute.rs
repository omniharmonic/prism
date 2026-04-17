use reqwest::{Client, RequestBuilder};
use crate::error::PrismError;
use crate::models::note::*;
use crate::models::link::*;

/// HTTP client for Parachute Vault v2 API (9 consolidated tools).
///
/// All mutations (tags, links) flow through `PATCH /api/notes/:id`.
/// Search is absorbed into `GET /api/notes?search=...`.
/// Stats come from `GET /api/vault?include_stats=true`.
pub struct ParachuteClient {
    base_url: String,
    api_key: Option<String>,
    client: Client,
}

impl ParachuteClient {
    pub fn new(port: u16, api_key: Option<String>) -> Self {
        Self {
            base_url: format!("http://localhost:{}/api", port),
            api_key,
            client: Client::new(),
        }
    }

    fn authed(&self, req: RequestBuilder) -> RequestBuilder {
        if let Some(key) = &self.api_key {
            req.header("Authorization", format!("Bearer {}", key))
        } else {
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
    pub async fn list_notes(&self, params: &ListNotesParams) -> Result<Vec<Note>, PrismError> {
        let url = format!("{}/notes", self.base_url);
        let limit = params.limit.unwrap_or(10000);
        let mut qp: Vec<(&str, String)> = vec![
            ("limit", limit.to_string()),
            ("include_content", "true".into()),
        ];
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
            return Err(PrismError::Parachute(format!("list_notes failed: {}", resp.status())));
        }
        let text = resp.text().await?;
        let notes: Vec<Note> = serde_json::from_str(&text)
            .map_err(|e| PrismError::Parachute(format!("JSON parse error: {} (response size: {} bytes)", e, text.len())))?;
        Ok(notes)
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
}
