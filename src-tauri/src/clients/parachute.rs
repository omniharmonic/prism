use reqwest::Client;
use crate::error::PrismError;
use crate::models::note::*;
use crate::models::link::*;

pub struct ParachuteClient {
    base_url: String,
    client: Client,
}

impl ParachuteClient {
    pub fn new(port: u16, _api_key: Option<String>) -> Self {
        Self {
            base_url: format!("http://localhost:{}/api", port),
            client: Client::new(),
        }
    }

    pub async fn health(&self) -> Result<serde_json::Value, PrismError> {
        let resp = self.client
            .get(format!("{}/health", self.base_url))
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
            query_parts.push(format!("path={}", path));
        }
        if let Some(limit) = params.limit {
            query_parts.push(format!("limit={}", limit));
        }
        if let Some(offset) = params.offset {
            query_parts.push(format!("offset={}", offset));
        }
        if !query_parts.is_empty() {
            url = format!("{}?{}", url, query_parts.join("&"));
        }

        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("list_notes failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn get_note(&self, id: &str) -> Result<Note, PrismError> {
        let resp = self.client
            .get(format!("{}/notes/{}", self.base_url, id))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_note failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn create_note(&self, params: &CreateNoteParams) -> Result<Note, PrismError> {
        let resp = self.client
            .post(format!("{}/notes", self.base_url))
            .json(params)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("create_note failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn update_note(&self, id: &str, params: &UpdateNoteParams) -> Result<Note, PrismError> {
        let resp = self.client
            .patch(format!("{}/notes/{}", self.base_url, id))
            .json(params)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("update_note failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn delete_note(&self, id: &str) -> Result<(), PrismError> {
        let resp = self.client
            .delete(format!("{}/notes/{}", self.base_url, id))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("delete_note failed: {}", resp.status())));
        }
        Ok(())
    }

    pub async fn search(&self, query: &str, tags: &[String], limit: u32) -> Result<Vec<Note>, PrismError> {
        let mut url = format!("{}/search?q={}&limit={}", self.base_url, query, limit);
        for tag in tags {
            url.push_str(&format!("&tag={}", tag));
        }
        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("search failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn get_tags(&self) -> Result<Vec<TagCount>, PrismError> {
        let resp = self.client
            .get(format!("{}/tags", self.base_url))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_tags failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn add_tags(&self, id: &str, tags: &[String]) -> Result<(), PrismError> {
        let resp = self.client
            .post(format!("{}/notes/{}/tags", self.base_url, id))
            .json(&serde_json::json!({ "tags": tags }))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("add_tags failed: {}", resp.status())));
        }
        Ok(())
    }

    pub async fn remove_tags(&self, id: &str, tags: &[String]) -> Result<(), PrismError> {
        let resp = self.client
            .delete(format!("{}/notes/{}/tags", self.base_url, id))
            .json(&serde_json::json!({ "tags": tags }))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("remove_tags failed: {}", resp.status())));
        }
        Ok(())
    }

    pub async fn get_links(&self, params: &GetLinksParams) -> Result<Vec<Link>, PrismError> {
        let mut url = format!("{}/links", self.base_url);
        let mut query_parts = Vec::new();
        if let Some(ref note_id) = params.note_id {
            query_parts.push(format!("noteId={}", note_id));
        }
        if let Some(ref rel) = params.relationship {
            query_parts.push(format!("relationship={}", rel));
        }
        if !query_parts.is_empty() {
            url = format!("{}?{}", url, query_parts.join("&"));
        }
        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_links failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn create_link(&self, params: &CreateLinkParams) -> Result<Link, PrismError> {
        let resp = self.client
            .post(format!("{}/links", self.base_url))
            .json(params)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("create_link failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn delete_link(&self, params: &DeleteLinkParams) -> Result<(), PrismError> {
        let resp = self.client
            .delete(format!("{}/links", self.base_url))
            .json(params)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("delete_link failed: {}", resp.status())));
        }
        Ok(())
    }

    pub async fn get_graph(&self, params: &GetGraphParams) -> Result<Graph, PrismError> {
        let mut url = format!("{}/graph", self.base_url);
        let mut query_parts = Vec::new();
        if let Some(depth) = params.depth {
            query_parts.push(format!("depth={}", depth));
        }
        if let Some(ref center_id) = params.center_id {
            query_parts.push(format!("centerId={}", center_id));
        }
        if !query_parts.is_empty() {
            url = format!("{}?{}", url, query_parts.join("&"));
        }
        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_graph failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    pub async fn get_stats(&self) -> Result<VaultStats, PrismError> {
        let resp = self.client
            .get(format!("{}/stats", self.base_url))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(PrismError::Parachute(format!("get_stats failed: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }
}
