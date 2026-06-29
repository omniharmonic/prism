//! Local-model agent: vault-aware AI backed by an OpenAI-compatible server.
//!
//! This is the single local-model agent for any OpenAI-compatible backend
//! (LM Studio, Ollama `/v1`, llama.cpp, vLLM) via
//! [`OpenAiCompatClient`], and adds a second execution mode for reliability.
//!
//! Two modes, matching Prism's hybrid recurring-skill design:
//!
//! - [`LocalAgent::run_agentic`] — the model is given the Parachute vault tools
//!   and drives a multi-step tool-calling loop itself (query notes, add tags,
//!   create tasks…). Flexible; matches the existing free-text skill prompts.
//!   Reliability depends on the model's tool-calling quality.
//!
//! - [`LocalAgent::run_structured`] — a single grammar-constrained call that
//!   returns JSON guaranteed to conform to a caller-supplied schema. The model
//!   never touches a tool; Rust performs any resulting vault writes. This is the
//!   high-reliability path for classification/tagging, where a malformed
//!   response would otherwise break the run.
//!
//! Both modes share one [`PrismMcpClient`] for vault access and reuse the cached
//! tool definitions, so a single MCP connection serves the whole agent.

use std::collections::HashMap;
use std::sync::Mutex;

use log::{debug, info, warn};
use serde_json::Value;

use crate::clients::mcp_client::PrismMcpClient;
use crate::clients::openai_compat::{ChatMessage, ModelInfo, OpenAiCompatClient};
use crate::error::PrismError;

/// Maximum number of tool-call round-trips before the agentic loop bails out.
const MAX_ITERATIONS: usize = 12;

/// A vault-aware agent driven by a local OpenAI-compatible model.
pub struct LocalAgent {
    client: OpenAiCompatClient,
    mcp: PrismMcpClient,
    /// Per-thread conversation history, keyed by `context_key`.
    conversations: Mutex<HashMap<String, Vec<ChatMessage>>>,
}

impl LocalAgent {
    /// Create an agent from an already-connected MCP client and a base URL.
    pub fn new(base_url: impl Into<String>, api_key: Option<String>, mcp: PrismMcpClient) -> Self {
        Self {
            client: OpenAiCompatClient::new(base_url, api_key),
            mcp,
            conversations: Mutex::new(HashMap::new()),
        }
    }

    /// The configured base URL of the local server.
    pub fn base_url(&self) -> &str {
        self.client.base_url()
    }

    /// Repoint the agent's vault MCP connection at a different vault (no restart).
    /// Delegates to the live MCP client's `reconnect`; the local model server URL
    /// is unchanged (only the vault it reads/writes moves).
    pub async fn reconnect_mcp(&self, mcp_url: &str, api_key: Option<&str>) -> Result<(), PrismError> {
        self.mcp.reconnect(mcp_url, api_key).await
    }

    /// List models the local server currently exposes.
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, PrismError> {
        self.client.list_models().await
    }

    /// Whether the local server is reachable.
    pub async fn health(&self) -> bool {
        self.client.health().await
    }

    /// Drop the conversation history for a thread.
    pub fn clear_conversation(&self, context_key: &str) {
        if let Ok(mut convos) = self.conversations.lock() {
            convos.remove(context_key);
        }
    }

    // ── Agentic mode ──────────────────────────────────────────────────

    /// Run the agentic tool-calling loop and return the model's final text.
    ///
    /// Builds a message list (`system` + prior history for `context_key` +
    /// `user`), then repeatedly calls the model with the vault tools attached.
    /// Each round, any requested tool calls are executed against the vault and
    /// their results fed back, until the model answers with plain text or
    /// [`MAX_ITERATIONS`] is reached.
    pub async fn run_agentic(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        context_key: &str,
        model: &str,
        timeout_secs: u64,
    ) -> Result<String, PrismError> {
        let mut messages = vec![ChatMessage::system(system_prompt)];

        // Replay prior history (minus any stored system message — we just added a fresh one).
        {
            let convos = self
                .conversations
                .lock()
                .map_err(|e| PrismError::Ollama(format!("lock poisoned: {e}")))?;
            if let Some(history) = convos.get(context_key) {
                for msg in history {
                    if msg.role == "system" {
                        continue;
                    }
                    messages.push(msg.clone());
                }
            }
        }

        messages.push(ChatMessage::user(user_prompt));

        let tools = self.mcp.tools_as_ollama_format(); // OpenAI-format `{type, function}`.

        for iteration in 0..MAX_ITERATIONS {
            debug!(
                "local agent loop {}/{} (model={}, ctx={})",
                iteration + 1,
                MAX_ITERATIONS,
                model,
                context_key
            );

            let assistant = self
                .client
                .chat(model, &messages, Some(&tools), None, timeout_secs)
                .await?;

            let tool_calls = assistant.tool_calls.clone().unwrap_or_default();
            messages.push(assistant.clone());

            if tool_calls.is_empty() {
                // Final answer — persist history and return. Use text() so a
                // reasoning model that left `content` empty still yields its
                // answer from `reasoning_content`.
                self.save_conversation(context_key, &messages);
                return Ok(assistant.text());
            }

            info!("local agent: executing {} tool call(s)", tool_calls.len());
            for call in &tool_calls {
                let name = &call.function.name;
                let args = call.function.arguments_object();
                debug!("local agent tool: {name}");

                let result = match self.mcp.call_tool(name, args).await {
                    Ok(v) => v,
                    Err(e) => {
                        warn!("local agent tool {name} failed: {e}");
                        serde_json::json!({ "error": e.to_string() })
                    }
                };

                messages.push(ChatMessage::tool_result(
                    &call.id,
                    simplify_tool_result(name, &result),
                ));
            }
        }

        Err(PrismError::Ollama(format!(
            "local agent exceeded max iterations ({MAX_ITERATIONS})"
        )))
    }

    // ── Structured mode ───────────────────────────────────────────────

    /// Run a single grammar-constrained call and return JSON conforming to
    /// `schema`. The model is given no tools; the result is parsed and returned
    /// for Rust to act on.
    ///
    /// * `schema_name` — a short identifier for the schema (sent to the server).
    /// * `schema` — a JSON Schema object describing the required output shape.
    ///
    /// On servers that honor `strict` json-schema output (LM Studio, llama.cpp),
    /// the returned value is guaranteed to be valid against `schema`. As a
    /// belt-and-braces fallback for servers that only *bias* toward the schema,
    /// the raw text is also tolerated if it parses as JSON.
    pub async fn run_structured(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        schema_name: &str,
        schema: Value,
        model: &str,
        timeout_secs: u64,
    ) -> Result<Value, PrismError> {
        let messages = vec![ChatMessage::system(system_prompt), ChatMessage::user(user_prompt)];
        let response_format = OpenAiCompatClient::json_schema_format(schema_name, schema);

        let assistant = self
            .client
            .chat(model, &messages, None, Some(response_format), timeout_secs)
            .await?;

        // Reasoning models (e.g. Qwen3) route grammar-constrained output to
        // `reasoning_content`, so read via text(). Parse directly, falling back
        // to extracting the first {...} object if the model wrapped it in prose.
        let text = assistant.text();
        extract_json(&text).ok_or_else(|| {
            PrismError::Ollama(format!(
                "structured output contained no parseable JSON; raw: {}",
                text.chars().take(300).collect::<String>()
            ))
        })
    }

    // ── Helpers ───────────────────────────────────────────────────────

    fn save_conversation(&self, context_key: &str, messages: &[ChatMessage]) {
        if let Ok(mut convos) = self.conversations.lock() {
            convos.insert(context_key.to_string(), messages.to_vec());
        }
    }
}

/// Parse JSON from model text: try the whole (trimmed) string first, then fall
/// back to the first `{`…last `}` slice in case the model wrapped the object in
/// stray prose. Returns `None` if nothing parses.
fn extract_json(text: &str) -> Option<Value> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    if end > start {
        serde_json::from_str::<Value>(&t[start..=end]).ok()
    } else {
        None
    }
}

/// Post-process MCP tool results for the model. `query-notes` payloads are
/// distilled to title/tags/content so the model reasons about note text rather
/// than JSON plumbing; everything else is passed through as pretty JSON.
fn simplify_tool_result(tool_name: &str, result: &Value) -> String {
    if tool_name == "query-notes" {
        return simplify_notes_result(result);
    }
    serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string())
}

/// Extract readable content from `query-notes` results, dropping structural
/// noise (id, timestamps, byteSize).
fn simplify_notes_result(result: &Value) -> String {
    let text = match result {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    let parsed: Value = serde_json::from_str(&text).unwrap_or_else(|_| result.clone());

    let render = |note: &Value| -> String {
        let title = note
            .get("path")
            .and_then(|p| p.as_str())
            .and_then(|p| p.rsplit('/').next())
            .unwrap_or("Untitled");
        let content = note.get("content").and_then(|c| c.as_str()).unwrap_or("");
        let tags = note
            .get("tags")
            .and_then(|t| t.as_array())
            .map(|t| t.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        format!("## {title}\nTags: {tags}\n\n{content}")
    };

    match &parsed {
        Value::Array(notes) => notes.iter().map(render).collect::<Vec<_>>().join("\n\n---\n\n"),
        Value::Object(_) => render(&parsed),
        _ => text,
    }
}
