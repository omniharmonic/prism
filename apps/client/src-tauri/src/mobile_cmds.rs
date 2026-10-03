//! IPC commands of the iOS app (WP5). Declared in build.rs and granted to the
//! main window ONLY on iOS (`capabilities/mobile.json`); the desktop capability
//! never lists them, and on desktop each one answers an error without doing
//! anything.
//!
//!   reset_server       Settings → "Sign out & change server" (native confirmation)
//!   get_app_settings   Settings → Security: lock mode, biometry, the server
//!   set_app_lock       Settings → Security (re-authenticates first when a lock is on)
//!   push_register      notification permission + APNs token (the page POSTs it)
//!   push_status        notification permission
//!   push_take_opened   the agent session of the last tapped notification
//!
//! The Swift side (plugins/prism-ios) is reached only from here and from
//! signin.rs / confirm.rs, never from the page.

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::settings::AppLock;
use crate::state::AppState;

#[cfg(not(target_os = "ios"))]
const ONLY_IOS: &str = "This is only available in the iOS app.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsView {
    pub server_origin: Option<String>,
    pub lock: AppLock,
    /// "faceID" | "touchID" | "opticID" | "none"
    pub biometry: String,
    pub passcode_set: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRegistrationView {
    pub token: String,
    pub environment: String,
}

/// Session ids that may travel from a notification into the page (the same
/// rule as deeplink.ts / notify.rs).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// APNs tokens as the server accepts them (docs/push.md): even-length hex, 64–200.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn valid_apns_token(t: &str) -> bool {
    (64..=200).contains(&t.len()) && t.len() % 2 == 0 && t.chars().all(|c| c.is_ascii_hexdigit())
}

/// The APNs environment of this install's token. App Store and TestFlight
/// installs carry NO embedded provisioning profile (Apple strips it), so "no
/// profile" means PRODUCTION; only the simulator, or a profile that says
/// `development` (an Xcode/dev-signed build), is the sandbox. Getting this wrong
/// = 400 BadDeviceToken = the server deletes the row on every launch.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn apns_environment(profile_environment: Option<&str>, simulator: bool) -> &'static str {
    if simulator || profile_environment == Some("development") {
        "sandbox"
    } else {
        "production"
    }
}

/// Reload the main webview: after any server change the page must boot again
/// under the new CSP/origin (window.rs), whatever else happened.
#[cfg(mobile)]
pub(crate) fn reload_main<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(crate::MAIN_WINDOW) {
        let _ = w.eval("window.location.reload()");
    }
}

/// "Sign out & change server": after a NATIVE confirmation, revoke this device
/// (and its APNs registration), forget the token, and clear the saved server.
/// The page then reloads into the first-run "Enter your server" screen.
/// Returns false when the user cancelled.
#[tauri::command]
pub async fn reset_server<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    #[cfg(target_os = "ios")]
    {
        let Some(origin) = state.origin() else {
            return Ok(true);
        };
        let ok = crate::confirm::ask(
            &app,
            crate::confirm::Prompt {
                title: "Sign out and change server?".into(),
                body: format!(
                    "Prism will sign out of {} on this device. You'll enter a server and sign in again.",
                    origin.as_str()
                ),
                confirm: "Sign Out".into(),
                cancel_is_default: true,
            },
        )
        .await;
        if !ok {
            return Ok(false);
        }
        // Every step runs even if an earlier one failed; the server is cleared
        // in memory regardless and the page always reloads.
        let forget = crate::commands::sign_out_inner(&state, true).await;
        let saved = match state.settings_dir.clone() {
            Some(dir) => crate::settings::update(&dir, |s| s.server_origin = None)
                .map_err(|e| format!("could not save settings: {e}")),
            None => Err("no settings directory on this platform".to_string()),
        };
        state.set_origin(None).await;
        reload_main(&app);
        forget.and(saved).map(|_| true)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (&app, &state);
        Err(ONLY_IOS.into())
    }
}

#[tauri::command]
pub async fn get_app_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<AppSettingsView, String> {
    let lock = state
        .settings_dir
        .as_deref()
        .map(crate::settings::load)
        .and_then(|s| s.app_lock)
        .unwrap_or_default();
    #[cfg(target_os = "ios")]
    let (biometry, passcode_set) = match crate::ios::plugin(&app)?.biometry().await {
        Ok(b) => (b.kind, b.passcode_set),
        Err(_) => ("none".to_string(), false),
    };
    #[cfg(not(target_os = "ios"))]
    let (biometry, passcode_set) = {
        let _ = &app;
        ("none".to_string(), false)
    };
    Ok(AppSettingsView {
        server_origin: state.origin().map(|o| o.as_str().to_string()),
        lock,
        biometry,
        passcode_set,
    })
}

/// Change the app lock. While a lock is on, the change itself needs Face ID /
/// the passcode first, so a page script can't quietly switch it off.
#[tauri::command]
pub async fn set_app_lock<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    mode: String,
    minutes: Option<u32>,
) -> Result<AppLock, String> {
    let wanted = AppLock::parse(&mode, minutes)?;
    #[cfg(target_os = "ios")]
    {
        let dir = state
            .settings_dir
            .clone()
            .ok_or("no settings directory on this platform")?;
        let current = crate::settings::load(&dir).app_lock.unwrap_or_default();
        if current == wanted {
            return Ok(current);
        }
        let ios = crate::ios::plugin(&app)?;
        if current.mode != crate::settings::LockMode::Off
            && !ios.verify_owner("Change the Prism lock").await
        {
            return Err(
                "Not changed: Face ID or your passcode is needed to change the lock.".into(),
            );
        }
        crate::settings::update(&dir, |s| s.app_lock = Some(wanted))
            .map_err(|e| format!("could not save settings: {e}"))?;
        ios.configure_lock(wanted.mode.as_str(), wanted.minutes, false)
            .await?;
        Ok(wanted)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (&app, &state, wanted);
        Err(ONLY_IOS.into())
    }
}

/// Ask for notification permission (first time only) and return this app's
/// APNs token. The page POSTs it to `/api/push/apns` with the device bearer.
#[tauri::command]
pub async fn push_register<R: Runtime>(app: AppHandle<R>) -> Result<PushRegistrationView, String> {
    #[cfg(target_os = "ios")]
    {
        let r = crate::ios::plugin(&app)?.push_register().await?;
        let token = r.token.to_ascii_lowercase();
        if !valid_apns_token(&token) {
            return Err("APNs returned an unexpected token.".into());
        }
        let environment = apns_environment(r.profile_environment.as_deref(), r.simulator);
        Ok(PushRegistrationView {
            token,
            environment: environment.into(),
        })
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = &app;
        Err(ONLY_IOS.into())
    }
}

/// "notDetermined" | "denied" | "authorized" | "provisional" | "ephemeral".
#[tauri::command]
pub async fn push_status<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        Ok(crate::ios::plugin(&app)?.push_status().await?.permission)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = &app;
        Err(ONLY_IOS.into())
    }
}

/// The agent session whose notification was tapped (consumed), or null.
#[tauri::command]
pub async fn push_take_opened<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    #[cfg(target_os = "ios")]
    {
        let id = crate::ios::plugin(&app)?
            .take_opened_session()
            .await?
            .session_id;
        Ok(id.filter(|id| valid_session_id(id)))
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = &app;
        Err(ONLY_IOS.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apns_environment_defaults_to_production() {
        // TestFlight / App Store: Apple strips embedded.mobileprovision.
        assert_eq!(apns_environment(None, false), "production");
        assert_eq!(apns_environment(Some("production"), false), "production");
        // Xcode/dev-signed builds and the simulator use the sandbox.
        assert_eq!(apns_environment(Some("development"), false), "sandbox");
        assert_eq!(apns_environment(None, true), "sandbox");
        assert_eq!(apns_environment(Some("production"), true), "sandbox");
        // Anything unexpected is not "development": production.
        assert_eq!(apns_environment(Some("Development "), false), "production");
    }

    #[test]
    fn session_and_token_validation() {
        assert!(valid_session_id("0b9c8f5e-1d2a-4c3b-9e8f-7a6b5c4d3e2f"));
        assert!(!valid_session_id("short"));
        assert!(!valid_session_id("../../etc/passwd-xxxx"));
        assert!(!valid_session_id(&"a".repeat(65)));
        assert!(valid_apns_token(&"ab".repeat(32)));
        assert!(!valid_apns_token(&"ab".repeat(31)), "too short");
        assert!(
            !valid_apns_token(&format!("{}a", "ab".repeat(40))),
            "odd length"
        );
        assert!(!valid_apns_token(&"zz".repeat(32)), "not hex");
    }
}
