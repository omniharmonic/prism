use tauri::{AppHandle, Emitter};
use crate::error::PrismError;

/// Emit a document content update event to the frontend.
/// The editor listens for this and applies the content to the active TipTap instance.
#[tauri::command]
pub fn editor_set_content(
    app: AppHandle,
    note_id: String,
    content: String,
    mode: Option<String>, // "replace" (default), "append", "insert_at_cursor"
) -> Result<(), PrismError> {
    app.emit("editor:set-content", serde_json::json!({
        "noteId": note_id,
        "content": content,
        "mode": mode.unwrap_or_else(|| "replace".into()),
    }))
    .map_err(|e| PrismError::Other(format!("Failed to emit event: {}", e)))?;

    Ok(())
}

/// Emit a document selection replacement event.
/// Used by the inline agent edit to replace selected text.
#[tauri::command]
pub fn editor_replace_selection(
    app: AppHandle,
    note_id: String,
    replacement: String,
) -> Result<(), PrismError> {
    app.emit("editor:replace-selection", serde_json::json!({
        "noteId": note_id,
        "replacement": replacement,
    }))
    .map_err(|e| PrismError::Other(format!("Failed to emit event: {}", e)))?;

    Ok(())
}
