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
use clients::mcp_client::PrismMcpClient;
use clients::ollama::OllamaAgent;
use clients::model_router::ModelRouter;
use commands::{vault, convert, system, matrix, google, sync_cmds, agent, config, editor, wikilinks, notion_pages, message_index, service_cmds, ollama_cmds, github_cmds, notion_db_cmds};
use commands::github_cmds::GitHubSyncState;
use commands::notion_db_cmds::NotionDbSyncState;
use commands::agent::AgentSessions;
use commands::config::AppConfig;
use services::ServiceManager;
use services::agent_dispatch::DispatchManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::try_init();

    // Load configuration from omniharmonic agent's .env
    let app_config = AppConfig::load().unwrap_or_else(|e| {
        log::warn!("Failed to load config: {}. Using defaults.", e);
        AppConfig::default()
    });

    let parachute_key = if app_config.parachute_api_key.is_empty() { None } else { Some(app_config.parachute_api_key.clone()) };
    let parachute_url = app_config.parachute_url.clone();
    let parachute = ParachuteClient::new(&parachute_url, parachute_key.clone());

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
    let claude_client = ClaudeClient::new(prism_root);

    // Try to connect Ollama agent with MCP vault access.
    // This is optional — if Ollama or Parachute MCP aren't running, we proceed without it.
    let ollama_agent = tauri::async_runtime::block_on(async {
        let mcp_url = format!("{}/mcp", parachute_url);
        let ollama_url = "http://localhost:11434".to_string(); // TODO: make configurable
        match PrismMcpClient::connect(&mcp_url, parachute_key.as_deref()).await {
            Ok(mcp) => {
                log::info!("PrismMcpClient connected — {} tools", mcp.tools().len());
                Some(OllamaAgent::new(ollama_url, mcp).await)
            }
            Err(e) => {
                log::warn!("MCP connection failed, Ollama unavailable: {}", e);
                None
            }
        }
    });

    let model_router = ModelRouter::new(claude_client, ollama_agent);

    let agent_sessions = AgentSessions::new();

    // Start background sync services (uses tauri::async_runtime which is always available)
    let service_manager = ServiceManager::start(&app_config);
    let dispatch_manager = std::sync::Arc::new(DispatchManager::new(&parachute_url, parachute_key.clone()));

    // Start skill scheduler (needs both ServiceManager and DispatchManager)
    service_manager.start_scheduler(dispatch_manager.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(parachute)
        .manage(matrix_client)
        .manage(google_client)
        .manage(model_router)
        .manage(agent_sessions)
        .manage(app_config)
        .manage(service_manager)
        .manage(dispatch_manager)
        .manage(GitHubSyncState::new())
        .manage(NotionDbSyncState::new())
        .invoke_handler(tauri::generate_handler![
            // Vault CRUD
            vault::vault_list_notes,
            vault::vault_get_note,
            vault::vault_create_note,
            vault::vault_update_note,
            vault::vault_delete_note,
            vault::vault_batch_delete,
            vault::vault_search,
            vault::vault_get_tags,
            vault::vault_add_tags,
            vault::vault_remove_tags,
            vault::vault_get_stats,
            vault::vault_get_info,
            vault::vault_update_description,
            vault::vault_get_paths,
            vault::vault_get_links,
            vault::vault_create_link,
            vault::vault_delete_link,
            vault::vault_get_graph,
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
            // Message indexing
            message_index::index_messages,
            // Config + integration testing
            config::get_config_status,
            config::set_anthropic_key,
            config::test_parachute,
            config::test_matrix,
            config::test_notion,
            config::check_claude_cli,
            config::check_google_cli,
            config::get_full_config,
            config::update_config,
            config::discover_meetily_path,
            // Editor events
            editor::editor_set_content,
            editor::editor_replace_selection,
            // Wikilink resolution
            wikilinks::resolve_wikilinks,
            wikilinks::resolve_all_wikilinks,
            // Notion
            notion_pages::notion_list_pages,
            // Background services
            service_cmds::get_service_status,
            service_cmds::calendar_sync_range,
            service_cmds::agent_dispatch,
            service_cmds::agent_get_dispatches,
            service_cmds::agent_cancel_dispatch,
            service_cmds::agent_get_skills,
            service_cmds::agent_update_skill,
            // Ollama / model management
            ollama_cmds::ollama_status,
            ollama_cmds::ollama_list_models,
            ollama_cmds::set_skill_model,
            ollama_cmds::get_skill_models,
            // GitHub sync
            github_cmds::github_check_auth,
            github_cmds::github_sync_init,
            github_cmds::github_sync_push,
            github_cmds::github_sync_push_file,
            github_cmds::github_sync_status,
            github_cmds::github_sync_remove,
            // Notion database sync
            notion_db_cmds::notion_db_list,
            notion_db_cmds::notion_db_schema,
            notion_db_cmds::notion_db_sync_init,
            notion_db_cmds::notion_db_sync,
            notion_db_cmds::notion_db_sync_status,
            notion_db_cmds::notion_db_sync_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
