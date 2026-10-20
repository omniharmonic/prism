//! Quick capture (WP4.2): a note typed into the small capture window is POSTed
//! to the configured Prism Server from RUST, with the stored device token.
//!
//! Why Rust and not the page: the capture window has its own minimal
//! capability (`quick-capture.json`: the single command `quick_capture`) and is
//! never given `get_token`, so the bearer never enters that webview. The only
//! thing it controls is the note text; the destination (the one configured
//! origin, `POST /api/notes`), the path, the tags and the metadata are all
//! built here from validated input.

use std::time::Duration;

use serde_json::{json, Value};

use crate::origin::ServerOrigin;

/// Label of the quick-capture webview window (its capability file targets it).
pub const WINDOW_LABEL: &str = "quick-capture";

/// Largest note the capture window may send, in bytes (UTF-8).
pub const MAX_CAPTURE_BYTES: usize = 100_000;

/// Validate and normalise the text. Control characters other than newline,
/// carriage return and tab are refused (they have no place in a typed note and
/// could confuse downstream consumers).
pub fn validate(text: &str) -> Result<String, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("There is nothing to save.".into());
    }
    if t.len() > MAX_CAPTURE_BYTES {
        return Err(format!(
            "That note is too long for quick capture ({} KB max).",
            MAX_CAPTURE_BYTES / 1000
        ));
    }
    if t.chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("That text contains characters that can't be saved.".into());
    }
    Ok(t.to_string())
}

/// `(year, month, day)` of a Unix day number (proleptic Gregorian, UTC).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `(YYYY-MM-DD, HHMMSS, RFC 3339)` for a Unix timestamp, in UTC.
pub fn utc_parts(secs: i64) -> (String, String, String) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    (
        format!("{y:04}-{m:02}-{d:02}"),
        format!("{hh:02}{mm:02}{ss:02}"),
        format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z"),
    )
}

/// The JSON body for `POST /api/notes`. `suffix` is 4 hex characters that keep
/// two captures in the same second from colliding on the path.
pub fn build_body(text: &str, now_secs: i64, suffix: &str) -> Result<Value, String> {
    let content = validate(text)?;
    if suffix.len() != 4 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("internal: bad capture suffix".into());
    }
    let (date, time, iso) = utc_parts(now_secs);
    Ok(json!({
        "content": content,
        "path": format!("vault/capture/{date}/{time}-{}", suffix.to_ascii_lowercase()),
        "tags": ["capture"],
        "metadata": { "source": "prism-client-quick-capture", "capturedAt": iso },
    }))
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn random_suffix() -> String {
    use rand::Rng;
    format!("{:04x}", rand::thread_rng().gen::<u16>())
}

/// Map a server status to a message that never echoes the response body.
pub fn status_message(status: u16) -> Option<String> {
    match status {
        200..=299 => None,
        401 => Some("Your Prism sign-in has expired. Open Prism and sign in again.".into()),
        403 => Some("This account isn't allowed to create notes.".into()),
        413 => Some("The server says that note is too large.".into()),
        s => Some(format!("The server could not save the note (HTTP {s}).")),
    }
}

/// POST the note. The request goes only to `origin` (redirects are not
/// followed, so the bearer can't be bounced elsewhere).
pub async fn post(origin: &ServerOrigin, token: &str, body: &Value) -> Result<(), String> {
    let client = crate::auth::client()?;
    let resp = client
        .post(origin.join("/api/notes"))
        .bearer_auth(token)
        .timeout(Duration::from_secs(15))
        .json(body)
        .send()
        .await
        .map_err(|_| "Couldn't reach the Prism server. Check your connection.".to_string())?;
    match status_message(resp.status().as_u16()) {
        None => Ok(()),
        Some(m) => Err(m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_oversized_and_control_text() {
        assert!(validate("   \n\t ").is_err());
        assert!(validate("").is_err());
        assert!(validate(&"a".repeat(MAX_CAPTURE_BYTES + 1)).is_err());
        assert!(validate(&"a".repeat(MAX_CAPTURE_BYTES)).is_ok());
        assert!(validate("a\u{0}b").is_err(), "NUL");
        assert!(validate("a\u{1b}[31mb").is_err(), "ESC");
        assert_eq!(validate("  hi\nthere\t!  ").unwrap(), "hi\nthere\t!");
        // Multi-byte text is measured in bytes, not chars.
        assert!(validate(&"é".repeat(MAX_CAPTURE_BYTES / 2 + 1)).is_err());
    }

    #[test]
    fn civil_dates_are_right() {
        assert_eq!(utc_parts(0).0, "1970-01-01");
        assert_eq!(utc_parts(951_782_400).0, "2000-02-29", "leap day");
        let (d, t, iso) = utc_parts(1_791_000_000);
        assert_eq!((d.as_str(), t.as_str()), ("2026-10-03", "040000"));
        assert_eq!(iso, "2026-10-03T04:00:00Z");
        assert_eq!(utc_parts(-1).0, "1969-12-31");
    }

    #[test]
    fn body_is_built_from_validated_input_only() {
        let b = build_body("  Buy oat milk ", 1_791_000_000, "AB12").unwrap();
        assert_eq!(b["content"], "Buy oat milk");
        assert_eq!(b["path"], "vault/capture/2026-10-03/040000-ab12");
        assert_eq!(b["tags"], json!(["capture"]));
        assert_eq!(b["metadata"]["source"], "prism-client-quick-capture");
        // Nothing but these four keys is ever sent.
        let mut keys: Vec<_> = b.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["content", "metadata", "path", "tags"]);
        assert!(build_body("x", 0, "zz").is_err());
        assert!(build_body("x", 0, "../..").is_err());
        assert!(build_body("", 0, "abcd").is_err());
    }

    #[test]
    fn random_suffix_is_four_hex_chars() {
        for _ in 0..50 {
            let s = random_suffix();
            assert_eq!(s.len(), 4);
            assert!(s.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn status_messages_never_echo_a_body() {
        assert!(status_message(201).is_none());
        assert!(status_message(401).unwrap().contains("sign in"));
        assert!(status_message(500).unwrap().contains("500"));
    }
}
