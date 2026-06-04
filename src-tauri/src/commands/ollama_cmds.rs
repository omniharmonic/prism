use std::collections::HashMap;
use tauri::State;

use crate::clients::model_router::{AvailableModel, ModelRouter, SkillModelConfig};
use crate::clients::openai_compat::{ModelInfo, OpenAiCompatClient};
use crate::error::PrismError;

/// Check whether the local (OpenAI-compatible) backend is reachable.
#[tauri::command]
pub async fn ollama_status(
    router: State<'_, ModelRouter>,
) -> Result<bool, PrismError> {
    Ok(router.local_available().await)
}

/// List all available models across every configured provider (Ollama, Claude, etc.).
#[tauri::command]
pub async fn ollama_list_models(
    router: State<'_, ModelRouter>,
) -> Result<Vec<AvailableModel>, PrismError> {
    router.list_available_models().await
}

/// Assign a specific provider/model pair to a skill (e.g. "edit", "chat").
#[tauri::command]
pub async fn set_skill_model(
    router: State<'_, ModelRouter>,
    skill: String,
    provider: String,
    model: String,
) -> Result<(), PrismError> {
    router.set_skill_config(&skill, SkillModelConfig { provider, model });
    Ok(())
}

/// List models exposed by an OpenAI-compatible local server (LM Studio, Ollama
/// `/v1`, llama.cpp, …) at the given base URL. Unlike `ollama_list_models`
/// (which lists the model router's configured providers), this probes the URL
/// the user is configuring for recurring skills directly, so the Settings UI
/// can populate a model dropdown before the value is saved/restarted.
#[tauri::command]
pub async fn local_ai_list_models(base_url: String) -> Result<Vec<ModelInfo>, PrismError> {
    OpenAiCompatClient::new(base_url, None).list_models().await
}

/// Health-check an OpenAI-compatible local server at the given base URL.
#[tauri::command]
pub async fn test_local_ai(base_url: String) -> Result<bool, PrismError> {
    Ok(OpenAiCompatClient::new(base_url, None).health().await)
}

const KNOWN_SKILLS: &[&str] = &["edit", "chat", "transform", "generate"];

/// Return the current provider/model configuration for every known skill.
#[tauri::command]
pub async fn get_skill_models(
    router: State<'_, ModelRouter>,
) -> Result<HashMap<String, SkillModelConfig>, PrismError> {
    let mut map = HashMap::new();
    for &skill in KNOWN_SKILLS {
        if let Some(config) = router.get_skill_config(skill) {
            map.insert(skill.to_string(), config);
        }
    }
    Ok(map)
}
