use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;
use crate::clients::model_router::ModelRouter;
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
/// Parachute Vault v2 consolidated its MCP surface to 9 tools. Tool names
/// are prefixed with `mcp__parachute-vault__`.
const PRISM_CONTEXT: &str = "\
You are an AI assistant embedded in Prism, Benjamin Life's universal interface for documents, \
messages, tasks, and knowledge management. You are part of the OmniHarmonic agent ecosystem.\n\n\
You have access to the Parachute Vault via 9 consolidated MCP tools, prefixed \
`mcp__parachute-vault__`:\n\
- `query-notes` — query/read notes by ID, path, tag, search text, or graph neighborhood. \
Supports `include_metadata: [\"summary\"]` for lightweight scans.\n\
- `create-note` — create one or many notes (pass `notes` array for batch)\n\
- `update-note` — update content, metadata (merge), tags (add/remove), or links (add/remove)\n\
- `delete-note` — delete a note\n\
- `list-tags` — list tags with counts; pass a tag name for schema detail\n\
- `update-tag` — upsert a tag's description and field schema\n\
- `delete-tag` — delete a tag from all notes\n\
- `find-path` — BFS shortest path between two notes\n\
- `vault-info` — vault description + optional stats; also updates description\n\n\
When the user asks you to edit a document, USE `mcp__parachute-vault__update-note` to make \
the changes directly — pass the note ID and updated content. Tag mutations use \
`update-note` with `tags: { add: [...], remove: [...] }`. Link mutations use \
`update-note` with `links: { add: [{ target, relationship }], remove: [...] }`.\n\
Graph neighborhood queries use `query-notes` with `near: <id>` and optional `depth`.\n\n\
When you receive results from `query-notes`, focus on the `content` field — that's the actual \
note text. Ignore structural fields like `id`, `createdAt`, `updatedAt`, and `byteSize`. \
The `metadata` object contains structured properties (status, priority, etc.) and `tags` shows \
the note's type. Summarize the CONTENT, not the JSON structure.\n\n\
The vault contains Benjamin's projects, meetings, contacts, tasks, research, and writing. \
Tag schemas define structured fields for each note type.\n\n";

/// Inline edit: takes selected text + prompt, returns replacement text.
/// Uses `claude -p` with a focused editing prompt.
#[tauri::command]
pub async fn agent_edit(
    router: State<'_, ModelRouter>,
    parachute: State<'_, ParachuteClient>,
    note_id: String,
    selection: String,
    prompt: String,
) -> Result<String, PrismError> {
    let note = parachute.get_note(&note_id).await
        .map_err(|e| PrismError::Parachute(format!("Cannot edit: note {} not found ({})", note_id, e)))?;

    let edit_prompt = format!(
        "You are editing a document in Prism. Apply the following edit to the selected text.\n\n\
         Note ID: {}\n\
         Document path: {}\n\
         Tags: {}\n\n\
         Full document:\n{}\n\n\
         ---\n\n\
         Selected text:\n\"{}\"\n\n\
         Edit instruction: {}\n\n\
         Return ONLY the replacement text. No explanations, no code fences, no markdown wrapping.",
        note_id,
        note.path.as_deref().unwrap_or("untitled"),
        note.tags.as_deref().unwrap_or(&[]).join(", "),
        &note.content[..note.content.len().min(4000)],
        selection,
        prompt,
    );

    router.run("edit", PRISM_CONTEXT, &edit_prompt, &note_id, 60).await
}

/// Chat: conversational exchange with document context.
/// Uses `claude -p` with session resumption for multi-turn conversations.
/// Claude has access to Parachute MCP tools to search, read, and modify vault notes.
#[tauri::command]
pub async fn agent_chat(
    router: State<'_, ModelRouter>,
    parachute: State<'_, ParachuteClient>,
    sessions: State<'_, AgentSessions>,
    note_id: Option<String>,
    message: String,
) -> Result<serde_json::Value, PrismError> {
    // Build context-aware prompt, split into system vs user parts
    let note = if let Some(id) = &note_id {
        parachute.get_note(id).await.ok()
    } else {
        None
    };

    let system_prompt = if let Some(note) = &note {
        let id = note_id.as_deref().unwrap_or("");
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
             You can also search the vault, create new notes, add tags, and traverse links.",
            PRISM_CONTEXT,
            id,
            note.path.as_deref().unwrap_or("untitled"),
            note.tags.as_deref().unwrap_or(&[]).join(", "),
            &note.content[..note.content.len().min(6000)],
        )
    } else {
        format!(
            "{}You are a helpful assistant. Use the Parachute MCP tools to search and browse \
             the vault when answering questions about documents, projects, people, or tasks.",
            PRISM_CONTEXT,
        )
    };

    // Get/create session for this context
    let session_key = note_id.clone().unwrap_or_else(|| "global".into());
    let session_id = sessions.sessions.lock().unwrap().get(&session_key).cloned();

    let response = router.run_conversational(
        "chat",
        &system_prompt,
        &message,
        &session_key,
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
    router: State<'_, ModelRouter>,
    parachute: State<'_, ParachuteClient>,
    note_id: String,
    target_type: String,
) -> Result<String, PrismError> {
    let note = parachute.get_note(&note_id).await?;

    let transform_prompt = format!(
        "Convert the following document into a {}. \
         Preserve all semantic content. Use formatting conventions appropriate for the target type.\n\
         If you need additional context, use the Parachute MCP tools to search related notes.\n\n\
         Source document ({}, tags: {}):\n{}\n\n\
         Return ONLY the converted content.",
        target_type,
        note.path.as_deref().unwrap_or("untitled"),
        note.tags.as_deref().unwrap_or(&[]).join(", "),
        note.content,
    );

    router.run("transform", PRISM_CONTEXT, &transform_prompt, &note_id, 120).await
}

/// Generate: create new content from a prompt.
/// Claude can use Parachute MCP to pull relevant context from the vault.
#[tauri::command]
pub async fn agent_generate(
    router: State<'_, ModelRouter>,
    prompt: String,
    content_type: Option<String>,
) -> Result<String, PrismError> {
    let generate_prompt = if let Some(ct) = content_type {
        format!(
            "Generate {} content based on this prompt. \
             Use the Parachute MCP tools to search the vault for relevant context if needed.\n\n\
             Prompt: {}\n\n\
             Return ONLY the generated content.",
            ct, prompt,
        )
    } else {
        format!(
            "Generate content based on this prompt. \
             Use the Parachute MCP tools to search the vault for relevant context if needed.\n\n\
             Prompt: {}\n\n\
             Return ONLY the generated content.",
            prompt,
        )
    };

    router.run("generate", PRISM_CONTEXT, &generate_prompt, "generate", 120).await
}
