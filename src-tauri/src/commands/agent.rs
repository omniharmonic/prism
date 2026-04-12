use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;
use crate::clients::anthropic::ClaudeClient;
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;

/// Tracks active Claude Code sessions for conversational continuity.
/// Key: context identifier (e.g., note_id or "global"), Value: session_id
pub struct AgentSessions {
    pub sessions: Mutex<HashMap<String, String>>,
}

impl AgentSessions {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// System context that tells Claude about its environment and available tools.
/// Includes the full MCP tool names so Claude can call them directly.
const PRISM_CONTEXT: &str = "\
You are an AI assistant embedded in Prism, Benjamin Life's universal interface for documents, \
messages, tasks, and knowledge management. You are part of the OmniHarmonic agent ecosystem.\n\n\
You have access to the Parachute Vault via MCP tools. The tool names are prefixed with \
`mcp__parachute-vault__`. Here are the key tools:\n\
- `mcp__parachute-vault__search-notes` — search notes by query text\n\
- `mcp__parachute-vault__get-note` — read a note by ID\n\
- `mcp__parachute-vault__update-note` — update a note's content or metadata by ID\n\
- `mcp__parachute-vault__create-note` — create a new note\n\
- `mcp__parachute-vault__list-tags` — list all tags in the vault\n\
- `mcp__parachute-vault__describe-tag` — get a tag's schema (fields and types)\n\
- `mcp__parachute-vault__get-links` — get links for a note\n\
- `mcp__parachute-vault__traverse-links` — traverse the knowledge graph\n\
- `mcp__parachute-vault__tag-note` — add tags to a note\n\
- `mcp__parachute-vault__semantic-search` — semantic/vector search\n\n\
When the user asks you to edit the current document, write the updated content in your response. \
The user will click 'Apply to document' or 'Replace document' buttons to update the note. \
Do NOT try to call MCP tools to update the document — the Prism UI handles persistence.\n\
For searching or reading OTHER notes, you can use the MCP tools listed above.\n\n\
The vault contains Benjamin's projects, meetings, contacts, tasks, research, and writing. \
Tag schemas define structured fields for each note type (task, meeting, person, project, etc.).\n\n";

/// Inline edit: takes selected text + prompt, returns replacement text.
/// Uses `claude -p` with a focused editing prompt.
#[tauri::command]
pub async fn agent_edit(
    claude: State<'_, ClaudeClient>,
    parachute: State<'_, ParachuteClient>,
    note_id: String,
    selection: String,
    prompt: String,
) -> Result<String, PrismError> {
    let note = parachute.get_note(&note_id).await?;

    let full_prompt = format!(
        "{}You are editing a document in Prism. Apply the following edit to the selected text.\n\n\
         Note ID: {}\n\
         Document path: {}\n\
         Tags: {}\n\n\
         Full document:\n{}\n\n\
         ---\n\n\
         Selected text:\n\"{}\"\n\n\
         Edit instruction: {}\n\n\
         Return ONLY the replacement text. No explanations, no code fences, no markdown wrapping.",
        PRISM_CONTEXT,
        note_id,
        note.path.as_deref().unwrap_or("untitled"),
        note.tags.as_deref().unwrap_or(&[]).join(", "),
        &note.content[..note.content.len().min(4000)],
        selection,
        prompt,
    );

    claude.run(&full_prompt, "sonnet", 60).await
}

/// Chat: conversational exchange with document context.
/// Uses `claude -p` with session resumption for multi-turn conversations.
/// Claude has access to Parachute MCP tools to search, read, and modify vault notes.
#[tauri::command]
pub async fn agent_chat(
    claude: State<'_, ClaudeClient>,
    parachute: State<'_, ParachuteClient>,
    sessions: State<'_, AgentSessions>,
    note_id: Option<String>,
    message: String,
) -> Result<serde_json::Value, PrismError> {
    // Build context-aware prompt
    let prompt = if let Some(id) = &note_id {
        let note = parachute.get_note(id).await?;
        format!(
            "{}You are a writing collaborator. The user has a document open in Prism.\n\n\
             CURRENT DOCUMENT:\n\
             - Note ID: {}\n\
             - Path: {}\n\
             - Tags: {}\n\n\
             Content:\n{}\n\n\
             ---\n\n\
             To edit this document, write the new or modified content in your response. \
             The user will click 'Append to document' or 'Replace document' to apply your edits. \
             Do NOT try to use MCP tools to update this note — Prism handles saving automatically.\n\
             If the user asks about OTHER documents or topics, you can search the vault.\n\n\
             User: {}",
            PRISM_CONTEXT,
            id,
            note.path.as_deref().unwrap_or("untitled"),
            note.tags.as_deref().unwrap_or(&[]).join(", "),
            &note.content[..note.content.len().min(6000)],
            message,
        )
    } else {
        format!(
            "{}You are a helpful assistant. Use the Parachute MCP tools to search and browse \
             the vault when answering questions about documents, projects, people, or tasks.\n\n\
             User: {}",
            PRISM_CONTEXT,
            message,
        )
    };

    // Get/create session for this context
    let session_key = note_id.clone().unwrap_or_else(|| "global".into());
    let session_id = sessions.sessions.lock().unwrap().get(&session_key).cloned();

    let response = claude.run_conversational(
        &prompt,
        "sonnet",
        session_id.as_deref(),
        120,
    ).await?;

    // Store session ID for continuity
    if let Some(sid) = &response.session_id {
        sessions.sessions.lock().unwrap().insert(session_key, sid.clone());
    }

    Ok(serde_json::json!({
        "message": response.result,
        "session_id": response.session_id,
        "is_error": response.is_error,
    }))
}

/// Transform: convert content to a different type using Claude.
/// Claude can use Parachute MCP to look up related content for context.
#[tauri::command]
pub async fn agent_transform(
    claude: State<'_, ClaudeClient>,
    parachute: State<'_, ParachuteClient>,
    note_id: String,
    target_type: String,
) -> Result<String, PrismError> {
    let note = parachute.get_note(&note_id).await?;

    let prompt = format!(
        "{}Convert the following document into a {}. \
         Preserve all semantic content. Use formatting conventions appropriate for the target type.\n\
         If you need additional context, use the Parachute MCP tools to search related notes.\n\n\
         Source document ({}, tags: {}):\n{}\n\n\
         Return ONLY the converted content.",
        PRISM_CONTEXT,
        target_type,
        note.path.as_deref().unwrap_or("untitled"),
        note.tags.as_deref().unwrap_or(&[]).join(", "),
        note.content,
    );

    claude.run(&prompt, "sonnet", 120).await
}

/// Generate: create new content from a prompt.
/// Claude can use Parachute MCP to pull relevant context from the vault.
#[tauri::command]
pub async fn agent_generate(
    claude: State<'_, ClaudeClient>,
    prompt: String,
    content_type: Option<String>,
) -> Result<String, PrismError> {
    let full_prompt = if let Some(ct) = content_type {
        format!(
            "{}Generate {} content based on this prompt. \
             Use the Parachute MCP tools to search the vault for relevant context if needed.\n\n\
             Prompt: {}\n\n\
             Return ONLY the generated content.",
            PRISM_CONTEXT, ct, prompt,
        )
    } else {
        format!(
            "{}Generate content based on this prompt. \
             Use the Parachute MCP tools to search the vault for relevant context if needed.\n\n\
             Prompt: {}\n\n\
             Return ONLY the generated content.",
            PRISM_CONTEXT, prompt,
        )
    };

    claude.run(&full_prompt, "sonnet", 120).await
}
