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

    // Propagate deletions for this window too, so navigating the calendar prunes
    // events that were removed from Google (matches the background sync).
    let (deleted, cancelled) = crate::services::calendar_sync::reconcile_deletions(
        &parachute, &events_data, &from, &to, 100,
    ).await.unwrap_or((0, 0));

    Ok(serde_json::json!({
        "synced": synced,
        "errors": errors,
        "deleted": deleted,
        "cancelled": cancelled,
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
    // Look up a matching agent-skill note so manual "Run now" honors the same
    // routing the scheduler uses: executionMode (structured vs agentic), per-skill
    // provider/model override, and template variables. Falls back to a plain
    // agentic dispatch of the given prompt for ad-hoc/custom runs (no note).
    let skills = parachute.list_notes(&crate::models::note::ListNotesParams {
        tag: Some("agent-skill".into()),
        limit: Some(200),
        include_content: true,
        ..Default::default()
    }).await.unwrap_or_default();

    let matched = skills.into_iter().find(|n| {
        n.metadata.as_ref()
            .and_then(|m| m.get("skillName"))
            .and_then(|v| v.as_str())
            == Some(skill.as_str())
    });

    let id = if let Some(note) = matched {
        let meta = note.metadata.clone().unwrap_or(serde_json::json!({}));
        let provider = meta.get("provider").and_then(|v| v.as_str());
        let model = meta.get("model").and_then(|v| v.as_str());
        let mode = meta.get("executionMode").and_then(|v| v.as_str()).unwrap_or("agentic");

        // Resolve template variables (same as the scheduler).
        let now = chrono::Utc::now();
        let resolved = note.content
            .replace("{{today}}", &now.format("%Y-%m-%d").to_string())
            .replace("{{yesterday}}", &(now - chrono::Duration::days(1)).format("%Y-%m-%d").to_string())
            .replace("{{now}}", &now.to_rfc3339());

        if mode == "structured" {
            dispatch_mgr.dispatch_structured(skill.as_str(), &resolved, meta.clone(), provider, model).await?
        } else {
            dispatch_mgr.dispatch(skill.as_str(), &resolved, None, provider, model).await?
        }
    } else {
        // Ad-hoc / custom prompt — agentic, global routing.
        dispatch_mgr.dispatch(skill.as_str(), prompt.as_str(), context.as_deref(), None, None).await?
    };

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
        include_content: true,
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
            "runAtHour": meta.get("runAtHour").cloned().unwrap_or(serde_json::json!(null)),
            // Per-skill AI routing override (defaults handled by DispatchManager).
            "provider": meta.get("provider").cloned().unwrap_or(serde_json::json!(null)),
            "model": meta.get("model").cloned().unwrap_or(serde_json::json!(null)),
            "executionMode": meta.get("executionMode").cloned().unwrap_or(serde_json::json!("agentic")),
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
    provider: Option<String>,
    model: Option<String>,
    #[allow(non_snake_case)] executionMode: Option<String>,
) -> Result<(), PrismError> {
    let note = parachute.get_note(&id).await?;
    let mut meta = note.metadata.unwrap_or(serde_json::json!({}));

    if let Some(obj) = meta.as_object_mut() {
        if let Some(e) = enabled { obj.insert("enabled".into(), serde_json::json!(e)); }
        if let Some(i) = intervalSecs { obj.insert("intervalSecs".into(), serde_json::json!(i)); }
        if let Some(d) = description { obj.insert("description".into(), serde_json::json!(d)); }
        // Per-skill AI routing override. An empty string is the "use global
        // default" sentinel (DispatchManager::effective_routing treats empty as
        // fallback), which avoids serde's null→None ambiguity for Option fields.
        if let Some(p) = provider { obj.insert("provider".into(), serde_json::json!(p)); }
        if let Some(m) = model { obj.insert("model".into(), serde_json::json!(m)); }
        if let Some(em) = executionMode { obj.insert("executionMode".into(), serde_json::json!(em)); }
    }

    parachute.update_note(&id, &crate::models::note::UpdateNoteParams {
        content: prompt,
        path: None,
        metadata: Some(meta),
        force: Some(true),
        ..Default::default()
    }).await?;

    Ok(())
}
