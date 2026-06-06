use tauri::State;
use crate::commands::config::AppConfig;
use crate::error::PrismError;

#[derive(serde::Serialize)]
pub struct NotionPageInfo {
    pub id: String,
    pub title: String,
    pub url: String,
    pub icon: Option<String>,
}

/// Search Notion pages accessible to the integration
#[tauri::command]
pub async fn notion_list_pages(
    config: State<'_, AppConfig>,
    query: Option<String>,
) -> Result<Vec<NotionPageInfo>, PrismError> {
    if config.notion_api_key.is_empty() {
        return Err(PrismError::Notion("Notion API key not configured".into()));
    }

    let client = reqwest::Client::new();
    let search_query = query.unwrap_or_default();

    let mut body = serde_json::json!({
        "page_size": 50,
        "filter": {"property": "object", "value": "page"},
    });
    if !search_query.is_empty() {
        body["query"] = serde_json::json!(search_query);
    }

    let resp = client.post("https://api.notion.com/v1/search")
        .header("Authorization", format!("Bearer {}", config.notion_api_key))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(PrismError::Notion(format!("Search failed: {}", resp.status())));
    }

    let data: serde_json::Value = resp.json().await?;
    let pages = data["results"].as_array()
        .map(|arr| {
            arr.iter().filter_map(|r| {
                let id = r["id"].as_str()?.to_string();
                let url = r["url"].as_str().unwrap_or("").to_string();

                let title = r["properties"].as_object()
                    .and_then(|props| {
                        props.values().find_map(|v| {
                            if v["type"].as_str() == Some("title") {
                                v["title"].as_array()
                                    .and_then(|t| t.first())
                                    .and_then(|t| t["text"]["content"].as_str())
                                    .map(String::from)
                            } else {
                                None
                            }
                        })
                    })
                    .unwrap_or_else(|| "Untitled".into());

                let icon = r["icon"].as_object().and_then(|i| {
                    if i.get("type")?.as_str()? == "emoji" {
                        i.get("emoji")?.as_str().map(String::from)
                    } else {
                        None
                    }
                });

                Some(NotionPageInfo { id, title, url, icon })
            }).collect()
        })
        .unwrap_or_default();

    Ok(pages)
}
