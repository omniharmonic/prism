use std::sync::atomic::{AtomicU64, Ordering};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::PrismError;

/// A tool definition returned by the MCP server's `tools/list` method.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct McpToolDef {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

/// MCP client that speaks JSON-RPC 2.0 over Streamable HTTP to the Parachute
/// Vault MCP server. Designed to be shared across async tasks so that Ollama
/// (or any local LLM) can invoke the same vault tools that Claude Code gets
/// via `.mcp.json`.
///
/// # Usage
///
/// ```ignore
/// let mcp = PrismMcpClient::connect("http://localhost:1940/mcp").await?;
/// let result = mcp.call_tool("query-notes", json!({"search": "hello"})).await?;
/// ```
pub struct PrismMcpClient {
    mcp_url: String,
    client: Client,
    tools: Vec<McpToolDef>,
    session_id: Option<String>,
    next_id: AtomicU64,
}

// reqwest::Client is Send+Sync, AtomicU64 is Send+Sync, the rest are plain data.
// Rust derives Send+Sync automatically here, but we assert it for clarity.
const _: () = {
    fn _assert_send_sync<T: Send + Sync>() {}
    fn _check() { _assert_send_sync::<PrismMcpClient>(); }
};

impl PrismMcpClient {
    /// Connect to an MCP server, perform the initialize handshake, and cache
    /// the available tool definitions.
    ///
    /// `mcp_url` should be the full endpoint, e.g. `http://localhost:1940/mcp`.
    pub async fn connect(mcp_url: &str) -> Result<Self, PrismError> {
        let client = Client::new();
        let next_id = AtomicU64::new(1);

        // --- initialize ---
        let init_id = next_id.fetch_add(1, Ordering::Relaxed);
        let init_body = json!({
            "jsonrpc": "2.0",
            "id": init_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "prism", "version": "0.1.3" }
            }
        });

        let init_resp = client
            .post(mcp_url)
            .header("Content-Type", "application/json")
            .json(&init_body)
            .send()
            .await
            .map_err(|e| PrismError::Mcp(format!("initialize request failed: {e}")))?;

        // Capture session ID if the server provides one.
        let session_id = init_resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let init_json: Value = init_resp
            .json()
            .await
            .map_err(|e| PrismError::Mcp(format!("initialize response parse failed: {e}")))?;

        if init_json.get("error").is_some() {
            return Err(PrismError::Mcp(format!(
                "initialize error: {}",
                init_json["error"]
            )));
        }

        log::debug!("MCP initialized: {}", init_json);

        // --- notifications/initialized ---
        let mut notif_req = client
            .post(mcp_url)
            .header("Content-Type", "application/json");
        if let Some(sid) = &session_id {
            notif_req = notif_req.header("mcp-session-id", sid);
        }
        let notif_body = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        notif_req
            .json(&notif_body)
            .send()
            .await
            .map_err(|e| PrismError::Mcp(format!("initialized notification failed: {e}")))?;

        // --- tools/list ---
        let list_id = next_id.fetch_add(1, Ordering::Relaxed);
        let list_body = json!({
            "jsonrpc": "2.0",
            "id": list_id,
            "method": "tools/list"
        });

        let mut list_req = client
            .post(mcp_url)
            .header("Content-Type", "application/json");
        if let Some(sid) = &session_id {
            list_req = list_req.header("mcp-session-id", sid);
        }

        let list_resp: Value = list_req
            .json(&list_body)
            .send()
            .await
            .map_err(|e| PrismError::Mcp(format!("tools/list request failed: {e}")))?
            .json()
            .await
            .map_err(|e| PrismError::Mcp(format!("tools/list response parse failed: {e}")))?;

        let tools_array = list_resp
            .pointer("/result/tools")
            .and_then(|v| v.as_array())
            .ok_or_else(|| PrismError::Mcp("tools/list missing result.tools array".into()))?;

        let tools: Vec<McpToolDef> = serde_json::from_value(Value::Array(tools_array.clone()))
            .map_err(|e| PrismError::Mcp(format!("failed to parse tool definitions: {e}")))?;

        log::info!(
            "MCP client connected to {} — {} tools available",
            mcp_url,
            tools.len()
        );

        Ok(Self {
            mcp_url: mcp_url.to_string(),
            client,
            tools,
            session_id,
            next_id,
        })
    }

    /// Call an MCP tool by name with the given arguments.
    ///
    /// Returns the tool's response content. If the content array contains text
    /// entries, they are concatenated into a single JSON string value. Otherwise
    /// the raw content array is returned.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, PrismError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments
            }
        });

        let mut req = self
            .client
            .post(&self.mcp_url)
            .header("Content-Type", "application/json");
        if let Some(sid) = &self.session_id {
            req = req.header("mcp-session-id", sid);
        }

        let resp: Value = req
            .json(&body)
            .send()
            .await
            .map_err(|e| PrismError::Mcp(format!("tools/call {name} request failed: {e}")))?
            .json()
            .await
            .map_err(|e| {
                PrismError::Mcp(format!("tools/call {name} response parse failed: {e}"))
            })?;

        // Check for JSON-RPC error
        if let Some(err) = resp.get("error") {
            return Err(PrismError::Mcp(format!("tools/call {name} error: {err}")));
        }

        let content = resp
            .pointer("/result/content")
            .ok_or_else(|| PrismError::Mcp(format!("tools/call {name}: missing result.content")))?;

        // Extract text from content array entries.
        if let Some(arr) = content.as_array() {
            let texts: Vec<&str> = arr
                .iter()
                .filter(|item| item.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect();

            if !texts.is_empty() {
                let combined = texts.join("\n");
                // Try to parse as JSON in case the text is structured data.
                return Ok(serde_json::from_str(&combined).unwrap_or(Value::String(combined)));
            }
        }

        // Fallback: return the raw content value.
        Ok(content.clone())
    }

    /// Convert the cached tool definitions to Ollama's tool-calling format.
    ///
    /// Each tool becomes:
    /// ```json
    /// { "type": "function", "function": { "name": "...", "description": "...", "parameters": {...} } }
    /// ```
    pub fn tools_as_ollama_format(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema
                    }
                })
            })
            .collect()
    }

    /// Return the names of all available tools.
    pub fn tool_names(&self) -> Vec<String> {
        self.tools.iter().map(|t| t.name.clone()).collect()
    }

    /// Check whether the MCP server is reachable.
    ///
    /// Sends a lightweight `tools/list` request and returns `true` if the
    /// server responds successfully.
    pub async fn health(&self) -> bool {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/list"
        });

        let mut req = self
            .client
            .post(&self.mcp_url)
            .header("Content-Type", "application/json");
        if let Some(sid) = &self.session_id {
            req = req.header("mcp-session-id", sid);
        }

        matches!(req.json(&body).send().await, Ok(resp) if resp.status().is_success())
    }

    /// Access the cached tool definitions.
    pub fn tools(&self) -> &[McpToolDef] {
        &self.tools
    }
}
