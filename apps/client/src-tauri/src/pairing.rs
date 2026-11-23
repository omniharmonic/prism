//! QR pairing, the phone's half (launch decision D-G; docs/native-auth.md § Pairing).
//!
//! The owner's Mac shows a QR code holding `prism://pair?v=1&s=<server origin>&c=<code>`.
//! The phone's Camera opens it in Prism (the app registers the `prism` scheme); the OS hands
//! it over as `RunEvent::Opened`, and links.rs passes it here BEFORE its own route rules (a
//! pairing link is not an in-app route and never reaches the page as one).
//!
//! What this does, in order — the whole exchange stays in Rust, like PKCE sign-in:
//!  1. validate the link strictly ([`parse_pair_link`]): the exact shape, an `https` origin
//!     that `ServerOrigin::parse` accepts, a code of exactly the minted shape;
//!  2. wait until the app is unlocked (the app-lock rule of links.rs);
//!  3. refuse when the app already belongs to ANOTHER server, or is already signed in to this
//!     one ([`decide`]) — a link never switches servers or replaces a sign-in;
//!  4. a NATIVE confirmation naming the server (any web page can fire `prism://`, so a drive-by
//!     link must not quietly point a fresh app at a stranger's server);
//!  5. `GET /health?live=1` (the setup screen's probe), then `POST /auth/pair/claim` with a
//!     fresh PKCE S256 challenge; the page shows the 4-digit check code for the owner to type
//!     on the Mac (a DOM call into host.js — display only, nothing the page can act on);
//!  6. poll `POST /auth/pair/token` with the verifier until approved, declined or expired;
//!  7. on a token: save the server (only if none was set) and the token exactly as a PKCE
//!     sign-in does, then boot the page again.
//!
//! Nothing is stored before step 7: the verifier, the claim id and the code live in this
//! task's memory only and die with it. A newer pairing link replaces an older one in flight.
//! Logs carry constants only (no URL, code, claim id or token).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use crate::origin::ServerOrigin;
use crate::pkce::PkceSession;
use crate::state::AppState;
use crate::MAIN_WINDOW;

const MAX_LINK_BYTES: usize = 2048;
/// How long the phone keeps polling for the owner's decision (the server's code lives 5 min).
const POLL_DEADLINE: Duration = Duration::from_secs(6 * 60);

/// A validated pairing link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairLink {
    pub origin: ServerOrigin,
    pub code: String,
}

fn is_code(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `prism://pair?v=1&s=<https origin>&c=<22-char code>` and nothing else. `None` = not a
/// (valid) pairing link: an invalid one is dropped silently, like any unknown `prism://`.
pub fn parse_pair_link(raw: &str) -> Option<PairLink> {
    if raw.is_empty() || raw.len() > MAX_LINK_BYTES || raw.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b'\\') {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != crate::links::SCHEME || url.host_str() != Some("pair") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() || url.fragment().is_some() {
        return None;
    }
    if !(url.path().is_empty() || url.path() == "/") {
        return None;
    }
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    if pairs.len() != 3 {
        return None;
    }
    let one = |key: &str| -> Option<&str> {
        let mut it = pairs.iter().filter(|(k, _)| k == key);
        let v = it.next()?;
        it.next().is_none().then_some(v.1.as_str())
    };
    if one("v")? != "1" {
        return None;
    }
    let code = one("c")?;
    if !is_code(code) {
        return None;
    }
    let s = one("s")?;
    // A QR from the server always names an https address: never a loopback test server.
    if !s.starts_with("https://") {
        return None;
    }
    let origin = ServerOrigin::parse(s).ok()?;
    Some(PairLink { origin, code: code.to_string() })
}

/// What to do with a valid link, given the app's current server and sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairStart {
    /// Pair (this server, or a fresh app with none yet).
    Go,
    /// The app belongs to another server: never switch servers from a link.
    OtherServer,
    /// Already signed in to this server: a second device token would replace the first.
    AlreadySignedIn,
}

pub fn decide(link: &ServerOrigin, configured: Option<&ServerOrigin>, signed_in: bool) -> PairStart {
    match configured {
        Some(o) if o != link => PairStart::OtherServer,
        Some(_) if signed_in => PairStart::AlreadySignedIn,
        _ => PairStart::Go,
    }
}

// ---------------------------------------------------------------- server calls (pure parsing + thin HTTP)

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub claim_id: String,
    pub check_code: String,
    pub interval: Duration,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimOk {
    claim_id: String,
    check_code: String,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

/// Interpret `POST /auth/pair/claim`. Messages are fixed sentences: nothing from the
/// server's body reaches the screen except a known error word.
pub fn parse_claim_response(status: u16, body: &str) -> Result<Claim, String> {
    if (200..300).contains(&status) {
        let ok: ClaimOk = serde_json::from_str(body).map_err(|_| "The server gave an unexpected answer.".to_string())?;
        let id_ok = ok.claim_id.len() == 43 && ok.claim_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        let code_ok = ok.check_code.len() == 4 && ok.check_code.bytes().all(|b| b.is_ascii_digit());
        if !id_ok || !code_ok {
            return Err("The server gave an unexpected answer.".into());
        }
        let secs = ok.interval.unwrap_or(2).clamp(1, 10);
        return Ok(Claim { claim_id: ok.claim_id, check_code: ok.check_code, interval: Duration::from_secs(secs) });
    }
    let code = serde_json::from_str::<ErrorBody>(body).map(|e| e.error).unwrap_or_default();
    Err(match code.as_str() {
        "already_used" => "This pairing code was already used. Make a new one on your computer.",
        "expired" => "This pairing code expired. Make a new one on your computer.",
        "invalid_code" => "This pairing code isn't valid on that server.",
        "rate_limited" => "Too many attempts. Wait a few minutes and try again.",
        _ => "The server refused the pairing code.",
    }
    .to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Poll {
    Pending,
    SlowDown,
    Token(String),
    Denied,
    Expired,
    Failed(String),
}

/// Interpret `POST /auth/pair/token` (OAuth-style errors, or the same token answer as
/// `/auth/device/token`, checked by the same parser).
pub fn parse_poll_response(status: u16, body: &str) -> Poll {
    if (200..300).contains(&status) {
        return match crate::auth::parse_token_response(status, body) {
            Ok(t) => Poll::Token(t),
            Err(_) => Poll::Failed("The server gave an unexpected answer.".into()),
        };
    }
    match serde_json::from_str::<ErrorBody>(body).map(|e| e.error).unwrap_or_default().as_str() {
        "authorization_pending" => Poll::Pending,
        "slow_down" | "rate_limited" => Poll::SlowDown,
        "access_denied" => Poll::Denied,
        "expired_token" => Poll::Expired,
        _ => Poll::Failed("Pairing failed. Make a new code on your computer.".into()),
    }
}

pub async fn claim(origin: &ServerOrigin, code: &str, challenge: &str, label: &str, platform: &str) -> Result<Claim, String> {
    let body = serde_json::json!({ "code": code, "code_challenge": challenge, "label": label, "platform": platform });
    let resp = crate::auth::client()?
        .post(origin.join("/auth/pair/claim"))
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|_| format!("Couldn't reach {}. Check your connection.", origin.as_str()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|_| "The server's answer could not be read.".to_string())?;
    parse_claim_response(status, &text)
}

pub async fn poll(origin: &ServerOrigin, claim_id: &str, verifier: &str) -> Poll {
    let body = serde_json::json!({ "claim_id": claim_id, "code_verifier": verifier });
    let Ok(client) = crate::auth::client() else {
        return Poll::Failed("Pairing failed.".into());
    };
    match client.post(origin.join("/auth/pair/token")).header("Accept", "application/json").json(&body).send().await {
        // A dropped connection is retried on the next tick (the deadline still applies).
        Err(_) => Poll::SlowDown,
        Ok(resp) => {
            let status = resp.status().as_u16();
            match resp.text().await {
                Ok(text) => parse_poll_response(status, &text),
                Err(_) => Poll::SlowDown,
            }
        }
    }
}

// ---------------------------------------------------------------- what the page shows

/// One state for the page's pairing sheet (host.js `pairing`). Display only.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairView {
    /// "working" | "waiting" | "failed" | "done"
    pub state: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_code: Option<String>,
}

pub fn view_js(v: Option<&PairView>) -> String {
    let lit = match v {
        Some(v) => serde_json::to_string(v).expect("a view serializes"),
        None => "null".into(),
    };
    format!("window.__PRISM_SHELL__ && window.__PRISM_SHELL__.pairing && window.__PRISM_SHELL__.pairing({lit});")
}

/// The pairing in flight (at most one) and what the page should show for it.
#[derive(Default)]
pub struct PairingState {
    generation: AtomicU64,
    view: Mutex<Option<PairView>>,
}

impl PairingState {
    /// A new pairing: every older one stops at its next step.
    pub fn begin(&self) -> u64 {
        *self.view.lock().unwrap() = None;
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
    pub fn is_current(&self, gen: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == gen
    }
    fn set_view(&self, gen: u64, v: Option<PairView>) -> bool {
        if !self.is_current(gen) {
            return false;
        }
        *self.view.lock().unwrap() = v;
        true
    }
    pub fn view(&self) -> Option<PairView> {
        self.view.lock().unwrap().clone()
    }
}

fn show<R: Runtime>(app: &AppHandle<R>, gen: u64, v: Option<PairView>) {
    let st = app.state::<PairingState>();
    if !st.set_view(gen, v.clone()) {
        return;
    }
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.eval(view_js(v.as_ref()));
    }
}

fn failed<R: Runtime>(app: &AppHandle<R>, gen: u64, message: impl Into<String>) {
    show(app, gen, Some(PairView { state: "failed", message: message.into(), check_code: None }));
}

/// The page (re)loaded: show the pairing sheet again if one is in flight.
pub fn on_page_loaded<R: Runtime>(app: &AppHandle<R>) {
    if let (Some(v), Some(w)) = (app.state::<PairingState>().view(), app.get_webview_window(MAIN_WINDOW)) {
        let _ = w.eval(view_js(Some(&v)));
    }
}

fn platform_and_label(model: &str) -> (&'static str, String) {
    #[cfg(target_os = "ios")]
    {
        let platform = if model.starts_with("iPad") { "ipados" } else { "ios" };
        (platform, crate::auth::mobile_device_label(model))
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = model;
        ("macos", crate::auth::device_label())
    }
}

/// Wait for the app-lock state to be known and the app to be unlocked (links.rs's rule).
async fn wait_unlocked<R: Runtime>(app: &AppHandle<R>) -> bool {
    let start = Instant::now();
    while !app.state::<crate::links::LinkState>().lock_ready() {
        if start.elapsed() > Duration::from_secs(60) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    crate::links::app_unlocked(app).await
}

/// Run one pairing for a validated link (see the module docs for the steps).
pub fn start<R: Runtime>(app: &AppHandle<R>, link: PairLink) {
    let gen = app.state::<PairingState>().begin();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !wait_unlocked(&app).await || !app.state::<PairingState>().is_current(gen) {
            return;
        }
        let state = app.state::<AppState>();
        let signed_in = matches!(state.token().await, Ok(Some(_)));
        let origin = link.origin.clone();
        match decide(&origin, state.origin().as_ref(), signed_in) {
            PairStart::Go => {}
            PairStart::OtherServer => {
                log::info!("ignored a pairing link for another server");
                return failed(&app, gen, format!(
                    "This pairing code is for {}, but Prism here is set up for another server. Sign out and change the server first.",
                    origin.as_str()
                ));
            }
            PairStart::AlreadySignedIn => {
                log::info!("ignored a pairing link: already signed in");
                return failed(&app, gen, "Prism is already signed in to this server on this device.");
            }
        }
        #[cfg(desktop)]
        crate::tray::show_main(&app);
        let ok = crate::confirm::ask(
            &app,
            crate::confirm::Prompt {
                title: "Pair with this Prism Server?".into(),
                body: format!(
                    "{}\n\nOnly continue if you just scanned the pairing code on your own computer. You will approve this device there.",
                    origin.as_str()
                ),
                confirm: "Pair".into(),
                cancel_is_default: true,
            },
        )
        .await;
        if !ok || !app.state::<PairingState>().is_current(gen) {
            return show(&app, gen, None);
        }
        show(&app, gen, Some(PairView { state: "working", message: "Connecting to the server…".into(), check_code: None }));
        if let Err(e) = crate::auth::probe_server(&origin).await {
            return failed(&app, gen, e);
        }
        #[cfg(target_os = "ios")]
        let model = match crate::ios::plugin(&app) {
            Ok(ios) => ios.device_info().await.map(|d| d.model).unwrap_or_default(),
            Err(_) => String::new(),
        };
        #[cfg(not(target_os = "ios"))]
        let model = String::new();
        let (platform, label) = platform_and_label(&model);
        let pkce = PkceSession::new();
        let c = match claim(&origin, &link.code, &pkce.challenge, &label, platform).await {
            Ok(c) => c,
            Err(e) => return failed(&app, gen, e),
        };
        show(&app, gen, Some(PairView {
            state: "waiting",
            message: "On your computer, type this code to approve this device:".into(),
            check_code: Some(c.check_code.clone()),
        }));
        let deadline = Instant::now() + POLL_DEADLINE;
        let mut interval = c.interval;
        let token = loop {
            tokio::time::sleep(interval).await;
            if !app.state::<PairingState>().is_current(gen) {
                return;
            }
            if Instant::now() > deadline {
                return failed(&app, gen, "The pairing code expired. Make a new one on your computer.");
            }
            match poll(&origin, &c.claim_id, &pkce.verifier).await {
                Poll::Pending => {}
                Poll::SlowDown => interval = (interval + Duration::from_secs(1)).min(Duration::from_secs(10)),
                Poll::Token(t) => break t,
                Poll::Denied => return failed(&app, gen, "The pairing was declined or cancelled on your computer."),
                Poll::Expired => return failed(&app, gen, "The pairing code expired. Make a new one on your computer."),
                Poll::Failed(e) => return failed(&app, gen, e),
            }
        };
        if let Err(e) = finish(&app, &origin, token).await {
            return failed(&app, gen, e);
        }
        log::info!("paired this device");
        show(&app, gen, None);
    });
}

/// Keep the token exactly like a PKCE sign-in does; set the server first if none was set.
async fn finish<R: Runtime>(app: &AppHandle<R>, origin: &ServerOrigin, token: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    match state.origin() {
        Some(o) if &o == origin => {
            state.store_token(token).await?;
            if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                let _ = w.eval("window.location.reload()");
            }
            Ok(())
        }
        Some(_) => {
            // The server changed while we waited: never file this token under another server.
            if let Err(e) = crate::auth::revoke(origin, &token).await {
                log::warn!("{e}");
            }
            Err("The server changed while pairing. Nothing was signed in.".into())
        }
        None => {
            let dir = state.settings_dir.clone().ok_or("no settings directory on this platform")?;
            crate::settings::update(&dir, |s| s.server_origin = Some(origin.as_str().to_string()))
                .map_err(|e| format!("could not save settings: {e}"))?;
            state.set_origin(Some(origin.clone())).await;
            app.state::<crate::links::LinkState>().clear();
            state.store_token(token).await?;
            #[cfg(mobile)]
            crate::mobile_cmds::reload_main(app);
            // Desktop: the CSP is derived from the origin at startup.
            #[cfg(desktop)]
            {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    app.restart();
                });
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "AbCdEfGhIjKlMnOpQrStUv";
    fn link(s: &str) -> String {
        format!("prism://pair?v=1&s={}&c={CODE}", url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>())
    }

    #[test]
    fn the_server_s_link_is_accepted() {
        let l = parse_pair_link(&link("https://prism.tail1234.ts.net")).unwrap();
        assert_eq!(l.origin.as_str(), "https://prism.tail1234.ts.net");
        assert_eq!(l.code, CODE);
        // The exact string the server builds (encodeURIComponent).
        let l = parse_pair_link(&format!("prism://pair?v=1&s=https%3A%2F%2Fprism.example.com%3A8443&c={CODE}")).unwrap();
        assert_eq!(l.origin.as_str(), "https://prism.example.com:8443");
        // Order of the three parameters does not matter.
        assert!(parse_pair_link(&format!("prism://pair?c={CODE}&s=https%3A%2F%2Fa.example.org&v=1")).is_some());
        assert!(parse_pair_link(&format!("prism://pair/?v=1&s=https%3A%2F%2Fa.example.org&c={CODE}")).is_some());
    }

    #[test]
    fn anything_else_is_not_a_pairing_link() {
        let ok_s = "https%3A%2F%2Fprism.example.org";
        for bad in [
            // Not https, not an origin, not a server address at all.
            link("http://prism.example.org"),
            link("http://127.0.0.1:8787"),
            link("https://prism.example.org/path"),
            link("https://prism.example.org?x=1"),
            link("https://user:pw@prism.example.org"),
            link("javascript:alert(1)"),
            link(""),
            // Wrong code shapes.
            format!("prism://pair?v=1&s={ok_s}&c=short"),
            format!("prism://pair?v=1&s={ok_s}&c={CODE}x"),
            format!("prism://pair?v=1&s={ok_s}&c=AbCdEfGhIjKlMnOpQrSt%2F"),
            format!("prism://pair?v=1&s={ok_s}&c=AbCdEfGhIjKlMnOpQrSt.v"),
            // Version, duplicates, extras, missing parts.
            format!("prism://pair?v=2&s={ok_s}&c={CODE}"),
            format!("prism://pair?v=1&v=1&s={ok_s}&c={CODE}"),
            format!("prism://pair?v=1&s={ok_s}&c={CODE}&c={CODE}"),
            format!("prism://pair?v=1&s={ok_s}&c={CODE}&next=/auth"),
            format!("prism://pair?v=1&c={CODE}"),
            format!("prism://pair?v=1&s={ok_s}"),
            // Other hosts, paths, ports, userinfo, fragments, spellings.
            format!("prism://PAIR?v=1&s={ok_s}&c={CODE}"),
            format!("prism://pair/x?v=1&s={ok_s}&c={CODE}"),
            format!("prism://pair:80?v=1&s={ok_s}&c={CODE}"),
            format!("prism://u@pair?v=1&s={ok_s}&c={CODE}"),
            format!("prism://pair?v=1&s={ok_s}&c={CODE}#x"),
            format!("prism:pair?v=1&s={ok_s}&c={CODE}"),
            format!("prism://auth/callback?v=1&s={ok_s}&c={CODE}"),
            format!("https://prism.example.org/pair?v=1&s={ok_s}&c={CODE}"),
            format!("omni://pair?v=1&s={ok_s}&c={CODE}"),
            // Raw-string tricks and size.
            format!("prism://pair?v=1&s={ok_s}&c={CODE} "),
            format!("prism://pair?v=1&s={ok_s}\\&c={CODE}"),
            format!("prism://pair?v=1&s={ok_s}&c={CODE}&pad={}", "x".repeat(MAX_LINK_BYTES)),
        ] {
            assert_eq!(parse_pair_link(&bad), None, "{bad}");
        }
        // Real in-app routes are not pairing links (links.rs keeps handling them).
        assert_eq!(parse_pair_link("prism://page/abc"), None);
    }

    #[test]
    fn a_link_never_switches_servers_or_replaces_a_sign_in() {
        let a = ServerOrigin::parse("https://a.example.org").unwrap();
        let b = ServerOrigin::parse("https://b.example.org").unwrap();
        assert_eq!(decide(&a, None, false), PairStart::Go, "a fresh app gets its server from the code");
        assert_eq!(decide(&a, Some(&a), false), PairStart::Go, "signed out of this server: pair");
        assert_eq!(decide(&a, Some(&a), true), PairStart::AlreadySignedIn);
        assert_eq!(decide(&a, Some(&b), false), PairStart::OtherServer);
        assert_eq!(decide(&a, Some(&b), true), PairStart::OtherServer);
    }

    #[test]
    fn claim_answers_are_checked() {
        let id = "a".repeat(43);
        let ok = parse_claim_response(200, &format!(r#"{{"claimId":"{id}","checkCode":"0472","interval":2,"expiresIn":250}}"#)).unwrap();
        assert_eq!((ok.claim_id.as_str(), ok.check_code.as_str(), ok.interval), (id.as_str(), "0472", Duration::from_secs(2)));
        // The interval is clamped; a missing one is 2 s.
        assert_eq!(parse_claim_response(200, &format!(r#"{{"claimId":"{id}","checkCode":"1234","interval":0}}"#)).unwrap().interval, Duration::from_secs(1));
        assert_eq!(parse_claim_response(200, &format!(r#"{{"claimId":"{id}","checkCode":"1234","interval":9999}}"#)).unwrap().interval, Duration::from_secs(10));
        for bad in [
            format!(r#"{{"claimId":"{id}","checkCode":"12a4"}}"#),
            format!(r#"{{"claimId":"{id}","checkCode":"12345"}}"#),
            r#"{"claimId":"short","checkCode":"1234"}"#.to_string(),
            "not json".to_string(),
        ] {
            assert!(parse_claim_response(200, &bad).is_err(), "{bad}");
        }
        assert!(parse_claim_response(409, r#"{"error":"already_used"}"#).unwrap_err().contains("already used"));
        assert!(parse_claim_response(409, r#"{"error":"expired"}"#).unwrap_err().contains("expired"));
        // The server's own words never reach the screen.
        let e = parse_claim_response(400, r#"{"error":"<script>alert(1)</script>"}"#).unwrap_err();
        assert_eq!(e, "The server refused the pairing code.");
    }

    #[test]
    fn poll_answers_map_to_outcomes() {
        assert_eq!(parse_poll_response(400, r#"{"error":"authorization_pending"}"#), Poll::Pending);
        assert_eq!(parse_poll_response(400, r#"{"error":"slow_down"}"#), Poll::SlowDown);
        assert_eq!(parse_poll_response(429, r#"{"error":"rate_limited","retryAfter":3}"#), Poll::SlowDown);
        assert_eq!(parse_poll_response(400, r#"{"error":"access_denied"}"#), Poll::Denied);
        assert_eq!(parse_poll_response(400, r#"{"error":"expired_token"}"#), Poll::Expired);
        assert!(matches!(parse_poll_response(400, r#"{"error":"invalid_grant"}"#), Poll::Failed(_)));
        let tok = format!("pd_{}", "a".repeat(43));
        assert_eq!(parse_poll_response(200, &format!(r#"{{"access_token":"{tok}","token_type":"Bearer","expires_in":10,"device_id":"dev_x"}}"#)), Poll::Token(tok));
        // Only a pd_ bearer token is ever kept.
        assert!(matches!(parse_poll_response(200, r#"{"access_token":"pp_nope_nope_nope_nope","token_type":"Bearer"}"#), Poll::Failed(_)));
    }

    #[test]
    fn the_page_gets_a_display_only_view() {
        let v = PairView { state: "waiting", message: "type \"this\"".into(), check_code: Some("0472".into()) };
        let js = view_js(Some(&v));
        assert_eq!(js, r#"window.__PRISM_SHELL__ && window.__PRISM_SHELL__.pairing && window.__PRISM_SHELL__.pairing({"state":"waiting","message":"type \"this\"","checkCode":"0472"});"#);
        assert!(view_js(None).ends_with("pairing(null);"));
        for js in [js, view_js(None)] {
            assert!(!js.contains("location") && !js.contains("href"), "{js}");
        }
    }

    #[test]
    fn a_newer_pairing_replaces_an_older_one() {
        let s = PairingState::default();
        let one = s.begin();
        assert!(s.set_view(one, Some(PairView { state: "working", message: "a".into(), check_code: None })));
        let two = s.begin();
        assert!(!s.is_current(one));
        assert_eq!(s.view(), None, "the older view is gone");
        assert!(!s.set_view(one, Some(PairView { state: "failed", message: "late".into(), check_code: None })), "a late step of the older pairing shows nothing");
        assert!(s.set_view(two, None));
    }

    #[test]
    fn nothing_secret_is_logged() {
        let src = include_str!("pairing.rs");
        let prod = src.split("#[cfg(test)]\nmod tests").next().unwrap();
        for line in prod.lines().filter(|l| l.contains("log::")) {
            assert!(!line.contains('{') || line.contains("log::warn!(\"{e}\")"), "a log line formats nothing secret: {line}");
        }
    }

    // ---- the HTTP half against a local fake server (no network, no real server)

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn fake(status: &'static str, body: &'static str) -> (ServerOrigin, tokio::task::JoinHandle<String>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = s.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let len = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if rest.len() >= len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            s.write_all(resp.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf).to_string()
        });
        (ServerOrigin::parse(&format!("http://127.0.0.1:{port}")).unwrap(), h)
    }

    #[tokio::test]
    async fn claim_posts_the_challenge_never_the_verifier() {
        let (origin, seen) = fake("200 OK", r#"{"claimId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checkCode":"0472","interval":2}"#).await;
        let pkce = PkceSession::new();
        let c = claim(&origin, CODE, &pkce.challenge, "Prism on iPhone", "ios").await.unwrap();
        assert_eq!(c.check_code, "0472");
        let req = seen.await.unwrap();
        assert!(req.starts_with("POST /auth/pair/claim HTTP/1.1"), "{req}");
        assert!(req.contains(&pkce.challenge) && req.contains(CODE) && req.contains("\"platform\":\"ios\""));
        assert!(!req.contains(&pkce.verifier), "the verifier stays on the phone until the token step");
        let lower = req.to_ascii_lowercase();
        assert!(!lower.contains("authorization:") && !lower.contains("cookie:"));
    }

    #[tokio::test]
    async fn poll_sends_the_verifier_and_reads_the_token() {
        let (origin, seen) = fake("200 OK", r#"{"access_token":"pd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","token_type":"Bearer","expires_in":10,"device_id":"dev_1"}"#).await;
        let out = poll(&origin, "claim-id", "the-verifier").await;
        assert_eq!(out, Poll::Token("pd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()));
        let req = seen.await.unwrap();
        assert!(req.starts_with("POST /auth/pair/token HTTP/1.1"), "{req}");
        assert!(req.contains("\"code_verifier\":\"the-verifier\"") && req.contains("\"claim_id\":\"claim-id\""));
        let (origin, _) = fake("400 Bad Request", r#"{"error":"authorization_pending"}"#).await;
        assert_eq!(poll(&origin, "c", "v").await, Poll::Pending);
        // A dead server is "try again" (the overall deadline ends it), never a token.
        let dead = ServerOrigin::parse("http://127.0.0.1:9").unwrap();
        assert_eq!(poll(&dead, "c", "v").await, Poll::SlowDown);
    }
}
