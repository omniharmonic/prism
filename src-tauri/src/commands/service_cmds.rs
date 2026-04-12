use tauri::State;
use crate::services::ServiceManager;

/// Get the status of all background sync services.
#[tauri::command]
pub fn get_service_status(
    services: State<'_, ServiceManager>,
) -> Vec<crate::services::ServiceStatus> {
    services.status()
}
