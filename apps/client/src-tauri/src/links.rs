//! Incoming links (NP-NA-04): a universal link (`https://<server>/page/<id>`,
//! claimed through the server's apple-app-site-association file) or a
//! `prism://page/<id>` deep link, delivered by the OS as `RunEvent::Opened`.
//!
//! 🔒 The shell NEVER navigates to what it is handed. A link is reduced to one
//! of four in-app routes by [`parse`] — everything else is dropped — and only
//! that route's canonical PATH (rebuilt here from validated parts, never the
//! original string) is handed to the page, which opens a tab for it through
//! the app's own data layer. Access is whatever the signed-in account has: a
//! page it cannot view shows the normal "unavailable" state.
//!
//! Rules (the same allowlist as the server's association file,
//! `apps/server/src/routes/app-links.ts`, and the page half,
//! `apps/web/src/native/appLinks.ts` — keep the three in step):
//!  - `https` (or `http` for a loopback test server): scheme + host + port must
//!    EQUAL the configured server origin; no userinfo; no query (a capability
//!    link `…/collab/<id>?t=…` is the browser's — the app would drop its
//!    access); the path is exactly `/<route>/<id>` (optional trailing slash);
//!  - `prism://<route>/<id>`: no userinfo, port or query;
//!  - routes: `page`, `collab` (both open the page), `inbox[/<notification>]`,
//!    `agent[/<session>]`. `prism://auth/callback` (the sign-in redirect of
//!    docs/native-auth.md) is NOT a route: it is never handled here;
//!  - ids are plain `[A-Za-z0-9_-]` (no percent-escapes, dots, slashes);
//!  - a raw value with a backslash, a control character, a space or DEL, or
//!    longer than 2048 bytes, is refused before it is parsed.
//!
//! Signed out: the link waits (≤ [`PENDING_TTL`]) and is delivered after the
//! sign-in reload; past that it is dropped. Delivery is a DOM handoff
//! (`__PRISM_SHELL__.openLink`), never a navigation and never a new IPC command.
//!
//! iOS (WP5) adds two rules; macOS behaves exactly as before:
//!  - **no server yet** (first run, or after "Sign out & change server"): there
//!    is no origin to validate against and nobody is signed in, so every link is
//!    refused, silently, and nothing is kept ([`accept`] with `None`). Changing
//!    or clearing the server also drops a link that was waiting ([`LinkState::clear`]):
//!    it was validated against the OLD server.
//!  - **app lock**: a link is handed to the page only while the app is UNLOCKED.
//!    The page keeps running behind the lock cover, so handing it over earlier
//!    would load the page's content behind the cover. Until the lock state is
//!    known at launch ([`LinkState::set_lock_ready`]) and the Swift side reports
//!    "unlocked" (`PrismIos::wait_unlocked`), the link stays here, and it still
//!    expires after [`PENDING_TTL`].

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use crate::origin::ServerOrigin;
use crate::state::AppState;
use crate::MAIN_WINDOW;

/// How long an undelivered link is kept (e.g. while the user signs in).
pub const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_LINK_BYTES: usize = 2048;
const MAX_PAGE_ID: usize = 128;
const MAX_NOTIFICATION_ID: usize = 64;

/// The custom scheme (registered in Info.plist). Also the scheme of the
/// sign-in redirect `prism://auth/callback`, which is deliberately not a route.
pub const SCHEME: &str = "prism";

/// A validated in-app destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppLink {
    /// `/page/<id>` and `/collab/<id>`: open that page in the workspace.
    Page(String),
    /// `/inbox[/<notification id>]`.
    Inbox(Option<String>),
    /// `/agent[/<session uuid>]`.
    Agent(Option<String>),
}

impl AppLink {
    /// The canonical client path handed to the page. Built from validated
    /// parts only, so it never carries anything the original URL smuggled in.
    pub fn path(&self) -> String {
        match self {
            AppLink::Page(id) => format!("/page/{id}"),
            AppLink::Inbox(None) => "/inbox".into(),
            AppLink::Inbox(Some(id)) => format!("/inbox/{id}"),
            AppLink::Agent(None) => "/agent".into(),
            AppLink::Agent(Some(id)) => format!("/agent/{id}"),
        }
    }
}

fn is_id(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 8-4-4-4-12 hex (the server mints session ids as uuids).
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// A backslash, any byte <= 0x20 (controls, tab, newline, space) or DEL.
fn has_unsafe_char(raw: &str) -> bool {
    raw.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b'\\')
}

fn route(name: &str, id: Option<&str>) -> Option<AppLink> {
    match (name, id) {
        ("page" | "collab", Some(id)) if is_id(id, MAX_PAGE_ID) => Some(AppLink::Page(id.into())),
        ("inbox", None) => Some(AppLink::Inbox(None)),
        ("inbox", Some(id)) if is_id(id, MAX_NOTIFICATION_ID) => {
            Some(AppLink::Inbox(Some(id.into())))
        }
        ("agent", None) => Some(AppLink::Agent(None)),
        ("agent", Some(id)) if is_uuid(id) => Some(AppLink::Agent(Some(id.to_ascii_lowercase()))),
        _ => None,
    }
}

/// The canonical client path for a tapped push notification (iOS, WP5): an
/// agent session → `/agent/<uuid>`, an inbox notification → `/inbox/<id>`. The
/// ids go through the SAME rules as a link's, so the page receives nothing a
/// link could not have carried. `None` = neither id is one of ours.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn notification_path(session_id: Option<&str>, notification_id: Option<&str>) -> Option<String> {
    session_id
        .and_then(|id| route("agent", Some(id)))
        .or_else(|| notification_id.and_then(|id| route("inbox", Some(id))))
        .map(|l| l.path())
}

/// `/<a>` , `/<a>/` , `/<a>/<b>` , `/<a>/<b>/` → (a, b). Anything else (empty
/// segments, a third segment, no leading slash) → None.
fn two_segments(path: &str) -> Option<(&str, Option<&str>)> {
    let rest = path.strip_prefix('/')?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let mut parts = rest.split('/');
    let a = parts.next().filter(|s| !s.is_empty())?;
    let b = parts.next();
    if parts.next().is_some() || b == Some("") {
        return None;
    }
    Some((a, b))
}

/// Validate a link the OS handed to the app. `None` = not ours / not allowed.
pub fn parse(raw: &str, origin: &ServerOrigin) -> Option<AppLink> {
    if raw.is_empty() || raw.len() > MAX_LINK_BYTES || has_unsafe_char(raw) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return None;
    }
    match url.scheme() {
        "https" | "http" => {
            // The whole origin must be the configured server's, compared in the
            // normalized form ServerOrigin itself uses (never a prefix test).
            let host = url.host_str()?;
            let mut theirs = format!("{}://{}", url.scheme(), host.to_ascii_lowercase());
            if let Some(port) = url.port() {
                theirs.push_str(&format!(":{port}"));
            }
            if ServerOrigin::parse(&theirs).ok()?.as_str() != origin.as_str() {
                return None;
            }
            let (name, id) = two_segments(url.path())?;
            route(name, id)
        }
        SCHEME => {
            // prism://<route>[/<id>] — the route is the URL's host.
            if url.port().is_some() {
                return None;
            }
            let name = url.host_str()?;
            let id = match url.path() {
                "" | "/" => None,
                p => {
                    let p = p.strip_prefix('/')?;
                    let p = p.strip_suffix('/').unwrap_or(p);
                    if p.is_empty() || p.contains('/') {
                        return None;
                    }
                    Some(p)
                }
            };
            route(name, id)
        }
        _ => None,
    }
}

/// Is this the sign-in redirect (or anything else under `prism://auth`)? It is
/// refused like every non-route, but silently: no "can't open" message for a
/// stray browser redirect, and its query (an auth code) is never logged.
/// Matched generously — any case, and the host-less `prism:auth/…` and
/// `prism:///auth/…` spellings — because the only effect is MORE silence.
pub fn is_auth_redirect(raw: &str) -> bool {
    let Ok(u) = Url::parse(raw) else {
        return false;
    };
    if u.scheme() != SCHEME {
        return false;
    }
    match u.host_str() {
        Some(h) if !h.is_empty() => h.eq_ignore_ascii_case("auth"),
        _ => u
            .path()
            .trim_start_matches('/')
            .split('/')
            .next()
            .is_some_and(|seg| seg.eq_ignore_ascii_case("auth")),
    }
}

/// What a batch of opened URLs amounts to. Carries no part of a refused URL:
/// there is nothing here to log, store or forward by accident.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// The first URL that validated, as its canonical path.
    Link(String),
    /// Nothing valid, and a sign-in redirect was among them: stay silent.
    AuthRedirect,
    /// Nothing valid; an `https` link the OS routed here (a universal link)
    /// was among them: the person tapped a link, so say it can't be opened.
    RefusedWebLink,
    /// Nothing valid, nothing to say (an unknown `prism://…`, a file, …):
    /// any web page can fire a custom scheme, so it gets no visible effect.
    Nothing,
}

/// Decide what to do with the URLs of one `RunEvent::Opened`, BEFORE anything
/// visible happens. A valid link wins over everything else in the batch; an
/// auth redirect is skipped (never the result, never stored).
pub fn classify<S: AsRef<str>>(urls: &[S], origin: &ServerOrigin) -> Opened {
    if let Some(path) = urls
        .iter()
        .find_map(|u| parse(u.as_ref(), origin).map(|l| l.path()))
    {
        return Opened::Link(path);
    }
    if urls.iter().any(|u| is_auth_redirect(u.as_ref())) {
        return Opened::AuthRedirect;
    }
    let web = urls.iter().any(|u| {
        let u = u.as_ref();
        u.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("https://"))
            || u.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("http://"))
    });
    if web {
        Opened::RefusedWebLink
    } else {
        Opened::Nothing
    }
}

/// Classify and, for a valid link only, remember it. Returns the decision.
/// `origin` is `None` while no server is configured (iOS first run): nothing can
/// be validated, so nothing is accepted, kept or announced.
pub fn accept<S: AsRef<str>>(
    urls: &[S],
    origin: Option<&ServerOrigin>,
    links: &LinkState,
    now: Instant,
) -> Opened {
    let Some(origin) = origin else {
        return Opened::Nothing;
    };
    let decision = classify(urls, origin);
    if let Opened::Link(path) = &decision {
        links.set(path.clone(), now);
    }
    decision
}

/// JS that hands a validated path to the page (host.js `openLink`). A DOM
/// handoff, never a navigation; the path is a JSON string literal.
pub fn deliver_js(path: &str) -> String {
    let lit = serde_json::to_string(path).expect("a string serializes");
    format!("window.__PRISM_SHELL__ && window.__PRISM_SHELL__.openLink({lit});")
}

const REFUSED_JS: &str =
    "window.__PRISM_SHELL__ && window.__PRISM_SHELL__.toast(\"This link can\u{2019}t be opened in Prism.\");";

struct Inner {
    pending: Option<(String, Instant)>,
    /// The main window's document has finished loading (host.js is there).
    page_ready: bool,
    /// The app-lock state has been established for this launch. Always true
    /// where there is no app lock (desktop); on iOS it turns true once the saved
    /// lock was applied at startup (lib.rs), so a link that cold-starts the app
    /// can never slip in before the lock cover is up.
    lock_ready: bool,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            pending: None,
            page_ready: false,
            lock_ready: !cfg!(target_os = "ios"),
        }
    }
}

/// The one link waiting to be handed to the page.
#[derive(Default)]
pub struct LinkState(Mutex<Inner>);

impl LinkState {
    /// Remember a validated path; a newer link replaces an older one.
    pub fn set(&self, path: String, now: Instant) {
        self.0.lock().unwrap().pending = Some((path, now));
    }
    pub fn set_page_ready(&self, ready: bool) {
        self.0.lock().unwrap().page_ready = ready;
    }
    /// iOS: the saved app lock has been applied (or there is none to apply).
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub fn set_lock_ready(&self) {
        self.0.lock().unwrap().lock_ready = true;
    }
    /// Drop the waiting link (the server it was validated against is gone).
    #[cfg_attr(not(mobile), allow(dead_code))]
    pub fn clear(&self) {
        self.0.lock().unwrap().pending = None;
    }
    /// Is there a link that could be handed over once the account and the lock
    /// allow it? (Unexpired, page loaded, lock state known.) Lets `deliver` skip
    /// the keychain and the lock query when there is nothing to do; drops an
    /// expired link.
    pub fn awaiting_delivery(&self, now: Instant) -> bool {
        let mut inner = self.0.lock().unwrap();
        let Some((_, at)) = inner.pending.as_ref() else {
            return false;
        };
        if now.duration_since(*at) > PENDING_TTL {
            inner.pending = None;
            return false;
        }
        inner.page_ready && inner.lock_ready
    }
    /// The pending path if it may be delivered NOW: the page is ready, someone
    /// is signed in, the app is unlocked (always true without an app lock) and
    /// the link has not expired. Taking it clears it. An expired link is dropped
    /// whatever the other conditions.
    pub fn take_deliverable(&self, signed_in: bool, unlocked: bool, now: Instant) -> Option<String> {
        let mut inner = self.0.lock().unwrap();
        let (_, at) = inner.pending.as_ref()?;
        if now.duration_since(*at) > PENDING_TTL {
            inner.pending = None;
            return None;
        }
        if !inner.page_ready || !inner.lock_ready || !signed_in || !unlocked {
            return None;
        }
        inner.pending.take().map(|(p, _)| p)
    }
    #[cfg(test)]
    fn with_lock_ready(ready: bool) -> Self {
        let s = Self::default();
        s.0.lock().unwrap().lock_ready = ready;
        s
    }
    #[cfg(test)]
    fn has_pending(&self) -> bool {
        self.0.lock().unwrap().pending.is_some()
    }
}

/// `RunEvent::Opened`: validate FIRST. Only a valid link brings the window to
/// the front; a refused universal link gets a toast in the window as it is;
/// everything else (an unknown `prism://…`, a sign-in redirect) has no visible
/// effect at all. Never logs a URL (a sign-in redirect carries a code).
pub fn on_opened<R: Runtime>(app: &AppHandle<R>, urls: &[Url]) {
    let raw: Vec<&str> = urls.iter().map(|u| u.as_str()).collect();
    let origin = app.state::<AppState>().origin();
    let decision = accept(
        &raw,
        origin.as_ref(),
        &app.state::<LinkState>(),
        Instant::now(),
    );
    match decision {
        Opened::Link(_) => {
            #[cfg(desktop)]
            crate::tray::show_main(app);
            deliver(app);
        }
        Opened::RefusedWebLink => {
            log::info!("ignored an incoming link (not an allowed route)");
            if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                let _ = w.eval(REFUSED_JS);
            }
        }
        Opened::AuthRedirect | Opened::Nothing => {
            log::info!("ignored an incoming link (not an allowed route)");
        }
    }
}

/// The main window's page finished (re)loading: host.js is in place.
pub fn on_page_loaded<R: Runtime>(app: &AppHandle<R>, finished: bool) {
    app.state::<LinkState>().set_page_ready(finished);
    if finished {
        deliver(app);
    }
}

/// Hand the pending link to the page if the conditions hold; otherwise it
/// stays for the next page load (i.e. after sign-in) until it expires.
///
/// iOS: this waits for the app to be unlocked first (see the module docs). The
/// wait can be long (the phone in a pocket), so the expiry is judged AFTER it.
pub(crate) fn deliver<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !app.state::<LinkState>().awaiting_delivery(Instant::now()) {
            return;
        }
        let unlocked = app_unlocked(&app).await;
        let signed_in = matches!(app.state::<AppState>().token().await, Ok(Some(_)));
        let Some(path) = app
            .state::<LinkState>()
            .take_deliverable(signed_in, unlocked, Instant::now())
        else {
            return;
        };
        if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
            let _ = w.eval(deliver_js(&path));
        }
    });
}

/// Resolves once the app is unlocked. No app lock outside iOS.
#[cfg(not(target_os = "ios"))]
async fn app_unlocked<R: Runtime>(_app: &AppHandle<R>) -> bool {
    true
}

/// Resolves `true` once the Swift app lock reports "unlocked" (at once when no
/// lock is on). Any failure to ask is `false`: the link stays where it is.
#[cfg(target_os = "ios")]
async fn app_unlocked<R: Runtime>(app: &AppHandle<R>) -> bool {
    match crate::ios::plugin(app) {
        Ok(ios) => ios.wait_unlocked().await,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> ServerOrigin {
        ServerOrigin::parse("https://prism.example.com").unwrap()
    }
    fn p(raw: &str) -> Option<String> {
        parse(raw, &origin()).map(|l| l.path())
    }
    const UUID: &str = "0b0e0c9e-2f0e-4c59-9a55-0a5b3d5f1a11";

    #[test]
    fn universal_links_to_content_routes_are_accepted() {
        assert_eq!(p("https://prism.example.com/page/abc_123-X").as_deref(), Some("/page/abc_123-X"));
        assert_eq!(p("https://prism.example.com/page/abc/").as_deref(), Some("/page/abc"));
        // A share-route address (no token) opens the same page in the workspace.
        assert_eq!(p("https://prism.example.com/collab/abc").as_deref(), Some("/page/abc"));
        assert_eq!(p("https://prism.example.com/inbox").as_deref(), Some("/inbox"));
        assert_eq!(p("https://prism.example.com/inbox/").as_deref(), Some("/inbox"));
        assert_eq!(p("https://prism.example.com/inbox/n_1-a").as_deref(), Some("/inbox/n_1-a"));
        assert_eq!(p("https://prism.example.com/agent").as_deref(), Some("/agent"));
        assert_eq!(
            p(&format!("https://prism.example.com/agent/{UUID}")),
            Some(format!("/agent/{UUID}"))
        );
        // Host case and the default port normalize like the configured origin.
        assert_eq!(p("https://PRISM.example.com/page/abc").as_deref(), Some("/page/abc"));
        assert_eq!(p("https://prism.example.com:443/page/abc").as_deref(), Some("/page/abc"));
        // A fragment is not part of the route and is dropped.
        assert_eq!(p("https://prism.example.com/page/abc#heading").as_deref(), Some("/page/abc"));
    }

    #[test]
    fn deep_links_use_the_same_routes() {
        assert_eq!(p("prism://page/abc").as_deref(), Some("/page/abc"));
        assert_eq!(p("prism://page/abc/").as_deref(), Some("/page/abc"));
        assert_eq!(p("prism://collab/abc").as_deref(), Some("/page/abc"));
        assert_eq!(p("prism://inbox").as_deref(), Some("/inbox"));
        assert_eq!(p("prism://inbox/n1").as_deref(), Some("/inbox/n1"));
        assert_eq!(p("prism://agent").as_deref(), Some("/agent"));
        assert_eq!(p(&format!("prism://agent/{UUID}")), Some(format!("/agent/{UUID}")));
    }

    #[test]
    fn another_origin_is_never_ours() {
        for bad in [
            "https://evil.example/page/abc",
            "https://prism.example.com.evil.example/page/abc",
            "https://evil.example/prism.example.com/page/abc",
            "https://sub.prism.example.com/page/abc",
            "https://prism.example.com:8443/page/abc",
            "http://prism.example.com/page/abc", // scheme is part of the origin
            "https://prism.example.com@evil.example/page/abc",
            "https://user@prism.example.com/page/abc",
            "https://user:pw@prism.example.com/page/abc",
            "https://prism.example.com\\@evil.example/page/abc",
            "https://evil.example\\prism.example.com/page/abc",
            "https://prism.example.com%2Fpage%2Fabc@evil.example/page/abc",
            "//prism.example.com/page/abc",
            "/page/abc",
            "page/abc",
        ] {
            assert_eq!(p(bad), None, "{bad}");
        }
    }

    #[test]
    fn sign_in_invite_api_and_published_paths_are_refused() {
        for bad in [
            "https://prism.example.com/",
            "https://prism.example.com",
            "https://prism.example.com/auth/device/authorize",
            "https://prism.example.com/auth/device/continue",
            "https://prism.example.com/auth/callback",
            "https://prism.example.com/auth/logout",
            "https://prism.example.com/accept-invite",
            "https://prism.example.com/api/notes",
            "https://prism.example.com/acl/workers",
            "https://prism.example.com/mcp",
            "https://prism.example.com/health",
            "https://prism.example.com/.well-known/apple-app-site-association",
            "https://prism.example.com/p/site",
            "https://prism.example.com/p/site/notes/abc",
            "https://prism.example.com/home",
            "https://prism.example.com/map",
            "https://prism.example.com/governance",
            "https://prism.example.com/pages/abc",
            "https://prism.example.com/page",
            "https://prism.example.com/page/",
            "https://prism.example.com/collab",
            // The sign-in redirect and anything else on the custom scheme.
            "prism://auth/callback",
            "prism://auth/callback?code=abc&state=def",
            "prism://auth",
            "prism://settings",
            "prism://page",
            "prism://",
            "prism:page/abc",
            "prism:///page/abc",
        ] {
            assert_eq!(p(bad), None, "{bad}");
        }
        assert!(is_auth_redirect("prism://auth/callback?code=abc"));
        assert!(!is_auth_redirect("prism://page/abc"));
        assert!(!is_auth_redirect("https://prism.example.com/auth/callback"));
    }

    #[test]
    fn a_query_is_refused_so_capability_links_stay_in_the_browser() {
        for bad in [
            "https://prism.example.com/collab/abc?t=cap.token",
            "https://prism.example.com/page/abc?t=x",
            "https://prism.example.com/page/abc?",
            "https://prism.example.com/page/abc?next=/auth/logout",
            "prism://page/abc?x=1",
            "https://prism.example.com/inbox?id=1",
        ] {
            assert_eq!(p(bad), None, "{bad}");
        }
    }

    #[test]
    fn path_tricks_are_refused() {
        for bad in [
            "https://prism.example.com/page/a/b",
            "https://prism.example.com/page//abc",
            "https://prism.example.com//page/abc",
            "https://prism.example.com/page/../auth/logout",
            "https://prism.example.com/x/../page/abc/../../auth/logout",
            "https://prism.example.com/page/%2e%2e",
            "https://prism.example.com/page/abc%2Fdef",
            "https://prism.example.com/page/abc%00",
            "https://prism.example.com/page/a.b",
            "https://prism.example.com/page/a:b",
            "https://prism.example.com/page/a b",
            "https://prism.example.com/page/a\tb",
            "https://prism.example.com/page/abc\n",
            " https://prism.example.com/page/abc",
            "https://prism.example.com/page/abc\\def",
            "https://prism.example.com/page\\abc",
            "https://prism.example.com/page/caf\u{e9}",
            "https://prism.example.com/PAGE/abc",
            "https://prism.example.com/inbox/a/b",
            "https://prism.example.com/agent/not-a-uuid",
            "https://prism.example.com/agent/0b0e0c9e2f0e4c599a550a5b3d5f1a11",
            "prism://page/a/b",
            "prism://page:80/abc",
            "prism://user@page/abc",
            "prism://PAGE/abc/..",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "tauri://localhost/page/abc",
            "data:text/html,hi",
            "mailto:someone@example.com",
            "",
        ] {
            assert_eq!(p(bad), None, "{bad:?}");
        }
        // Dot segments that the URL parser resolves ONTO an allowed route are
        // judged on the result (the path handed on is rebuilt, never the input).
        assert_eq!(p("https://prism.example.com/auth/../page/abc").as_deref(), Some("/page/abc"));
        // Length limits.
        let long_id = "a".repeat(MAX_PAGE_ID + 1);
        assert_eq!(p(&format!("https://prism.example.com/page/{long_id}")), None);
        assert_eq!(p(&format!("https://prism.example.com/page/{}", "a".repeat(MAX_PAGE_ID))).map(|s| s.len()), Some(6 + MAX_PAGE_ID));
        assert_eq!(p(&format!("https://prism.example.com/inbox/{}", "a".repeat(MAX_NOTIFICATION_ID + 1))), None);
        assert_eq!(p(&format!("https://prism.example.com/page/abc#{}", "x".repeat(3000))), None);
    }

    #[test]
    fn a_loopback_test_server_is_matched_exactly() {
        let o = ServerOrigin::parse("http://127.0.0.1:8787").unwrap();
        assert_eq!(parse("http://127.0.0.1:8787/page/abc", &o).map(|l| l.path()).as_deref(), Some("/page/abc"));
        assert_eq!(parse("http://127.0.0.1:8788/page/abc", &o), None);
        assert_eq!(parse("http://localhost:8787/page/abc", &o), None);
        assert_eq!(parse("https://127.0.0.1:8787/page/abc", &o), None);
    }

    #[test]
    fn the_handoff_is_a_dom_call_with_an_escaped_path_never_a_navigation() {
        let js = deliver_js("/page/abc");
        assert_eq!(js, r#"window.__PRISM_SHELL__ && window.__PRISM_SHELL__.openLink("/page/abc");"#);
        assert!(deliver_js("a\"b").contains(r#"openLink("a\"b")"#));
        for js in [deliver_js("/page/abc"), REFUSED_JS.to_string()] {
            assert!(!js.contains("location") && !js.contains("href") && !js.contains("open("), "{js}");
        }
        // Every path the validator can produce is one of four shapes.
        for raw in ["prism://page/a", "prism://collab/a", "prism://inbox", "prism://inbox/a", "prism://agent"] {
            let path = p(raw).unwrap();
            assert!(path.starts_with("/page/") || path.starts_with("/inbox") || path.starts_with("/agent"), "{path}");
            assert!(!path.contains("//") && !path.contains('?') && !path.contains('#'));
        }
    }

    #[test]
    fn the_auth_redirect_is_recognised_in_every_spelling() {
        for yes in [
            "prism://auth/callback?code=abc&state=def",
            "prism://AUTH/callback?code=abc",
            "prism://Auth",
            "prism:auth/callback?code=abc",
            "prism:AUTH/callback",
            "prism:/auth/callback?code=abc",
            "prism:///auth/callback?code=abc",
        ] {
            assert!(is_auth_redirect(yes), "{yes}");
            assert_eq!(p(yes), None, "{yes} is never a route");
        }
        for no in [
            "prism://page/abc",
            "prism://authx/callback",
            "prism:page/auth",
            "https://prism.example.com/auth/callback",
            "other://auth/callback",
            "not a url",
        ] {
            assert!(!is_auth_redirect(no), "{no}");
        }
    }

    #[test]
    fn a_batch_keeps_a_valid_link_and_never_the_auth_redirect_beside_it() {
        let o = origin();
        let t0 = Instant::now();
        const CODE: &str = "s3cr3t-auth-code";
        let auth = format!("prism://auth/callback?code={CODE}&state=xyz");

        // The redirect comes first: it is skipped, the valid sibling is kept.
        let s = LinkState::default();
        let d = accept(&[auth.as_str(), "prism://page/abc"], Some(&o), &s, t0);
        assert_eq!(d, Opened::Link("/page/abc".into()));
        s.set_page_ready(true);
        let stored = s.take_deliverable(true, true, t0).unwrap();
        assert_eq!(stored, "/page/abc");
        assert!(!format!("{d:?}{stored}").contains(CODE), "the code is nowhere in what is kept");

        // The redirect alone (in every spelling): silent, nothing stored, nothing to log.
        for raw in [auth.clone(), format!("prism:auth/callback?code={CODE}"), format!("prism://AUTH/callback?code={CODE}")] {
            let s = LinkState::default();
            let d = accept(&[raw.as_str()], Some(&o), &s, t0);
            assert_eq!(d, Opened::AuthRedirect);
            assert!(!s.has_pending());
            assert!(!format!("{d:?}").contains(CODE));
        }
        // A redirect beside a refused web link is still silent (no toast for a sign-in).
        let s = LinkState::default();
        assert_eq!(accept(&[auth.as_str(), "https://evil.example/page/x"], Some(&o), &s, t0), Opened::AuthRedirect);
        assert!(!s.has_pending());

        // An unknown custom-scheme URL — what any web page can fire — does nothing visible.
        for raw in ["prism://x", "prism://settings/open", "prism://page/a/b", "file:///etc/passwd", "mailto:a@b.c"] {
            let s = LinkState::default();
            assert_eq!(accept(&[raw], Some(&o), &s, t0), Opened::Nothing, "{raw}");
            assert!(!s.has_pending());
        }
        // A universal link the OS routed here but the app refuses: a toast, nothing stored.
        let s = LinkState::default();
        assert_eq!(accept(&["https://prism.example.com/page/abc?utm=1"], Some(&o), &s, t0), Opened::RefusedWebLink);
        assert_eq!(accept(&["HTTPS://other.example/page/abc"], Some(&o), &s, t0), Opened::RefusedWebLink);
        assert!(!s.has_pending());
        let empty: [&str; 0] = [];
        assert_eq!(accept(&empty, Some(&o), &s, t0), Opened::Nothing);

        // The handler validates before anything visible, and logs constants only.
        let src = include_str!("links.rs");
        let handler = &src[src.find("pub fn on_opened").unwrap()..src.find("pub fn on_page_loaded").unwrap()];
        assert!(handler.find("accept(").unwrap() < handler.find("show_main").unwrap(), "validate first");
        assert_eq!(handler.matches("show_main").count(), 1, "only a valid link foregrounds the app");
        let prod = src.split("#[cfg(test)]\nmod tests").next().unwrap();
        for line in prod.lines().filter(|l| l.contains("log::")) {
            assert!(!line.contains('{'), "a log line formats nothing: {line}");
        }
    }

    #[test]
    fn a_link_waits_for_a_loaded_page_and_a_signed_in_user_and_is_delivered_once() {
        let s = LinkState::default();
        let t0 = Instant::now();
        assert_eq!(s.take_deliverable(true, true, t0), None, "nothing pending");
        s.set("/page/abc".into(), t0);
        // Cold start: the page has not loaded yet.
        assert_eq!(s.take_deliverable(true, true, t0), None);
        assert!(s.has_pending());
        s.set_page_ready(true);
        // Signed out: it waits (the sign-in reload delivers it).
        assert_eq!(s.take_deliverable(false, true, t0), None);
        assert!(s.has_pending());
        // A reload in between (page not ready) changes nothing.
        s.set_page_ready(false);
        assert_eq!(s.take_deliverable(true, true, t0), None);
        s.set_page_ready(true);
        assert_eq!(s.take_deliverable(true, true, t0 + Duration::from_secs(60)).as_deref(), Some("/page/abc"));
        // Once.
        assert_eq!(s.take_deliverable(true, true, t0 + Duration::from_secs(61)), None);
        assert!(!s.has_pending());
    }

    #[test]
    fn an_undelivered_link_expires_and_a_newer_one_replaces_an_older() {
        let s = LinkState::default();
        let t0 = Instant::now();
        s.set_page_ready(true);
        s.set("/page/old".into(), t0);
        assert_eq!(s.take_deliverable(false, true, t0 + PENDING_TTL + Duration::from_secs(1)), None);
        assert!(!s.has_pending(), "dropped, not kept for a later sign-in");
        assert_eq!(s.take_deliverable(true, true, t0 + PENDING_TTL + Duration::from_secs(2)), None);

        s.set("/page/one".into(), t0);
        s.set("/page/two".into(), t0 + Duration::from_secs(1));
        assert_eq!(s.take_deliverable(true, true, t0 + Duration::from_secs(2)).as_deref(), Some("/page/two"));
        // Exactly at the limit it is still delivered.
        s.set("/page/edge".into(), t0);
        assert_eq!(s.take_deliverable(true, true, t0 + PENDING_TTL).as_deref(), Some("/page/edge"));
    }

    #[test]
    fn no_server_configured_refuses_every_link_and_keeps_nothing() {
        // iOS first run / after "Sign out & change server": no origin to validate against.
        let t0 = Instant::now();
        for raw in [
            "https://prism.example.com/page/abc",
            "prism://page/abc",
            "prism://inbox",
            "prism://auth/callback?code=c&state=s",
            "https://evil.example/page/x",
        ] {
            let s = LinkState::default();
            assert_eq!(accept(&[raw], None, &s, t0), Opened::Nothing, "{raw}");
            assert!(!s.has_pending(), "{raw}");
        }
        // The same links are accepted once a server is configured (macOS: always).
        let s = LinkState::default();
        let o = origin();
        assert_eq!(accept(&["prism://page/abc"], Some(&o), &s, t0), Opened::Link("/page/abc".into()));
    }

    #[test]
    fn a_link_waits_for_the_app_lock() {
        let t0 = Instant::now();
        // The lock state is not known yet (iOS, before the saved lock was applied at launch).
        let s = LinkState::with_lock_ready(false);
        s.set("/page/abc".into(), t0);
        s.set_page_ready(true);
        assert!(!s.awaiting_delivery(t0), "nothing is asked of the lock before it is configured");
        assert_eq!(s.take_deliverable(true, true, t0), None, "even an 'unlocked' answer is not believed yet");
        assert!(s.has_pending());
        s.set_lock_ready();
        assert!(s.awaiting_delivery(t0));
        // Locked: it stays. Signed in and page ready make no difference.
        assert_eq!(s.take_deliverable(true, false, t0 + Duration::from_secs(30)), None);
        assert!(s.has_pending(), "kept for the unlock");
        // Unlocked: handed over once.
        assert_eq!(s.take_deliverable(true, true, t0 + Duration::from_secs(60)).as_deref(), Some("/page/abc"));
        assert_eq!(s.take_deliverable(true, true, t0 + Duration::from_secs(61)), None);
    }

    #[test]
    fn a_link_that_outlives_the_ttl_behind_the_lock_is_dropped() {
        let t0 = Instant::now();
        let s = LinkState::default();
        s.set("/page/abc".into(), t0);
        s.set_page_ready(true);
        assert_eq!(s.take_deliverable(true, false, t0 + Duration::from_secs(5)), None);
        // Unlocked an hour later: the link is gone, not opened.
        assert_eq!(s.take_deliverable(true, true, t0 + PENDING_TTL + Duration::from_secs(1)), None);
        assert!(!s.has_pending());
        // awaiting_delivery drops an expired link too.
        s.set("/page/two".into(), t0);
        assert!(!s.awaiting_delivery(t0 + PENDING_TTL + Duration::from_secs(1)));
        assert!(!s.has_pending());
    }

    #[test]
    fn changing_the_server_drops_the_waiting_link() {
        let t0 = Instant::now();
        let s = LinkState::default();
        s.set("/page/abc".into(), t0);
        s.set_page_ready(true);
        s.clear();
        assert!(!s.has_pending());
        assert_eq!(s.take_deliverable(true, true, t0), None);
    }

    #[test]
    fn the_lock_is_asked_before_the_link_is_taken() {
        // deliver(): the wait for the unlock comes BEFORE take_deliverable, and its answer is passed in.
        let src = include_str!("links.rs");
        let prod = src.split("#[cfg(test)]\nmod tests").next().unwrap();
        let body = &prod[prod.find("pub(crate) fn deliver").unwrap()..];
        let ask = body.find("app_unlocked(&app).await").unwrap();
        let take = body.find(".take_deliverable(signed_in, unlocked,").unwrap();
        assert!(ask < take);
        // On iOS a failure to reach the lock is "locked", never "unlocked".
        assert!(body.contains("Err(_) => false"));
    }

    #[test]
    fn tapped_notifications_become_canonical_paths() {
        assert_eq!(notification_path(Some(UUID), None).as_deref(), Some(format!("/agent/{UUID}").as_str()));
        assert_eq!(notification_path(None, Some("n_1-a")).as_deref(), Some("/inbox/n_1-a"));
        // The session wins when both are present; a bad session id falls back to the notification.
        assert_eq!(notification_path(Some(UUID), Some("n1")).as_deref(), Some(format!("/agent/{UUID}").as_str()));
        assert_eq!(notification_path(Some("not-a-uuid"), Some("n1")).as_deref(), Some("/inbox/n1"));
        for bad in ["", "../../etc", "a/b", "a b", "a?b", "%2e%2e", &"a".repeat(65)] {
            assert_eq!(notification_path(None, Some(bad)), None, "{bad:?}");
            assert_eq!(notification_path(Some(bad), None), None, "{bad:?}");
        }
        assert_eq!(notification_path(None, None), None);
    }
}
