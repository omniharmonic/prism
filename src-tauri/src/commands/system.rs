use tauri::State;
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;

#[derive(serde::Serialize)]
pub struct ServiceStatus {
    pub parachute: bool,
    pub matrix: bool,
}

#[tauri::command]
pub async fn check_services(
    parachute: State<'_, ParachuteClient>,
) -> Result<ServiceStatus, PrismError> {
    let parachute_ok = parachute.health().await.is_ok();
    // Matrix check will be added later
    Ok(ServiceStatus {
        parachute: parachute_ok,
        matrix: false,
    })
}
