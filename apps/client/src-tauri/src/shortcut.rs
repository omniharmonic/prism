//! Global shortcut for quick capture (WP4.2, desktop). Registered from Rust at
//! startup through the official global-shortcut plugin; none of the plugin's
//! JS commands is granted to any window, so page script can't register,
//! unregister or listen to global shortcuts.
//!
//! Configurable in `client-settings.json` as `quickCaptureShortcut` (absent =
//! default, "" = off). A shortcut must carry at least one modifier, so a bare
//! key can never be hijacked system-wide.

use std::path::Path;

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::settings;

pub const DEFAULT: &str = "CommandOrControl+Shift+Space";

/// The accelerator string to use, or `None` when disabled.
pub fn resolve(setting: &Option<String>) -> Option<String> {
    match setting {
        None => Some(DEFAULT.to_string()),
        Some(s) if s.trim().is_empty() => None,
        Some(s) => Some(s.trim().to_string()),
    }
}

pub fn parse(accel: &str) -> Result<Shortcut, String> {
    if accel.len() > 64 {
        return Err("shortcut is too long".into());
    }
    let sc: Shortcut = accel
        .parse()
        .map_err(|e| format!("not a valid shortcut ({e})"))?;
    if sc.mods.is_empty() {
        return Err("a global shortcut needs at least one modifier (Cmd/Ctrl/Alt/Shift)".into());
    }
    Ok(sc)
}

pub fn register<R: Runtime>(app: &AppHandle<R>, settings_dir: Option<&Path>) {
    let setting = settings_dir
        .map(settings::load)
        .and_then(|s| s.quick_capture_shortcut);
    let Some(accel) = resolve(&setting) else {
        log::info!("quick-capture shortcut is disabled in settings");
        return;
    };
    let shortcut = match parse(&accel) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("ignoring quickCaptureShortcut {accel:?}: {e}");
            return;
        }
    };
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                if let Err(e) = crate::capture_window::show(app) {
                    log::warn!("could not open quick capture: {e}");
                }
            }
        });
    if let Err(e) = result {
        // Typically "already registered" by another app: the tray still works.
        log::warn!("could not register the quick-capture shortcut {accel:?}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_semantics() {
        assert_eq!(resolve(&None).as_deref(), Some(DEFAULT));
        assert_eq!(resolve(&Some("".into())), None, "empty = disabled");
        assert_eq!(resolve(&Some("  ".into())), None);
        assert_eq!(
            resolve(&Some(" Alt+Shift+K ".into())).as_deref(),
            Some("Alt+Shift+K")
        );
    }

    #[test]
    fn default_parses_and_bare_keys_are_refused() {
        assert!(parse(DEFAULT).is_ok());
        assert!(parse("CmdOrCtrl+Shift+Space").is_ok());
        assert!(parse("Alt+Shift+K").is_ok());
        assert!(parse("Space").is_err(), "no modifier");
        assert!(parse("K").is_err());
        assert!(parse("").is_err());
        assert!(parse("Ctrl+Shift+NotAKey").is_err());
        assert!(parse(&"Ctrl+".repeat(40)).is_err());
    }
}
