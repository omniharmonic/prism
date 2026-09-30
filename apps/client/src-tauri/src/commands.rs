//! The shell's entire IPC surface. Every command here is declared in build.rs
//! and granted in capabilities/default.json; nothing else is callable.

use std::time::Duration;

use tauri::{AppHandle, Runtime, State};

use crate::origin::ServerOrigin;
use crate::state::AppState;
use crate::{auth, confirm, settings, signin};

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
    // 1. Revoke server-side with whatever token we know (memory, else
    //    keychain) BEFORE touching local storage, so a keychain failure can
    //    never skip the revoke.
    if revoke {
        if let Some(token) = state.known_token().await {
            if let Err(e) = auth::revoke(&state.origin, &token).await {
                // The token also dies on its own (idle expiry) and can be
                // revoked in Account -> Signed-in devices.
                log::warn!("{e}");
            }
        }
    }
    // 2. Forget locally; a keychain failure is reported to the UI.
    state
        .forget_token()
        .await
        .map_err(|e| format!("Signed out, but the saved token could not be removed from the Keychain ({e}). Remove \"Prism device token\" in Keychain Access."))
}

/// Open a link in the system browser / mail client, after the user confirms
/// it in a NATIVE dialog that shows the URL. The only way the page can get
/// anything opened outside the app: navigations are cancelled (window.rs).
#[tauri::command]
pub async fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<bool, String> {
    let Some(target) = crate::window::open_external_target(&url) else {
        return Err("This link can't be opened from Prism.".into());
    };
    let is_mail = target.scheme() == "mailto";
    let ok = confirm::ask(
        &app,
        confirm::Prompt {
            title: if is_mail {
                "Write an email?".into()
            } else {
                "Open this link in your browser?".into()
            },
            body: confirm::display_url(target.as_str()),
            confirm: if is_mail {
                "Open Mail".into()
            } else {
                "Open".into()
            },
            cancel_is_default: false,
        },
    )
    .await;
    if !ok {
        return Ok(false);
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| format!("could not open the link: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn get_server_origin(state: State<'_, AppState>) -> String {
    state.origin.as_str().to_string()
}

/// Change the server. Two gates, because page script can alter what the
/// in-page dialog submits:
///  1. the single-use `grant` the shell handed to the Server settings dialog
///     when the user chose it from the native menu (consumed by this call,
///     whatever happens next);
///  2. a NATIVE confirmation that shows the normalized origin that will
///     actually be saved. Only "Change Server" persists; Cancel/close does not.
/// Then persists and restarts (the CSP is derived from the origin at startup).
/// Returns the normalized origin.
#[tauri::command]
pub async fn set_server_origin<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    origin: String,
    grant: String,
) -> Result<String, String> {
    let parsed = ServerOrigin::parse(&origin)?;
    if !state.take_settings_grant(&grant) {
        return Err("Open Server Settings from the Prism menu to change the server.".into());
    }
    if parsed == state.origin {
        return Ok(parsed.as_str().to_string());
    }
    let confirmed = confirm::ask(
        &app,
        confirm::Prompt {
            title: format!("Point Prism Client at {}?", parsed.as_str()),
            body: format!(
                "Prism Client will talk only to {} from now on and restart. You will need to sign in to that server. \
                 Only continue if you typed this address yourself.",
                parsed.as_str()
            ),
            confirm: "Change Server".into(),
            cancel_is_default: true,
        },
    )
    .await;
    if !confirmed {
        return Err("Server not changed.".into());
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
