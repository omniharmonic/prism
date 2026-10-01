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
    async fn revoke_posts_the_token() {
        let (origin, seen) = fake_server("200 OK", "{}").await;
        revoke(&origin, "pd_tok").await.unwrap();
        let req = seen.await.unwrap();
        assert!(req.starts_with("POST /auth/device/revoke HTTP/1.1"));
        assert!(req.ends_with("token=pd_tok"));
    }
}
