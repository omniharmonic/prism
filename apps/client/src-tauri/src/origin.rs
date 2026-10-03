//! The Prism Server origin this client talks to, and the CSP derived from it.
//!
//! The client talks to exactly ONE origin. It is chosen, in order:
//!   1. the user's "Server settings…" choice (persisted, see `settings.rs`);
//!   2. `PRISM_SERVER_ORIGIN` baked in at build time;
//!   3. [`DEFAULT_ORIGIN`].
//!
//! The same value is injected into the host hook (`apiOrigin`) and into the
//! webview CSP (`connect-src`), so the page cannot reach any other server even
//! if it tried. Platform-independent (shared with the iOS target, WP5).

use url::Url;

/// Default server when nothing else is configured.
pub const DEFAULT_ORIGIN: &str = "https://prism.omniharmonic.com";

/// Parachute vault (1940) and hub (1939) ports. A Prism *client* must never be
/// pointed at them: that would put the vault itself in the CSP.
const FORBIDDEN_LOOPBACK_PORTS: [u16; 2] = [1939, 1940];

/// A validated, normalized server origin: `scheme://host[:port]`, no path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerOrigin(String);

impl ServerOrigin {
    /// Validate + normalize user or build input.
    ///
    /// Rules: `https://` only, except `http://` for a loopback host
    /// (127.0.0.1 / localhost / [::1]) so a local test server can be used. No
    /// path (other than "/"), query, fragment or userinfo. Loopback ports of the
    /// vault/hub are refused.
    pub fn parse(input: &str) -> Result<Self, String> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err("Enter a server address, e.g. https://prism.example.com".into());
        }
        let url = Url::parse(trimmed).map_err(|_| format!("Not a valid URL: {trimmed}"))?;
        let host = url
            .host_str()
            .ok_or_else(|| "The server address needs a host name".to_string())?
            .to_ascii_lowercase();
        let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]");
        match url.scheme() {
            "https" => {}
            "http" if loopback => {}
            "http" => {
                return Err(
                    "Use https:// (plain http is only allowed for 127.0.0.1/localhost)".into(),
                )
            }
            other => return Err(format!("Unsupported scheme {other}:// — use https://")),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("The server address must not contain a user name or password".into());
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err("The server address must not contain ?query or #fragment".into());
        }
        if url.path() != "/" && !url.path().is_empty() {
            return Err("Enter just the server origin, without a path".into());
        }
        if loopback {
            if let Some(port) = url.port_or_known_default() {
                if FORBIDDEN_LOOPBACK_PORTS.contains(&port) {
                    return Err(format!(
                        "Port {port} is the Parachute vault/hub, not a Prism Server. The client only talks to a Prism Server."
                    ));
                }
            }
        }
        let mut out = format!("{}://{}", url.scheme(), host);
        if let Some(port) = url.port() {
            out.push_str(&format!(":{port}"));
        }
        Ok(Self(out))
    }

    /// The origin baked in at build time (`PRISM_SERVER_ORIGIN`), else the default.
    pub fn build_default() -> Self {
        let baked = option_env!("PRISM_SERVER_ORIGIN").unwrap_or(DEFAULT_ORIGIN);
        Self::parse(baked).unwrap_or_else(|e| {
            // A bad build-time value must not brick the app: fall back loudly.
            log::error!("PRISM_SERVER_ORIGIN is invalid ({e}); using {DEFAULT_ORIGIN}");
            Self(DEFAULT_ORIGIN.to_string())
        })
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The websocket origin for the collab socket (`http→ws`, `https→wss`).
    pub fn ws(&self) -> String {
        if let Some(rest) = self.0.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.0.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.0.clone()
        }
    }

    /// `origin + path` (path starts with "/").
    pub fn join(&self, path: &str) -> String {
        format!("{}{}", self.0, path)
    }
}

/// The webview Content-Security-Policy for this origin.
///
/// `connect-src` (fetch/XHR/WebSocket/SSE) is the hard boundary: the app shell,
/// Tauri IPC and the one configured server, nothing else. `img-src` is limited
/// the same way (an image URL is a GET that could carry data out). External
/// images in notes and the OpenFreeMap basemap are NOT allowed here: the page
/// fetches them through the server's SSRF-guarded `/api/media/proxy` (shown as
/// `blob:` URLs) and `/api/map/*` proxies, with the bearer in a header (Client
/// parity C), so this CSP never widens for them. Fonts and
/// stylesheets may still come from Google Fonts / esm.sh (Excalidraw's font
/// files), matching the PWA's server CSP; they cannot carry script.
#[allow(dead_code)] // the policy for one fixed origin; tests and docs use it
pub fn build_csp(origin: &ServerOrigin) -> String {
    build_csp_for(Some(origin))
}

/// [`build_csp`], or — with no server configured yet (the iOS first-run
/// screen) — the same policy with NO remote origin at all: the page can reach
/// only the bundle and the shell's IPC until the user picks a server.
pub fn build_csp_for(origin: Option<&ServerOrigin>) -> String {
    [
        "default-src 'self'".to_string(),
        "script-src 'self' 'wasm-unsafe-eval'".to_string(),
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com".to_string(),
        "font-src 'self' data: https://fonts.gstatic.com https://esm.sh".to_string(),
        img_src(origin),
        "media-src 'self' blob:".to_string(),
        "worker-src 'self' blob:".to_string(),
        connect_src(origin),
        "object-src 'none'".to_string(),
        "base-uri 'self'".to_string(),
        "form-action 'none'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ]
    .join("; ")
}

fn img_src(origin: Option<&ServerOrigin>) -> String {
    match origin {
        Some(o) => format!("img-src 'self' data: blob: {}", o.as_str()),
        None => "img-src 'self' data: blob:".to_string(),
    }
}

/// `ipc:` / `http://ipc.localhost` = Tauri's own IPC transport (macOS+iOS / Windows+Android).
fn connect_src(origin: Option<&ServerOrigin>) -> String {
    match origin {
        Some(o) => format!(
            "connect-src 'self' ipc: http://ipc.localhost {} {}",
            o.as_str(),
            o.ws()
        ),
        None => "connect-src 'self' ipc: http://ipc.localhost".to_string(),
    }
}

/// Re-point a served page's CSP header at the CURRENT origin (iOS, where the
/// origin can change without a process restart). Only the two directives that
/// name the server are replaced; everything else Tauri put in the header
/// (script hashes, nonces) is kept as is. A header without those directives
/// gets them appended, so the result never allows more than [`build_csp_for`].
pub fn retarget_csp(header: &str, origin: Option<&ServerOrigin>) -> String {
    let mut out: Vec<String> = Vec::new();
    let (mut saw_connect, mut saw_img) = (false, false);
    for d in header.split(';').map(str::trim).filter(|d| !d.is_empty()) {
        let name = d
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        match name.as_str() {
            "connect-src" => {
                if !saw_connect {
                    out.push(connect_src(origin));
                }
                saw_connect = true;
            }
            "img-src" => {
                if !saw_img {
                    out.push(img_src(origin));
                }
                saw_img = true;
            }
            _ => out.push(d.to_string()),
        }
    }
    if !saw_img {
        out.push(img_src(origin));
    }
    if !saw_connect {
        out.push(connect_src(origin));
    }
    out.join("; ")
}

/// iOS: the live server origin travels with the page as
/// `<meta name="prism-server-origin" content="…">` (the host hook's
/// `apiOrigin` getter reads it), plus a viewport that disables focus zoom.
/// Inserted right before `</head>` so it is the last viewport declaration (the
/// one WebKit uses). An empty content means "no server yet" (first-run screen).
/// The value is a validated origin, HTML-escaped anyway.
pub fn inject_head_meta(html: &[u8], origin: Option<&ServerOrigin>) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(html).ok()?;
    let at = text.find("</head>")?;
    let value = origin.map(|o| o.as_str()).unwrap_or("");
    let escaped = value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let meta = format!(
        "<meta name=\"prism-server-origin\" content=\"{escaped}\" />\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover\" />"
    );
    let mut out = String::with_capacity(text.len() + meta.len());
    out.push_str(&text[..at]);
    out.push_str(&meta);
    out.push_str(&text[at..]);
    Some(out.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_https_origins() {
        assert_eq!(
            ServerOrigin::parse("https://Prism.Example.com/")
                .unwrap()
                .as_str(),
            "https://prism.example.com"
        );
        assert_eq!(
            ServerOrigin::parse(" https://prism.example.com:8443 ")
                .unwrap()
                .as_str(),
            "https://prism.example.com:8443"
        );
        // default port is dropped by the URL parser
        assert_eq!(
            ServerOrigin::parse("https://prism.example.com:443")
                .unwrap()
                .as_str(),
            "https://prism.example.com"
        );
    }

    #[test]
    fn rejects_bad_origins() {
        for bad in [
            "",
            "prism.example.com",
            "http://prism.example.com",
            "ftp://prism.example.com",
            "https://user:pw@prism.example.com",
            "https://prism.example.com/app",
            "https://prism.example.com/?x=1",
            "https://prism.example.com/#frag",
            "http://127.0.0.1:1940",
            "http://localhost:1939",
            "javascript:alert(1)",
        ] {
            assert!(ServerOrigin::parse(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn allows_http_only_on_loopback() {
        assert_eq!(
            ServerOrigin::parse("http://127.0.0.1:8899")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8899"
        );
        assert_eq!(
            ServerOrigin::parse("http://localhost:8899").unwrap().ws(),
            "ws://localhost:8899"
        );
    }

    #[test]
    fn csp_connects_only_to_the_origin() {
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        let csp = build_csp(&o);
        let connect = csp
            .split("; ")
            .find(|d| d.starts_with("connect-src"))
            .unwrap();
        assert_eq!(
            connect,
            "connect-src 'self' ipc: http://ipc.localhost https://prism.example.com wss://prism.example.com"
        );
        assert!(!csp.contains("1940"));
        assert!(!csp.contains("localhost:"));
        assert!(!csp.contains(" https: "));
        assert!(!csp.contains(" wss: ") && !csp.ends_with(" wss:"));
    }

    #[test]
    fn img_src_is_only_self_data_blob_and_the_origin() {
        // Client parity C: external images/tiles are proxied by the server, never allowed here.
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        let csp = build_csp(&o);
        let img = csp.split("; ").find(|d| d.starts_with("img-src")).unwrap();
        assert_eq!(img, "img-src 'self' data: blob: https://prism.example.com");
        assert!(!csp.contains("openfreemap"));
        assert!(!csp.contains('*'));
    }

    #[test]
    fn unconfigured_csp_reaches_no_server() {
        let csp = build_csp_for(None);
        let connect = csp
            .split("; ")
            .find(|d| d.starts_with("connect-src"))
            .unwrap();
        assert_eq!(connect, "connect-src 'self' ipc: http://ipc.localhost");
        let img = csp.split("; ").find(|d| d.starts_with("img-src")).unwrap();
        assert_eq!(img, "img-src 'self' data: blob:");
        assert!(!csp.contains("https://prism"));
    }

    #[test]
    fn retarget_replaces_only_the_server_directives() {
        let a = ServerOrigin::parse("https://a.example.com").unwrap();
        let b = ServerOrigin::parse("https://b.example.com").unwrap();
        // What Tauri serves: our policy plus hashes it added to script-src.
        let served = format!("{}; script-src 'self' 'sha256-abc='", build_csp(&a))
            .replace("script-src 'self' 'wasm-unsafe-eval'; ", "");
        let out = retarget_csp(&served, Some(&b));
        assert!(out.contains("connect-src 'self' ipc: http://ipc.localhost https://b.example.com wss://b.example.com"));
        assert!(out.contains("img-src 'self' data: blob: https://b.example.com"));
        assert!(!out.contains("a.example.com"), "{out}");
        assert!(out.contains("'sha256-abc='"), "Tauri's hashes are kept");
        assert!(out.contains("default-src 'self'"));
        // Back to unconfigured: no remote origin at all.
        let none = retarget_csp(&out, None);
        assert!(!none.contains("example.com"), "{none}");
        assert!(none.contains("connect-src 'self' ipc: http://ipc.localhost"));
        // A header missing the directives gets them (never wider than ours).
        let bare = retarget_csp("default-src 'self'", Some(&b));
        assert!(bare.contains("connect-src 'self' ipc: http://ipc.localhost https://b.example.com"));
        assert!(bare.contains("img-src 'self' data: blob: https://b.example.com"));
        // Duplicated directives collapse to one (ours).
        let dup = retarget_csp("connect-src *; connect-src https://evil", Some(&b));
        assert_eq!(dup.matches("connect-src").count(), 1);
        assert!(!dup.contains('*') && !dup.contains("evil"));
    }

    #[test]
    fn head_meta_is_injected_before_head_close() {
        let html =
            b"<html><head><meta name=\"viewport\" content=\"x\" /></head><body></body></html>";
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        let out = String::from_utf8(inject_head_meta(html, Some(&o)).unwrap()).unwrap();
        let meta = out
            .find("name=\"prism-server-origin\" content=\"https://prism.example.com\"")
            .unwrap();
        let zoom = out.find("maximum-scale=1.0").unwrap();
        let head_end = out.find("</head>").unwrap();
        assert!(meta < head_end && zoom < head_end);
        assert!(
            out.find("content=\"x\"").unwrap() < zoom,
            "ours is the LAST viewport (the one WebKit uses)"
        );
        let empty = String::from_utf8(inject_head_meta(html, None).unwrap()).unwrap();
        assert!(empty.contains("name=\"prism-server-origin\" content=\"\""));
        assert!(inject_head_meta(b"no head here", Some(&o)).is_none());
    }

    #[test]
    fn build_default_is_valid() {
        let o = ServerOrigin::build_default();
        assert!(o.as_str().starts_with("https://") || o.as_str().starts_with("http://127.0.0.1"));
    }
}
