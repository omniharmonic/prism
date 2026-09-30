//! PKCE (RFC 7636, S256 only) and the pure pieces of the device sign-in flow
//! (docs/native-auth.md): verifier/challenge/state generation, the authorize
//! URL, the constant-time state check, and callback-query parsing.
//!
//! Platform-independent: the macOS loopback redirect and the future iOS
//! `ASWebAuthenticationSession` redirect both feed [`parse_callback_query`].

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use url::Url;

use crate::origin::ServerOrigin;

/// The server's registered native client id.
pub const CLIENT_ID: &str = "prism-native";

/// 32 random bytes, base64url without padding (43 chars). Used for both the
/// verifier and `state`.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `BASE64URL(SHA256(ascii(verifier)))` — the S256 code challenge.
pub fn challenge_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// One sign-in attempt's secrets. Never leaves the Rust process except as the
/// challenge + state in the authorize URL and the verifier in the token POST.
pub struct PkceSession {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl PkceSession {
    pub fn new() -> Self {
        let verifier = random_token();
        let challenge = challenge_s256(&verifier);
        Self {
            verifier,
            challenge,
            state: random_token(),
        }
    }
}

/// `GET {origin}/auth/device/authorize?...` for the system browser.
pub fn authorize_url(
    origin: &ServerOrigin,
    redirect_uri: &str,
    pkce: &PkceSession,
    label: &str,
) -> String {
    let mut url =
        Url::parse(&origin.join("/auth/device/authorize")).expect("origin is a valid URL");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &pkce.state)
        .append_pair("label", label);
    url.into()
}

/// Constant-time string equality (for `state`).
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// What the authorization server sent back to the redirect URI.
#[derive(Debug, PartialEq, Eq)]
pub enum CallbackOutcome {
    /// `code` with a matching `state`.
    Code(String),
    /// `error=...` with a matching `state` (e.g. the user pressed Deny).
    Denied(String),
    /// Missing/mismatched `state`: not ours (or forged). Ignore it.
    StateMismatch,
    /// Our state, but neither `code` nor `error`.
    Malformed,
}

/// Parse the redirect's query string and check `state`.
pub fn parse_callback_query(query: &str, expected_state: &str) -> CallbackOutcome {
    let (mut code, mut state, mut error) = (None, None, None);
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            // First occurrence wins; a duplicate parameter is suspicious but harmless.
            "code" if code.is_none() => code = Some(v.into_owned()),
            "state" if state.is_none() => state = Some(v.into_owned()),
            "error" if error.is_none() => error = Some(v.into_owned()),
            _ => {}
        }
    }
    match state {
        Some(s) if ct_eq(&s, expected_state) => {}
        _ => return CallbackOutcome::StateMismatch,
    }
    if let Some(e) = error {
        return CallbackOutcome::Denied(sanitize_error(&e));
    }
    match code {
        Some(c) if !c.is_empty() && c.len() <= 512 => CallbackOutcome::Code(c),
        _ => CallbackOutcome::Malformed,
    }
}

/// Keep server-supplied error codes printable and short before showing them.
fn sanitize_error(e: &str) -> String {
    e.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_appendix_b_vector() {
        // RFC 7636 Appendix B.
        assert_eq!(
            challenge_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_shape() {
        let s = PkceSession::new();
        // 32 bytes -> 43 base64url chars, within RFC 7636's 43..=128.
        assert_eq!(s.verifier.len(), 43);
        assert!(s
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(s.challenge.len(), 43, "server requires a 43-char challenge");
        assert_eq!(s.challenge, challenge_s256(&s.verifier));
        assert_ne!(s.verifier, s.state);
        assert_ne!(
            PkceSession::new().verifier,
            s.verifier,
            "fresh randomness per attempt"
        );
    }

    #[test]
    fn authorize_url_carries_every_param() {
        let o = ServerOrigin::parse("https://prism.example.com").unwrap();
        let s = PkceSession::new();
        let u = Url::parse(&authorize_url(
            &o,
            "http://127.0.0.1:50123/callback",
            &s,
            "Prism Client on test",
        ))
        .unwrap();
        assert_eq!(
            u.origin().ascii_serialization(),
            "https://prism.example.com"
        );
        assert_eq!(u.path(), "/auth/device/authorize");
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "prism-native");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:50123/callback");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], s.challenge);
        assert_eq!(q["state"], s.state);
        assert_eq!(q["label"], "Prism Client on test");
        assert!(
            !q.contains_key("code_verifier"),
            "the verifier never goes to the browser"
        );
    }

    #[test]
    fn state_check() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "abcd"));
        assert!(!ct_eq("", "a"));
    }

    #[test]
    fn callback_parsing() {
        let st = "S7ate";
        assert_eq!(
            parse_callback_query("code=abc&state=S7ate", st),
            CallbackOutcome::Code("abc".into())
        );
        assert_eq!(
            parse_callback_query("state=S7ate&code=a%2Bb", st),
            CallbackOutcome::Code("a+b".into())
        );
        assert_eq!(
            parse_callback_query("code=abc&state=nope", st),
            CallbackOutcome::StateMismatch
        );
        assert_eq!(
            parse_callback_query("code=abc", st),
            CallbackOutcome::StateMismatch
        );
        assert_eq!(parse_callback_query("", st), CallbackOutcome::StateMismatch);
        assert_eq!(
            parse_callback_query("error=access_denied&state=S7ate", st),
            CallbackOutcome::Denied("access_denied".into())
        );
        // An error with the wrong state is not ours: ignored, not "denied".
        assert_eq!(
            parse_callback_query("error=access_denied&state=x", st),
            CallbackOutcome::StateMismatch
        );
        assert_eq!(
            parse_callback_query("state=S7ate", st),
            CallbackOutcome::Malformed
        );
        assert_eq!(
            parse_callback_query("state=S7ate&code=", st),
            CallbackOutcome::Malformed
        );
        // Error text is sanitized before display.
        assert_eq!(
            parse_callback_query("error=%3Cscript%3Ebad&state=S7ate", st),
            CallbackOutcome::Denied("scriptbad".into())
        );
    }
}
