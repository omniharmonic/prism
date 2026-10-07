//! Access to the Swift half of the iOS app (`plugins/prism-ios`). iOS only.

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_prism_ios::PrismIos;

pub fn plugin<R: Runtime>(app: &AppHandle<R>) -> Result<State<'_, PrismIos<R>>, String> {
    app.try_state::<PrismIos<R>>()
        .ok_or_else(|| "the iOS plugin is not loaded".to_string())
}
