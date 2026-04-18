pub mod message_sync;
pub mod calendar_sync;
pub mod email_sync;
pub mod person_linker;
pub mod agent_dispatch;
pub mod skill_scheduler;
pub mod transcript_sync;

use std::sync::Arc;
use tokio::sync::watch;
use tauri::async_runtime::JoinHandle;
use serde::{Deserialize, Serialize};
use crate::clients::matrix::MatrixClient;
use crate::clients::google::GoogleClient;
use crate::clients::parachute::ParachuteClient;
use crate::commands::config::AppConfig;

/// Status of a single background service.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub name: String,
    pub running: bool,
    pub last_run: Option<String>,
    pub last_error: Option<String>,
    pub items_processed: u64,
}

/// Manages all background sync services.
/// Each service runs as a tokio task with a shutdown channel.
pub struct ServiceManager {
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
    handles: Vec<JoinHandle<()>>,
    parachute_url: String,
    parachute_api_key: Option<String>,
    pub message_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub calendar_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub email_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub transcript_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub scheduler_status: Arc<std::sync::Mutex<ServiceStatus>>,
}

impl ServiceManager {
    /// Create and start all background services.
    pub fn start(config: &AppConfig) -> Self {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let mut handles = Vec::new();

        let message_status = Arc::new(std::sync::Mutex::new(ServiceStatus {
            name: "message-sync".into(),
            running: false,
            last_run: None,
            last_error: None,
            items_processed: 0,
        }));
        let calendar_status = Arc::new(std::sync::Mutex::new(ServiceStatus {
            name: "calendar-sync".into(),
            running: false,
            last_run: None,
            last_error: None,
            items_processed: 0,
        }));
        let email_status = Arc::new(std::sync::Mutex::new(ServiceStatus {
            name: "email-sync".into(),
            running: false,
            last_run: None,
            last_error: None,
            items_processed: 0,
        }));

        // Create separate client instances for background services
        let parachute_key = if config.parachute_api_key.is_empty() { None } else { Some(config.parachute_api_key.clone()) };
        let parachute_url = config.parachute_url.clone();
        let parachute = Arc::new(ParachuteClient::new(&parachute_url, parachute_key.clone()));

        // Message sync (Matrix → Parachute) — every 60 seconds
        if !config.matrix_access_token.is_empty() {
            let matrix = Arc::new(MatrixClient::new(
                &config.matrix_homeserver,
                &config.matrix_access_token,
                &config.matrix_user,
            ));
            let p = parachute.clone();
            let rx = shutdown_rx.clone();
            let status = message_status.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                message_sync::run(matrix, p, rx, status).await;
            }));
        } else {
            log::info!("Message sync disabled: no Matrix access token configured");
        }

        // Calendar sync (Google → Parachute) — every 5 minutes
        if !config.google_account_primary.is_empty() {
            let google = Arc::new(GoogleClient::new());
            let account = config.google_account_primary.clone();
            let p = parachute.clone();
            let rx = shutdown_rx.clone();
            let status = calendar_status.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                calendar_sync::run(google, p, account, rx, status).await;
            }));
        } else {
            log::info!("Calendar sync disabled: no Google account configured");
        }

        // Email sync (Gmail → Parachute) — every 3 minutes
        if !config.google_account_primary.is_empty() {
            let google = Arc::new(GoogleClient::new());
            let account = config.google_account_primary.clone();
            let p = parachute.clone();
            let rx = shutdown_rx.clone();
            let status = email_status.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                email_sync::run(google, p, account, rx, status).await;
            }));
        } else {
            log::info!("Email sync disabled: no Google account configured");
        }

        // Transcript sync (Fathom + Meetily → Parachute) — every 10 minutes
        let transcript_status = Arc::new(std::sync::Mutex::new(ServiceStatus {
            name: "transcript-sync".into(),
            running: false,
            last_run: None,
            last_error: None,
            items_processed: 0,
        }));

        let has_transcript_sources = !config.fathom_api_key.is_empty() || !config.meetily_db_path.is_empty();
        if has_transcript_sources {
            let p = parachute.clone();
            let rx = shutdown_rx.clone();
            let status = transcript_status.clone();
            let cfg = config.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                transcript_sync::run(p, cfg, rx, status).await;
            }));
        } else {
            log::info!("Transcript sync disabled: no Fathom or Meetily configured");
        }

        let scheduler_status = Arc::new(std::sync::Mutex::new(ServiceStatus {
            name: "skill-scheduler".into(),
            running: false,
            last_run: None,
            last_error: None,
            items_processed: 0,
        }));

        log::info!("ServiceManager started {} background services", handles.len());

        Self {
            shutdown_tx,
            shutdown_rx,
            handles,
            parachute_url,
            parachute_api_key: parachute_key,
            message_status,
            calendar_status,
            email_status,
            transcript_status,
            scheduler_status,
        }
    }

    /// Start the skill scheduler (must be called after DispatchManager is created).
    pub fn start_scheduler(&self, dispatch_manager: Arc<agent_dispatch::DispatchManager>) {
        let parachute = Arc::new(ParachuteClient::new(&self.parachute_url, self.parachute_api_key.clone()));
        let rx = self.shutdown_rx.clone();
        let status = self.scheduler_status.clone();
        tauri::async_runtime::spawn(async move {
            skill_scheduler::run(parachute, dispatch_manager, rx, status).await;
        });
        log::info!("Skill scheduler started");
    }

    /// Get status of all services.
    pub fn status(&self) -> Vec<ServiceStatus> {
        vec![
            self.message_status.lock().unwrap().clone(),
            self.calendar_status.lock().unwrap().clone(),
            self.email_status.lock().unwrap().clone(),
            self.transcript_status.lock().unwrap().clone(),
            self.scheduler_status.lock().unwrap().clone(),
        ]
    }

    /// Shutdown all services gracefully.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        log::info!("ServiceManager: shutdown signal sent to all services");
    }
}

impl Drop for ServiceManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
