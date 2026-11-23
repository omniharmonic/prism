//! The quick-capture window: a small separate webview with its OWN capability
//! (capabilities/quick-capture.json grants only `allow-quick-capture`). It
//! loads a static page from the bundle (`quick-capture.html`, no app code, no
//! host hook, no token), and its navigation is locked like the main window's.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::window::{navigation_decision, NavDecision};

pub use crate::capture::WINDOW_LABEL as LABEL;
const PAGE: &str = "quick-capture.html";

/// Open (or focus) the capture window.
pub fn show<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.unminimize();
        return w.set_focus();
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
        .title("Quick capture")
        .inner_size(480.0, 230.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .always_on_top(true)
        .center()
        .focused(true)
        .on_navigation(|url| navigation_decision(url, false) == NavDecision::Allow)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .build()?;
    Ok(())
}
