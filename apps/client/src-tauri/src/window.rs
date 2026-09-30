//! The main webview window: host hook injection, navigation lockdown, and
//! (desktop) window-geometry persistence.

use tauri::webview::NewWindowResponse;
use tauri::{App, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::state::AppState;
use crate::MAIN_WINDOW;

/// The page may only ever be the bundled app (`tauri://localhost` on macOS/iOS,
/// `http(s)://tauri.localhost` on Windows/Android). The IPC capability is
/// scoped to that local origin, so nothing remote can call the shell.
pub fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Links the page may hand to the system browser / mail client.
pub fn is_external_openable(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "mailto") && !is_app_url(url)
}

fn open_externally<R: Runtime>(app: &tauri::AppHandle<R>, url: &Url) {
    use tauri_plugin_opener::OpenerExt;
    if is_external_openable(url) {
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            log::warn!("could not open external link: {e}");
        }
    }
}

pub fn create_main_window<R: Runtime>(app: &mut App<R>) -> tauri::Result<WebviewWindow<R>> {
    let state = app.state::<AppState>();
    let script = crate::host::init_script(&state.origin);
    let handle = app.handle().clone();
    let handle2 = app.handle().clone();

    #[allow(unused_mut)]
    let mut builder =
        WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
            .title("Prism")
            .initialization_script(script)
            .on_navigation(move |url| {
                // about:blank / about:srcdoc: inert frames some editors create.
                if is_app_url(url) || url.scheme() == "about" {
                    return true;
                }
                // Clicked external link: hand it to the system browser, keep the app.
                open_externally(&handle, url);
                false
            });

    #[cfg(desktop)]
    {
        builder = builder
            .on_new_window(move |url, _features| {
                open_externally(&handle2, &url);
                NewWindowResponse::Deny
            })
            .min_inner_size(800.0, 600.0)
            .resizable(true);
        builder = geometry::apply_saved(builder, state.settings_dir.as_deref());
    }
    #[cfg(mobile)]
    let _ = (handle2, NewWindowResponse::<R>::Deny);

    builder.build()
}

#[cfg(desktop)]
pub mod geometry {
    //! Remember the main window's size, position and maximized state.

    use std::path::Path;

    use tauri::{LogicalPosition, LogicalSize, Runtime, WebviewWindow, WebviewWindowBuilder};

    use crate::settings::{self, WindowGeometry};

    const DEFAULT_SIZE: (f64, f64) = (1200.0, 800.0);

    /// Sanity-check a saved geometry (a corrupted or absurd file must not
    /// produce an invisible window).
    pub fn sane(g: &WindowGeometry) -> bool {
        let finite = [g.width, g.height, g.x, g.y].iter().all(|v| v.is_finite());
        finite
            && (400.0..=16384.0).contains(&g.width)
            && (300.0..=16384.0).contains(&g.height)
            && g.x.abs() < 32768.0
            && g.y.abs() < 32768.0
    }

    pub fn apply_saved<'a, R: Runtime, M: tauri::Manager<R>>(
        builder: WebviewWindowBuilder<'a, R, M>,
        dir: Option<&Path>,
    ) -> WebviewWindowBuilder<'a, R, M> {
        let saved = dir.and_then(|d| settings::load(d).window).filter(sane);
        match saved {
            Some(g) => builder
                .inner_size(g.width, g.height)
                .position(g.x, g.y)
                .maximized(g.maximized),
            None => builder.inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1).center(),
        }
    }

    /// If the restored position is off every monitor (a display was
    /// unplugged), recenter.
    pub fn ensure_visible<R: Runtime>(w: &WebviewWindow<R>) {
        let (Ok(pos), Ok(monitors)) = (w.outer_position(), w.available_monitors()) else {
            return;
        };
        let on_screen = monitors.iter().any(|m| {
            let (mp, ms) = (m.position(), m.size());
            pos.x + 40 >= mp.x
                && pos.y >= mp.y - 10
                && pos.x < mp.x + ms.width as i32 - 40
                && pos.y < mp.y + ms.height as i32 - 40
        });
        if !on_screen {
            let _ = w.center();
        }
    }

    pub fn save<R: Runtime>(w: &WebviewWindow<R>, dir: &Path) {
        let Ok(scale) = w.scale_factor() else { return };
        let maximized = w.is_maximized().unwrap_or(false);
        if w.is_minimized().unwrap_or(false) || w.is_fullscreen().unwrap_or(false) {
            return; // don't remember a transient state
        }
        let (Ok(size), Ok(pos)) = (w.inner_size(), w.outer_position()) else {
            return;
        };
        let size: LogicalSize<f64> = size.to_logical(scale);
        let pos: LogicalPosition<f64> = pos.to_logical(scale);
        let mut g = WindowGeometry {
            width: size.width,
            height: size.height,
            x: pos.x,
            y: pos.y,
            maximized,
        };
        if maximized {
            // Keep the pre-maximize frame from last time rather than the screen size.
            if let Some(prev) = settings::load(dir).window.filter(sane) {
                g = WindowGeometry {
                    maximized: true,
                    ..prev
                };
            }
        }
        if sane(&g) {
            if let Err(e) = settings::update(dir, |s| s.window = Some(g)) {
                log::warn!("could not save window state: {e}");
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn rejects_absurd_geometry() {
            let ok = WindowGeometry {
                width: 1200.0,
                height: 800.0,
                x: 0.0,
                y: 25.0,
                maximized: false,
            };
            assert!(sane(&ok));
            assert!(!sane(&WindowGeometry { width: 10.0, ..ok }));
            assert!(!sane(&WindowGeometry {
                height: f64::NAN,
                ..ok
            }));
            assert!(!sane(&WindowGeometry { x: 1e9, ..ok }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_bundled_app_is_navigable() {
        assert!(is_app_url(&u("tauri://localhost/")));
        assert!(is_app_url(&u("tauri://localhost/p/some-site")));
        assert!(is_app_url(&u("http://tauri.localhost/")));
        assert!(!is_app_url(&u("https://prism.example.com/")));
        assert!(!is_app_url(&u("http://localhost:1940/")));
        assert!(!is_app_url(&u("tauri://evil/")));
        assert!(!is_app_url(&u("file:///etc/passwd")));
    }

    #[test]
    fn external_links_go_to_the_browser() {
        assert!(is_external_openable(&u("https://example.com/a")));
        assert!(is_external_openable(&u("mailto:someone@example.com")));
        assert!(!is_external_openable(&u("javascript:alert(1)")));
        assert!(!is_external_openable(&u("file:///etc/passwd")));
        assert!(!is_external_openable(&u("tauri://localhost/")));
    }
}
