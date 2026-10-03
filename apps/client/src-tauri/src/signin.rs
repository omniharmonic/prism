//! The platform leg of sign-in: get the browser to the authorize URL and the
//! redirect back to us. Everything else (PKCE, token exchange, keychain) is
//! shared.
//!
//! - desktop (macOS): RFC 8252 §7.3 loopback redirect + the system browser.
//! - iOS: `ASWebAuthenticationSession` (the system sign-in sheet, sharing
//!   Safari's cookies) with the `prism://auth/callback` redirect, which the
//!   server allows by default (`DEVICE_REDIRECT_URIS`). The session hands the
//!   redirect straight back to this app; no URL type is registered, so no other
//!   app's scheme handler is involved.

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

    let origin = state.require_origin()?;
    let cancel = state.begin_sign_in();
    let listener = LoopbackListener::bind().await.map_err(|e| e.to_string())?;
    let redirect_uri = listener.redirect_uri();
    let pkce = PkceSession::new();
    let url = authorize_url(&origin, &redirect_uri, &pkce, &device_label());

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))?;

    let code = listener
        .wait_for_code(&pkce.state, SIGN_IN_TIMEOUT, cancel)
        .await
        .map_err(|e| e.to_string())?;
    let token = exchange_code(&origin, &code, &pkce.verifier, &redirect_uri).await?;
    state.store_token(token).await?;

    if let Some(w) = app.get_webview_window(crate::MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

#[cfg(target_os = "ios")]
pub async fn sign_in<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Result<(), String> {
    use crate::auth::{exchange_code, mobile_device_label};
    use crate::pkce::{
        authorize_url, code_from_redirect, PkceSession, MOBILE_CALLBACK_SCHEME, MOBILE_REDIRECT_URI,
    };

    let origin = state.require_origin()?;
    // A second press replaces the attempt (the Swift side also cancels a sheet
    // that is still up); the old one's result is dropped below.
    let _cancel = state.begin_sign_in();
    let ios = crate::ios::plugin(app)?;
    let model = ios.device_info().await.map(|d| d.model).unwrap_or_default();
    let pkce = PkceSession::new();
    let url = authorize_url(
        &origin,
        MOBILE_REDIRECT_URI,
        &pkce,
        &mobile_device_label(&model),
    );
    let returned = ios.authenticate(&url, MOBILE_CALLBACK_SCHEME).await?;
    let code = code_from_redirect(&returned, MOBILE_REDIRECT_URI, &pkce.state)?;
    let token = exchange_code(&origin, &code, &pkce.verifier, MOBILE_REDIRECT_URI).await?;
    // The server may have been changed while the sheet was up: never file a
    // token under another server's keychain item.
    if state.origin().as_ref() != Some(&origin) {
        // Don't leave a live, unstored device token behind on the old server.
        if let Err(e) = crate::auth::revoke(&origin, &token).await {
            log::warn!("{e}");
        }
        return Err("The server changed during sign-in; sign in again.".into());
    }
    state.store_token(token).await
}

#[cfg(all(mobile, not(target_os = "ios")))]
pub async fn sign_in<R: Runtime>(_app: &AppHandle<R>, _state: &AppState) -> Result<(), String> {
    Err("Sign-in is not available on this platform yet.".into())
}
