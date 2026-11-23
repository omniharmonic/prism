//! Non-secret, persisted client settings: the chosen server origin, the main
//! window's geometry (desktop) and the app lock (iOS). Stored as JSON in the app
//! config directory (`~/Library/Application Support/<identifier>/client-settings.json`
//! on macOS; the same path inside the app's sandbox container on iOS).
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
    /// Global shortcut that opens the quick-capture window (WP4.2). Absent =
    /// the default (`CommandOrControl+Shift+Space`); an empty string disables
    /// it. Validated at startup (needs a modifier); an invalid value is logged
    /// and ignored. Restart required.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_capture_shortcut: Option<String>,
    /// iOS: Face ID / passcode app lock (WP5). Absent = off. A malformed value
    /// reads as absent, never as a corrupt file (which would drop the origin).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_lock"
    )]
    pub app_lock: Option<AppLock>,
}

fn lenient_lock<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<AppLock>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value::<AppLock>(v)
        .ok()
        .map(AppLock::sanitized))
}

/// When the iOS app asks for Face ID (or the device passcode).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LockMode {
    #[default]
    Off,
    /// Once per app launch.
    Launch,
    /// After the app has been in the background for `minutes`.
    Background,
    /// Every time the app comes back from the background.
    Always,
}

impl LockMode {
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub fn as_str(self) -> &'static str {
        match self {
            LockMode::Off => "off",
            LockMode::Launch => "launch",
            LockMode::Background => "background",
            LockMode::Always => "always",
        }
    }
}

/// Minutes the Settings UI offers for [`LockMode::Background`].
pub const LOCK_MINUTES: [u32; 3] = [5, 15, 60];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppLock {
    pub mode: LockMode,
    /// Only meaningful for `background`; always one of [`LOCK_MINUTES`].
    pub minutes: u32,
}

impl Default for AppLock {
    fn default() -> Self {
        Self {
            mode: LockMode::Off,
            minutes: LOCK_MINUTES[0],
        }
    }
}

impl AppLock {
    /// Validate what the Settings page asks for.
    pub fn parse(mode: &str, minutes: Option<u32>) -> Result<Self, String> {
        let mode = match mode {
            "off" => LockMode::Off,
            "launch" => LockMode::Launch,
            "background" => LockMode::Background,
            "always" => LockMode::Always,
            _ => return Err("Unknown lock setting.".into()),
        };
        let minutes = minutes.unwrap_or(LOCK_MINUTES[0]);
        if !LOCK_MINUTES.contains(&minutes) {
            return Err("Choose 5, 15 or 60 minutes.".into());
        }
        Ok(Self { mode, minutes })
    }

    /// A saved value from disk, with anything out of range treated as the default.
    pub fn sanitized(self) -> Self {
        if LOCK_MINUTES.contains(&self.minutes) {
            self
        } else {
            Self {
                minutes: LOCK_MINUTES[0],
                ..self
            }
        }
    }
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

/// `<config dir>/<identifier>`. On iOS that is inside the app's own sandbox
/// container (`$HOME` is the container there): `Library/Application Support`,
/// which is backed up but never visible in the Files app.
pub fn settings_dir(identifier: &str) -> Option<PathBuf> {
    #[cfg(target_os = "ios")]
    {
        std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(identifier)
        })
    }
    #[cfg(not(target_os = "ios"))]
    {
        dirs::config_dir().map(|d| d.join(identifier))
    }
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
    fn app_lock_parsing() {
        assert_eq!(
            AppLock::parse("background", Some(15)),
            Ok(AppLock {
                mode: LockMode::Background,
                minutes: 15
            })
        );
        assert_eq!(AppLock::parse("off", None).unwrap().mode, LockMode::Off);
        assert_eq!(
            AppLock::parse("always", None).unwrap().mode,
            LockMode::Always
        );
        assert_eq!(AppLock::parse("launch", Some(60)).unwrap().minutes, 60);
        assert!(AppLock::parse("sometimes", None).is_err());
        assert!(AppLock::parse("background", Some(0)).is_err());
        assert!(AppLock::parse("background", Some(7)).is_err());
        let s: Settings =
            serde_json::from_str(r#"{"appLock":{"mode":"always","minutes":5}}"#).unwrap();
        assert_eq!(s.app_lock.unwrap().mode, LockMode::Always);
        let odd: Settings =
            serde_json::from_str(r#"{"appLock":{"mode":"background","minutes":9999}}"#).unwrap();
        assert_eq!(
            odd.app_lock.unwrap().minutes,
            5,
            "out-of-range minutes are sanitized"
        );
        let bad: Settings = serde_json::from_str(
            r#"{"serverOrigin":"https://prism.example.com","appLock":{"mode":"nope","minutes":5}}"#,
        )
        .unwrap();
        assert_eq!(bad.app_lock, None, "a bad lock value reads as off…");
        assert_eq!(
            bad.server_origin.as_deref(),
            Some("https://prism.example.com"),
            "…and never costs the saved server"
        );
        assert!(!serde_json::to_string(&Settings::default())
            .unwrap()
            .contains("appLock"));
    }

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
