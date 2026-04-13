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
- `mcp__parachute-vault__query-notes` — universal read: get by ID, search, filter by tags/path, traverse graph neighborhood\n\
- `mcp__parachute-vault__create-note` — create a new note (single or batch)\n\
- `mcp__parachute-vault__update-note` — update content, metadata, tags (add/remove), and links (add/remove)\n\
- `mcp__parachute-vault__delete-note` — delete a note by ID\n\
- `mcp__parachute-vault__list-tags` — list all tags, or get a single tag's schema with { tag: \"name\" }\n\
- `mcp__parachute-vault__update-tag` — update a tag's description or field schema\n\
- `mcp__parachute-vault__delete-tag` — delete a tag from all notes\n\
- `mcp__parachute-vault__find-path` — find shortest path between two notes in the link graph\n\
- `mcp__parachute-vault__vault-info` — get vault name, description, and stats\n\n\
When the user asks you to edit a document, USE `mcp__parachute-vault__update-note` \
to make the changes directly. Pass the note ID and the updated content. To add tags, include \
`tags: { add: [\"tag1\"] }` in the update. To add links, include `links: { add: [{ target: \"id\", \
relationship: \"related\" }] }`. After editing, briefly describe what you changed.\n\
The Prism UI will detect your changes and show them to the user for review.\n\n\
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
             To edit this document, use `mcp__parachute-vault__update-note` with the note ID above \
             and the updated content. After editing, briefly describe what you changed.\n\
             You can also search the vault, create new notes, add tags, and traverse links.\n\n\
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
