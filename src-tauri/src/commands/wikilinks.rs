use tauri::State;
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::ListNotesParams;

/// Scan a note's content for [[wikilinks]] and create Parachute links
/// for any that resolve to existing notes.
#[tauri::command]
pub async fn resolve_wikilinks(
    parachute: State<'_, ParachuteClient>,
    note_id: String,
) -> Result<serde_json::Value, PrismError> {
    let note = parachute.get_note(&note_id).await?;

    // Find all [[wikilinks]] in content
    let wikilinks = extract_wikilinks(&note.content);
    if wikilinks.is_empty() {
        return Ok(serde_json::json!({ "resolved": 0, "total": 0, "links": [] }));
    }

    // Get all notes to match against
    let all_notes = parachute.list_notes(&ListNotesParams {
        limit: Some(2000),
        ..Default::default()
    }).await?;

    let mut resolved = Vec::new();
    let mut created = 0;

    for wikilink in &wikilinks {
        // Try to find a matching note by path or title
        let target = all_notes.iter().find(|n| {
            let path = n.path.as_deref().unwrap_or("");
            let name = path.split('/').last().unwrap_or("");

            // Match by exact path
            if path == *wikilink { return true; }
            // Match by last path segment (filename)
            if name.eq_ignore_ascii_case(wikilink) { return true; }
            // Match with vault/ prefix stripped
            let stripped = path.strip_prefix("vault/").unwrap_or(path);
            if stripped == *wikilink { return true; }
            if stripped.split('/').last().unwrap_or("").eq_ignore_ascii_case(wikilink) { return true; }

            false
        });

        if let Some(target_note) = target {
            // Create a link in Parachute
            let link_params = crate::models::link::CreateLinkParams {
                source_id: note_id.clone(),
                target_id: target_note.id.clone(),
                relationship: "references".to_string(),
                metadata: Some(serde_json::json!({
                    "source": "wikilink",
                    "original": wikilink,
                })),
            };

            match parachute.create_link(&link_params).await {
                Ok(_) => {
                    created += 1;
                    resolved.push(serde_json::json!({
                        "wikilink": wikilink,
                        "targetId": target_note.id,
                        "targetPath": target_note.path,
                        "status": "created",
                    }));
                }
                Err(e) => {
                    resolved.push(serde_json::json!({
                        "wikilink": wikilink,
                        "targetId": target_note.id,
                        "targetPath": target_note.path,
                        "status": format!("error: {}", e),
                    }));
                }
            }
        } else {
            resolved.push(serde_json::json!({
                "wikilink": wikilink,
                "status": "unresolved",
            }));
        }
    }

    Ok(serde_json::json!({
        "resolved": created,
        "total": wikilinks.len(),
        "links": resolved,
    }))
}

/// Batch resolve wikilinks across all notes in the vault
#[tauri::command]
pub async fn resolve_all_wikilinks(
    parachute: State<'_, ParachuteClient>,
) -> Result<serde_json::Value, PrismError> {
    let all_notes = parachute.list_notes(&ListNotesParams {
        limit: Some(2000),
        ..Default::default()
    }).await?;

    let mut total_links = 0;
    let mut total_resolved = 0;
    let mut total_unresolved = 0;

    for note in &all_notes {
        let wikilinks = extract_wikilinks(&note.content);
        if wikilinks.is_empty() { continue; }

        for wikilink in &wikilinks {
            total_links += 1;

            let target = all_notes.iter().find(|n| {
                if n.id == note.id { return false; }
                let path = n.path.as_deref().unwrap_or("");
                let name = path.split('/').last().unwrap_or("");
                let stripped = path.strip_prefix("vault/").unwrap_or(path);

                name.eq_ignore_ascii_case(wikilink)
                    || path == *wikilink
                    || stripped == *wikilink
                    || stripped.split('/').last().unwrap_or("").eq_ignore_ascii_case(wikilink)
            });

            if let Some(target_note) = target {
                let link_params = crate::models::link::CreateLinkParams {
                    source_id: note.id.clone(),
                    target_id: target_note.id.clone(),
                    relationship: "references".to_string(),
                    metadata: Some(serde_json::json!({
                        "source": "wikilink",
                        "original": wikilink,
                    })),
                };

                if parachute.create_link(&link_params).await.is_ok() {
                    total_resolved += 1;
                }
            } else {
                total_unresolved += 1;
            }
        }
    }

    Ok(serde_json::json!({
        "total_wikilinks": total_links,
        "resolved": total_resolved,
        "unresolved": total_unresolved,
    }))
}

/// Extract [[wikilink]] targets from markdown content
fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut chars = content.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '[' {
            if chars.peek() == Some(&'[') {
                chars.next(); // consume second [
                let mut link = String::new();
                while let Some(c) = chars.next() {
                    if c == ']' {
                        if chars.peek() == Some(&']') {
                            chars.next(); // consume second ]
                            let target = if link.contains('|') {
                                // [[target|display text]] — take the target part
                                link.split('|').next().unwrap_or(&link).to_string()
                            } else {
                                link.clone()
                            };
                            // Strip any path prefixes like vault/
                            let cleaned = target.trim().to_string();
                            if !cleaned.is_empty() && !links.contains(&cleaned) {
                                links.push(cleaned);
                            }
                            break;
                        }
                    }
                    link.push(c);
                }
            }
        }
    }

    links
}
