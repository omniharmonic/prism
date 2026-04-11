use tauri::State;
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::*;

/// Enrich a note's metadata with Prism-specific fields derived from tags and tag schema data.
/// This implements the "backend enrichment" strategy from the alignment plan:
/// - Infers `prism_type` from structural tags when `metadata.type` isn't a known Prism type
/// - Normalizes tag schema fields (e.g. `due` → `deadline`)
/// - Passes through all unknown fields for future renderers
fn enrich_note(mut note: Note) -> Note {
    let tags = note.tags.clone().unwrap_or_default();
    let meta = note.metadata.get_or_insert_with(|| serde_json::json!({}));

    if let Some(obj) = meta.as_object_mut() {
        // Infer prism_type from tags if metadata.type isn't a known Prism renderer type
        let current_type = obj.get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let known_prism_types = [
            "document", "note", "presentation", "code", "email",
            "message-thread", "task-board", "task", "event",
            "project", "spreadsheet", "website", "canvas", "briefing",
        ];

        if !known_prism_types.contains(&current_type.as_str()) {
            // Map structural tags to Prism content types (priority order)
            let tag_map: &[(&str, &str)] = &[
                ("task", "task"),
                ("slides", "presentation"),
                ("briefing", "briefing"),
                ("dashboard", "project"),
                ("project", "project"),
                ("project-page", "website"),
                ("meeting", "document"),
                ("transcript", "document"),
                ("concept", "document"),
                ("writing", "document"),
                ("research", "document"),
                ("proposal", "document"),
                ("spec", "document"),
                ("script", "document"),
                ("person", "document"),
                ("organization", "document"),
                ("decision-record", "document"),
                ("grant-application", "document"),
                ("project-update", "document"),
                ("report", "document"),
                ("page", "document"),
                ("index", "document"),
            ];

            let inferred = tag_map.iter()
                .find(|(tag, _)| tags.contains(&tag.to_string()))
                .map(|(_, prism_type)| *prism_type)
                .unwrap_or("document");

            obj.insert("prism_type".to_string(), serde_json::json!(inferred));

            // Preserve original vault type for display
            if !current_type.is_empty() {
                obj.insert("vault_type".to_string(), serde_json::json!(&current_type));
            }
        }

        // Normalize task-specific fields
        if tags.contains(&"task".to_string()) {
            // Rename "due" → "deadline" for Prism compatibility
            if let Some(due) = obj.remove("due") {
                obj.entry("deadline").or_insert(due);
            }
        }

        // Normalize meeting-specific fields
        if tags.contains(&"meeting".to_string()) {
            // Ensure attendees field exists (from tag schema "attendees")
            if let Some(attendees) = obj.get("attendees").cloned() {
                obj.entry("participants").or_insert(attendees);
            }
        }
    }

    note
}

#[tauri::command]
pub async fn vault_list_notes(
    client: State<'_, ParachuteClient>,
    tag: Option<String>,
    path: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<Note>, PrismError> {
    let params = ListNotesParams { tag, path, limit, offset };
    let notes = match client.list_notes(&params).await {
        Ok(n) => n,
        Err(e) => {
            log::error!("vault_list_notes failed: {}", e);
            return Err(e);
        }
    };
    log::info!("vault_list_notes: got {} notes", notes.len());
    // Strip content from list response to reduce payload size.
    // Full content is fetched on-demand via vault_get_note.
    // 1,118 notes with content = 17.5MB; without = ~1MB.
    Ok(notes.into_iter().map(|mut n| {
        n.content = String::new();
        enrich_note(n)
    }).collect())
}

#[tauri::command]
pub async fn vault_get_note(
    client: State<'_, ParachuteClient>,
    id: String,
) -> Result<Note, PrismError> {
    let note = client.get_note(&id).await?;
    Ok(enrich_note(note))
}

#[tauri::command]
pub async fn vault_create_note(
    client: State<'_, ParachuteClient>,
    content: String,
    path: Option<String>,
    metadata: Option<serde_json::Value>,
    tags: Option<Vec<String>>,
) -> Result<Note, PrismError> {
    let params = CreateNoteParams { content, path, metadata, tags };
    client.create_note(&params).await
}

#[tauri::command]
pub async fn vault_update_note(
    client: State<'_, ParachuteClient>,
    id: String,
    content: Option<String>,
    path: Option<String>,
    metadata: Option<serde_json::Value>,
) -> Result<Note, PrismError> {
    let params = UpdateNoteParams { content, path, metadata };
    client.update_note(&id, &params).await
}

#[tauri::command]
pub async fn vault_delete_note(
    client: State<'_, ParachuteClient>,
    id: String,
) -> Result<(), PrismError> {
    client.delete_note(&id).await
}

#[tauri::command]
pub async fn vault_search(
    client: State<'_, ParachuteClient>,
    query: String,
    tags: Option<Vec<String>>,
    limit: Option<u32>,
) -> Result<Vec<Note>, PrismError> {
    let notes = client.search(&query, &tags.unwrap_or_default(), limit.unwrap_or(20)).await?;
    Ok(notes.into_iter().map(enrich_note).collect())
}

#[tauri::command]
pub async fn vault_get_tags(
    client: State<'_, ParachuteClient>,
) -> Result<Vec<TagCount>, PrismError> {
    client.get_tags().await
}

#[tauri::command]
pub async fn vault_add_tags(
    client: State<'_, ParachuteClient>,
    id: String,
    tags: Vec<String>,
) -> Result<(), PrismError> {
    client.add_tags(&id, &tags).await
}

#[tauri::command]
pub async fn vault_remove_tags(
    client: State<'_, ParachuteClient>,
    id: String,
    tags: Vec<String>,
) -> Result<(), PrismError> {
    client.remove_tags(&id, &tags).await
}

#[tauri::command]
pub async fn vault_get_stats(
    client: State<'_, ParachuteClient>,
) -> Result<VaultStats, PrismError> {
    client.get_stats().await
}

#[tauri::command]
pub async fn vault_get_links(
    client: State<'_, ParachuteClient>,
    note_id: Option<String>,
    relationship: Option<String>,
) -> Result<Vec<crate::models::link::Link>, PrismError> {
    let params = crate::models::link::GetLinksParams { note_id, relationship };
    client.get_links(&params).await
}
