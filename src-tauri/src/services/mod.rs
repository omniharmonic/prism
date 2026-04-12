pub mod message_sync;
pub mod calendar_sync;
pub mod email_sync;
pub mod person_linker;
pub mod agent_dispatch;

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
    handles: Vec<JoinHandle<()>>,
    pub message_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub calendar_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub email_status: Arc<std::sync::Mutex<ServiceStatus>>,
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
        let parachute = Arc::new(ParachuteClient::new(1940, None));

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

        log::info!("ServiceManager started {} background services", handles.len());

        Self {
            shutdown_tx,
            handles,
            message_status,
            calendar_status,
            email_status,
        }
    }

    /// Get status of all services.
    pub fn status(&self) -> Vec<ServiceStatus> {
        vec![
            self.message_status.lock().unwrap().clone(),
            self.calendar_status.lock().unwrap().clone(),
            self.email_status.lock().unwrap().clone(),
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
