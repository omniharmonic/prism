//! The shell's entire IPC surface. Every command here is declared in build.rs
//! and granted in capabilities/default.json; nothing else is callable.

use std::time::Duration;

use tauri::{AppHandle, Runtime, State};

use crate::origin::ServerOrigin;
use crate::state::AppState;
use crate::{auth, settings, signin};

/// The device token for the configured server, or null when signed out.
#[tauri::command]
pub async fn get_token(state: State<'_, AppState>) -> Result<Option<String>, String> {
    state.token().await
}

/// Run the PKCE sign-in in the system browser; resolves once the token is
/// stored. A second call cancels the first.
#[tauri::command]
pub async fn sign_in<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    signin::sign_in(&app, &state).await
}

/// Forget the token. `revoke` (default true) also revokes it server-side; the
/// web app passes false when it already did (`logout()`), or after a 401.
#[tauri::command]
pub async fn sign_out(state: State<'_, AppState>, revoke: Option<bool>) -> Result<(), String> {
    sign_out_inner(&state, revoke.unwrap_or(true)).await
}

pub async fn sign_out_inner(state: &AppState, revoke: bool) -> Result<(), String> {
    let previous = state.forget_token().await?;
    if revoke {
        if let Some(token) = previous {
            if let Err(e) = auth::revoke(&state.origin, &token).await {
                // Forgotten locally either way; the token also dies on its own
                // (idle expiry) and can be revoked in Account → Devices.
                log::warn!("{e}");
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_server_origin(state: State<'_, AppState>) -> String {
    state.origin.as_str().to_string()
}

/// Change the server. Requires the single-use `grant` the shell handed to the
/// Server settings dialog when the user chose it from the native menu, so page
/// script alone cannot repoint the app. Persists, then restarts (the CSP is
/// derived from the origin at startup). Returns the normalized origin.
#[tauri::command]
pub fn set_server_origin<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    origin: String,
    grant: String,
) -> Result<String, String> {
    let parsed = ServerOrigin::parse(&origin)?;
    if !state.take_settings_grant(&grant) {
        return Err("Open Server settings from the Prism menu to change the server.".into());
    }
    if parsed == state.origin {
        return Ok(parsed.as_str().to_string());
    }
    let dir = state
        .settings_dir
        .clone()
        .ok_or("no settings directory on this platform")?;
    settings::update(&dir, |s| {
        s.server_origin = Some(parsed.as_str().to_string())
    })
    .map_err(|e| format!("could not save settings: {e}"))?;
    let normalized = parsed.as_str().to_string();
    // Let the IPC reply reach the page before the process restarts.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        app.restart();
    });
    Ok(normalized)
}
