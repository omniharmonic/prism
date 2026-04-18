//! Model routing layer for AI requests.
//!
//! Routes requests to either Claude Code CLI (default) or Ollama+MCP (user opt-in per skill).
//! Claude Code is the primary provider; Ollama is an optional alternative that users can
//! select on a per-skill basis. Both paths get full vault access — Claude via `.mcp.json`,
//! Ollama via the built-in `PrismMcpClient`.

use std::collections::HashMap;
use std::sync::Mutex;

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};

use crate::clients::anthropic::{ClaudeClient, ClaudeJsonResponse};
use crate::clients::ollama::{ModelInfo, OllamaAgent};
use crate::error::PrismError;

/// Per-skill model configuration specifying which provider and model to use.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SkillModelConfig {
    /// Provider identifier: `"claude"` or `"ollama"`.
    pub provider: String,
    /// Model name, e.g. `"sonnet"` or `"llama3.3"`.
    pub model: String,
}

/// Unified response from either AI provider.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LlmResponse {
    /// The generated text.
    pub result: String,
    /// Session identifier for continuing a conversation.
    pub session_id: Option<String>,
    /// Whether the provider reported an error.
    pub is_error: bool,
}

/// A model available from one of the configured providers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AvailableModel {
    /// Model identifier used when invoking the provider.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Provider this model belongs to: `"claude"` or `"ollama"`.
    pub provider: String,
    /// Model size on disk (Ollama only).
    pub size: Option<String>,
}

/// Routes AI requests to Claude Code CLI (default) or Ollama+MCP (opt-in).
///
/// Thread-safe: the skill configuration map is protected by a [`Mutex`].
pub struct ModelRouter {
    claude: ClaudeClient,
    ollama: Option<OllamaAgent>,
    /// Per-skill model configuration. Key: skill name (e.g. "edit", "chat", "transform", "generate").
    skill_config: Mutex<HashMap<String, SkillModelConfig>>,
}

impl ModelRouter {
    /// Create a new router with the given providers and an empty skill configuration.
    pub fn new(claude: ClaudeClient, ollama: Option<OllamaAgent>) -> Self {
        Self {
            claude,
            ollama,
            skill_config: Mutex::new(HashMap::new()),
        }
    }

    /// Set or update the model configuration for a single skill.
    pub fn set_skill_config(&self, skill: &str, config: SkillModelConfig) {
        let mut map = self.skill_config.lock().expect("skill_config lock poisoned");
        debug!("Setting skill config for '{}': {:?}", skill, config);
        map.insert(skill.to_string(), config);
    }

    /// Retrieve the model configuration for a skill, if one has been set.
    pub fn get_skill_config(&self, skill: &str) -> Option<SkillModelConfig> {
        let map = self.skill_config.lock().expect("skill_config lock poisoned");
        map.get(skill).cloned()
    }

    /// Replace the entire skill configuration map (used when loading from settings).
    pub fn set_all_skill_configs(&self, configs: HashMap<String, SkillModelConfig>) {
        let mut map = self.skill_config.lock().expect("skill_config lock poisoned");
        info!("Loading {} skill config(s)", configs.len());
        *map = configs;
    }

    /// Route a one-shot AI request to the appropriate provider.
    ///
    /// Checks the skill configuration to decide between Ollama and Claude.
    /// Falls back to Claude with model `"sonnet"` when no configuration exists
    /// or the configured Ollama provider is unavailable.
    pub async fn run(
        &self,
        skill: &str,
        system_prompt: &str,
        user_prompt: &str,
        context_key: &str,
        timeout_secs: u64,
    ) -> Result<String, PrismError> {
        let config = self.resolve_config(skill);

        if let Some(ref cfg) = config {
            if cfg.provider == "ollama" {
                if let Some(ref ollama) = self.ollama {
                    debug!("Routing skill '{}' to Ollama model '{}'", skill, cfg.model);
                    return ollama
                        .run(system_prompt, user_prompt, context_key, &cfg.model, timeout_secs)
                        .await;
                }
                warn!(
                    "Skill '{}' configured for Ollama but no Ollama agent available; falling back to Claude",
                    skill
                );
            }
        }

        let model = config
            .as_ref()
            .filter(|c| c.provider == "claude")
            .map(|c| c.model.as_str())
            .unwrap_or("sonnet");

        let prompt = format!("{}\n\n{}", system_prompt, user_prompt);
        debug!("Routing skill '{}' to Claude model '{}'", skill, model);
        self.claude.run(&prompt, model, timeout_secs).await
    }

    /// Route a conversational AI request to the appropriate provider.
    ///
    /// For Claude, uses `run_conversational` with session tracking.
    /// For Ollama, uses `run` (Ollama manages its own conversation history via `context_key`)
    /// and returns `context_key` as the session identifier.
    pub async fn run_conversational(
        &self,
        skill: &str,
        system_prompt: &str,
        user_prompt: &str,
        context_key: &str,
        session_id: Option<&str>,
        timeout_secs: u64,
    ) -> Result<LlmResponse, PrismError> {
        let config = self.resolve_config(skill);

        if let Some(ref cfg) = config {
            if cfg.provider == "ollama" {
                if let Some(ref ollama) = self.ollama {
                    debug!(
                        "Routing conversational skill '{}' to Ollama model '{}'",
                        skill, cfg.model
                    );
                    let result = ollama
                        .run(system_prompt, user_prompt, context_key, &cfg.model, timeout_secs)
                        .await?;
                    return Ok(LlmResponse {
                        result,
                        session_id: Some(context_key.to_string()),
                        is_error: false,
                    });
                }
                warn!(
                    "Skill '{}' configured for Ollama but no Ollama agent available; falling back to Claude",
                    skill
                );
            }
        }

        let model = config
            .as_ref()
            .filter(|c| c.provider == "claude")
            .map(|c| c.model.as_str())
            .unwrap_or("sonnet");

        let prompt = format!("{}\n\n{}", system_prompt, user_prompt);
        debug!(
            "Routing conversational skill '{}' to Claude model '{}'",
            skill, model
        );

        let response: ClaudeJsonResponse = self
            .claude
            .run_conversational(&prompt, model, session_id, timeout_secs)
            .await?;

        Ok(LlmResponse {
            result: response.result,
            session_id: response.session_id,
            is_error: response.is_error,
        })
    }

    /// List all available models across configured providers.
    ///
    /// Claude models are hardcoded (sonnet, opus, haiku). Ollama models are
    /// discovered dynamically via `list_models()` if an agent is configured.
    pub async fn list_available_models(&self) -> Result<Vec<AvailableModel>, PrismError> {
        let mut models = vec![
            AvailableModel {
                id: "sonnet".to_string(),
                name: "Claude Sonnet".to_string(),
                provider: "claude".to_string(),
                size: None,
            },
            AvailableModel {
                id: "opus".to_string(),
                name: "Claude Opus".to_string(),
                provider: "claude".to_string(),
                size: None,
            },
            AvailableModel {
                id: "haiku".to_string(),
                name: "Claude Haiku".to_string(),
                provider: "claude".to_string(),
                size: None,
            },
        ];

        if let Some(ref ollama) = self.ollama {
            match ollama.list_models().await {
                Ok(ollama_models) => {
                    for m in ollama_models {
                        models.push(AvailableModel {
                            id: m.id,
                            name: m.name,
                            provider: "ollama".to_string(),
                            size: m.size,
                        });
                    }
                }
                Err(e) => {
                    warn!("Failed to list Ollama models: {}", e);
                }
            }
        }

        Ok(models)
    }

    /// Check whether the Ollama provider is configured and healthy.
    pub async fn ollama_available(&self) -> bool {
        match &self.ollama {
            Some(ollama) => ollama.health().await.unwrap_or(false),
            None => false,
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────

    /// Read the skill config from the mutex-protected map.
    fn resolve_config(&self, skill: &str) -> Option<SkillModelConfig> {
        let map = self.skill_config.lock().expect("skill_config lock poisoned");
        map.get(skill).cloned()
    }
}
