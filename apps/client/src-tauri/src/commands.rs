//! The shell's entire IPC surface. Every command here is declared in build.rs
//! and granted in capabilities/default.json; nothing else is callable.

#[cfg(desktop)]
use std::time::Duration;

use tauri::{AppHandle, Runtime, State};

use crate::origin::ServerOrigin;
use crate::state::AppState;
use crate::{auth, confirm, settings, signin};

/// The device token for the configured server, or null when signed out.
///
/// The page passes the origin it is about to send the token to (`apiOrigin`).
/// If that is not EXACTLY the shell's current server (a stale page after a
/// server change on iOS, or a tampered value), it gets nothing.
#[tauri::command]
pub async fn get_token(
    state: State<'_, AppState>,
    origin: Option<String>,
) -> Result<Option<String>, String> {
    if !origin_matches(state.origin().as_ref(), origin.as_deref()) {
        return Ok(None);
    }
    state.token().await
}

/// `get_token`'s rule: a configured server, named exactly by the page.
pub fn origin_matches(current: Option<&ServerOrigin>, asked: Option<&str>) -> bool {
    matches!((current, asked), (Some(c), Some(a)) if c.as_str() == a)
}

/// iOS: upper bound for the network part of a sign-out (APNs unregister +
/// revoke): the local forget never waits longer than this on a dead network.
/// (Desktop keeps what it always had: the revoke call's own 30 s client timeout.)
#[cfg(target_os = "ios")]
const SIGN_OUT_NETWORK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

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
    if let (true, Some(origin)) = (revoke, state.origin()) {
        if let Some(token) = state.known_token().await {
            // iOS also drops this device's APNs registration (revoking deletes
            // it server-side too; belt and braces), both calls in parallel under
            // one overall timeout. A failed revoke is logged: the token
            // also dies on its own (idle expiry) and can be revoked in
            // Account -> Signed-in devices.
            let network = async {
                #[cfg(target_os = "ios")]
                let (apns, revoked) = tokio::join!(
                    auth::delete_apns(&origin, &token),
                    auth::revoke(&origin, &token)
                );
                #[cfg(not(target_os = "ios"))]
                let (apns, revoked) = (Ok::<(), String>(()), auth::revoke(&origin, &token).await);
                for r in [apns, revoked] {
                    if let Err(e) = r {
                        log::warn!("{e}");
                    }
                }
            };
            #[cfg(target_os = "ios")]
            if tokio::time::timeout(SIGN_OUT_NETWORK_TIMEOUT, network)
                .await
                .is_err()
            {
                log::warn!(
                    "sign-out: the server didn't answer in time; forgetting the token anyway"
                );
            }
            #[cfg(not(target_os = "ios"))]
            network.await;
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

/// The configured server, or "" while none is set (iOS first run).
#[tauri::command]
pub fn get_server_origin(state: State<'_, AppState>) -> String {
    state
        .origin()
        .map(|o| o.as_str().to_string())
        .unwrap_or_default()
}

/// Change the server.
///
/// iOS: only the first-run "Enter your server" screen may call this, i.e. only
/// while NO server is set (no token exists yet, so there is nothing to steal).
/// The address must answer like a Prism Server (`GET /health`). It is saved and
/// applied in place; the page reloads into the sign-in screen. Changing an
/// existing server goes through `reset_server` (native confirmation + sign-out).
///
/// Desktop: two gates, because page script can alter what the in-page dialog
/// submits:
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
    grant: Option<String>,
) -> Result<String, String> {
    let parsed = ServerOrigin::parse(&origin)?;
    #[cfg(mobile)]
    {
        let _ = grant;
        if state.origin().is_some() {
            return Err("A server is already set. Use Settings → Sign out & change server.".into());
        }
        auth::probe_server(&parsed).await?;
        let dir = state
            .settings_dir
            .clone()
            .ok_or("no settings directory on this platform")?;
        settings::update(&dir, |s| {
            s.server_origin = Some(parsed.as_str().to_string())
        })
        .map_err(|e| format!("could not save settings: {e}"))?;
        state.set_origin(Some(parsed.clone())).await;
        // Nothing can be waiting (links are refused while no server is set), but
        // a link is only ever valid for the server it was checked against.
        {
            use tauri::Manager;
            app.state::<crate::links::LinkState>().clear();
        }
        // Boot the page again under this server's CSP + origin.
        crate::mobile_cmds::reload_main(&app);
        Ok(parsed.as_str().to_string())
    }
    #[cfg(desktop)]
    {
        set_server_origin_desktop(app, &state, parsed, grant.unwrap_or_default()).await
    }
}

#[cfg(desktop)]
async fn set_server_origin_desktop<R: Runtime>(
    app: AppHandle<R>,
    state: &AppState,
    parsed: ServerOrigin,
    grant: String,
) -> Result<String, String> {
    if !state.take_settings_grant(&grant) {
        return Err("Open Server Settings from the Prism menu to change the server.".into());
    }
    if Some(&parsed) == state.origin().as_ref() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_only_for_the_current_origin() {
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        assert!(origin_matches(Some(&o), Some("https://prism.example.com")));
        assert!(!origin_matches(
            Some(&o),
            Some("https://prism.example.com/")
        ));
        assert!(!origin_matches(Some(&o), Some("https://other.example.com")));
        assert!(!origin_matches(Some(&o), Some("")));
        assert!(
            !origin_matches(Some(&o), None),
            "a page that names no origin gets nothing"
        );
        assert!(
            !origin_matches(None, Some("https://prism.example.com")),
            "no server, no token"
        );
    }
}
