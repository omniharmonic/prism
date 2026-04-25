use std::sync::Arc;
use tokio::sync::watch;
use chrono;
use crate::clients::google::GoogleClient;
use crate::clients::parachute::ParachuteClient;
use crate::models::note::{CreateNoteParams, UpdateNoteParams, ListNotesParams};
use crate::services::ServiceStatus;
use crate::services::person_linker;

const SYNC_INTERVAL_SECS: u64 = 180; // 3 minutes

/// Continuous Gmail → Parachute email sync.
///
/// Every 3 minutes: fetch recent inbox messages via `gog gmail messages search`
/// with `--include-body` → create/update email notes in Parachute tagged `email`
/// → link to person notes for sender.
pub async fn run(
    google: Arc<GoogleClient>,
    parachute: Arc<ParachuteClient>,
    account: String,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<std::sync::Mutex<ServiceStatus>>,
) {
    log::info!("Email sync service starting for account: {}", account);

    // Initial delay — stagger with other services
    tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;

    let mut first_run = true;

    loop {
        if *shutdown.borrow() {
            break;
        }

        {
            let mut s = status.lock().unwrap();
            s.running = true;
        }

        // First run: broader window to backfill bodies for older emails
        let query = if first_run {
            first_run = false;
            "in:inbox newer_than:14d"
        } else {
            "in:inbox newer_than:3h"
        };

        match sync_emails(&google, &parachute, &account, query).await {
            Ok(count) => {
                let mut s = status.lock().unwrap();
                s.last_run = Some(chrono::Utc::now().to_rfc3339());
                s.items_processed += count;
                s.last_error = None;
                if count > 0 {
                    log::info!("Email sync: processed {} messages", count);
                }
            }
            Err(e) => {
                log::warn!("Email sync error: {}", e);
                let mut s = status.lock().unwrap();
                s.last_error = Some(e.to_string());
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(SYNC_INTERVAL_SECS)) => {},
            _ = shutdown.changed() => {
                if *shutdown.borrow() { break; }
            }
        }
    }

    let mut s = status.lock().unwrap();
    s.running = false;
    log::info!("Email sync service stopped");
}

async fn sync_emails(
    google: &GoogleClient,
    parachute: &ParachuteClient,
    account: &str,
    query: &str,
) -> Result<u64, crate::error::PrismError> {
    // Fetch inbox messages — gog returns { "messages": [...], "nextPageToken": ... }
    // Each message has: id, threadId, date, from, subject, labels, body (with --include-body)
    let max_results = if query.contains("14d") { 100 } else { 30 };
    let data = tokio::task::spawn_blocking({
        let google = google.clone();
        let account = account.to_string();
        let query = query.to_string();
        move || google.gmail_list_threads(&account, Some(&query), max_results)
    }).await
        .map_err(|e| crate::error::PrismError::Google(format!("spawn error: {}", e)))??;

    let messages = if let Some(arr) = data.as_array() {
        arr.clone()
    } else {
        data.get("messages")
            .or(data.get("threads"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };

    if messages.is_empty() {
        return Ok(0);
    }

    // Load existing email notes
    let existing_notes = parachute.list_notes(&ListNotesParams {
        tag: Some("email".into()),
        limit: Some(500),
        ..Default::default()
    }).await.unwrap_or_default();

    // Group messages by threadId to create one note per thread
    let mut threads: std::collections::HashMap<String, Vec<&serde_json::Value>> = std::collections::HashMap::new();
    for msg in &messages {
        let thread_id = msg.get("threadId")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| msg.get("id").and_then(|v| v.as_str()).unwrap_or("unknown"));
        threads.entry(thread_id.to_string()).or_default().push(msg);
    }

    let mut processed = 0u64;

    for (thread_id, thread_msgs) in &threads {
        // Use the first (most recent) message for thread metadata
        let first = thread_msgs[0];

        let subject = first.get("subject")
            .and_then(|v| v.as_str())
            .unwrap_or("No Subject");

        let from = first.get("from")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");

        let date = first.get("date")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let labels: Vec<String> = first.get("labels")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let is_unread = labels.iter().any(|l| l == "UNREAD");

        // Build content from all messages in thread (includes body from --include-body)
        let mut content = format!("# {}\n\n", subject);
        for msg in thread_msgs {
            let msg_from = msg.get("from").and_then(|v| v.as_str()).unwrap_or("Unknown");
            let msg_date = msg.get("date").and_then(|v| v.as_str()).unwrap_or("");
            let msg_body = msg.get("body").and_then(|v| v.as_str()).unwrap_or("");

            content.push_str(&format!("**From:** {}  \n**Date:** {}\n\n", msg_from, msg_date));

            if !msg_body.is_empty() {
                // Trim excessive whitespace and limit body length to keep notes manageable
                let trimmed_body = msg_body.trim();
                let body_text = if trimmed_body.len() > 20_000 {
                    format!("{}…\n\n*(truncated)*", &trimmed_body[..20_000])
                } else {
                    trimmed_body.to_string()
                };
                content.push_str(&body_text);
                content.push_str("\n\n");
            }

            content.push_str("---\n\n");
        }

        // Parse date to epoch ms for consistent sorting with message-threads.
        // gog returns dates in three observed shapes:
        //   "2026-04-25 10:41"             (no TZ — naive, gog's default)
        //   "Fri, 25 Apr 2026 10:41:00 ..."(RFC 2822, sometimes from raw headers)
        //   "2026-04-25T10:41:00Z"         (RFC 3339)
        // Try the standards first, then fall back to the naive form parsed
        // as UTC — slight TZ skew is fine since this field is only used for
        // recency sorting at day granularity.
        let last_message_at: i64 = parse_email_date_to_millis(date);

        let metadata = serde_json::json!({
            "type": "email",
            "platform": "email",
            "threadId": thread_id,
            "from": from,
            "subject": subject,
            "date": date,
            "labels": labels,
            "isUnread": is_unread,
            "messageCount": thread_msgs.len(),
            "lastMessageAt": last_message_at,
        });

        // Find existing note for this thread
        let existing = existing_notes.iter().find(|n| {
            n.metadata.as_ref()
                .and_then(|m| m.get("threadId"))
                .and_then(|v| v.as_str())
                == Some(thread_id)
        });

        let note_id = if let Some(note) = existing {
            parachute.update_note(&note.id, &UpdateNoteParams {
                content: Some(content),
                path: None,
                metadata: Some(metadata),
            }).await?;
            note.id.clone()
        } else {
            let slug = sanitize_path(subject);
            // Append short thread ID suffix to avoid path collisions on recurring subjects
            let tid_suffix = if thread_id.len() > 6 { &thread_id[thread_id.len()-6..] } else { thread_id.as_str() };
            let path = format!("vault/messages/email/{}-{}", slug, tid_suffix);
            let note = match parachute.create_note(&CreateNoteParams {
                content: content.clone(),
                path: Some(path),
                metadata: Some(metadata.clone()),
                tags: Some(vec!["email".into()]),
            }).await {
                Ok(n) => n,
                Err(e) => {
                    log::warn!("Email create_note failed for '{}': {} — skipping", subject, e);
                    continue;
                }
            };
            note.id
        };

        // Link to sender person note
        let from_name = extract_display_name(from);
        let from_email = extract_email_address(from);
        if !from_name.is_empty() {
            if let Ok(person_id) = person_linker::find_or_create_person(
                parachute, &from_name, Some(&from_email), None, Some("email"),
            ).await {
                let _ = person_linker::link_to_person(
                    parachute, &note_id, &person_id, "email-from",
                ).await;
            }
        }

        processed += 1;
    }

    Ok(processed)
}

fn extract_email_address(s: &str) -> String {
    if let Some(start) = s.find('<') {
        if let Some(end) = s.find('>') {
            return s[start + 1..end].to_string();
        }
    }
    s.trim().to_string()
}

fn extract_display_name(s: &str) -> String {
    if let Some(start) = s.find('<') {
        let name = s[..start].trim().trim_matches('"');
        if !name.is_empty() {
            return name.to_string();
        }
    }
    let email = s.trim();
    if email.contains('@') {
        email.split('@').next().unwrap_or("").to_string()
    } else {
        email.to_string()
    }
}

fn sanitize_path(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .replace(' ', "-")
        .to_lowercase()
}

/// Parse the email-date string `gog` returns and convert to epoch milliseconds.
/// Returns 0 only when no known format matches.
fn parse_email_date_to_millis(date: &str) -> i64 {
    let s = date.trim();
    if s.is_empty() {
        return 0;
    }

    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(s) {
        return dt.timestamp_millis();
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return dt.timestamp_millis();
    }

    // gog's default shape is naive: "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM:SS"
    let naive_formats = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"];
    for fmt in naive_formats {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            // Treat as UTC — TZ skew of a few hours is acceptable for
            // recency-sorting at day granularity.
            return naive.and_utc().timestamp_millis();
        }
    }

    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc3339() {
        let ms = parse_email_date_to_millis("2026-04-25T17:24:10Z");
        assert!(ms > 1_700_000_000_000);
    }

    #[test]
    fn parses_rfc2822() {
        let ms = parse_email_date_to_millis("Sat, 25 Apr 2026 17:24:10 +0000");
        assert!(ms > 1_700_000_000_000);
    }

    #[test]
    fn parses_gog_naive_minute() {
        // The format gog has been emitting that previously fell back to 0.
        let ms = parse_email_date_to_millis("2026-04-25 10:41");
        // Cross-checked against `chrono::NaiveDate::from_ymd_opt(2026,4,25)
        // .unwrap().and_hms_opt(10,41,0).unwrap().and_utc().timestamp_millis()`
        assert_eq!(ms, 1_777_113_660_000);
    }

    #[test]
    fn parses_gog_naive_second() {
        let ms = parse_email_date_to_millis("2026-04-25 10:41:30");
        assert_eq!(ms, 1_777_113_690_000);
    }

    #[test]
    fn empty_or_garbage_returns_zero() {
        assert_eq!(parse_email_date_to_millis(""), 0);
        assert_eq!(parse_email_date_to_millis("not a date"), 0);
    }
}
