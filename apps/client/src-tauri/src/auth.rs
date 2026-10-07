//! Server calls of the device sign-in flow (docs/native-auth.md): redeem the
//! authorization code at `POST /auth/device/token`, and revoke at
//! `POST /auth/device/revoke`. Platform-independent (iOS reuses it in WP5.2).
//!
//! Only ever talks to the configured origin. Redirects are refused, so a code,
//! verifier or token can never be forwarded to another host.

use std::time::Duration;

use serde::Deserialize;

use crate::origin::ServerOrigin;
use crate::pkce::CLIENT_ID;

pub(crate) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("PrismClient/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

#[derive(Deserialize)]
struct TokenOk {
    access_token: String,
    token_type: String,
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

/// Interpret the token endpoint's response. Returns the `pd_…` token.
pub fn parse_token_response(status: u16, body: &str) -> Result<String, String> {
    if (200..300).contains(&status) {
        let ok: TokenOk =
            serde_json::from_str(body).map_err(|_| "unexpected token response".to_string())?;
        if !ok.token_type.eq_ignore_ascii_case("bearer") {
            return Err(format!("unexpected token type {:?}", ok.token_type));
        }
        if !ok.access_token.starts_with("pd_")
            || ok.access_token.len() < 20
            || ok.access_token.len() > 256
        {
            return Err("the server returned an unexpected token format".into());
        }
        return Ok(ok.access_token);
    }
    match serde_json::from_str::<OAuthError>(body) {
        Ok(e) => {
            let code: String = e
                .error
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                .take(64)
                .collect();
            let desc = e
                .error_description
                .map(|d| {
                    d.chars()
                        .filter(|c| !c.is_control())
                        .take(200)
                        .collect::<String>()
                })
                .unwrap_or_default();
            Err(if desc.is_empty() {
                format!("sign-in failed: {code}")
            } else {
                format!("sign-in failed: {code} ({desc})")
            })
        }
        Err(_) => Err(format!("sign-in failed: HTTP {status}")),
    }
}

/// Redeem an authorization code (PKCE) for a device token.
pub async fn exchange_code(
    origin: &ServerOrigin,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let resp = client()?
        .post(origin.join("/auth/device/token"))
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
            ("client_id", CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|e| format!("could not reach the server: {}", e.without_url()))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("reading token response: {}", e.without_url()))?;
    parse_token_response(status, &body)
}

/// Revoke the calling device token (sign out). The server answers 200 for any
/// token (RFC 7009 style); a network failure is reported but the caller still
/// forgets the token locally.
pub async fn revoke(origin: &ServerOrigin, token: &str) -> Result<(), String> {
    let resp = client()?
        .post(origin.join("/auth/device/revoke"))
        .form(&[("token", token)])
        .send()
        .await
        .map_err(|e| format!("could not reach the server to revoke: {}", e.without_url()))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("revoke failed: HTTP {}", resp.status().as_u16()))
    }
}

/// Is this a Prism Server? (iOS first-run screen, before the address is saved.)
///
/// `GET /health?live=1` — the server's liveness probe: `200 {"ok":true,"live":true}`
/// with no vault call behind it. A server from before that form ignores the query
/// and answers the plain `/health` (`{"ok":…,"vault":…}`, 200 when the vault is
/// up, 503 when it isn't); every one of these means "a Prism Server is here".
///
/// 🔒 This is the ONLY request made to an address nobody has confirmed yet, so it
/// carries nothing: no bearer (none exists while no server is set, and this
/// function takes none), no cookies (the client has no cookie store), and it
/// follows no redirect. The answer is read up to [`PROBE_MAX_BYTES`] and only
/// its shape is looked at.
#[cfg_attr(not(mobile), allow(dead_code))]
pub async fn probe_server(origin: &ServerOrigin) -> Result<(), String> {
    let unreachable = || {
        format!(
            "Couldn't reach {}. Check the address and your connection.",
            origin.as_str()
        )
    };
    let mut resp = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("PrismClient/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))?
        .get(origin.join("/health?live=1"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| unreachable())?;
    let status = resp.status().as_u16();
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| unreachable())? {
        if body.len() + chunk.len() > PROBE_MAX_BYTES {
            body.clear();
            break;
        }
        body.extend_from_slice(&chunk);
    }
    let looks_like_prism = matches!(status, 200 | 503)
        && serde_json::from_slice::<serde_json::Value>(&body)
            .map(|v| v.get("ok").is_some_and(|ok| ok.is_boolean()))
            .unwrap_or(false);
    if looks_like_prism {
        Ok(())
    } else {
        Err(format!(
            "{} doesn't look like a Prism Server.",
            origin.as_str()
        ))
    }
}

/// The health answer is a few dozen bytes; anything longer is not one.
#[cfg_attr(not(mobile), allow(dead_code))]
const PROBE_MAX_BYTES: usize = 4096;

/// Remove this device's APNs registration (`DELETE /api/push/apns`) before the
/// token is revoked. Best effort: revoking the device deletes the row
/// server-side anyway (docs/push.md, "Lifecycle").
#[cfg_attr(not(mobile), allow(dead_code))]
pub async fn delete_apns(origin: &ServerOrigin, token: &str) -> Result<(), String> {
    let resp = client()?
        .delete(origin.join("/api/push/apns"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("could not reach the server: {}", e.without_url()))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "push unregister failed: HTTP {}",
            resp.status().as_u16()
        ))
    }
}

/// The consent-page label on iOS ("Prism on iPhone"). The model comes from
/// `UIDevice`; anything odd falls back to a generic label.
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn mobile_device_label(model: &str) -> String {
    let model: String = model
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ')
        .take(24)
        .collect();
    let model = model.trim();
    if model.is_empty() {
        "Prism on iOS".into()
    } else {
        format!("Prism on {model}")
    }
}

/// The device label shown on the consent page and in Account → Devices.
/// A claim, not an identity: the server presents it as such.
pub fn device_label() -> String {
    let host = hostname()
        .map(|h| h.trim_end_matches(".local").to_string())
        .filter(|h| !h.is_empty());
    let label = match host {
        Some(h) => format!("Prism Client on {h}"),
        None => "Prism Client".to_string(),
    };
    label.chars().filter(|c| !c.is_control()).take(80).collect()
}

#[cfg(unix)]
fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: buf is valid for buf.len() bytes; gethostname NUL-terminates on success
    // (we also guard with the explicit search below).
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8(buf[..end].to_vec()).ok()
}

#[cfg(not(unix))]
fn hostname() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn token_response_parsing() {
        let tok = format!("pd_{}", "a".repeat(43));
        assert_eq!(
            parse_token_response(
                200,
                &format!(
                    r#"{{"access_token":"{tok}","token_type":"Bearer","expires_in":7776000,"device_id":"d1"}}"#
                )
            ),
            Ok(tok.clone())
        );
        assert!(parse_token_response(
            200,
            &format!(r#"{{"access_token":"{tok}","token_type":"mac"}}"#)
        )
        .is_err());
        assert!(parse_token_response(
            200,
            r#"{"access_token":"eyJhbGciOi.jwt.like","token_type":"Bearer"}"#
        )
        .is_err());
        assert!(parse_token_response(200, "not json").is_err());
        assert_eq!(
            parse_token_response(
                400,
                r#"{"error":"invalid_grant","error_description":"code expired"}"#
            ),
            Err("sign-in failed: invalid_grant (code expired)".into())
        );
        assert_eq!(
            parse_token_response(502, "<html>"),
            Err("sign-in failed: HTTP 502".into())
        );
    }

    #[test]
    fn label_is_bounded() {
        let l = device_label();
        assert!(l.starts_with("Prism Client"));
        assert!(l.chars().count() <= 80);
    }

    /// A one-request fake server on 127.0.0.1: returns the raw request it saw.
    async fn fake_server(
        status: &'static str,
        body: &'static str,
    ) -> (ServerOrigin, tokio::task::JoinHandle<String>) {
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
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if rest.len() >= len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            s.write_all(resp.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf).to_string()
        });
        (
            ServerOrigin::parse(&format!("http://127.0.0.1:{port}")).unwrap(),
            h,
        )
    }

    #[tokio::test]
    async fn exchange_posts_the_pkce_form() {
        let (origin, seen) = fake_server(
            "200 OK",
            r#"{"access_token":"pd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","token_type":"Bearer","expires_in":1,"device_id":"x"}"#,
        )
        .await;
        let tok = exchange_code(
            &origin,
            "the-code",
            "the-verifier",
            "http://127.0.0.1:5555/callback",
        )
        .await
        .unwrap();
        assert!(tok.starts_with("pd_"));
        let req = seen.await.unwrap();
        assert!(req.starts_with("POST /auth/device/token HTTP/1.1"));
        let body = req.split_once("\r\n\r\n").unwrap().1;
        let form: std::collections::HashMap<_, _> = url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["code"], "the-code");
        assert_eq!(form["code_verifier"], "the-verifier");
        assert_eq!(form["redirect_uri"], "http://127.0.0.1:5555/callback");
        assert_eq!(form["client_id"], "prism-native");
        assert!(
            !req.to_ascii_lowercase().contains("\r\ncookie:"),
            "no cookies"
        );
    }

    #[tokio::test]
    async fn exchange_does_not_follow_redirects() {
        let (origin, _seen) =
            fake_server("302 Found\r\nLocation: https://elsewhere.example/steal", "").await;
        let r = exchange_code(&origin, "c", "v", "http://127.0.0.1:1/callback").await;
        assert_eq!(r, Err("sign-in failed: HTTP 302".into()));
    }

    #[tokio::test]
    async fn probe_accepts_a_prism_health_answer() {
        let (origin, seen) = fake_server("200 OK", r#"{"ok":true,"vault":true}"#).await;
        probe_server(&origin).await.unwrap();
        let req = seen.await.unwrap();
        assert!(req.starts_with("GET /health?live=1 HTTP/1.1"), "{req}");
        // Nothing but the request goes to an unconfirmed address.
        let lower = req.to_ascii_lowercase();
        assert!(!lower.contains("authorization:") && !lower.contains("cookie:"), "{req}");
        // The liveness form's own answer.
        let (origin, _) = fake_server("200 OK", r#"{"ok":true,"live":true}"#).await;
        probe_server(&origin).await.unwrap();
        // Not JSON-with-ok, however long: refused (and never buffered whole).
        let big: &'static str =
            Box::leak(format!(r#"{{"ok":true,"pad":"{}"}}"#, "x".repeat(PROBE_MAX_BYTES)).into_boxed_str());
        let (origin, _) = fake_server("200 OK", big).await;
        assert!(probe_server(&origin).await.is_err(), "an oversized answer is not a health answer");
        // A dead address reads as unreachable.
        let dead = ServerOrigin::parse("http://127.0.0.1:9").unwrap();
        assert!(probe_server(&dead).await.unwrap_err().starts_with("Couldn't reach"));
        let (origin, _) =
            fake_server("503 Service Unavailable", r#"{"ok":false,"vault":false}"#).await;
        assert!(
            probe_server(&origin).await.is_ok(),
            "vault down is still a Prism Server"
        );
        let (origin, _) = fake_server("200 OK", "<html>hello</html>").await;
        assert!(probe_server(&origin).await.is_err());
        let (origin, _) =
            fake_server("302 Found\r\nLocation: https://elsewhere.example/", "").await;
        assert!(
            probe_server(&origin).await.is_err(),
            "redirects are not followed"
        );
    }

    #[tokio::test]
    async fn delete_apns_sends_the_bearer() {
        let (origin, seen) = fake_server("200 OK", r#"{"ok":true}"#).await;
        delete_apns(&origin, "pd_tok").await.unwrap();
        let req = seen.await.unwrap();
        assert!(req.starts_with("DELETE /api/push/apns HTTP/1.1"));
        assert!(req
            .to_ascii_lowercase()
            .contains("\r\nauthorization: bearer pd_tok\r\n"));
    }

    #[test]
    fn mobile_label() {
        assert_eq!(mobile_device_label("iPhone"), "Prism on iPhone");
        assert_eq!(mobile_device_label("iPad"), "Prism on iPad");
        assert_eq!(mobile_device_label("<b>\u{202e}"), "Prism on b");
        assert_eq!(mobile_device_label(""), "Prism on iOS");
    }

    #[tokio::test]
    async fn revoke_posts_the_token() {
        let (origin, seen) = fake_server("200 OK", "{}").await;
        revoke(&origin, "pd_tok").await.unwrap();
        let req = seen.await.unwrap();
        assert!(req.starts_with("POST /auth/device/revoke HTTP/1.1"));
        assert!(req.ends_with("token=pd_tok"));
    }
}
