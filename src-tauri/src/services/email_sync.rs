use std::sync::Arc;
use tokio::sync::watch;
use crate::clients::google::GoogleClient;
use crate::clients::parachute::ParachuteClient;
use crate::models::note::{CreateNoteParams, UpdateNoteParams, ListNotesParams};
use crate::services::ServiceStatus;
use crate::services::person_linker;

const SYNC_INTERVAL_SECS: u64 = 180; // 3 minutes

/// Continuous Gmail → Parachute email sync.
///
/// Every 3 minutes: fetch recent inbox messages via `gog gmail messages search`
/// → create/update email notes in Parachute tagged `email`
/// → link to person notes for sender.
///
/// Note: gog's search returns summary data (from, subject, date, labels)
/// but not full message bodies. This gives us enough for triage and linking.
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

    loop {
        if *shutdown.borrow() {
            break;
        }

        {
            let mut s = status.lock().unwrap();
            s.running = true;
        }

        match sync_emails(&google, &parachute, &account).await {
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
) -> Result<u64, crate::error::PrismError> {
    // Fetch recent inbox messages — gog returns { "messages": [...], "nextPageToken": ... }
    // Each message has: id, threadId, date, from, subject, labels
    let data = tokio::task::spawn_blocking({
        let google = google.clone();
        let account = account.to_string();
        move || google.gmail_list_threads(&account, Some("in:inbox newer_than:3h"), 30)
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
        path: None,
        limit: Some(500),
        offset: None,
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

        // Build content from all messages in thread
        let mut content = format!("# {}\n\n", subject);
        for msg in thread_msgs {
            let msg_from = msg.get("from").and_then(|v| v.as_str()).unwrap_or("Unknown");
            let msg_date = msg.get("date").and_then(|v| v.as_str()).unwrap_or("");
            content.push_str(&format!("**From:** {}  \n**Date:** {}\n\n---\n\n", msg_from, msg_date));
        }

        let metadata = serde_json::json!({
            "type": "email",
            "threadId": thread_id,
            "from": from,
            "subject": subject,
            "date": date,
            "labels": labels,
            "isUnread": is_unread,
            "messageCount": thread_msgs.len(),
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
            let path = format!("vault/messages/email/{}", slug);
            let note = parachute.create_note(&CreateNoteParams {
                content,
                path: Some(path),
                metadata: Some(metadata),
                tags: Some(vec!["email".into()]),
            }).await?;
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
