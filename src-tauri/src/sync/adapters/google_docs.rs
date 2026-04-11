use async_trait::async_trait;
use crate::clients::google::GoogleClient;
use crate::error::PrismError;
use crate::models::note::Note;
use crate::models::sync_config::{SyncConfig, SyncResult};
use super::SyncAdapter;

/// Sync adapter for Google Docs.
/// Push: converts markdown → plain text and inserts into Google Doc.
/// Pull: reads Google Doc content and converts back to markdown.
/// MVP approach: full content replacement (not diff-based).
pub struct GoogleDocsAdapter {
    client: GoogleClient,
    account: String,
}

impl GoogleDocsAdapter {
    pub fn new(client: GoogleClient, account: String) -> Self {
        Self { client, account }
    }
}

#[async_trait]
impl SyncAdapter for GoogleDocsAdapter {
    async fn push(&self, note: &Note, config: &SyncConfig) -> Result<SyncResult, PrismError> {
        let token = self.get_token()?;
        let doc_id = &config.remote_id;

        // For MVP: delete all content, then insert the note content
        // Step 1: Get current doc to find content length
        let doc = self.get_doc(doc_id, &token).await?;
        let end_index = doc["body"]["content"]
            .as_array()
            .and_then(|arr| arr.last())
            .and_then(|e| e["endIndex"].as_u64())
            .unwrap_or(1);

        // Step 2: Delete existing content (if any beyond the initial newline)
        if end_index > 2 {
            let delete_req = serde_json::json!({
                "requests": [{
                    "deleteContentRange": {
                        "range": {
                            "startIndex": 1,
                            "endIndex": end_index - 1
                        }
                    }
                }]
            });
            self.batch_update(doc_id, &delete_req, &token).await?;
        }

        // Step 3: Insert note content
        let insert_req = serde_json::json!({
            "requests": [{
                "insertText": {
                    "location": { "index": 1 },
                    "text": &note.content
                }
            }]
        });
        self.batch_update(doc_id, &insert_req, &token).await?;

        Ok(SyncResult::Pushed {
            content: note.content.clone(),
        })
    }

    async fn pull(&self, _note: &Note, config: &SyncConfig) -> Result<SyncResult, PrismError> {
        let token = self.get_token()?;
        let doc = self.get_doc(&config.remote_id, &token).await?;

        // Extract plain text from Google Docs body
        let content = extract_text_from_doc(&doc);

        Ok(SyncResult::Pulled { content })
    }

    async fn create_remote(&self, note: &Note) -> Result<String, PrismError> {
        let token = self.get_token()?;
        let title = note
            .path
            .as_ref()
            .and_then(|p| p.split('/').last())
            .unwrap_or("Untitled");

        let create_req = serde_json::json!({ "title": title });

        let resp = reqwest::Client::new()
            .post("https://docs.googleapis.com/v1/documents")
            .header("Authorization", format!("Bearer {}", token))
            .json(&create_req)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!(
                "create doc failed: {}",
                resp.status()
            )));
        }

        let data: serde_json::Value = resp.json().await?;
        let doc_id = data["documentId"]
            .as_str()
            .ok_or_else(|| PrismError::Google("No documentId in response".into()))?
            .to_string();

        // Insert initial content
        if !note.content.is_empty() {
            let insert_req = serde_json::json!({
                "requests": [{
                    "insertText": {
                        "location": { "index": 1 },
                        "text": &note.content
                    }
                }]
            });
            self.batch_update(&doc_id, &insert_req, &token).await?;
        }

        Ok(doc_id)
    }

    async fn remote_modified_since(&self, config: &SyncConfig) -> Result<bool, PrismError> {
        let token = self.get_token()?;
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{}?fields=modifiedTime",
            config.remote_id
        );

        let resp = reqwest::Client::new()
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!(
                "drive metadata failed: {}",
                resp.status()
            )));
        }

        let data: serde_json::Value = resp.json().await?;
        let modified = data["modifiedTime"]
            .as_str()
            .unwrap_or("")
            .to_string();

        Ok(modified > config.last_synced)
    }

    async fn get_remote_content(&self, config: &SyncConfig) -> Result<String, PrismError> {
        let token = self.get_token()?;
        let doc = self.get_doc(&config.remote_id, &token).await?;
        Ok(extract_text_from_doc(&doc))
    }
}

impl GoogleDocsAdapter {
    fn get_token(&self) -> Result<String, PrismError> {
        // In production, get from GoogleClient's managed token store
        // For now, return error prompting OAuth setup
        Err(PrismError::Auth(
            "Google Docs sync requires OAuth2 setup. Configure via Settings.".into(),
        ))
    }

    async fn get_doc(
        &self,
        doc_id: &str,
        token: &str,
    ) -> Result<serde_json::Value, PrismError> {
        let url = format!("https://docs.googleapis.com/v1/documents/{}", doc_id);
        let resp = reqwest::Client::new()
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!(
                "get doc failed: {}",
                resp.status()
            )));
        }
        Ok(resp.json().await?)
    }

    async fn batch_update(
        &self,
        doc_id: &str,
        body: &serde_json::Value,
        token: &str,
    ) -> Result<(), PrismError> {
        let url = format!(
            "https://docs.googleapis.com/v1/documents/{}:batchUpdate",
            doc_id
        );
        let resp = reqwest::Client::new()
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(body)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Google(format!(
                "batch update failed: {}",
                resp.status()
            )));
        }
        Ok(())
    }
}

/// Extract plain text from a Google Docs JSON structure
fn extract_text_from_doc(doc: &serde_json::Value) -> String {
    let mut text = String::new();
    if let Some(content) = doc["body"]["content"].as_array() {
        for element in content {
            if let Some(paragraph) = element["paragraph"]["elements"].as_array() {
                for elem in paragraph {
                    if let Some(t) = elem["textRun"]["content"].as_str() {
                        text.push_str(t);
                    }
                }
            }
        }
    }
    text
}
