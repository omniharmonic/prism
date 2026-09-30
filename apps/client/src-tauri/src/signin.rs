//! The platform leg of sign-in: get the browser to the authorize URL and the
//! redirect back to us. Everything else (PKCE, token exchange, keychain) is
//! shared.
//!
//! - desktop (macOS): RFC 8252 §7.3 loopback redirect + the system browser.
//! - mobile: not implemented yet. WP5.2 adds `ASWebAuthenticationSession`
//!   with the `prism://auth/callback` (or universal-link) redirect here.

use tauri::{AppHandle, Runtime};

use crate::state::AppState;

#[cfg(desktop)]
pub async fn sign_in<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Result<(), String> {
    use std::time::Duration;

    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;

    use crate::auth::{device_label, exchange_code};
    use crate::loopback::LoopbackListener;
    use crate::pkce::{authorize_url, PkceSession};

    /// Enough for a password or magic-link login in the browser; the server's
    /// authorization code itself lives 5 minutes.
    const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

    let cancel = state.begin_sign_in();
    let listener = LoopbackListener::bind().await.map_err(|e| e.to_string())?;
    let redirect_uri = listener.redirect_uri();
    let pkce = PkceSession::new();
    let url = authorize_url(&state.origin, &redirect_uri, &pkce, &device_label());

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))?;

    let code = listener
        .wait_for_code(&pkce.state, SIGN_IN_TIMEOUT, cancel)
        .await
        .map_err(|e| e.to_string())?;
    let token = exchange_code(&state.origin, &code, &pkce.verifier, &redirect_uri).await?;
    state.store_token(token).await?;

    if let Some(w) = app.get_webview_window(crate::MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

#[cfg(mobile)]
pub async fn sign_in<R: Runtime>(_app: &AppHandle<R>, _state: &AppState) -> Result<(), String> {
    Err("Sign-in is not available on this platform yet (WP5.2).".into())
}
