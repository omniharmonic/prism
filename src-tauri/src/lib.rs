pub mod error;
pub mod models;
pub mod clients;
pub mod commands;
pub mod auth;
pub mod services;
pub mod sync;

use clients::parachute::ParachuteClient;
use clients::matrix::MatrixClient;
use clients::google::GoogleClient;
use clients::anthropic::ClaudeClient;
use commands::{vault, convert, system, matrix, google, sync_cmds, agent, config, editor, wikilinks, notion_pages};
use commands::agent::AgentSessions;
use commands::config::AppConfig;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::try_init();

    // Load configuration from omniharmonic agent's .env
    let app_config = AppConfig::load().unwrap_or_else(|e| {
        log::warn!("Failed to load config: {}. Using defaults.", e);
        AppConfig {
            matrix_homeserver: "http://localhost:8008".into(),
            matrix_user: "@prism:localhost".into(),
            matrix_access_token: String::new(),
            matrix_device_id: "PRISM".into(),
            notion_api_key: String::new(),
            google_account_primary: "benjamin@opencivics.co".into(),
            google_account_agent: "omniharmonicagent@gmail.com".into(),
            anthropic_api_key: String::new(),
            omniharmonic_root: dirs::home_dir().unwrap_or_default(),
        }
    });

    let parachute = ParachuteClient::new(1940, None);

    // Matrix client configured from omniharmonic .env
    let matrix_client = MatrixClient::new(
        &app_config.matrix_homeserver,
        &app_config.matrix_access_token,
        &app_config.matrix_user,
    );

    let google_client = GoogleClient::new();

    // Claude Code CLI client — runs in the Prism project directory
    // so it picks up .mcp.json (Parachute MCP) and has access to vault tools
    let prism_root = std::env::current_dir().unwrap_or_else(|_| {
        dirs::home_dir()
            .unwrap_or_default()
            .join("iCloud Drive (Archive)/Documents/cursor projects/prism")
    });
    let claude_client = ClaudeClient::new(prism_root, app_config.omniharmonic_root.clone());

    let agent_sessions = AgentSessions::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(parachute)
        .manage(matrix_client)
        .manage(google_client)
        .manage(claude_client)
        .manage(agent_sessions)
        .manage(app_config)
        .invoke_handler(tauri::generate_handler![
            // Vault CRUD
            vault::vault_list_notes,
            vault::vault_get_note,
            vault::vault_create_note,
            vault::vault_update_note,
            vault::vault_delete_note,
            vault::vault_search,
            vault::vault_get_tags,
            vault::vault_add_tags,
            vault::vault_remove_tags,
            vault::vault_get_stats,
            vault::vault_get_links,
            // Markdown conversion
            convert::markdown_to_html,
            convert::html_to_markdown,
            // System
            system::check_services,
            // Matrix messaging
            matrix::matrix_get_rooms,
            matrix::matrix_get_messages,
            matrix::matrix_send_message,
            matrix::matrix_get_room_members,
            matrix::matrix_mark_read,
            matrix::matrix_search_messages,
            // Gmail
            google::gmail_list_threads,
            google::gmail_get_thread,
            google::gmail_send,
            google::gmail_archive,
            google::gmail_label,
            // Calendar
            google::calendar_list_events,
            google::calendar_create_event,
            google::calendar_update_event,
            google::calendar_delete_event,
            google::google_check_auth,
            // Sync
            sync_cmds::sync_trigger,
            sync_cmds::sync_pull,
            sync_cmds::sync_status,
            sync_cmds::sync_add_config,
            sync_cmds::sync_remove_config,
            sync_cmds::sync_resolve_conflict,
            // Agent (Claude Code CLI)
            agent::agent_edit,
            agent::agent_chat,
            agent::agent_transform,
            agent::agent_generate,
            // Config
            config::get_config_status,
            config::set_anthropic_key,
            // Editor events
            editor::editor_set_content,
            editor::editor_replace_selection,
            // Wikilink resolution
            wikilinks::resolve_wikilinks,
            wikilinks::resolve_all_wikilinks,
            // Notion
            notion_pages::notion_list_pages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
