use tauri::State;
use crate::clients::google::{GoogleClient, build_raw_email};
use crate::error::PrismError;
use crate::models::email::*;
use crate::models::event::*;

// ─── Gmail Commands ──────────────────────────────────────────

#[tauri::command]
pub async fn gmail_list_threads(
    client: State<'_, GoogleClient>,
    account: String,
    query: Option<String>,
    max_results: Option<u32>,
    page_token: Option<String>,
) -> Result<GmailThreadList, PrismError> {
    let data = client
        .gmail_list_threads(&account, query.as_deref(), max_results.unwrap_or(20), page_token.as_deref())
        .await?;

    // Parse the thread list response into our model
    let threads = data["threads"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    Some(GmailThreadSummary {
                        id: t["id"].as_str()?.to_string(),
                        subject: t["snippet"].as_str().unwrap_or("").to_string(),
                        snippet: t["snippet"].as_str().unwrap_or("").to_string(),
                        from: String::new(),
                        from_name: None,
                        date: String::new(),
                        unread: false,
                        message_count: 0,
                        labels: vec![],
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(GmailThreadList {
        threads,
        next_page_token: data["nextPageToken"].as_str().map(String::from),
        result_size_estimate: data["resultSizeEstimate"].as_u64().unwrap_or(0) as u32,
    })
}

#[tauri::command]
pub async fn gmail_get_thread(
    client: State<'_, GoogleClient>,
    account: String,
    thread_id: String,
) -> Result<GmailThread, PrismError> {
    let data = client.gmail_get_thread(&account, &thread_id).await?;

    let messages: Vec<GmailMessage> = data["messages"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| parse_gmail_message(m))
                .collect()
        })
        .unwrap_or_default();

    let subject = messages.first().map(|m| m.subject.clone()).unwrap_or_default();
    let snippet = data["snippet"].as_str().unwrap_or("").to_string();
    let labels: Vec<String> = messages
        .first()
        .map(|_| {
            data["messages"][0]["labelIds"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let unread = labels.contains(&"UNREAD".to_string());

    Ok(GmailThread {
        id: thread_id,
        subject,
        snippet,
        messages,
        unread,
        labels,
    })
}

fn parse_gmail_message(msg: &serde_json::Value) -> Option<GmailMessage> {
    let headers = msg["payload"]["headers"].as_array()?;
    let get_header = |name: &str| -> String {
        headers
            .iter()
            .find(|h| h["name"].as_str() == Some(name))
            .and_then(|h| h["value"].as_str())
            .unwrap_or("")
            .to_string()
    };

    let from = get_header("From");
    let from_name = if from.contains('<') {
        Some(from.split('<').next().unwrap_or("").trim().trim_matches('"').to_string())
    } else {
        None
    };

    // Extract plain text body from parts or direct body
    let body = extract_body(&msg["payload"]);

    let label_ids: Vec<String> = msg["labelIds"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    Some(GmailMessage {
        id: msg["id"].as_str()?.to_string(),
        thread_id: msg["threadId"].as_str()?.to_string(),
        from: from.clone(),
        from_name,
        to: vec![get_header("To")],
        cc: {
            let cc = get_header("Cc");
            if cc.is_empty() { None } else { Some(vec![cc]) }
        },
        subject: get_header("Subject"),
        body,
        date: get_header("Date"),
        is_unread: label_ids.contains(&"UNREAD".to_string()),
        in_reply_to: {
            let rt = get_header("In-Reply-To");
            if rt.is_empty() { None } else { Some(rt) }
        },
    })
}

fn extract_body(payload: &serde_json::Value) -> String {
    // Try direct body.data first
    if let Some(data) = payload["body"]["data"].as_str() {
        return decode_base64url(data);
    }

    // Try parts (multipart messages)
    if let Some(parts) = payload["parts"].as_array() {
        // Prefer text/plain
        for part in parts {
            if part["mimeType"].as_str() == Some("text/plain") {
                if let Some(data) = part["body"]["data"].as_str() {
                    return decode_base64url(data);
                }
            }
        }
        // Fallback to first part with body data
        for part in parts {
            if let Some(data) = part["body"]["data"].as_str() {
                return decode_base64url(data);
            }
            // Recurse into nested parts
            let nested = extract_body(part);
            if !nested.is_empty() {
                return nested;
            }
        }
    }

    String::new()
}

fn decode_base64url(data: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(data)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn gmail_send(
    client: State<'_, GoogleClient>,
    account: String,
    to: Vec<String>,
    cc: Option<Vec<String>>,
    subject: String,
    body: String,
    in_reply_to: Option<String>,
) -> Result<String, PrismError> {
    let raw = build_raw_email(
        &account,
        &to,
        &cc.unwrap_or_default(),
        &subject,
        &body,
        in_reply_to.as_deref(),
    );

    let result = client.gmail_send(&account, &raw).await?;
    Ok(result["id"].as_str().unwrap_or("").to_string())
}

#[tauri::command]
pub async fn gmail_archive(
    client: State<'_, GoogleClient>,
    account: String,
    thread_id: String,
) -> Result<(), PrismError> {
    client.gmail_archive(&account, &thread_id).await
}

#[tauri::command]
pub async fn gmail_label(
    client: State<'_, GoogleClient>,
    account: String,
    thread_id: String,
    add_labels: Vec<String>,
    remove_labels: Vec<String>,
) -> Result<(), PrismError> {
    client.gmail_label(&account, &thread_id, &add_labels, &remove_labels).await
}

// ─── Calendar Commands ───────────────────────────────────

#[tauri::command]
pub async fn calendar_list_events(
    client: State<'_, GoogleClient>,
    from: String,
    to: String,
    calendar_id: Option<String>,
) -> Result<Vec<CalendarEvent>, PrismError> {
    let cal_id = calendar_id.as_deref().unwrap_or("primary");
    // Use first configured account for calendar
    let account = "benjamin@opencivics.co";

    let data = client.calendar_list_events(account, &from, &to, cal_id).await?;

    let events = data["items"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|e| parse_calendar_event(e, cal_id)).collect())
        .unwrap_or_default();

    Ok(events)
}

#[tauri::command]
pub async fn calendar_create_event(
    client: State<'_, GoogleClient>,
    summary: String,
    start: String,
    end: String,
    attendees: Option<Vec<String>>,
    description: Option<String>,
    location: Option<String>,
    with_meet: Option<bool>,
) -> Result<CalendarEvent, PrismError> {
    let account = "benjamin@opencivics.co";
    let cal_id = "primary";

    let mut event = serde_json::json!({
        "summary": summary,
        "start": { "dateTime": start },
        "end": { "dateTime": end },
    });

    if let Some(desc) = description {
        event["description"] = serde_json::json!(desc);
    }
    if let Some(loc) = location {
        event["location"] = serde_json::json!(loc);
    }
    if let Some(att) = attendees {
        event["attendees"] = serde_json::json!(
            att.iter().map(|e| serde_json::json!({"email": e})).collect::<Vec<_>>()
        );
    }
    if with_meet.unwrap_or(true) {
        event["conferenceData"] = serde_json::json!({
            "createRequest": {
                "requestId": uuid::Uuid::new_v4().to_string(),
                "conferenceSolutionKey": { "type": "hangoutsMeet" }
            }
        });
    }

    let data = client.calendar_create_event(account, cal_id, &event).await?;
    parse_calendar_event(&data, cal_id)
        .ok_or_else(|| PrismError::Google("Failed to parse created event".into()))
}

#[tauri::command]
pub async fn calendar_update_event(
    client: State<'_, GoogleClient>,
    event_id: String,
    summary: Option<String>,
    start: Option<String>,
    end: Option<String>,
    attendees: Option<Vec<String>>,
    description: Option<String>,
) -> Result<CalendarEvent, PrismError> {
    let account = "benjamin@opencivics.co";
    let cal_id = "primary";

    let mut event = serde_json::json!({});
    if let Some(s) = summary { event["summary"] = serde_json::json!(s); }
    if let Some(s) = start { event["start"] = serde_json::json!({"dateTime": s}); }
    if let Some(e) = end { event["end"] = serde_json::json!({"dateTime": e}); }
    if let Some(d) = description { event["description"] = serde_json::json!(d); }
    if let Some(att) = attendees {
        event["attendees"] = serde_json::json!(
            att.iter().map(|e| serde_json::json!({"email": e})).collect::<Vec<_>>()
        );
    }

    let data = client.calendar_update_event(account, cal_id, &event_id, &event).await?;
    parse_calendar_event(&data, cal_id)
        .ok_or_else(|| PrismError::Google("Failed to parse updated event".into()))
}

#[tauri::command]
pub async fn calendar_delete_event(
    client: State<'_, GoogleClient>,
    event_id: String,
) -> Result<(), PrismError> {
    let account = "benjamin@opencivics.co";
    client.calendar_delete_event(account, "primary", &event_id).await
}

fn parse_calendar_event(e: &serde_json::Value, cal_id: &str) -> Option<CalendarEvent> {
    Some(CalendarEvent {
        id: e["id"].as_str()?.to_string(),
        summary: e["summary"].as_str().unwrap_or("(No title)").to_string(),
        description: e["description"].as_str().map(String::from),
        start: EventTime {
            date_time: e["start"]["dateTime"].as_str().map(String::from),
            date: e["start"]["date"].as_str().map(String::from),
            time_zone: e["start"]["timeZone"].as_str().map(String::from),
        },
        end: EventTime {
            date_time: e["end"]["dateTime"].as_str().map(String::from),
            date: e["end"]["date"].as_str().map(String::from),
            time_zone: e["end"]["timeZone"].as_str().map(String::from),
        },
        location: e["location"].as_str().map(String::from),
        attendees: e["attendees"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| {
                        Some(EventAttendee {
                            email: a["email"].as_str()?.to_string(),
                            display_name: a["displayName"].as_str().map(String::from),
                            response_status: a["responseStatus"].as_str().map(String::from),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        meet_url: e["hangoutLink"].as_str().map(String::from),
        calendar_id: cal_id.to_string(),
        status: e["status"].as_str().unwrap_or("confirmed").to_string(),
        html_link: e["htmlLink"].as_str().map(String::from),
    })
}
