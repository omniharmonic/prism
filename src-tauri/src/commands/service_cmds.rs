use tauri::State;
use crate::services::ServiceManager;
use crate::services::agent_dispatch::DispatchManager;
use crate::clients::google::GoogleClient;
use crate::clients::parachute::ParachuteClient;
use crate::commands::config::AppConfig;
use crate::error::PrismError;

/// Get the status of all background sync services.
#[tauri::command]
pub fn get_service_status(
    services: State<'_, ServiceManager>,
) -> Vec<crate::services::ServiceStatus> {
    services.status()
}

/// On-demand calendar sync for a specific date range.
/// Called by the CalendarDashboard when the user navigates to a new week/month.
#[tauri::command]
pub async fn calendar_sync_range(
    google: State<'_, GoogleClient>,
    parachute: State<'_, ParachuteClient>,
    config: State<'_, AppConfig>,
    from: String,
    to: String,
) -> Result<serde_json::Value, PrismError> {
    let account = &config.google_account_primary;
    if account.is_empty() {
        return Err(PrismError::Google("No Google account configured".into()));
    }

    let google = google.inner().clone();
    let account = account.clone();
    let from_clone = from.clone();
    let to_clone = to.clone();

    let events_data = tokio::task::spawn_blocking(move || {
        google.calendar_list_events_range(&account, &from_clone, &to_clone, 100)
    }).await
        .map_err(|e| PrismError::Google(format!("spawn error: {}", e)))??;

    let empty_arr = vec![];
    let events = if let Some(arr) = events_data.as_array() {
        arr
    } else {
        events_data.get("events")
            .or_else(|| events_data.get("items"))
            .and_then(|v| v.as_array())
            .unwrap_or(&empty_arr)
    };

    // Sync each event into Parachute
    let mut synced = 0u64;
    let mut errors = 0u64;

    for event in events {
        match crate::services::calendar_sync::sync_single_event(&parachute, event).await {
            Ok(_) => synced += 1,
            Err(e) => {
                log::debug!("Calendar range sync: event error: {}", e);
                errors += 1;
            }
        }
    }

    Ok(serde_json::json!({
        "synced": synced,
        "errors": errors,
        "total": events.len(),
        "from": from,
        "to": to,
    }))
}

/// Dispatch a background agent task.
#[tauri::command]
pub async fn agent_dispatch(
    dispatch_mgr: State<'_, std::sync::Arc<DispatchManager>>,
    parachute: State<'_, ParachuteClient>,
    skill: String,
    prompt: String,
    context: Option<String>,
) -> Result<serde_json::Value, PrismError> {
    // We need a dummy ClaudeClient reference — but dispatch_manager spawns its own process
    let id = dispatch_mgr.dispatch(
        // ClaudeClient not needed — dispatch spawns its own process
        skill.as_str(),
        prompt.as_str(),
        context.as_deref(),
    ).await?;

    Ok(serde_json::json!({ "id": id }))
}

/// List all dispatches (active and completed).
#[tauri::command]
pub async fn agent_get_dispatches(
    dispatch_mgr: State<'_, std::sync::Arc<DispatchManager>>,
) -> Result<Vec<crate::services::agent_dispatch::Dispatch>, PrismError> {
    Ok(dispatch_mgr.list().await)
}

/// Cancel a running dispatch.
#[tauri::command]
pub async fn agent_cancel_dispatch(
    dispatch_mgr: State<'_, std::sync::Arc<DispatchManager>>,
    id: String,
) -> Result<(), PrismError> {
    dispatch_mgr.cancel(&id).await
}

/// List all agent skills.
#[tauri::command]
pub async fn agent_get_skills(
    parachute: State<'_, ParachuteClient>,
) -> Result<Vec<serde_json::Value>, PrismError> {
    let notes = parachute.list_notes(&crate::models::note::ListNotesParams {
        tag: Some("agent-skill".into()),
        path: None,
        limit: Some(100),
        offset: None,
    }).await?;

    Ok(notes.into_iter().map(|n| {
        let meta = n.metadata.clone().unwrap_or(serde_json::json!({}));
        serde_json::json!({
            "id": n.id,
            "path": n.path,
            "prompt": n.content,
            "skillName": meta.get("skillName").cloned().unwrap_or(serde_json::json!("")),
            "description": meta.get("description").cloned().unwrap_or(serde_json::json!("")),
            "intervalSecs": meta.get("intervalSecs").cloned().unwrap_or(serde_json::json!(3600)),
            "enabled": meta.get("enabled").cloned().unwrap_or(serde_json::json!(false)),
            "lastRun": meta.get("lastRun").cloned().unwrap_or(serde_json::json!(null)),
        })
    }).collect())
}

/// Update an agent skill's settings.
#[tauri::command]
pub async fn agent_update_skill(
    parachute: State<'_, ParachuteClient>,
    id: String,
    enabled: Option<bool>,
    #[allow(non_snake_case)] intervalSecs: Option<u64>,
    prompt: Option<String>,
    description: Option<String>,
) -> Result<(), PrismError> {
    let note = parachute.get_note(&id).await?;
    let mut meta = note.metadata.unwrap_or(serde_json::json!({}));

    if let Some(obj) = meta.as_object_mut() {
        if let Some(e) = enabled { obj.insert("enabled".into(), serde_json::json!(e)); }
        if let Some(i) = intervalSecs { obj.insert("intervalSecs".into(), serde_json::json!(i)); }
        if let Some(d) = description { obj.insert("description".into(), serde_json::json!(d)); }
    }

    parachute.update_note(&id, &crate::models::note::UpdateNoteParams {
        content: prompt,
        path: None,
        metadata: Some(meta),
    }).await?;

    Ok(())
}
