use reqwest::Client;
use crate::error::PrismError;
use crate::models::note::*;
use crate::models::link::*;

pub struct ParachuteClient {
    base_url: String,
    client: Client,
    api_key: Option<String>,
}

impl ParachuteClient {
    pub fn new(port: u16, api_key: Option<String>) -> Self {
        Self {
            base_url: format!("http://localhost:{}/api", port),
            client: Client::new(),
            api_key,
        }
    }

    /// Build a request with optional API key authorization
    fn authed_get(&self, url: &str) -> reqwest::RequestBuilder {
        let mut req = self.client.get(url);
        if let Some(ref key) = self.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
        req
    }

    fn authed_post(&self, url: &str) -> reqwest::RequestBuilder {
        let mut req = self.client.post(url);
        if let Some(ref key) = self.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
        req
    }

    fn authed_patch(&self, url: &str) -> reqwest::RequestBuilder {
        let mut req = self.client.patch(url);
        if let Some(ref key) = self.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
        req
    }

    fn authed_delete(&self, url: &str) -> reqwest::RequestBuilder {
        let mut req = self.client.delete(url);
        if let Some(ref key) = self.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
        req
    }

    pub async fn health(&self) -> Result<serde_json::Value, PrismError> {
        let resp = self.authed_get(&format!("{}/health", self.base_url))
            .send()
            .await?
            .json()
            .await?;
        Ok(resp)
    }

    pub async fn list_notes(&self, params: &ListNotesParams) -> Result<Vec<Note>, PrismError> {
        let mut url = format!("{}/notes", self.base_url);
        let mut query_parts = Vec::new();
        if let Some(ref tag) = params.tag {
            query_parts.push(format!("tag={}", tag));
        }
        if let Some(ref path) = params.path {
            // Use path_prefix for directory-level filtering
            query_parts.push(format!("path_prefix={}", path));
        }
        // Default to 10000 to get all notes (vault grew to 5000+ with sync services)
        let limit = params.limit.unwrap_or(10000);
        query_parts.push(format!("limit={}", limit));
        if let Some(offset) = params.offset {
            query_parts.push(format!("offset={}", offset));
        }
        if !query_parts.is_empty() {
            url = format!("{}?{}", url, query_parts.join("&"));
        }

        let resp = self.authed_get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("list_notes failed: {}", resp.status())));
        }
        // Use text() + serde_json for large responses (vault can be 17MB+)
        let text = resp.text().await?;
        let notes: Vec<Note> = serde_json::from_str(&text)
            .map_err(|e| PrismError::Parachute(format!("JSON parse error: {} (response size: {} bytes)", e, text.len())))?;
        Ok(notes)
    }

    pub async fn get_note(&self, id: &str) -> Result<Note, PrismError> {
        let resp = self.authed_get(&format!("{}/notes/{}", self.base_url, id))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_note failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn create_note(&self, params: &CreateNoteParams) -> Result<Note, PrismError> {
        let resp = self.authed_post(&format!("{}/notes", self.base_url))
            .json(params)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("create_note failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn update_note(&self, id: &str, params: &UpdateNoteParams) -> Result<Note, PrismError> {
        let resp = self.authed_patch(&format!("{}/notes/{}", self.base_url, id))
            .json(params)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("update_note failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn delete_note(&self, id: &str) -> Result<(), PrismError> {
        let resp = self.authed_delete(&format!("{}/notes/{}", self.base_url, id))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("delete_note failed: {}", resp.status())));
        }
        Ok(())
    }

    /// Search notes. New API: GET /api/notes?search=X&tag=Y&limit=Z
    pub async fn search(&self, query: &str, tags: &[String], limit: u32) -> Result<Vec<Note>, PrismError> {
        let mut url = format!("{}/notes?search={}&limit={}&include_content=true", self.base_url, query, limit);
        for tag in tags {
            url.push_str(&format!("&tag={}", tag));
        }
        let resp = self.authed_get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("search failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn get_tags(&self) -> Result<Vec<TagCount>, PrismError> {
        let resp = self.authed_get(&format!("{}/tags", self.base_url))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_tags failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Add tags via PATCH /api/notes/{id} with { tags: { add: [...] } }
    pub async fn add_tags(&self, id: &str, tags: &[String]) -> Result<(), PrismError> {
        let resp = self.authed_patch(&format!("{}/notes/{}", self.base_url, id))
            .json(&serde_json::json!({ "tags": { "add": tags } }))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("add_tags failed: {}", resp.status())));
        }
        Ok(())
    }

    /// Remove tags via PATCH /api/notes/{id} with { tags: { remove: [...] } }
    pub async fn remove_tags(&self, id: &str, tags: &[String]) -> Result<(), PrismError> {
        let resp = self.authed_patch(&format!("{}/notes/{}", self.base_url, id))
            .json(&serde_json::json!({ "tags": { "remove": tags } }))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("remove_tags failed: {}", resp.status())));
        }
        Ok(())
    }

    /// Get links for a note via GET /api/notes/{id}?include_links=true&include_content=false
    pub async fn get_links(&self, params: &GetLinksParams) -> Result<Vec<Link>, PrismError> {
        if let Some(ref note_id) = params.note_id {
            let url = format!("{}/notes/{}?include_links=true&include_content=false", self.base_url, note_id);
            let resp = self.authed_get(&url).send().await?;
            if !resp.status().is_success() {
                return Err(PrismError::Parachute(format!("get_links failed: {}", resp.status())));
            }
            // Response is a note with an embedded "links" array
            let body: serde_json::Value = resp.json().await?;
            let links: Vec<Link> = serde_json::from_value(
                body.get("links").cloned().unwrap_or(serde_json::json!([]))
            ).unwrap_or_default();
            Ok(links)
        } else {
            // No note_id — return empty (global link listing removed in v2)
            Ok(vec![])
        }
    }

    /// Create a link via PATCH /api/notes/{sourceId} with { links: { add: [...] } }
    pub async fn create_link(&self, params: &CreateLinkParams) -> Result<Link, PrismError> {
        let mut link_entry = serde_json::json!({
            "target": params.target_id,
            "relationship": params.relationship,
        });
        if let Some(ref metadata) = params.metadata {
            link_entry["metadata"] = metadata.clone();
        }
        let resp = self.authed_patch(&format!("{}/notes/{}", self.base_url, params.source_id))
            .json(&serde_json::json!({ "links": { "add": [link_entry] } }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let err = resp.text().await.unwrap_or_default();
            return Err(PrismError::Parachute(format!("create_link failed: {}", err)));
        }
        // Return a synthetic Link since PATCH returns the updated note
        Ok(Link {
            source_id: params.source_id.clone(),
            target_id: params.target_id.clone(),
            relationship: params.relationship.clone(),
            metadata: params.metadata.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    /// Delete a link via PATCH /api/notes/{sourceId} with { links: { remove: [...] } }
    pub async fn delete_link(&self, params: &DeleteLinkParams) -> Result<(), PrismError> {
        let resp = self.authed_patch(&format!("{}/notes/{}", self.base_url, params.source_id))
            .json(&serde_json::json!({
                "links": { "remove": [{
                    "target": params.target_id,
                    "relationship": params.relationship,
                }] }
            }))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("delete_link failed: {}", resp.status())));
        }
        Ok(())
    }

    /// Get graph via GET /api/notes?format=graph&include_links=true
    pub async fn get_graph(&self, params: &GetGraphParams) -> Result<Graph, PrismError> {
        let mut url = format!("{}/notes?format=graph&include_links=true&limit=10000", self.base_url);
        // If centerId provided, use near[] scope to get neighborhood
        if let Some(ref center_id) = params.center_id {
            url.push_str(&format!("&near[note_id]={}", center_id));
            if let Some(depth) = params.depth {
                url.push_str(&format!("&near[depth]={}", depth));
            }
        }
        let resp = self.authed_get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_graph failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Get vault stats via GET /api/vault?include_stats=true
    pub async fn get_stats(&self) -> Result<VaultStats, PrismError> {
        let resp = self.authed_get(&format!("{}/vault?include_stats=true", self.base_url))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_stats failed: {}", resp.status())));
        }
        // Response is { name, description, stats: { totalNotes, tagCount, ... } }
        let body: serde_json::Value = resp.json().await?;
        let stats_val = body.get("stats").cloned().unwrap_or(serde_json::json!({}));
        let stats: VaultStats = serde_json::from_value(stats_val)
            .map_err(|e| PrismError::Parachute(format!("stats parse error: {}", e)))?;
        Ok(stats)
    }
}
