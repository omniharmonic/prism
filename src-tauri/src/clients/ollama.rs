use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use log::{debug, error, info, warn};
use reqwest;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::clients::mcp_client::PrismMcpClient;
use crate::error::PrismError;

/// Ollama agent with MCP tool-calling support.
///
/// Connects to a local Ollama instance (default `localhost:11434`) and the
/// Parachute MCP server for vault access. The core `run` method implements a
/// tool-calling agent loop: it sends prompts to Ollama, intercepts tool-call
/// responses, executes them against the vault via [`PrismMcpClient`], feeds
/// results back, and repeats until the model produces a final text answer.
///
/// Conversation history is keyed by `context_key` so multiple independent
/// threads can be maintained concurrently.
pub struct OllamaAgent {
    ollama_url: String,
    client: reqwest::Client,
    mcp: PrismMcpClient,
    conversations: Mutex<HashMap<String, Vec<ChatMessage>>>,
}

/// A single message in a chat conversation.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

/// A tool invocation requested by the model.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolCall {
    pub function: FunctionCall,
}

/// The name and arguments of a tool call.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: Value,
}

/// Summary information about an available Ollama model.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub size: Option<String>,
}

/// Maximum number of tool-call round-trips before we bail out.
const MAX_ITERATIONS: usize = 10;

impl OllamaAgent {
    /// Create a new agent connected to the given Ollama URL and MCP client.
    pub async fn new(ollama_url: String, mcp: PrismMcpClient) -> Self {
        Self {
            ollama_url,
            client: reqwest::Client::new(),
            mcp,
            conversations: Mutex::new(HashMap::new()),
        }
    }

    /// Run the agent loop: send a prompt, handle tool calls, return final text.
    ///
    /// * `system_prompt` — instructions prepended as a system message.
    /// * `user_prompt` — the user's request.
    /// * `context_key` — key for conversation history (reuse to continue a thread).
    /// * `model` — Ollama model name (e.g. `"llama3.3"`).
    /// * `timeout_secs` — per-request timeout in seconds.
    ///
    /// The method loops up to [`MAX_ITERATIONS`] times. On each iteration it
    /// posts the accumulated messages to `/api/chat`. If the response contains
    /// `tool_calls`, each tool is executed via [`PrismMcpClient::call_tool`] and
    /// the results are appended as `role: "tool"` messages before the next
    /// iteration. When the model responds with plain text (no tool calls), that
    /// text is returned and the conversation is saved.
    pub async fn run(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        context_key: &str,
        model: &str,
        timeout_secs: u64,
    ) -> Result<String, PrismError> {
        // Build the initial messages list.
        let mut messages = Vec::new();

        // Always start with the system prompt.
        messages.push(ChatMessage {
            role: "system".into(),
            content: system_prompt.into(),
            tool_calls: None,
        });

        // If we have prior conversation history for this key, append it
        // (skip any leading system message from the saved history since we
        // already added a fresh one above).
        {
            let convos = self.conversations.lock().map_err(|e| {
                PrismError::Ollama(format!("lock poisoned: {e}"))
            })?;
            if let Some(history) = convos.get(context_key) {
                for msg in history {
                    if msg.role == "system" {
                        continue;
                    }
                    messages.push(msg.clone());
                }
            }
        }

        // Append the new user message.
        messages.push(ChatMessage {
            role: "user".into(),
            content: user_prompt.into(),
            tool_calls: None,
        });

        // Collect MCP tools in Ollama format.
        let tools = self.mcp.tools_as_ollama_format();
        let timeout = Duration::from_secs(timeout_secs);

        for iteration in 0..MAX_ITERATIONS {
            debug!(
                "ollama agent loop iteration {}/{} (model={}, context={})",
                iteration + 1,
                MAX_ITERATIONS,
                model,
                context_key
            );

            // Build the request body.
            let body = serde_json::json!({
                "model": model,
                "messages": messages,
                "tools": tools,
                "stream": false,
            });

            // POST with timeout.
            let response = tokio::time::timeout(
                timeout,
                self.client
                    .post(format!("{}/api/chat", self.ollama_url))
                    .json(&body)
                    .send(),
            )
            .await
            .map_err(|_| {
                PrismError::Ollama(format!(
                    "request timed out after {timeout_secs}s"
                ))
            })?
            .map_err(|e| PrismError::Ollama(format!("HTTP error: {e}")))?;

            if !response.status().is_success() {
                let status = response.status();
                let text = response
                    .text()
                    .await
                    .unwrap_or_else(|_| "<no body>".into());
                return Err(PrismError::Ollama(format!(
                    "Ollama returned {status}: {text}"
                )));
            }

            let resp_json: Value = response
                .json()
                .await
                .map_err(|e| PrismError::Ollama(format!("bad JSON: {e}")))?;

            // Extract the assistant message from the response.
            let msg_val = resp_json
                .get("message")
                .ok_or_else(|| {
                    PrismError::Ollama(
                        "response missing 'message' field".into(),
                    )
                })?;

            let content = msg_val
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let tool_calls = Self::parse_tool_calls(msg_val);

            // Push the assistant message into the running conversation.
            messages.push(ChatMessage {
                role: "assistant".into(),
                content: content.clone(),
                tool_calls: tool_calls.clone(),
            });

            // If there are no tool calls, we're done.
            match &tool_calls {
                Some(calls) if !calls.is_empty() => {
                    info!(
                        "ollama agent: {} tool call(s) to execute",
                        calls.len()
                    );

                    for call in calls {
                        let name = &call.function.name;
                        let args = &call.function.arguments;

                        debug!("executing tool: {name}");

                        let result = match self
                            .mcp
                            .call_tool(name, args.clone())
                            .await
                        {
                            Ok(v) => v,
                            Err(e) => {
                                warn!(
                                    "tool {name} failed: {e}, sending error to model"
                                );
                                serde_json::json!({
                                    "error": e.to_string()
                                })
                            }
                        };

                        messages.push(ChatMessage {
                            role: "tool".into(),
                            content: Self::simplify_tool_result(name, &result),
                            tool_calls: None,
                        });
                    }
                }
                _ => {
                    // No tool calls — save conversation and return.
                    self.save_conversation(context_key, &messages);
                    return Ok(content);
                }
            }
        }

        Err(PrismError::Ollama(format!(
            "agent exceeded max iterations ({MAX_ITERATIONS})"
        )))
    }

    /// List models available on the Ollama instance.
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, PrismError> {
        let resp = self
            .client
            .get(format!("{}/api/tags", self.ollama_url))
            .send()
            .await
            .map_err(|e| {
                PrismError::Ollama(format!("failed to list models: {e}"))
            })?;

        if !resp.status().is_success() {
            return Err(PrismError::Ollama(format!(
                "Ollama /api/tags returned {}",
                resp.status()
            )));
        }

        let body: Value = resp
            .json()
            .await
            .map_err(|e| PrismError::Ollama(format!("bad JSON: {e}")))?;

        let models = body
            .get("models")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let result = models
            .into_iter()
            .map(|m| {
                let name = m
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();

                let size = m
                    .get("size")
                    .and_then(|v| v.as_u64())
                    .map(Self::format_bytes);

                ModelInfo {
                    id: name.clone(),
                    name,
                    size,
                }
            })
            .collect();

        Ok(result)
    }

    /// Check whether the Ollama server is reachable.
    pub async fn health(&self) -> Result<bool, PrismError> {
        let resp = self
            .client
            .get(format!("{}/api/tags", self.ollama_url))
            .send()
            .await;

        match resp {
            Ok(r) => Ok(r.status().is_success()),
            Err(e) => {
                debug!("ollama health check failed: {e}");
                Ok(false)
            }
        }
    }

    /// Remove conversation history for the given key.
    pub fn clear_conversation(&self, context_key: &str) {
        if let Ok(mut convos) = self.conversations.lock() {
            convos.remove(context_key);
        }
    }

    // ── Private helpers ─────────────────────────────────────────────

    /// Parse tool_calls from the assistant message, handling both pre-parsed
    /// object arguments and string-encoded JSON arguments.
    fn parse_tool_calls(msg: &Value) -> Option<Vec<ToolCall>> {
        let arr = msg.get("tool_calls")?.as_array()?;
        if arr.is_empty() {
            return None;
        }

        let calls: Vec<ToolCall> = arr
            .iter()
            .filter_map(|tc| {
                let func = tc.get("function")?;
                let name = func.get("name")?.as_str()?.to_string();

                let arguments = match func.get("arguments") {
                    Some(Value::Object(_)) => {
                        func.get("arguments").cloned().unwrap_or(Value::Null)
                    }
                    Some(Value::String(s)) => {
                        // Ollama sometimes returns arguments as a JSON string.
                        serde_json::from_str(s).unwrap_or_else(|e| {
                            warn!(
                                "failed to parse tool arguments string for {name}: {e}"
                            );
                            Value::Object(serde_json::Map::new())
                        })
                    }
                    other => other.cloned().unwrap_or(Value::Null),
                };

                Some(ToolCall {
                    function: FunctionCall { name, arguments },
                })
            })
            .collect();

        if calls.is_empty() {
            None
        } else {
            Some(calls)
        }
    }

    /// Save the current messages list as conversation history.
    fn save_conversation(&self, context_key: &str, messages: &[ChatMessage]) {
        match self.conversations.lock() {
            Ok(mut convos) => {
                convos.insert(context_key.to_string(), messages.to_vec());
            }
            Err(e) => {
                error!("failed to save conversation: lock poisoned: {e}");
            }
        }
    }

    /// Post-process MCP tool results to make them more readable for the LLM.
    /// Extracts the key content from verbose JSON responses.
    fn simplify_tool_result(tool_name: &str, result: &Value) -> String {
        // For query-notes results, extract just the content and key metadata
        if tool_name == "query-notes" {
            return Self::simplify_notes_result(result);
        }
        // For other tools, return as-is
        serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string())
    }

    /// Extract readable content from query-notes results, stripping structural
    /// noise (id, createdAt, updatedAt, byteSize) so the LLM focuses on the
    /// actual note text rather than describing JSON structure.
    fn simplify_notes_result(result: &Value) -> String {
        // Result might be a Value::String containing JSON, or already-parsed JSON
        let text = match result {
            Value::String(s) => s.clone(),
            other => serde_json::to_string(other).unwrap_or_default(),
        };

        // Try to parse as JSON
        let parsed: Value = serde_json::from_str(&text).unwrap_or(result.clone());

        match &parsed {
            Value::Array(notes) => {
                // Multiple notes — extract content from each
                let mut output = Vec::new();
                for note in notes {
                    let title = note.get("path")
                        .and_then(|p| p.as_str())
                        .and_then(|p| p.split('/').last())
                        .unwrap_or("Untitled");
                    let content = note.get("content")
                        .and_then(|c| c.as_str())
                        .unwrap_or("");
                    let tags = note.get("tags")
                        .and_then(|t| t.as_array())
                        .map(|t| t.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", "))
                        .unwrap_or_default();

                    output.push(format!("## {}\nTags: {}\n\n{}", title, tags, content));
                }
                output.join("\n\n---\n\n")
            }
            Value::Object(obj) => {
                // Single note
                let title = obj.get("path")
                    .and_then(|p| p.as_str())
                    .and_then(|p| p.split('/').last())
                    .unwrap_or("Untitled");
                let content = obj.get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                let tags = obj.get("tags")
                    .and_then(|t| t.as_array())
                    .map(|t| t.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", "))
                    .unwrap_or_default();

                format!("## {}\nTags: {}\n\n{}", title, tags, content)
            }
            _ => text
        }
    }

    /// Format a byte count into a human-readable string (e.g. `"4.3GB"`).
    fn format_bytes(bytes: u64) -> String {
        const KB: f64 = 1024.0;
        const MB: f64 = KB * 1024.0;
        const GB: f64 = MB * 1024.0;
        const TB: f64 = GB * 1024.0;

        let b = bytes as f64;
        if b >= TB {
            format!("{:.1}TB", b / TB)
        } else if b >= GB {
            format!("{:.1}GB", b / GB)
        } else if b >= MB {
            format!("{:.1}MB", b / MB)
        } else if b >= KB {
            format!("{:.1}KB", b / KB)
        } else {
            format!("{bytes}B")
        }
    }
}
