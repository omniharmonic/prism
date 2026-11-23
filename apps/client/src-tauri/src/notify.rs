//! Native notifications for agent-turn completion (WP4.2).
//!
//! The page asks via the narrow `notify` command; everything it passes is
//! treated as untrusted display text: stripped of HTML and control characters
//! and length-capped here, never interpreted. The shell, not the page, decides
//! whether to show it (only while the main window is NOT focused) and
//! rate-limits it, so a compromised page can't spam the notification centre.
//!
//! Click handling: notify-rust on desktop has no click callback. Clicking a
//! notification activates the app, which focuses the main window; if a
//! notification with a session id was shown in the last [`CLICK_TTL`], that
//! focus event is treated as "the user came for it" and the shell dispatches
//! the in-app `prism:open-agent-session` event (a DOM event, not a
//! navigation; the web layer already handles it, see apps/web/src/push/deeplink.ts).

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MAX_TITLE_CHARS: usize = 80;
pub const MAX_BODY_CHARS: usize = 240;
/// Only this much of any input string is even inspected.
const MAX_INPUT_CHARS: usize = 4096;
/// A notification whose click-through is still honoured after this long.
pub const CLICK_TTL: Duration = Duration::from_secs(60);
/// Minimum gap between two shown notifications.
pub const MIN_GAP: Duration = Duration::from_millis(1500);

/// Plain, bounded, single-line display text: HTML tags and angle brackets
/// removed, control characters and runs of whitespace collapsed to one space,
/// cut at `max` characters with an ellipsis.
pub fn sanitize_text(input: &str, max: usize) -> String {
    // 1. drop <...> spans, then any stray angle bracket. Only the head of an
    //    oversized input is looked at (the result is capped far below this).
    let mut no_tags = String::with_capacity(input.len().min(MAX_INPUT_CHARS));
    let mut in_tag = false;
    for c in input.chars().take(MAX_INPUT_CHARS) {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if in_tag => {}
            '>' => {}
            _ => no_tags.push(c),
        }
    }
    // An unterminated "<…" swallowed the rest of the text; that is intended
    // (it can only have been markup).
    // 2. control chars (incl. newlines, bidi controls) → space; collapse runs.
    let mut out = String::new();
    let mut last_space = true;
    for c in no_tags.chars() {
        let space = c.is_whitespace()
            || c.is_control()
            || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
        if space {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    let out = out.trim_end().to_string();
    if out.chars().count() <= max {
        return out;
    }
    let cut: String = out.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// Same shape the web layer accepts for a session id (push/deeplink.ts).
pub fn session_id_ok(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// What the shell will actually show.
#[derive(Debug, PartialEq, Eq)]
pub struct Prepared {
    pub title: String,
    pub body: String,
    pub session_id: Option<String>,
}

pub fn prepare(title: &str, body: &str, session_id: Option<&str>) -> Prepared {
    let title = sanitize_text(title, MAX_TITLE_CHARS);
    Prepared {
        title: if title.is_empty() {
            "Prism".into()
        } else {
            title
        },
        body: sanitize_text(body, MAX_BODY_CHARS),
        session_id: session_id.filter(|s| session_id_ok(s)).map(str::to_string),
    }
}

#[derive(Default)]
pub struct NotifyState {
    last_shown: Mutex<Option<Instant>>,
    pending: Mutex<Option<(String, Instant)>>,
}

impl NotifyState {
    /// Rate limit: `true` (and the slot is taken) when enough time has passed.
    pub fn allow(&self, now: Instant) -> bool {
        let mut last = self.last_shown.lock().unwrap();
        if matches!(*last, Some(t) if now.saturating_duration_since(t) < MIN_GAP) {
            return false;
        }
        *last = Some(now);
        true
    }

    pub fn set_pending(&self, session_id: Option<String>, now: Instant) {
        *self.pending.lock().unwrap() = session_id.map(|s| (s, now));
    }

    /// The session to open now that the app was focused, if a notification for
    /// it is still fresh. Consumed: one notification opens at most once.
    pub fn take_pending(&self, now: Instant) -> Option<String> {
        let taken = self.pending.lock().unwrap().take();
        match taken {
            Some((id, at)) if now.saturating_duration_since(at) <= CLICK_TTL => Some(id),
            _ => None,
        }
    }
}

/// JS the shell evals in the main window to open a session (a DOM event; the
/// id has already passed [`session_id_ok`] and is JSON-escaped regardless).
pub fn open_session_js(session_id: &str) -> String {
    let lit = serde_json::to_string(session_id).expect("a string serializes");
    format!(
        "window.dispatchEvent(new CustomEvent(\"prism:open-agent-session\",{{detail:{{sessionId:{lit}}}}}));"
    )
}

/// Show the notification (desktop). Blocking: call from `spawn_blocking`.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn show(identifier: &str, p: &Prepared) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            // Attribute notifications to this app (not Terminal).
            let _ = notify_rust::set_application(identifier);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = identifier;
    notify_rust::Notification::new()
        .summary(&p.title)
        .body(&p.body)
        .show()
        .map(|_| ())
        .map_err(|e| format!("could not show the notification: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html_and_control_characters() {
        assert_eq!(
            sanitize_text("<b>Done</b> <img src=x onerror=alert(1)>ok", 100),
            "Done ok"
        );
        assert_eq!(sanitize_text("a\u{0}b\r\nc\td", 100), "a b c d");
        assert_eq!(sanitize_text("1 < 2 > 0", 100), "1 0");
        assert_eq!(sanitize_text("   \n  ", 100), "");
        assert_eq!(
            sanitize_text("x\u{202e}evil", 100),
            "x evil",
            "bidi override"
        );
        assert_eq!(sanitize_text("an <unterminated tag", 100), "an");
        assert!(!sanitize_text("<<script>>alert<</script>>", 100).contains('<'));
    }

    #[test]
    fn caps_length_in_characters() {
        let t = sanitize_text(&"é".repeat(500), MAX_BODY_CHARS);
        assert_eq!(t.chars().count(), MAX_BODY_CHARS);
        assert!(t.ends_with('…'));
        assert_eq!(sanitize_text("short", MAX_TITLE_CHARS), "short");
        assert_eq!(
            sanitize_text(&"a".repeat(MAX_TITLE_CHARS), MAX_TITLE_CHARS)
                .chars()
                .count(),
            MAX_TITLE_CHARS,
            "exactly at the cap is untouched"
        );
    }

    #[test]
    fn session_ids_are_validated() {
        assert!(session_id_ok("3f2b8c1e-aaaa-bbbb-cccc-123456789abc"));
        assert!(!session_id_ok("short"));
        assert!(!session_id_ok("a/../../b-123456"));
        assert!(!session_id_ok("x\"});alert(1);//aaaa"));
        assert!(!session_id_ok(&"a".repeat(65)));
    }

    #[test]
    fn prepare_applies_defaults_and_drops_bad_ids() {
        let p = prepare("", "<i>hi</i>", Some("bad id!"));
        assert_eq!(
            p,
            Prepared {
                title: "Prism".into(),
                body: "hi".into(),
                session_id: None
            }
        );
        let p = prepare("T", "b", Some("3f2b8c1e-aaaa-bbbb-cccc-123456789abc"));
        assert_eq!(
            p.session_id.as_deref(),
            Some("3f2b8c1e-aaaa-bbbb-cccc-123456789abc")
        );
    }

    #[test]
    fn rate_limit_and_click_ttl() {
        let s = NotifyState::default();
        let t0 = Instant::now();
        assert!(s.allow(t0));
        assert!(!s.allow(t0 + Duration::from_millis(500)), "too soon");
        assert!(s.allow(t0 + MIN_GAP));

        s.set_pending(Some("abcdefgh".into()), t0);
        assert_eq!(
            s.take_pending(t0 + Duration::from_secs(5)).as_deref(),
            Some("abcdefgh")
        );
        assert_eq!(
            s.take_pending(t0 + Duration::from_secs(6)),
            None,
            "consumed"
        );

        s.set_pending(Some("abcdefgh".into()), t0);
        assert_eq!(
            s.take_pending(t0 + CLICK_TTL + Duration::from_secs(1)),
            None,
            "stale"
        );

        s.set_pending(None, t0);
        assert_eq!(s.take_pending(t0), None);
    }

    #[test]
    fn open_session_js_is_a_dom_event_with_an_escaped_id() {
        let js = open_session_js("abc\"def");
        assert!(js.contains("prism:open-agent-session"));
        assert!(js.contains(r#"sessionId:"abc\"def""#));
        assert!(!js.contains("location"), "never a navigation");
    }
}
