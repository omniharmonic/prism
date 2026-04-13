use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::{CreateNoteParams, Note};
use crate::models::link::CreateLinkParams;

/// Find a person note by display name, email, or Matrix user ID.
/// Returns the note ID if found, None otherwise.
pub async fn find_person(
    parachute: &ParachuteClient,
    name: Option<&str>,
    email: Option<&str>,
    matrix_id: Option<&str>,
) -> Result<Option<Note>, PrismError> {
    // Strategy 1: Search by name in person-tagged notes
    if let Some(name) = name {
        let clean = clean_display_name(name);
        if !clean.is_empty() {
            let results = parachute.search(&clean, &["person".into()], 10).await?;
            if let Some(note) = results.into_iter().find(|n| {
                person_name_matches(n, &clean)
            }) {
                return Ok(Some(note));
            }
        }
    }

    // Strategy 2: Search by email in person metadata
    if let Some(email) = email {
        let results = parachute.search(email, &["person".into()], 10).await?;
        if let Some(note) = results.into_iter().find(|n| {
            note_metadata_contains(n, "email", email)
                || note_metadata_contains(n, "channels.email", email)
        }) {
            return Ok(Some(note));
        }
    }

    // Strategy 3: Search by Matrix user ID in metadata
    if let Some(mid) = matrix_id {
        let results = parachute.search(mid, &["person".into()], 10).await?;
        if let Some(note) = results.into_iter().find(|n| {
            note_metadata_contains(n, "matrix", mid)
                || note_metadata_contains(n, "matrixRoomIds", mid)
        }) {
            return Ok(Some(note));
        }
    }

    Ok(None)
}

/// Find or create a person note. Returns the person note ID.
pub async fn find_or_create_person(
    parachute: &ParachuteClient,
    name: &str,
    email: Option<&str>,
    matrix_id: Option<&str>,
    platform: Option<&str>,
) -> Result<String, PrismError> {
    let clean = clean_display_name(name);
    if clean.is_empty() || clean.len() < 3 {
        return Err(PrismError::Other("Name too short to create person note".into()));
    }
    // Skip phone numbers, numeric IDs, and obviously non-name strings
    let digits: usize = clean.chars().filter(|c| c.is_ascii_digit()).count();
    if digits as f32 / clean.len() as f32 > 0.5 {
        return Err(PrismError::Other("Name looks like a phone number or ID".into()));
    }
    // Skip email-only names
    if clean.contains('@') && !clean.contains(' ') {
        return Err(PrismError::Other("Name is an email address, not a person name".into()));
    }

    // Try to find existing
    if let Some(note) = find_person(parachute, Some(name), email, matrix_id).await? {
        return Ok(note.id);
    }

    // Double-check by path before creating to prevent Parachute 500 on duplicate path
    let path = format!("vault/people/{}", sanitize_path(&clean));
    let path_check = parachute.search(&clean, &["person".into()], 20).await.unwrap_or_default();
    if let Some(note) = path_check.into_iter().find(|n| {
        n.path.as_deref().map(|p| normalize_name(p.split('/').last().unwrap_or("")))
            == Some(normalize_name(&clean))
    }) {
        return Ok(note.id);
    }

    let mut channels = serde_json::Map::new();
    if let Some(email) = email {
        channels.insert("email".into(), serde_json::json!([email]));
    }
    if let Some(mid) = matrix_id {
        channels.insert("matrix".into(), serde_json::json!(mid));
    }
    if let Some(platform) = platform {
        if let Some(mid) = matrix_id {
            channels.insert(platform.into(), serde_json::json!(mid));
        }
    }

    let metadata = serde_json::json!({
        "type": "person",
        "name": clean,
        "channels": channels,
    });

    match parachute.create_note(&CreateNoteParams {
        content: format!("# {}\n\nAuto-created by Prism sync.", clean),
        path: Some(path),
        metadata: Some(metadata),
        tags: Some(vec!["person".into()]),
    }).await {
        Ok(note) => {
            log::info!("Created person note for '{}': {}", clean, note.id);
            Ok(note.id)
        }
        Err(e) => {
            // If creation fails (e.g., 500 from path conflict), try to find by broader search
            log::debug!("Person create failed for '{}': {} — trying broader search", clean, e);
            let fallback = parachute.search(&clean, &[], 10).await.unwrap_or_default();
            if let Some(note) = fallback.into_iter().find(|n| person_name_matches(n, &clean)) {
                Ok(note.id)
            } else {
                Err(e)
            }
        }
    }
}

/// Link a note to a person note with a relationship type.
/// Skips if the link already exists.
pub async fn link_to_person(
    parachute: &ParachuteClient,
    note_id: &str,
    person_id: &str,
    relationship: &str,
) -> Result<(), PrismError> {
    // Check for existing link to avoid duplicates
    let params = crate::models::link::GetLinksParams {
        note_id: Some(note_id.to_string()),
        relationship: Some(relationship.to_string()),
    };
    let existing = parachute.get_links(&params).await.unwrap_or_default();
    if existing.iter().any(|l| {
        (l.source_id == note_id && l.target_id == person_id)
            || (l.source_id == person_id && l.target_id == note_id)
    }) {
        return Ok(()); // Already linked
    }

    let params = CreateLinkParams {
        source_id: note_id.to_string(),
        target_id: person_id.to_string(),
        relationship: relationship.to_string(),
        metadata: None,
    };
    parachute.create_link(&params).await?;
    Ok(())
}

/// Clean a Matrix display name: remove platform suffixes, bridge artifacts.
fn clean_display_name(name: &str) -> String {
    let name = name.trim();
    // Remove common bridge suffixes like " (WhatsApp)", " (Telegram)"
    let cleaned = if let Some(idx) = name.rfind(" (") {
        &name[..idx]
    } else {
        name
    };
    // Remove Matrix IDs if accidentally used as names
    let cleaned = if cleaned.starts_with('@') && cleaned.contains(':') {
        cleaned.split(':').next().unwrap_or(cleaned).trim_start_matches('@')
    } else {
        cleaned
    };
    cleaned.trim().to_string()
}

/// Check if a person note's name matches the target (case-insensitive, fuzzy).
fn person_name_matches(note: &Note, target: &str) -> bool {
    let target_lower = normalize_name(target);
    if target_lower.is_empty() {
        return false;
    }

    // Check metadata.name
    if let Some(meta) = &note.metadata {
        if let Some(name) = meta.get("name").and_then(|v| v.as_str()) {
            if normalize_name(name) == target_lower {
                return true;
            }
        }
    }

    // Check path (last segment) — handles both "Aaron_Gabriel" and "aaron-gabriel"
    if let Some(path) = &note.path {
        let filename = path.split('/').last().unwrap_or("");
        if normalize_name(filename) == target_lower {
            return true;
        }
    }

    // Check content first line (# Name)
    if note.content.starts_with("# ") {
        let first_line = note.content.lines().next().unwrap_or("");
        if first_line.len() > 2 && normalize_name(&first_line[2..]) == target_lower {
            return true;
        }
    }

    false
}

/// Normalize a name for comparison: lowercase, collapse separators to spaces, trim.
fn normalize_name(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .replace('_', " ")
        .replace('-', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Check if note metadata contains a value at a given key path.
fn note_metadata_contains(note: &Note, key: &str, value: &str) -> bool {
    let meta = match &note.metadata {
        Some(m) => m,
        None => return false,
    };

    let parts: Vec<&str> = key.split('.').collect();
    let mut current = meta;
    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            // Final key — check value
            if let Some(v) = current.get(*part) {
                if let Some(s) = v.as_str() {
                    return s.to_lowercase() == value.to_lowercase();
                }
                if let Some(arr) = v.as_array() {
                    return arr.iter().any(|item| {
                        item.as_str().map(|s| s.to_lowercase() == value.to_lowercase()).unwrap_or(false)
                    });
                }
            }
        } else {
            current = match current.get(*part) {
                Some(v) => v,
                None => return false,
            };
        }
    }
    false
}

fn sanitize_path(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect::<String>()
        .trim()
        .replace(' ', "-")
        .to_lowercase()
}
