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
pub fn build_csp(origin: &ServerOrigin) -> String {
    let http = origin.as_str();
    let ws = origin.ws();
    [
        "default-src 'self'".to_string(),
        "script-src 'self' 'wasm-unsafe-eval'".to_string(),
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com".to_string(),
        "font-src 'self' data: https://fonts.gstatic.com https://esm.sh".to_string(),
        format!("img-src 'self' data: blob: {http}"),
        "media-src 'self' blob:".to_string(),
        "worker-src 'self' blob:".to_string(),
        // ipc: / http://ipc.localhost = Tauri's own IPC transport (macOS / Windows+Android).
        format!("connect-src 'self' ipc: http://ipc.localhost {http} {ws}"),
        "object-src 'none'".to_string(),
        "base-uri 'self'".to_string(),
        "form-action 'none'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ]
    .join("; ")
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
    fn build_default_is_valid() {
        let o = ServerOrigin::build_default();
        assert!(o.as_str().starts_with("https://") || o.as_str().starts_with("http://127.0.0.1"));
    }
}
