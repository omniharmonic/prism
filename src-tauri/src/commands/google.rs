use tauri::State;
use crate::clients::google::GoogleClient;
use crate::commands::config::AppConfig;
use crate::error::PrismError;

// ─── Gmail Commands ──────────────────────────────────────────

#[tauri::command]
pub async fn gmail_list_threads(
    client: State<'_, GoogleClient>,
    config: State<'_, AppConfig>,
    account: Option<String>,
    query: Option<String>,
    max_results: Option<u32>,
    _page_token: Option<String>,
) -> Result<serde_json::Value, PrismError> {
    let acct = account.as_deref().unwrap_or(&config.google_account_primary);
    client.gmail_list_threads(acct, query.as_deref(), max_results.unwrap_or(20))
}

#[tauri::command]
pub async fn gmail_get_thread(
    client: State<'_, GoogleClient>,
    config: State<'_, AppConfig>,
    account: Option<String>,
    thread_id: String,
) -> Result<serde_json::Value, PrismError> {
    let acct = account.as_deref().unwrap_or(&config.google_account_primary);
    client.gmail_get_thread(acct, &thread_id)
}

#[tauri::command]
pub async fn gmail_send(
    client: State<'_, GoogleClient>,
    config: State<'_, AppConfig>,
    account: Option<String>,
    to: Vec<String>,
    subject: String,
    body: String,
    _cc: Option<Vec<String>>,
    _in_reply_to: Option<String>,
) -> Result<serde_json::Value, PrismError> {
    let acct = account.as_deref().unwrap_or(&config.google_account_primary);
    client.gmail_send(acct, &to.join(","), &subject, &body)
}

#[tauri::command]
pub async fn gmail_archive(
    _client: State<'_, GoogleClient>,
    _account: String,
    _thread_id: String,
) -> Result<(), PrismError> {
    // TODO: gog doesn't have a direct archive command
    Err(PrismError::Google("Archive not yet implemented via gog CLI".into()))
}

#[tauri::command]
pub async fn gmail_label(
    _client: State<'_, GoogleClient>,
    _account: String,
    _thread_id: String,
    _add_labels: Vec<String>,
    _remove_labels: Vec<String>,
) -> Result<(), PrismError> {
    Err(PrismError::Google("Label management not yet implemented via gog CLI".into()))
}

// ─── Calendar Commands ───────────────────────────────────

#[tauri::command]
pub async fn calendar_list_events(
    client: State<'_, GoogleClient>,
    config: State<'_, AppConfig>,
    from: Option<String>,
    to: Option<String>,
    _calendar_id: Option<String>,
) -> Result<serde_json::Value, PrismError> {
    let data = if let (Some(ref from), Some(ref to)) = (&from, &to) {
        // Date range query — extract just the date part if ISO datetime was passed
        let from_date = if from.contains('T') { &from[..10] } else { from.as_str() };
        let to_date = if to.contains('T') { &to[..10] } else { to.as_str() };
        client.calendar_list_events_range(&config.google_account_primary, from_date, to_date, 100)?
    } else {
        client.calendar_list_events(&config.google_account_primary, 50)?
    };
    // gog returns { "events": [...] } — extract the events array
    Ok(data.get("events").cloned().unwrap_or(serde_json::json!([])))
}

#[tauri::command]
pub async fn calendar_create_event(
    client: State<'_, GoogleClient>,
    config: State<'_, AppConfig>,
    summary: String,
    start: String,
    end: String,
    _attendees: Option<Vec<String>>,
    _description: Option<String>,
    _location: Option<String>,
    _with_meet: Option<bool>,
) -> Result<serde_json::Value, PrismError> {
    client.calendar_create_event(&config.google_account_primary, &summary, &start, &end)
}

#[tauri::command]
pub async fn calendar_update_event(
    _event_id: String,
    _summary: Option<String>,
    _start: Option<String>,
    _end: Option<String>,
    _attendees: Option<Vec<String>>,
    _description: Option<String>,
) -> Result<serde_json::Value, PrismError> {
    Err(PrismError::Google("Event update not yet implemented via gog CLI".into()))
}

#[tauri::command]
pub async fn calendar_delete_event(
    _event_id: String,
) -> Result<(), PrismError> {
    Err(PrismError::Google("Event delete not yet implemented via gog CLI".into()))
}

// ─── Auth Check ──────────────────────────────────────────

#[tauri::command]
pub fn google_check_auth(
    client: State<'_, GoogleClient>,
    config: State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    let primary_ok = client.check_auth(&config.google_account_primary);
    let agent_ok = client.check_auth(&config.google_account_agent);
    Ok(serde_json::json!({
        "primary": { "account": config.google_account_primary, "authenticated": primary_ok },
        "agent": { "account": config.google_account_agent, "authenticated": agent_ok },
    }))
}
