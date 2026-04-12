use tauri::State;
use crate::services::ServiceManager;
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
