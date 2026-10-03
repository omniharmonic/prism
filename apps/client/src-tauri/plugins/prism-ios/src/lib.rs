//! Prism Client's iOS glue (WP5). The Swift half lives in `ios/Sources`.
//!
//! The plugin registers NO webview-callable commands. The app's own commands
//! (declared in the app's build.rs and granted in its `capabilities/mobile.json`)
//! call these typed wrappers, which run the Swift methods with
//! `run_mobile_plugin_async`. So the page's IPC surface stays the shell's explicit
//! list, and every argument the page influences is validated in Rust first.
//!
//! On every non-iOS target the plugin is an inert no-op and the wrappers do not
//! exist (the app only calls them under `#[cfg(target_os = "ios")]`).

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_prism_ios);

/// Handle to the Swift plugin, managed as app state on iOS.
#[cfg(target_os = "ios")]
pub struct PrismIos<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("prism-ios")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let handle = _api.register_ios_plugin(init_plugin_prism_ios)?;
                _app.manage(PrismIos(handle));
            }
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateArgs<'a> {
    pub url: &'a str,
    pub callback_scheme: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateResult {
    /// The full callback URL the session returned (`prism://auth/callback?...`).
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmArgs<'a> {
    pub title: &'a str,
    pub message: &'a str,
    pub confirm: &'a str,
    pub cancel_is_default: bool,
    pub destructive: bool,
}

#[derive(Deserialize)]
pub struct ConfirmResult {
    pub confirmed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// `UIDevice.current.model` ("iPhone", "iPad").
    pub model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureLockArgs<'a> {
    /// "off" | "launch" | "background" | "always" (validated by the app).
    pub mode: &'a str,
    pub minutes: u32,
    /// True once per process, at startup: a mode other than "off" locks the
    /// app before the first frame is shown.
    pub at_launch: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Biometry {
    /// "faceID" | "touchID" | "opticID" | "none"
    pub kind: String,
    /// A device passcode is set (the lock needs one; Face ID falls back to it).
    pub passcode_set: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushRegistration {
    /// The APNs device token, lowercase hex.
    pub token: String,
    /// Built for the simulator (`targetEnvironment(simulator)`).
    pub simulator: bool,
    /// `aps-environment` of the embedded provisioning profile; None when there
    /// is none (App Store and TestFlight installs: Apple strips it).
    #[serde(default)]
    pub profile_environment: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushStatus {
    /// "notDetermined" | "denied" | "authorized" | "provisional" | "ephemeral"
    pub permission: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession {
    pub session_id: Option<String>,
}

#[derive(Deserialize)]
struct Empty {}

#[cfg(target_os = "ios")]
impl<R: Runtime> PrismIos<R> {
    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        cmd: &str,
        args: impl Serialize,
    ) -> Result<T, String> {
        self.0
            .run_mobile_plugin_async::<T>(cmd, args)
            .await
            .map_err(|e| e.to_string())
    }

    /// ASWebAuthenticationSession: returns the callback URL.
    pub async fn authenticate(&self, url: &str, callback_scheme: &str) -> Result<String, String> {
        let r: AuthenticateResult = self
            .call(
                "authenticate",
                AuthenticateArgs {
                    url,
                    callback_scheme,
                },
            )
            .await?;
        Ok(r.url)
    }

    /// UIAlertController. `false` on any failure to show it.
    pub async fn confirm(&self, args: ConfirmArgs<'_>) -> bool {
        self.call::<ConfirmResult>("confirm", args)
            .await
            .map(|r| r.confirmed)
            .unwrap_or(false)
    }

    pub async fn device_info(&self) -> Result<DeviceInfo, String> {
        self.call("deviceInfo", ()).await
    }

    pub async fn configure_lock(
        &self,
        mode: &str,
        minutes: u32,
        at_launch: bool,
    ) -> Result<(), String> {
        self.call::<Empty>(
            "configureLock",
            ConfigureLockArgs {
                mode,
                minutes,
                at_launch,
            },
        )
        .await
        .map(|_| ())
    }

    /// Face ID / Touch ID / passcode, right now. `false` on cancel or failure.
    pub async fn verify_owner(&self, reason: &str) -> bool {
        #[derive(Serialize)]
        struct Args<'a> {
            reason: &'a str,
        }
        self.call::<ConfirmResult>("verifyOwner", Args { reason })
            .await
            .map(|r| r.confirmed)
            .unwrap_or(false)
    }

    pub async fn biometry(&self) -> Result<Biometry, String> {
        self.call("biometry", ()).await
    }

    /// Ask for notification permission if needed, then register with APNs.
    pub async fn push_register(&self) -> Result<PushRegistration, String> {
        self.call("pushRegister", ()).await
    }

    pub async fn push_status(&self) -> Result<PushStatus, String> {
        self.call("pushStatus", ()).await
    }

    /// The agent session of the last tapped notification (consumed).
    pub async fn take_opened_session(&self) -> Result<OpenedSession, String> {
        self.call("takeOpenedSession", ()).await
    }
}
