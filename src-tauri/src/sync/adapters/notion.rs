use async_trait::async_trait;
use crate::error::PrismError;
use crate::models::note::Note;
use crate::models::sync_config::{SyncConfig, SyncResult};
use super::SyncAdapter;

/// Sync adapter for Notion.
/// Converts markdown to Notion blocks for push, and Notion blocks back to markdown for pull.
pub struct NotionAdapter {
    api_key: String,
}

impl NotionAdapter {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }

    fn client(&self) -> reqwest::Client {
        reqwest::Client::new()
    }
}

#[async_trait]
impl SyncAdapter for NotionAdapter {
    async fn push(&self, note: &Note, config: &SyncConfig) -> Result<SyncResult, PrismError> {
        let page_id = &config.remote_id;

        // Convert HTML → markdown first (TipTap stores HTML)
        let markdown_content = if note.content.contains('<') {
            let md = htmd::convert(&note.content).unwrap_or_default();
            if md.is_empty() { note.content.clone() } else { md }
        } else {
            note.content.clone()
        };

        // Step 1: Delete existing blocks
        let blocks = self.get_page_blocks(page_id).await?;
        for block in blocks {
            if let Some(id) = block["id"].as_str() {
                self.delete_block(id).await?;
            }
        }

        // Step 2: Convert markdown to Notion blocks and append
        let notion_blocks = markdown_to_notion_blocks(&markdown_content);
        self.append_blocks(page_id, &notion_blocks).await?;

        Ok(SyncResult::Pushed {
            content: markdown_content,
        })
    }

    async fn pull(&self, _note: &Note, config: &SyncConfig) -> Result<SyncResult, PrismError> {
        let blocks = self.get_page_blocks(&config.remote_id).await?;
        let content = notion_blocks_to_markdown(&blocks);
        Ok(SyncResult::Pulled { content })
    }

    async fn create_remote(&self, note: &Note) -> Result<String, PrismError> {
        let title = note
            .path
            .as_ref()
            .and_then(|p| p.split('/').last())
            .unwrap_or("Untitled");

        // Create a page in the user's workspace (no parent database)
        let payload = serde_json::json!({
            "parent": { "type": "workspace", "workspace": true },
            "properties": {
                "title": {
                    "title": [{
                        "text": { "content": title }
                    }]
                }
            },
            "children": markdown_to_notion_blocks(&note.content),
        });

        let resp = self.client()
            .post("https://api.notion.com/v1/pages")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Notion-Version", "2022-06-28")
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            let err = resp.text().await.unwrap_or_default();
            return Err(PrismError::Notion(format!("create page failed: {}", err)));
        }

        let data: serde_json::Value = resp.json().await?;
        data["id"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| PrismError::Notion("No id in response".into()))
    }

    async fn remote_modified_since(&self, config: &SyncConfig) -> Result<bool, PrismError> {
        let url = format!("https://api.notion.com/v1/pages/{}", config.remote_id);
        let resp = self.client()
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Notion-Version", "2022-06-28")
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Notion(format!("get page failed: {}", resp.status())));
        }

        let data: serde_json::Value = resp.json().await?;
        let modified = data["last_edited_time"]
            .as_str()
            .unwrap_or("")
            .to_string();

        Ok(modified > config.last_synced)
    }

    async fn get_remote_content(&self, config: &SyncConfig) -> Result<String, PrismError> {
        let blocks = self.get_page_blocks(&config.remote_id).await?;
        Ok(notion_blocks_to_markdown(&blocks))
    }
}

impl NotionAdapter {
    async fn get_page_blocks(&self, page_id: &str) -> Result<Vec<serde_json::Value>, PrismError> {
        let url = format!(
            "https://api.notion.com/v1/blocks/{}/children?page_size=100",
            page_id,
        );
        let resp = self.client()
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Notion-Version", "2022-06-28")
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Notion(format!("get blocks failed: {}", resp.status())));
        }

        let data: serde_json::Value = resp.json().await?;
        Ok(data["results"].as_array().cloned().unwrap_or_default())
    }

    async fn delete_block(&self, block_id: &str) -> Result<(), PrismError> {
        let url = format!("https://api.notion.com/v1/blocks/{}", block_id);
        let resp = self.client()
            .delete(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Notion-Version", "2022-06-28")
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(PrismError::Notion(format!("delete block failed: {}", resp.status())));
        }
        Ok(())
    }

    async fn append_blocks(
        &self,
        page_id: &str,
        blocks: &[serde_json::Value],
    ) -> Result<(), PrismError> {
        if blocks.is_empty() {
            return Ok(());
        }

        let url = format!("https://api.notion.com/v1/blocks/{}/children", page_id);
        let payload = serde_json::json!({ "children": blocks });

        let resp = self.client()
            .patch(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Notion-Version", "2022-06-28")
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            let err = resp.text().await.unwrap_or_default();
            return Err(PrismError::Notion(format!("append blocks failed: {}", err)));
        }
        Ok(())
    }
}

/// Convert markdown text to Notion block format (simplified)
fn markdown_to_notion_blocks(markdown: &str) -> Vec<serde_json::Value> {
    let mut blocks = Vec::new();

    for line in markdown.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }

        if let Some(heading) = trimmed.strip_prefix("# ") {
            blocks.push(serde_json::json!({
                "object": "block",
                "type": "heading_1",
                "heading_1": {
                    "rich_text": [{ "type": "text", "text": { "content": heading } }]
                }
            }));
        } else if let Some(heading) = trimmed.strip_prefix("## ") {
            blocks.push(serde_json::json!({
                "object": "block",
                "type": "heading_2",
                "heading_2": {
                    "rich_text": [{ "type": "text", "text": { "content": heading } }]
                }
            }));
        } else if let Some(heading) = trimmed.strip_prefix("### ") {
            blocks.push(serde_json::json!({
                "object": "block",
                "type": "heading_3",
                "heading_3": {
                    "rich_text": [{ "type": "text", "text": { "content": heading } }]
                }
            }));
        } else if let Some(item) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            blocks.push(serde_json::json!({
                "object": "block",
                "type": "bulleted_list_item",
                "bulleted_list_item": {
                    "rich_text": [{ "type": "text", "text": { "content": item } }]
                }
            }));
        } else if trimmed.starts_with("```") {
            // Code blocks need special handling — skip for now, add as paragraph
            blocks.push(serde_json::json!({
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{ "type": "text", "text": { "content": trimmed } }]
                }
            }));
        } else {
            blocks.push(serde_json::json!({
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{ "type": "text", "text": { "content": trimmed } }]
                }
            }));
        }
    }

    blocks
}

/// Convert Notion blocks back to markdown (simplified)
fn notion_blocks_to_markdown(blocks: &[serde_json::Value]) -> String {
    let mut lines = Vec::new();

    for block in blocks {
        let block_type = block["type"].as_str().unwrap_or("");
        let text = extract_rich_text(block, block_type);

        match block_type {
            "heading_1" => lines.push(format!("# {}", text)),
            "heading_2" => lines.push(format!("## {}", text)),
            "heading_3" => lines.push(format!("### {}", text)),
            "paragraph" => {
                if text.is_empty() {
                    lines.push(String::new());
                } else {
                    lines.push(text);
                }
            }
            "bulleted_list_item" => lines.push(format!("- {}", text)),
            "numbered_list_item" => lines.push(format!("1. {}", text)),
            "to_do" => {
                let checked = block["to_do"]["checked"].as_bool().unwrap_or(false);
                let marker = if checked { "- [x]" } else { "- [ ]" };
                lines.push(format!("{} {}", marker, text));
            }
            "code" => {
                let lang = block["code"]["language"].as_str().unwrap_or("");
                lines.push(format!("```{}", lang));
                lines.push(text);
                lines.push("```".to_string());
            }
            "quote" => lines.push(format!("> {}", text)),
            "divider" => lines.push("---".to_string()),
            _ => {
                if !text.is_empty() {
                    lines.push(text);
                }
            }
        }
    }

    lines.join("\n")
}

fn extract_rich_text(block: &serde_json::Value, block_type: &str) -> String {
    block[block_type]["rich_text"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t["text"]["content"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}
