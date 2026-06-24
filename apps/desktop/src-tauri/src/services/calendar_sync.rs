use std::sync::Arc;
use tokio::sync::watch;
use crate::clients::google::GoogleClient;
use crate::clients::parachute::ParachuteClient;
use crate::models::note::{CreateNoteParams, UpdateNoteParams};
use crate::services::ServiceStatus;
use crate::services::person_linker;

const SYNC_INTERVAL_SECS: u64 = 300; // 5 minutes

/// Continuous Google Calendar → Parachute sync.
pub async fn run(
    google: Arc<GoogleClient>,
    parachute: Arc<ParachuteClient>,
    account: String,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<std::sync::Mutex<ServiceStatus>>,
) {
    log::info!("Calendar sync service starting for account: {}", account);

    {
        let mut s = status.lock().unwrap();
        s.running = true;
    }

    // Initial delay
    tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;

    loop {
        if *shutdown.borrow() {
            break;
        }

        match sync_upcoming(&google, &parachute, &account).await {
            Ok(count) => {
                let mut s = status.lock().unwrap();
                s.last_run = Some(chrono::Utc::now().to_rfc3339());
                s.items_processed += count;
                s.last_error = None;
            }
            Err(e) => {
                log::warn!("Calendar sync error: {}", e);
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
    log::info!("Calendar sync service stopped");
}

/// Sync a rolling window of events (background service uses this).
///
/// We pull a fixed time range — a few days back through ~one month ahead —
/// rather than "the next N events", so the vault always holds a predictable
/// month of calendar coverage regardless of how densely the days are booked.
/// This is what makes the web app's vault-backed calendar render a full month.
async fn sync_upcoming(
    google: &GoogleClient,
    parachute: &ParachuteClient,
    account: &str,
) -> Result<u64, crate::error::PrismError> {
    let now = chrono::Utc::now();
    let from = (now - chrono::Duration::days(3)).format("%Y-%m-%d").to_string();
    let to = (now + chrono::Duration::days(31)).format("%Y-%m-%d").to_string();

    let events_data = tokio::task::spawn_blocking({
        let google = google.clone();
        let account = account.to_string();
        let from = from.clone();
        let to = to.clone();
        move || google.calendar_list_events_range(&account, &from, &to, 250)
    }).await
        .map_err(|e| crate::error::PrismError::Google(format!("spawn error: {}", e)))??;

    let processed = sync_events_data(parachute, &events_data).await?;

    // Propagate deletions: events removed from Google must disappear from the
    // vault too, or the (now vault-backed) calendar shows ghosts of meetings
    // that no longer exist.
    if let Err(e) = reconcile_deletions(parachute, &events_data, &from, &to, 250).await {
        log::warn!("Calendar reconcile error: {}", e);
    }

    Ok(processed)
}

/// Sync a single event into Parachute. Called by both the background service
/// and the on-demand `calendar_sync_range` command.
pub async fn sync_single_event(
    parachute: &ParachuteClient,
    event: &serde_json::Value,
) -> Result<(), crate::error::PrismError> {
    let event_id = event.get("id").and_then(|v| v.as_str())
        .ok_or_else(|| crate::error::PrismError::Google("Event missing id".into()))?;

    let summary = event.get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled Event");

    let description = event.get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let location = event.get("location")
        .and_then(|v| v.as_str());

    let start = event.get("start")
        .and_then(|s| s.get("dateTime").or(s.get("date")))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let end = event.get("end")
        .and_then(|s| s.get("dateTime").or(s.get("date")))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let attendees: Vec<String> = event.get("attendees")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter().filter_map(|a| {
                a.get("displayName").or(a.get("email"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
            }).collect()
        })
        .unwrap_or_default();

    let attendee_emails: Vec<String> = event.get("attendees")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter().filter_map(|a| {
                a.get("email").and_then(|v| v.as_str()).map(String::from)
            }).collect()
        })
        .unwrap_or_default();

    let meet_url = event.get("hangoutLink")
        .and_then(|v| v.as_str())
        .or_else(|| event.get("conferenceData")
            .and_then(|c| c.get("entryPoints"))
            .and_then(|e| e.as_array())
            .and_then(|arr| arr.first())
            .and_then(|e| e.get("uri"))
            .and_then(|v| v.as_str()));

    let html_link = event.get("htmlLink")
        .and_then(|v| v.as_str());

    let status_str = event.get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("confirmed");

    let date_part = if start.len() >= 10 { &start[..10] } else { "unknown" };
    let slug = sanitize_path(summary);
    let path = format!("vault/meetings/{}/{}", date_part, slug);

    let metadata = serde_json::json!({
        "type": "meeting",
        "title": summary,
        "calendarEventId": event_id,
        "date": date_part,
        "start": start,
        "end": end,
        "attendees": attendees,
        "location": location,
        "meetLink": meet_url,
        "htmlLink": html_link,
        // The `meeting` schema's `status` is a processing-state enum
        // {raw,cleaned,processed} — NOT the calendar event's lifecycle. Writing
        // Google's "confirmed"/"cancelled" there violated the enum, so the
        // calendar status now lives in its own `event_status` field and `status`
        // is left for the processing pipeline to own.
        "event_status": status_str,
    });

    // Check if note already exists for this event (by calendarEventId or path)
    let existing = find_meeting_note(parachute, event_id, &path).await?;

    let note_id = if let Some(note) = existing {
        parachute.update_note(&note.id, &UpdateNoteParams {
            content: None, // Don't overwrite user's meeting notes
            path: None,
            metadata: Some(metadata),
            ..Default::default()
        }).await?;
        note.id
    } else {
        let mut content = format!("# {}\n\n", summary);
        content.push_str(&format!("**Date:** {}\n", date_part));
        content.push_str(&format!("**Time:** {} — {}\n", start, end));
        if let Some(loc) = location {
            content.push_str(&format!("**Location:** {}\n", loc));
        }
        if let Some(meet) = meet_url {
            content.push_str(&format!("**Meet:** {}\n", meet));
        }
        if !attendees.is_empty() {
            content.push_str(&format!("**Attendees:** {}\n", attendees.join(", ")));
        }
        if !description.is_empty() {
            content.push_str(&format!("\n---\n\n{}\n", description));
        }
        content.push_str("\n---\n\n## Meeting Notes\n\n");

        match parachute.create_note(&CreateNoteParams {
            content,
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["meeting".into()]),
        }).await {
            Ok(note) => note.id,
            Err(e) => {
                log::debug!("Calendar sync: create failed for '{}': {}", summary, e);
                return Err(e);
            }
        }
    };

    // Link to attendee person notes
    for (i, name) in attendees.iter().enumerate() {
        let email = attendee_emails.get(i).map(|s| s.as_str());
        if let Ok(person_id) = person_linker::find_or_create_person(
            parachute, name, email, None, None,
        ).await {
            let _ = person_linker::link_to_person(
                parachute, &note_id, &person_id, "attended-by",
            ).await;
        }
    }

    // Check for existing unlinked transcripts matching this meeting
    link_meeting_to_transcripts(parachute, &note_id, summary, date_part, &attendees).await;

    Ok(())
}

/// Parse events from gog response and sync each one.
async fn sync_events_data(
    parachute: &ParachuteClient,
    events_data: &serde_json::Value,
) -> Result<u64, crate::error::PrismError> {
    let empty_arr = vec![];
    let events = if let Some(arr) = events_data.as_array() {
        arr
    } else {
        events_data.get("events")
            .or_else(|| events_data.get("items"))
            .and_then(|v| v.as_array())
            .unwrap_or(&empty_arr)
    };

    let mut processed = 0u64;
    for event in events {
        match sync_single_event(parachute, event).await {
            Ok(_) => processed += 1,
            Err(e) => {
                log::debug!("Calendar sync: event error: {}", e);
            }
        }
    }

    Ok(processed)
}

/// Propagate Google Calendar deletions into the vault.
///
/// `gog calendar list` returns no deleted events (it has no `--show-deleted`),
/// so an event removed from Google simply stops appearing — and the meeting note
/// a prior sync created lingers forever. After syncing the window `[from, to]`
/// (YYYY-MM-DD), this finds calendar-synced notes in that window whose
/// `calendarEventId` was NOT in Google's response and reconciles them:
///   - template-only notes (no transcript link, nothing the user wrote) are
///     hard-deleted;
///   - notes carrying real content are soft-cancelled (`event_status:
///     "cancelled"`, hidden on the calendar) so no user content is ever lost.
///
/// Only touches notes with a `calendarEventId` — hand-made meeting notes are
/// never reconciled. Returns `(deleted, cancelled)`.
pub async fn reconcile_deletions(
    parachute: &ParachuteClient,
    events_data: &serde_json::Value,
    from: &str,
    to: &str,
    max_results: usize,
) -> Result<(u64, u64), crate::error::PrismError> {
    let empty_arr = vec![];
    let events = if let Some(arr) = events_data.as_array() {
        arr
    } else {
        events_data.get("events")
            .or_else(|| events_data.get("items"))
            .and_then(|v| v.as_array())
            .unwrap_or(&empty_arr)
    };

    // Truncation guard: a full page means we can't distinguish "deleted" from
    // "didn't fit in the response" — skip the deletion pass rather than risk
    // mass false-positives.
    if events.len() >= max_results {
        log::warn!(
            "Calendar reconcile: {} events == max {}, response may be truncated; skipping deletion pass for {}..{}",
            events.len(), max_results, from, to
        );
        return Ok((0, 0));
    }

    let seen: std::collections::HashSet<&str> = events.iter()
        .filter_map(|e| e.get("id").and_then(|v| v.as_str()))
        .collect();

    let meetings = parachute.list_all_by_tag("meeting").await.unwrap_or_default();

    let mut deleted = 0u64;
    let mut cancelled = 0u64;

    for note in &meetings {
        let meta = match &note.metadata {
            Some(m) => m,
            None => continue,
        };

        // Only reconcile calendar-synced notes; never hand-made meeting notes.
        let event_id = match meta.get("calendarEventId").and_then(|v| v.as_str()) {
            Some(id) if !id.is_empty() => id,
            _ => continue,
        };

        // Already cancelled — leave it.
        if meta.get("event_status").and_then(|v| v.as_str()) == Some("cancelled") {
            continue;
        }

        // Scope to the queried window (ISO YYYY-MM-DD sorts lexicographically).
        let date_part = meta.get("date").and_then(|v| v.as_str())
            .or_else(|| meta.get("start").and_then(|v| v.as_str())
                .map(|s| if s.len() >= 10 { &s[..10] } else { s }))
            .unwrap_or("");
        if date_part.is_empty() || date_part < from || date_part > to {
            continue;
        }

        // Still on the calendar → keep.
        if seen.contains(event_id) {
            continue;
        }

        // Orphan. A linked transcript always counts as real content.
        let has_transcript = meta.get("transcriptNoteId").and_then(|v| v.as_str())
            .map_or(false, |s| !s.is_empty());

        let template_only = if has_transcript {
            false
        } else {
            // list_all_by_tag omits content; fetch just this orphan to classify.
            match parachute.get_note(&note.id).await {
                Ok(full) => is_template_only(&full.content),
                Err(_) => false, // can't confirm it's empty → don't delete
            }
        };

        if template_only {
            match parachute.delete_note(&note.id).await {
                Ok(_) => {
                    deleted += 1;
                    log::info!("Calendar reconcile: deleted orphaned meeting note {} ({})", note.id, date_part);
                }
                Err(e) => log::debug!("Calendar reconcile: delete failed for {}: {}", note.id, e),
            }
        } else {
            // Soft-cancel (metadata updates merge, so a partial is enough). The
            // note + its transcript link / user notes are preserved; the calendar
            // hides it via the event_status filter.
            match parachute.update_note(&note.id, &UpdateNoteParams {
                content: None,
                path: None,
                metadata: Some(serde_json::json!({ "event_status": "cancelled" })),
                ..Default::default()
            }).await {
                Ok(_) => {
                    cancelled += 1;
                    log::info!("Calendar reconcile: cancelled orphaned meeting note {} ({})", note.id, date_part);
                }
                Err(e) => log::debug!("Calendar reconcile: cancel failed for {}: {}", note.id, e),
            }
        }
    }

    if deleted > 0 || cancelled > 0 {
        log::info!("Calendar reconcile {}..{}: {} deleted, {} cancelled", from, to, deleted, cancelled);
    }
    Ok((deleted, cancelled))
}

/// True when a meeting note holds only the auto-generated template body — i.e.
/// the user wrote nothing under the "Meeting Notes" heading — so it's safe to
/// hard-delete. If the marker is absent (content was transformed in a way we
/// don't recognize) we conservatively return false and let the caller cancel
/// instead of delete.
fn is_template_only(content: &str) -> bool {
    match content.rsplit_once("Meeting Notes") {
        Some((_, tail)) => strip_markup(tail).is_empty(),
        None => false,
    }
}

/// Reduce a fragment to its alphanumeric characters (dropping HTML tags, the
/// template's `---` separators, and whitespace) so we can tell whether the user
/// actually typed anything.
fn strip_markup(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if in_tag => {}
            _ if c.is_alphanumeric() => out.push(c),
            _ => {}
        }
    }
    out
}

/// Find an existing meeting note by calendarEventId or path.
async fn find_meeting_note(
    parachute: &ParachuteClient,
    event_id: &str,
    path: &str,
) -> Result<Option<crate::models::note::Note>, crate::error::PrismError> {
    // Google event IDs are long opaque strings that never appear in note
    // content, so the prior full-text `search(event_id)` almost always returned
    // nothing. List meeting notes and match on the stored metadata/path instead.
    let meetings = parachute.list_all_by_tag("meeting").await.unwrap_or_default();

    // Prefer an exact calendarEventId match, fall back to an exact path match.
    let by_event_id = meetings.iter().find(|n| {
        n.metadata.as_ref()
            .and_then(|m| m.get("calendarEventId"))
            .and_then(|v| v.as_str())
            == Some(event_id)
    });
    if let Some(note) = by_event_id {
        return Ok(Some(note.clone()));
    }

    let by_path = meetings.into_iter().find(|n| n.path.as_deref() == Some(path));
    Ok(by_path)
}

/// When a meeting note is created/updated, check for existing transcript notes
/// that match and create links if not already linked.
async fn link_meeting_to_transcripts(
    parachute: &ParachuteClient,
    meeting_note_id: &str,
    meeting_title: &str,
    meeting_date: &str,
    meeting_attendees: &[String],
) {
    // Check if already linked
    if let Ok(links) = parachute.get_links(&crate::models::link::GetLinksParams {
        note_id: Some(meeting_note_id.to_string()),
        relationship: Some("has-transcript".into()),
    }).await {
        if !links.is_empty() {
            return; // Already has a transcript link
        }
    }

    // List ALL transcript notes and match on metadata.date (the prior full-text
    // search on the date string ranked by content relevance and capped at 20,
    // so the real same-day transcript could rank out or a wrong note rank in).
    let transcripts = parachute.list_all_by_tag("transcript").await.unwrap_or_default();

    if transcripts.is_empty() {
        return;
    }

    let norm_meeting_attendees: Vec<String> = meeting_attendees.iter()
        .map(|a| normalize_attendee(a))
        .filter(|a| !a.is_empty())
        .collect();

    let meeting_words = significant_words(meeting_title);

    for transcript in &transcripts {
        let meta = match &transcript.metadata {
            Some(m) => m,
            None => continue,
        };

        // Check date match
        let transcript_date = meta.get("date").and_then(|v| v.as_str()).unwrap_or("");
        if transcript_date != meeting_date {
            // Allow ±1 day for timezone differences
            let parse = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
            match (parse(meeting_date), parse(transcript_date)) {
                (Some(md), Some(td)) if (md - td).num_days().unsigned_abs() <= 1 => {},
                _ => continue,
            }
        }

        // Check if this transcript is already linked to any meeting
        if meta.get("meetingNoteId").and_then(|v| v.as_str()).is_some() {
            continue;
        }

        let mut score: u32 = 1; // Base score for date match

        // Attendee overlap
        let transcript_attendees: Vec<String> = meta.get("attendees")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|a| a.as_str().map(|s| normalize_attendee(s))).collect())
            .unwrap_or_default();

        for ma in &norm_meeting_attendees {
            for ta in &transcript_attendees {
                if ma == ta || ma.contains(ta) || ta.contains(ma) {
                    score += 3;
                }
            }
        }

        // Title overlap
        let transcript_title = meta.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let transcript_words = significant_words(transcript_title);
        for mw in &meeting_words {
            if transcript_words.contains(mw) {
                score += 1;
            }
        }

        if score >= 2 {
            log::info!(
                "Calendar sync: linking meeting '{}' → transcript '{}' (score: {})",
                meeting_title,
                transcript.path.as_deref().unwrap_or(&transcript.id),
                score
            );

            let _ = parachute.create_link(&crate::models::link::CreateLinkParams {
                source_id: meeting_note_id.to_string(),
                target_id: transcript.id.clone(),
                relationship: "has-transcript".into(),
                metadata: None,
            }).await;

            // Update meeting metadata
            let _ = parachute.update_note(meeting_note_id, &UpdateNoteParams {
                content: None,
                path: None,
                metadata: Some(serde_json::json!({ "transcriptNoteId": transcript.id })),
                ..Default::default()
            }).await;

            // Update transcript metadata
            let _ = parachute.update_note(&transcript.id, &UpdateNoteParams {
                content: None,
                path: None,
                metadata: Some(serde_json::json!({ "meetingNoteId": meeting_note_id })),
                ..Default::default()
            }).await;

            break; // Link to best/first match only
        }
    }
}

fn normalize_attendee(name: &str) -> String {
    let s = name.trim().to_lowercase();
    if let Some(at_pos) = s.find('@') {
        return s[..at_pos].replace('.', " ").replace('_', " ").replace('-', " ");
    }
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn significant_words(title: &str) -> Vec<String> {
    let skip = ["meeting", "call", "sync", "the", "and", "with", "for", "a", "an", "of", "in", "on", "at", "to"];
    title.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 2 && !skip.contains(w))
        .map(String::from)
        .collect()
}

fn sanitize_path(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .replace(' ', "-")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn significant_words_drops_filler_and_short_tokens() {
        let w = significant_words("Meeting: Q2 Roadmap Review with Acme");
        assert!(w.contains(&"roadmap".to_string()));
        assert!(w.contains(&"review".to_string()));
        assert!(w.contains(&"acme".to_string()));
        assert!(!w.contains(&"meeting".to_string())); // filler
        assert!(!w.contains(&"with".to_string()));    // filler
        assert!(!w.contains(&"q2".to_string()));      // len <= 2
    }

    #[test]
    fn normalize_attendee_handles_emails_and_display_names() {
        assert_eq!(normalize_attendee("Alice Smith"), "alice smith");
        assert_eq!(normalize_attendee("alice.smith@example.com"), "alice smith");
        // Display name with punctuation collapses to clean tokens.
        assert_eq!(normalize_attendee("O'Brien, Pat"), "o brien pat");
    }

    #[test]
    fn sanitize_path_is_slug_safe() {
        assert_eq!(sanitize_path("Q2 Roadmap: Review!"), "q2-roadmap--review-");
        assert!(!sanitize_path("a/b\\c").contains('/'));
    }
}
