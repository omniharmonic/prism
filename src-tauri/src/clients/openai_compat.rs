//! Generic OpenAI-compatible chat client.
//!
//! Speaks the OpenAI `/v1/chat/completions` wire format, which is implemented by
//! a wide range of local inference servers:
//! - **LM Studio** (`http://localhost:1234/v1`) — the preferred local backend.
//! - **Ollama** (`http://localhost:11434/v1`) — its OpenAI-compatibility shim.
//! - **llama.cpp server**, **vLLM**, **LiteLLM**, etc.
//!
//! Switching backends is a base-URL change, nothing more. This is a thin
//! transport layer: it sends one chat-completions request and returns the
//! assistant message. The agentic tool-calling *loop* lives in `LocalAgent`,
//! which drives this client repeatedly; structured (grammar-constrained) output
//! is requested by passing a `response_format`.
//!
//! ## Why this matters for reliability
//!
//! OpenAI-compatible servers support `response_format: { type: "json_schema",
//! json_schema: { name, schema, strict: true } }`. LM Studio and llama.cpp back
//! this with grammar-constrained decoding (GBNF): the sampler is restricted to
//! tokens that keep the output conforming to the schema, so malformed JSON
//! becomes *structurally impossible* — no post-hoc "JSON cleanup" required.

use std::time::Duration;

use log::debug;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::PrismError;

/// A single chat message in the OpenAI format.
///
/// `content` is optional because an assistant message that only requests tool
/// calls carries `content: null`. `tool_call_id` is set only on `role: "tool"`
/// messages, linking a result back to the originating call.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Some reasoning models (Qwen3, DeepSeek-R1, …) emit their answer in a
    /// separate `reasoning_content` channel and leave `content` empty. We read
    /// it as a fallback (see [`ChatMessage::text`]) but never send it back to
    /// the server, so it must not be serialized.
    #[serde(default, skip_serializing)]
    pub reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    /// Construct a `system` message.
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: "system".into(), content: Some(content.into()), reasoning_content: None, tool_calls: None, tool_call_id: None }
    }

    /// Construct a `user` message.
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user".into(), content: Some(content.into()), reasoning_content: None, tool_calls: None, tool_call_id: None }
    }

    /// Construct a `tool` result message linked to a prior tool call.
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: Some(content.into()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
        }
    }

    /// The assistant's textual output: `content` when non-empty, otherwise the
    /// `reasoning_content` fallback (for reasoning models that route output
    /// there). Returns a trimmed string, empty if neither field has text.
    pub fn text(&self) -> String {
        let c = self.content.as_deref().unwrap_or("").trim();
        if !c.is_empty() {
            return c.to_string();
        }
        self.reasoning_content.as_deref().unwrap_or("").trim().to_string()
    }
}

/// A tool invocation requested by the assistant.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolCall {
    /// Opaque id the server assigns; echoed back on the matching tool result.
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default = "default_tool_type")]
    pub call_type: String,
    pub function: FunctionCall,
}

fn default_tool_type() -> String {
    "function".into()
}

/// The name and arguments of a tool call.
///
/// Per the OpenAI spec `arguments` is a JSON-*encoded string*, but some servers
/// (notably Ollama) emit a JSON object. We store the raw [`Value`] and normalize
/// on read via [`FunctionCall::arguments_object`].
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FunctionCall {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

impl FunctionCall {
    /// Return the arguments as a JSON object regardless of whether the server
    /// sent a string-encoded payload or a pre-parsed object.
    pub fn arguments_object(&self) -> Value {
        match &self.arguments {
            Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Object(Default::default())),
            other => other.clone(),
        }
    }
}

/// Summary information about a model exposed by the server's `/models` endpoint.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub size: Option<String>,
}

/// A client for one OpenAI-compatible server.
///
/// Holds the base URL (including the `/v1` segment) and an optional bearer key.
/// Most local servers ignore the key, but vLLM/LiteLLM behind a proxy may
/// require it, so we send it when present.
pub struct OpenAiCompatClient {
    base_url: String,
    client: Client,
    api_key: Option<String>,
}

impl OpenAiCompatClient {
    /// Create a client. `base_url` should include the `/v1` path segment, e.g.
    /// `http://localhost:1234/v1`; a trailing slash is trimmed.
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        Self { base_url, client: Client::new(), api_key }
    }

    /// The configured base URL (without trailing slash).
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        let mut req = self
            .client
            .post(format!("{}{}", self.base_url, path))
            .header("Content-Type", "application/json");
        if let Some(key) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        req
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        let mut req = self.client.get(format!("{}{}", self.base_url, path));
        if let Some(key) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        req
    }

    /// Send one chat-completions request and return the assistant message.
    ///
    /// * `model` — the model id to request (server's `/models` id).
    /// * `messages` — the full conversation so far.
    /// * `tools` — optional OpenAI-format tool definitions (`{type, function}`);
    ///   pass `None` to disable tool calling.
    /// * `response_format` — optional `response_format` object. Pass a
    ///   `json_schema` spec to force grammar-constrained structured output.
    /// * `timeout_secs` — per-request timeout.
    ///
    /// Returns the assistant [`ChatMessage`], which may contain `content`,
    /// `tool_calls`, or both. The caller inspects `tool_calls` to decide whether
    /// to continue an agentic loop.
    pub async fn chat(
        &self,
        model: &str,
        messages: &[ChatMessage],
        tools: Option<&[Value]>,
        response_format: Option<Value>,
        timeout_secs: u64,
    ) -> Result<ChatMessage, PrismError> {
        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": false,
        });

        if let Some(tools) = tools {
            if !tools.is_empty() {
                body["tools"] = json!(tools);
                body["tool_choice"] = json!("auto");
            }
        }
        if let Some(rf) = response_format {
            body["response_format"] = rf;
        }

        debug!(
            "openai-compat chat → {} (model={}, msgs={}, tools={}, structured={})",
            self.base_url,
            model,
            messages.len(),
            tools.map(|t| t.len()).unwrap_or(0),
            body.get("response_format").is_some(),
        );

        let resp = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            self.post("/chat/completions").json(&body).send(),
        )
        .await
        .map_err(|_| PrismError::Ollama(format!("local AI request timed out after {timeout_secs}s")))?
        .map_err(|e| PrismError::Ollama(format!("local AI HTTP error: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_else(|_| "<no body>".into());
            return Err(PrismError::Ollama(format!(
                "local AI returned {status}: {}",
                text.chars().take(500).collect::<String>()
            )));
        }

        let json: Value = resp
            .json()
            .await
            .map_err(|e| PrismError::Ollama(format!("local AI bad JSON: {e}")))?;

        // choices[0].message
        let msg = json
            .pointer("/choices/0/message")
            .ok_or_else(|| PrismError::Ollama("local AI response missing choices[0].message".into()))?;

        serde_json::from_value::<ChatMessage>(msg.clone())
            .map_err(|e| PrismError::Ollama(format!("local AI message parse failed: {e}")))
    }

    /// Build a `response_format` value that forces output conforming to `schema`.
    ///
    /// `schema` must be a JSON Schema object. The `strict: true` flag asks
    /// servers that support it (LM Studio, llama.cpp) to constrain decoding so
    /// the result is guaranteed valid against the schema.
    pub fn json_schema_format(name: &str, schema: Value) -> Value {
        json!({
            "type": "json_schema",
            "json_schema": {
                "name": name,
                "strict": true,
                "schema": schema,
            }
        })
    }

    /// List models the server currently exposes via `GET /models`.
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, PrismError> {
        let resp = self
            .get("/models")
            .send()
            .await
            .map_err(|e| PrismError::Ollama(format!("local AI list-models failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(PrismError::Ollama(format!(
                "local AI /models returned {}",
                resp.status()
            )));
        }

        let body: Value = resp
            .json()
            .await
            .map_err(|e| PrismError::Ollama(format!("local AI /models bad JSON: {e}")))?;

        // OpenAI shape: { "data": [ { "id": "..." }, ... ] }
        let data = body
            .get("data")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let models = data
            .into_iter()
            .filter_map(|m| {
                let id = m.get("id").and_then(|v| v.as_str())?.to_string();
                Some(ModelInfo { id: id.clone(), name: id, size: None })
            })
            .collect();

        Ok(models)
    }

    /// Check whether the server is reachable (via `GET /models`).
    pub async fn health(&self) -> bool {
        matches!(self.get("/models").send().await, Ok(r) if r.status().is_success())
    }
}
