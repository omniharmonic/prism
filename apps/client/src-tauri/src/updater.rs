//! In-app updates (macOS; docs/client-app.md § Release (CI)).
//!
//! FAIL CLOSED. The updater is part of a build only when build.rs found BOTH the committed public
//! key (`updater/updater.key.pub`) and an update endpoint (`PRISM_UPDATER_ENDPOINT`); it then
//! compiles them in. Without either, nothing here runs: no plugin, no menu item, no request. There
//! is no placeholder key and no runtime way to supply one.
//!
//! Every update is verified by tauri-plugin-updater against that key before it is installed, with
//! `requireSignedVersion` on: the signature's trusted comment must name the version the manifest
//! announces, so a tampered manifest cannot pair a new version number with an older, validly
//! signed release (a downgrade). Downgrades are refused anyway (`allowDowngrades: false`).
//!
//! Rust only. No capability grants an `updater:*` permission, so the plugin's commands cannot be
//! called from any webview, and its JS API is not injected (`withGlobalTauri` is off). The page
//! is never told about updates; the shell asks the person with native dialogs (confirm.rs):
//!   1. a check at launch (after `LAUNCH_DELAY`) and once a day while the app runs, plus
//!      Prism → "Check for Updates…";
//!   2. an update is only downloaded and installed after "Download and Install";
//!   3. the app restarts only after "Restart Now" — never on its own. "Later" keeps the running
//!      version; the installed one starts the next time the app is opened.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::confirm::{self, Prompt};

/// First automatic check, after launch (the window and the sign-in come first).
pub const LAUNCH_DELAY: Duration = Duration::from_secs(20);
/// Automatic checks while the app keeps running (it lives on in the menu bar).
pub const RECHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const NOTES_MAX: usize = 600;

/// The build-time updater configuration (both values from build.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltIn {
    pub pubkey: &'static str,
    pub endpoint: &'static str,
}

/// `Some` only when this build carries the committed key AND an endpoint.
pub fn built_in() -> Option<BuiltIn> {
    from_build_values(
        option_env!("PRISM_UPDATER_PUBKEY"),
        option_env!("PRISM_UPDATER_ENDPOINT"),
    )
}

fn from_build_values(
    pubkey: Option<&'static str>,
    endpoint: Option<&'static str>,
) -> Option<BuiltIn> {
    let pubkey = pubkey.map(str::trim).filter(|k| !k.is_empty())?;
    let endpoint = endpoint
        .map(str::trim)
        .filter(|e| e.starts_with("https://"))?;
    Some(BuiltIn { pubkey, endpoint })
}

/// The `plugins.updater` configuration injected into the app context at startup (it is not in
/// tauri.conf.json, so a build without the key has no updater configuration at all).
pub fn plugin_config(b: &BuiltIn) -> serde_json::Value {
    serde_json::json!({
        "pubkey": b.pubkey,
        "endpoints": [b.endpoint],
        "requireSignedVersion": true,
        "allowDowngrades": false,
    })
}

#[derive(Default)]
pub struct UpdateState {
    busy: AtomicBool,
    /// The version the person answered "Later" to, so the automatic checks of this run do not
    /// ask again (the menu item always asks).
    declined: Mutex<Option<String>>,
}

/// Register the plugin + its state when this build carries an updater; otherwise do nothing.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    match built_in() {
        Some(b) => builder
            .plugin(
                tauri_plugin_updater::Builder::new()
                    .pubkey(b.pubkey)
                    .build(),
            )
            .manage(UpdateState::default()),
        None => builder,
    }
}

pub fn enabled() -> bool {
    built_in().is_some()
}

/// The launch check and the daily one (automatic: silent unless an update is found).
pub fn schedule<R: Runtime>(app: &AppHandle<R>) {
    if !enabled() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LAUNCH_DELAY).await;
        loop {
            check(&app, false);
            tokio::time::sleep(RECHECK_EVERY).await;
        }
    });
}

/// Check for an update. `manual` = from the menu: the person is told the outcome either way.
pub fn check<R: Runtime>(app: &AppHandle<R>, manual: bool) {
    let Some(state) = app.try_state::<UpdateState>() else {
        return;
    };
    if state.busy.swap(true, Ordering::SeqCst) {
        if manual {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                confirm::inform(&app, "Already checking for updates", "Prism Client is checking for an update or installing one. You will be asked before anything changes.").await;
            });
        }
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run(&app, manual).await;
        if let Some(s) = app.try_state::<UpdateState>() {
            s.busy.store(false, Ordering::SeqCst);
        }
    });
}

async fn run<R: Runtime>(app: &AppHandle<R>, manual: bool) {
    let found = match app.updater() {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    let update = match found {
        Ok(Some(u)) => u,
        Ok(None) => {
            if manual {
                let v = app.package_info().version.to_string();
                confirm::inform(
                    app,
                    "Prism Client is up to date",
                    &format!("You have the newest version ({v})."),
                )
                .await;
            }
            return;
        }
        Err(e) => {
            log::warn!("update check failed: {e}");
            if manual {
                confirm::inform(
                    app,
                    "Couldn't check for updates",
                    &failure_text(&e.to_string()),
                )
                .await;
            }
            return;
        }
    };
    let state = app.state::<UpdateState>();
    if !manual
        && state
            .declined
            .lock()
            .ok()
            .and_then(|d| d.clone())
            .as_deref()
            == Some(update.version.as_str())
    {
        return;
    }
    let yes = confirm::ask(
        app,
        Prompt {
            title: format!("Prism Client {} is available", plain(&update.version, 40)),
            body: offer_body(
                &update.current_version,
                &update.version,
                update.body.as_deref(),
            ),
            confirm: "Download and Install".into(),
            cancel_is_default: false,
        },
    )
    .await;
    if !yes {
        if let Ok(mut d) = state.declined.lock() {
            *d = Some(update.version.clone());
        }
        return;
    }
    // The plugin verifies the archive against the built-in key (and the signed version) before
    // it touches the installed app; a failed install leaves the current app in place.
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        log::warn!("update install failed: {e}");
        confirm::inform(
            app,
            "The update was not installed",
            &format!(
                "{} Prism Client was not changed.",
                failure_text(&e.to_string())
            ),
        )
        .await;
        return;
    }
    let restart = confirm::ask(
        app,
        Prompt {
            title: format!("Prism Client {} is installed", plain(&update.version, 40)),
            body: "Restart now to use it? Prism Client closes and opens again. If you choose Cancel, the new version starts the next time you open the app.".into(),
            confirm: "Restart Now".into(),
            cancel_is_default: false,
        },
    )
    .await;
    if restart {
        crate::save_geometry(app);
        app.restart();
    }
}

fn plain(s: &str, max: usize) -> String {
    crate::notify::sanitize_text(s, max)
}

/// The offer text: versions and the release notes, plain and bounded (the manifest is served by
/// the release host; its text is never markup and never a link).
pub fn offer_body(current: &str, next: &str, notes: Option<&str>) -> String {
    let mut body = format!(
        "You have {}. The update is signed by the Prism release key; it is checked before it is installed. You will be asked before the app restarts.",
        plain(current, 40)
    );
    let notes = notes.map(|n| plain(n, NOTES_MAX)).unwrap_or_default();
    if !notes.is_empty() {
        body.push_str(&format!("\n\nWhat's new in {}: {notes}", plain(next, 40)));
    }
    body
}

fn failure_text(reason: &str) -> String {
    format!("{}.", plain(reason, 300).trim_end_matches('.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The throwaway test key of scripts/release/fixtures (its secret half was never kept).
    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDgzRjlDNzgxMkM0QzFEMTQKUldRVUhVd3NnY2Y1ZzB6dGkxTWc0Z01RZ3p6S21ZWjYrTWtBWDB6OXJxWmJIME4zVXBCdnFkRWYK";
    const URL: &str =
        "https://github.com/acme/prism/releases/download/prism-client-updates/latest.json";

    #[test]
    fn needs_both_the_key_and_an_https_endpoint() {
        assert_eq!(from_build_values(None, None), None);
        assert_eq!(
            from_build_values(Some(KEY), None),
            None,
            "a key alone builds no updater"
        );
        assert_eq!(
            from_build_values(None, Some(URL)),
            None,
            "an endpoint alone builds no updater"
        );
        assert_eq!(
            from_build_values(Some("  "), Some(URL)),
            None,
            "an empty key is no key"
        );
        assert_eq!(
            from_build_values(Some(KEY), Some("http://example.com/latest.json")),
            None
        );
        assert_eq!(
            from_build_values(Some(KEY), Some(URL)),
            Some(BuiltIn {
                pubkey: KEY,
                endpoint: URL
            })
        );
    }

    #[test]
    fn this_build_has_no_updater_unless_both_were_given() {
        // The repository commits no key (owner action), so a test build is always without one;
        // and when a key exists, the values come only from build.rs.
        let key_committed = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("updater/updater.key.pub")
            .exists();
        if !key_committed {
            assert!(
                built_in().is_none(),
                "no committed key → no updater, whatever the environment says"
            );
        }
    }

    #[test]
    fn injected_config_verifies_versions_and_is_what_the_plugin_reads() {
        let b = BuiltIn {
            pubkey: KEY,
            endpoint: URL,
        };
        let v = plugin_config(&b);
        assert_eq!(v["requireSignedVersion"], true);
        assert_eq!(v["allowDowngrades"], false);
        assert_eq!(v["endpoints"], serde_json::json!([URL]));
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert!(
            !keys.iter().any(|k| k.starts_with("dangerous")),
            "no dangerous* option"
        );
        let parsed: tauri_plugin_updater::Config =
            serde_json::from_value(v).expect("the plugin parses it");
        assert!(parsed.require_signed_version && !parsed.allow_downgrades);
        assert_eq!(parsed.pubkey, KEY);
        assert_eq!(
            parsed
                .endpoints
                .iter()
                .map(|u| u.as_str())
                .collect::<Vec<_>>(),
            vec![URL]
        );
        assert!(
            !parsed.dangerous_insecure_transport_protocol
                && !parsed.dangerous_accept_invalid_certs
                && !parsed.dangerous_accept_invalid_hostnames
        );
    }

    #[test]
    fn tauri_conf_carries_no_updater_config_and_no_updater_artifacts() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(
            conf.pointer("/plugins/updater").is_none(),
            "the updater config is injected from build.rs values only"
        );
        assert!(
            conf.pointer("/bundle/createUpdaterArtifacts").is_none(),
            "updater archives are a release-job overlay"
        );
    }

    #[test]
    fn offer_text_is_plain_and_bounded() {
        let notes = format!("<b>Faster</b> sync\u{202e}\n{}", "x".repeat(2000));
        let body = offer_body("0.9.0", "0.9.1", Some(&notes));
        assert!(body.starts_with("You have 0.9.0."));
        assert!(body.contains("What's new in 0.9.1: Faster sync"));
        assert!(!body.contains('<') && !body.contains('\u{202e}'));
        assert!(body.chars().count() < 900);
        assert!(!offer_body("0.9.0", "0.9.1", None).contains("What's new"));
        assert_eq!(failure_text("signature mismatch."), "signature mismatch.");
    }
}
