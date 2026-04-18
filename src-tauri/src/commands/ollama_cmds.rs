use std::collections::HashMap;
use tauri::State;

use crate::clients::model_router::{AvailableModel, ModelRouter, SkillModelConfig};
use crate::error::PrismError;

/// Check whether the Ollama backend is reachable.
#[tauri::command]
pub async fn ollama_status(
    router: State<'_, ModelRouter>,
) -> Result<bool, PrismError> {
    Ok(router.ollama_available().await)
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
