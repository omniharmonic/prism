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

/// Plain-http loopback (a local test server) is a development affordance. In an
/// iOS RELEASE build it is refused outright (and the release Info.plist carries
/// no ATS exception for it either); desktop keeps it.
const ALLOW_HTTP_LOOPBACK: bool = cfg!(any(not(target_os = "ios"), debug_assertions));

/// A host that can go into a CSP source expression verbatim: after the URL
/// parser's IDNA step, only LDH labels (letters, digits, hyphen; not at a label
/// edge; 1–63 chars each, ≤253 in all), an IPv4 address, or a bracketed IPv6
/// address. This keeps `*`, `;`, `'`, `,`, spaces and anything else out of the
/// policy (`https://*.evil.com` would otherwise widen connect-src to a wildcard,
/// and `x.com;frame-src` would add a directive).
fn csp_safe_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_)) => true,
        Some(url::Host::Domain(d)) => {
            let d = d.strip_suffix('.').unwrap_or(d);
            !d.is_empty()
                && d.len() <= 253
                && d.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
        }
        None => false,
    }
}

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
        if url.scheme() == "https" || url.scheme() == "http" {
            if url.host().is_some() && !csp_safe_host(&url) {
                return Err("That server name isn't a valid host name".into());
            }
        }
        let host = url
            .host_str()
            .ok_or_else(|| "The server address needs a host name".to_string())?
            .to_ascii_lowercase();
        let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]");
        match url.scheme() {
            "https" => {}
            "http" if loopback && ALLOW_HTTP_LOOPBACK => {}
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
        // A trailing root dot is the same host; keep the policy canonical.
        let host = host.strip_suffix('.').map(str::to_string).unwrap_or(host);
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
        frame_src(origin),
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

/// The embed players a page may frame inside the app (owner decision c.7,
/// 2026-10-08): YouTube (no-cookie) and Vimeo ONLY, each scoped to its player
/// path. A trailing "/" is a CSP prefix match. Every other provider the PWA
/// frames (Spotify, Loom, Figma, Google, X) stays an "Open in …" card here.
/// The page's `__PRISM_HOST__.frameOrigins` (host.js) and
/// [`is_embed_player_url`] must name the same two — `verify-client.mjs` checks.
pub const EMBED_FRAME_SOURCES: [&str; 2] = [
    "https://www.youtube-nocookie.com/embed/",
    "https://player.vimeo.com/video/",
];

/// Is `url` one of the two embed players, exactly as the CSP scopes them:
/// https, the exact host, the default port, no credentials, under the player
/// path? Used by the navigation rule (window.rs), which sees a frame's load as
/// a navigation and cannot tell it from a main-frame one.
pub fn is_embed_player_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    EMBED_FRAME_SOURCES.iter().any(|source| {
        let s = Url::parse(source).expect("a constant URL parses");
        url.host_str() == s.host_str() && url.path().starts_with(s.path())
    })
}

/// No server configured (iOS first run): nothing remote, players included.
fn frame_src(origin: Option<&ServerOrigin>) -> String {
    match origin {
        Some(_) => format!("frame-src 'self' {}", EMBED_FRAME_SOURCES.join(" ")),
        None => "frame-src 'self'".to_string(),
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
/// origin can change without a process restart). Only the directives that
/// depend on the server (`connect-src`, `img-src`, and `frame-src`, which names
/// the embed players only once a server is set) are replaced; everything else Tauri put in the header
/// (script hashes, nonces) is kept as is. A header without those directives
/// gets them appended, so the result never allows more than [`build_csp_for`].
pub fn retarget_csp(header: &str, origin: Option<&ServerOrigin>) -> String {
    let mut out: Vec<String> = Vec::new();
    let (mut saw_connect, mut saw_img, mut saw_frame) = (false, false, false);
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
            "frame-src" => {
                if !saw_frame {
                    out.push(frame_src(origin));
                }
                saw_frame = true;
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
    if !saw_frame {
        out.push(frame_src(origin));
    }
    out.join("; ")
}

/// iOS: the live server origin travels with the page as
/// `<meta name="prism-server-origin" content="…">` in `<head>` (the host hook's
/// `apiOrigin` getter reads it from `document.head`). An empty content means
/// "no server yet" (first-run screen). The value is a validated origin,
/// HTML-escaped anyway. (Pinch zoom stays available: zoom-on-focus is avoided
/// by the 16px input rule, not by disabling user scaling.)
pub fn inject_head_meta(html: &[u8], origin: Option<&ServerOrigin>) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(html).ok()?;
    let at = text.find("</head>")?;
    let value = origin.map(|o| o.as_str()).unwrap_or("");
    let escaped = value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let meta = format!("<meta name=\"prism-server-origin\" content=\"{escaped}\" />");
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
        // No remote origin of ANY kind before a server is chosen — the embed players included.
        let frame = csp.split("; ").find(|d| d.starts_with("frame-src")).unwrap();
        assert_eq!(frame, "frame-src 'self'");
        assert!(!csp.contains("youtube") && !csp.contains("vimeo"), "{csp}");
    }

    #[test]
    fn frames_only_the_two_embed_players() {
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        let csp = build_csp(&o);
        let frame = csp.split("; ").find(|d| d.starts_with("frame-src")).unwrap();
        assert_eq!(
            frame,
            "frame-src 'self' https://www.youtube-nocookie.com/embed/ https://player.vimeo.com/video/"
        );
        // Nothing else the PWA frames is allowed in the app.
        for other in ["spotify", "loom", "figma", "google", "twitter", "youtube.com"] {
            assert!(!frame.contains(other), "{other} must stay a card: {frame}");
        }
        assert_eq!(csp.matches("frame-src").count(), 1);
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(is_embed_player_url(&u("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")));
        assert!(is_embed_player_url(&u("https://player.vimeo.com/video/76979871?h=abc")));
        for no in [
            "https://www.youtube-nocookie.com/",
            "https://www.youtube-nocookie.com/watch?v=x",
            "https://www.youtube-nocookie.com/embedded/x",
            "https://www.youtube.com/embed/x",
            "https://youtube-nocookie.com/embed/x",
            "http://www.youtube-nocookie.com/embed/x",
            "https://www.youtube-nocookie.com:8443/embed/x",
            "https://user@www.youtube-nocookie.com/embed/x",
            "https://www.youtube-nocookie.com.evil.example/embed/x",
            "https://evil.example/https://player.vimeo.com/video/1",
            "https://player.vimeo.com/",
            "https://vimeo.com/video/1",
            "https://open.spotify.com/embed/track/x",
            "https://www.loom.com/embed/x",
        ] {
            assert!(!is_embed_player_url(&u(no)), "{no}");
        }
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
        // The players come and go with the server.
        assert!(out.contains("frame-src 'self' https://www.youtube-nocookie.com/embed/ https://player.vimeo.com/video/"));
        let none = retarget_csp(&out, None);
        assert!(!none.contains("example.com"), "{none}");
        assert!(none.contains("frame-src 'self'") && !none.contains("youtube") && !none.contains("vimeo"), "{none}");
        let back = retarget_csp(&none, Some(&b));
        assert!(back.contains("https://player.vimeo.com/video/"), "{back}");
        assert_eq!(back.matches("frame-src").count(), 1);
        assert!(none.contains("connect-src 'self' ipc: http://ipc.localhost"));
        // A header missing the directives gets them (never wider than ours).
        let bare = retarget_csp("default-src 'self'", Some(&b));
        assert!(bare.contains("connect-src 'self' ipc: http://ipc.localhost https://b.example.com"));
        assert!(bare.contains("img-src 'self' data: blob: https://b.example.com"));
        assert!(bare.contains("frame-src 'self' https://www.youtube-nocookie.com/embed/"));
        let widened = retarget_csp("frame-src *; frame-src https://evil", Some(&b));
        assert_eq!(widened.matches("frame-src").count(), 1);
        assert!(!widened.contains('*') && !widened.contains("evil"));
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
        let head_end = out.find("</head>").unwrap();
        assert!(meta < head_end, "the meta is inside <head>");
        assert!(
            !out.contains("maximum-scale"),
            "user scaling is never disabled"
        );
        assert_eq!(
            out.matches("name=\"viewport\"").count(),
            1,
            "the page's viewport is untouched"
        );
        let empty = String::from_utf8(inject_head_meta(html, None).unwrap()).unwrap();
        assert!(empty.contains("name=\"prism-server-origin\" content=\"\""));
        assert!(inject_head_meta(b"no head here", Some(&o)).is_none());
    }

    #[test]
    fn hosts_must_be_csp_safe() {
        let long = format!("https://{}.com", "a".repeat(64));
        for bad in [
            "https://*.evil.com",
            "https://x.com;frame-src",
            "https://x.com;frame-src%20*",
            "https://x'y.com",
            "https://x\"y.com",
            "https://a.com,b.com",
            "https://-bad.example.com",
            "https://bad-.example.com",
            "https://a..b.com",
            "https://user@prism.example.com",
            "https://user:pw@prism.example.com",
            long.as_str(),
        ] {
            assert!(ServerOrigin::parse(bad).is_err(), "should reject {bad:?}");
        }
        // IDN → punycode (LDH), IPv4, IPv6 and a trailing root dot are fine.
        assert_eq!(
            ServerOrigin::parse("https://bücher.example")
                .unwrap()
                .as_str(),
            "https://xn--bcher-kva.example"
        );
        assert_eq!(
            ServerOrigin::parse("https://203.0.113.7:8443")
                .unwrap()
                .as_str(),
            "https://203.0.113.7:8443"
        );
        assert_eq!(
            ServerOrigin::parse("https://[2001:db8::1]")
                .unwrap()
                .as_str(),
            "https://[2001:db8::1]"
        );
        assert_eq!(
            ServerOrigin::parse("https://prism.example.com.")
                .unwrap()
                .as_str(),
            "https://prism.example.com"
        );
        // Whatever passes yields a CSP with no injected separators or wildcards.
        for ok in [
            "https://bücher.example",
            "https://[2001:db8::1]",
            "https://a-b.c-d.example",
        ] {
            let csp = build_csp(&ServerOrigin::parse(ok).unwrap());
            assert_eq!(csp.matches(';').count(), 12, "{csp}");
            assert!(!csp.contains('*') && !csp.contains(','), "{csp}");
        }
    }

    #[test]
    fn build_default_is_valid() {
        let o = ServerOrigin::build_default();
        assert!(o.as_str().starts_with("https://") || o.as_str().starts_with("http://127.0.0.1"));
    }
}
