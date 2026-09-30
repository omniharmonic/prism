//! Non-secret, persisted client settings: the chosen server origin and the
//! main window's geometry. Stored as JSON in the app config directory
//! (`~/Library/Application Support/<identifier>/client-settings.json` on macOS).
//! The device token is NOT here; it lives in the keychain (`secure_store.rs`).
//!
//! Read before the Tauri app is built (the CSP depends on the origin), so the
//! directory is resolved from the identifier directly, the same way Tauri's
//! `app_config_dir()` does on desktop.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const FILE: &str = "client-settings.json";

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// User-chosen server origin (validated on load; invalid values are ignored).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowGeometry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct WindowGeometry {
    /// Logical size and position.
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub maximized: bool,
}

/// `<config dir>/<identifier>`.
pub fn settings_dir(identifier: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(identifier))
}

pub fn load(dir: &Path) -> Settings {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Write atomically (temp file + rename) so a crash can't leave half a file.
pub fn save(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(tmp, dir.join(FILE))
}

/// Load, change, save.
pub fn update(dir: &Path, f: impl FnOnce(&mut Settings)) -> std::io::Result<()> {
    let mut s = load(dir);
    f(&mut s);
    save(dir, &s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_tolerates_garbage() {
        let dir =
            std::env::temp_dir().join(format!("prism-client-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir), Settings::default(), "missing file = defaults");

        update(&dir, |s| {
            s.server_origin = Some("https://prism.example.com".into())
        })
        .unwrap();
        update(&dir, |s| {
            s.window = Some(WindowGeometry {
                width: 1000.0,
                height: 700.0,
                x: 10.0,
                y: 20.0,
                maximized: false,
            })
        })
        .unwrap();
        let s = load(&dir);
        assert_eq!(
            s.server_origin.as_deref(),
            Some("https://prism.example.com")
        );
        assert_eq!(s.window.unwrap().width, 1000.0);

        std::fs::write(dir.join(FILE), b"{not json").unwrap();
        assert_eq!(
            load(&dir),
            Settings::default(),
            "corrupt file = defaults, never a crash"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
