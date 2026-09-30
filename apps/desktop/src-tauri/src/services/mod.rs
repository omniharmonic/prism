pub mod message_sync;
pub mod calendar_sync;
pub mod email_sync;
pub mod person_linker;
pub mod agent_dispatch;
pub mod skill_scheduler;
pub mod structured_skill;
pub mod transcript_sync;
pub mod notion_task_sync;
pub mod embedding_index;

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
    /// True when this service is NOT started on this machine (client mode, a
    /// disable_* flag, or not configured). `running` is then always false.
    #[serde(default)]
    pub disabled: bool,
    /// Human-readable why, shown by the UI. `None` when not disabled.
    #[serde(default)]
    pub disabled_reason: Option<String>,
}

impl ServiceStatus {
    fn new(name: &str) -> Self {
        Self {
            name: name.into(),
            running: false,
            last_run: None,
            last_error: None,
            items_processed: 0,
            disabled: false,
            disabled_reason: None,
        }
    }
}

pub const SVC_MESSAGE: &str = "message-sync";
pub const SVC_CALENDAR: &str = "calendar-sync";
pub const SVC_EMAIL: &str = "email-sync";
pub const SVC_TRANSCRIPT: &str = "transcript-sync";
pub const SVC_SCHEDULER: &str = "skill-scheduler";
pub const SVC_NOTION: &str = "notion-task-sync";
pub const SVC_EMBEDDING: &str = "embedding-index";

/// Whether one service should start on this machine, and if not, why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServicePlan {
    pub name: &'static str,
    pub start: bool,
    pub reason: Option<String>,
}

const CLIENT_REASON: &str = "client mode (ingest_mode=client): background work runs on the Prism server";

/// Pure decision: which services start for this config. Precedence of reasons:
/// client mode, then an explicit disable_* flag, then "not configured".
/// `ServiceManager::start` / `start_scheduler` act on exactly this list.
pub fn plan_services(c: &AppConfig) -> Vec<ServicePlan> {
    let client = c.is_client_mode();
    let mk = |name: &'static str, flag: Option<(&str, bool)>, configured: bool, unconfigured: &str| -> ServicePlan {
        let reason = if client {
            Some(CLIENT_REASON.to_string())
        } else if let Some((fname, true)) = flag {
            Some(format!("disabled by {fname}"))
        } else if !configured {
            Some(unconfigured.to_string())
        } else {
            None
        };
        ServicePlan { name, start: reason.is_none(), reason }
    };

    // transcript-sync covers Fathom + Fireflies + Meetily; it runs while ANY source is
    // both configured and not individually disabled (mirrors the per-source gates in
    // transcript_sync::run).
    let fathom = !c.fathom_api_key.is_empty() && !c.disable_fathom_sync;
    let fireflies = !c.fireflies_api_key.is_empty() && !c.disable_fireflies_sync;
    let meetily = !c.meetily_db_path.is_empty() && !c.disable_meetily_sync;
    let any_source_configured = !c.fathom_api_key.is_empty()
        || !c.fireflies_api_key.is_empty()
        || !c.meetily_db_path.is_empty();
    let transcript_unconfigured = if any_source_configured {
        "every configured transcript source is disabled (disable_fathom_sync / disable_fireflies_sync / disable_meetily_sync)"
    } else {
        "no Fathom, Fireflies, or Meetily configured"
    };

    vec![
        mk(SVC_MESSAGE, Some(("disable_message_sync", c.disable_message_sync)),
            !c.matrix_access_token.is_empty(), "no Matrix access token configured"),
        mk(SVC_CALENDAR, Some(("disable_calendar_sync", c.disable_calendar_sync)),
            !c.google_account_primary.is_empty(), "no Google account configured"),
        mk(SVC_EMAIL, Some(("disable_email_sync", c.disable_email_sync)),
            !c.google_account_primary.is_empty(), "no Google account configured"),
        mk(SVC_TRANSCRIPT, None, fathom || fireflies || meetily, transcript_unconfigured),
        // The scheduler needs no credentials of its own; it is gated only by mode/flag.
        mk(SVC_SCHEDULER, Some(("disable_skill_scheduler", c.disable_skill_scheduler)), true, ""),
        mk(SVC_NOTION, Some(("disable_notion_task_sync", c.disable_notion_task_sync)),
            !c.notion_api_key.is_empty(), "no Notion API key configured"),
        mk(SVC_EMBEDDING, Some(("disable_embedding_index", c.disable_embedding_index)),
            !c.collab_token.is_empty(), "no COLLAB_TOKEN (Prism Server) configured"),
    ]
}

/// Manages all background sync services.
/// Each service runs as a tokio task with a shutdown channel.
pub struct ServiceManager {
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
    handles: Vec<JoinHandle<()>>,
    parachute_url: String,
    parachute_vault: String,
    parachute_api_key: Option<String>,
    plans: Vec<ServicePlan>,
    pub message_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub calendar_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub email_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub transcript_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub scheduler_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub notion_task_sync_status: Arc<std::sync::Mutex<ServiceStatus>>,
    pub embedding_index_status: Arc<std::sync::Mutex<ServiceStatus>>,
}

impl ServiceManager {
    /// Create and start all background services.
    pub fn start(config: &AppConfig) -> Self {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let mut handles = Vec::new();
        let plans = plan_services(config);
        let should_start = |name: &str| plans.iter().any(|p| p.name == name && p.start);
        if config.is_client_mode() {
            log::info!("Ingest mode: CLIENT — no background services or skill scheduler will start on this machine (ingest runs on the Prism server)");
        }

        let message_status = Arc::new(std::sync::Mutex::new(ServiceStatus::new("message-sync")));
        let calendar_status = Arc::new(std::sync::Mutex::new(ServiceStatus::new("calendar-sync")));
        let email_status = Arc::new(std::sync::Mutex::new(ServiceStatus::new("email-sync")));

        // Create separate client instances for background services
        let parachute_key = if config.parachute_api_key.is_empty() { None } else { Some(config.parachute_api_key.clone()) };
        let parachute_url = config.parachute_url.clone();
        let parachute_vault = config.parachute_vault.clone();
        let parachute = Arc::new(ParachuteClient::new(&parachute_url, &parachute_vault, parachute_key.clone()));

        // Message sync (Matrix → Parachute) — every 60 seconds. Skipped when
        // `disable_message_sync` is set: the Prism Server ingests Matrix
        // server-side instead, so running both would double-append messages.
        if should_start(SVC_MESSAGE) {
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
            log_disabled(&plans, SVC_MESSAGE);
        }

        // Calendar sync (Google → Parachute) — every 5 minutes
        if should_start(SVC_CALENDAR) {
            let google = Arc::new(GoogleClient::new());
            let account = config.google_account_primary.clone();
            let p = parachute.clone();
            let rx = shutdown_rx.clone();
            let status = calendar_status.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                calendar_sync::run(google, p, account, rx, status).await;
            }));
        } else {
            log_disabled(&plans, SVC_CALENDAR);
        }

        // Email sync (Gmail → Parachute) — every 3 minutes
        if should_start(SVC_EMAIL) {
            let google = Arc::new(GoogleClient::new());
            let account = config.google_account_primary.clone();
            let p = parachute.clone();
            let rx = shutdown_rx.clone();
            let status = email_status.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                email_sync::run(google, p, account, rx, status).await;
            }));
        } else {
            log_disabled(&plans, SVC_EMAIL);
        }

        // Transcript sync (Fathom + Fireflies + Meetily → Parachute) — every 10 minutes
        let transcript_status = Arc::new(std::sync::Mutex::new(ServiceStatus::new("transcript-sync")));

        if should_start(SVC_TRANSCRIPT) {
            let p = parachute.clone();
            let rx = shutdown_rx.clone();
            let status = transcript_status.clone();
            let cfg = config.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                transcript_sync::run(p, cfg, rx, status).await;
            }));
        } else {
            log_disabled(&plans, SVC_TRANSCRIPT);
        }

        let scheduler_status = Arc::new(std::sync::Mutex::new(ServiceStatus::new("skill-scheduler")));

        // Notion task sync — background bidirectional sync for configured databases
        let notion_task_sync_status = Arc::new(std::sync::Mutex::new(ServiceStatus::new("notion-task-sync")));

        if should_start(SVC_NOTION) {
            let p = parachute.clone();
            let rx = shutdown_rx.clone();
            let status = notion_task_sync_status.clone();
            let api_key = config.notion_api_key.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                notion_task_sync::run(p, api_key, rx, status).await;
            }));
        } else {
            log_disabled(&plans, SVC_NOTION);
        }

        // Embedding index (vault → Prism Server semantic index) — every 5 minutes.
        // Needs the server (COLLAB_TOKEN); embeddings are a server-provided service.
        let embedding_index_status = Arc::new(std::sync::Mutex::new(ServiceStatus::new("embedding-index")));
        if should_start(SVC_EMBEDDING) {
            let p = parachute.clone();
            let rx = shutdown_rx.clone();
            let status = embedding_index_status.clone();
            let collab_url = config.collab_url.clone();
            let token = config.collab_token.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                embedding_index::run(p, collab_url, token, rx, status).await;
            }));
        } else {
            log_disabled(&plans, SVC_EMBEDDING);
        }

        log_disabled(&plans, SVC_SCHEDULER);
        log::info!("ServiceManager started {} background services", handles.len());

        Self {
            shutdown_tx,
            shutdown_rx,
            handles,
            parachute_url,
            parachute_vault,
            parachute_api_key: parachute_key,
            plans,
            message_status,
            calendar_status,
            email_status,
            transcript_status,
            scheduler_status,
            notion_task_sync_status,
            embedding_index_status,
        }
    }

    /// Start the skill scheduler (must be called after DispatchManager is created).
    /// Skipped (reason logged at start) in client mode or with disable_skill_scheduler.
    pub fn start_scheduler(&self, dispatch_manager: Arc<agent_dispatch::DispatchManager>) {
        if !self.plans.iter().any(|p| p.name == SVC_SCHEDULER && p.start) {
            return;
        }
        let parachute = Arc::new(ParachuteClient::new(&self.parachute_url, &self.parachute_vault, self.parachute_api_key.clone()));
        let rx = self.shutdown_rx.clone();
        let status = self.scheduler_status.clone();
        tauri::async_runtime::spawn(async move {
            skill_scheduler::run(parachute, dispatch_manager, rx, status).await;
        });
        log::info!("Skill scheduler started");
    }

    /// Get status of all services.
    pub fn status(&self) -> Vec<ServiceStatus> {
        let all = vec![
            self.message_status.lock().unwrap().clone(),
            self.calendar_status.lock().unwrap().clone(),
            self.email_status.lock().unwrap().clone(),
            self.transcript_status.lock().unwrap().clone(),
            self.scheduler_status.lock().unwrap().clone(),
            self.notion_task_sync_status.lock().unwrap().clone(),
            self.embedding_index_status.lock().unwrap().clone(),
        ];
        all.into_iter()
            .map(|mut st| {
                if let Some(plan) = self.plans.iter().find(|p| p.name == st.name && !p.start) {
                    st.running = false;
                    st.disabled = true;
                    st.disabled_reason = plan.reason.clone();
                }
                st
            })
            .collect()
    }

    /// Shutdown all services gracefully.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        log::info!("ServiceManager: shutdown signal sent to all services");
    }
}

fn log_disabled(plans: &[ServicePlan], name: &str) {
    if let Some(p) = plans.iter().find(|p| p.name == name && !p.start) {
        log::info!("{} disabled: {}", p.name, p.reason.as_deref().unwrap_or("unknown"));
    }
}

impl Drop for ServiceManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(patch: &[(&str, serde_json::Value)]) -> AppConfig {
        let mut v = serde_json::to_value(AppConfig::default()).unwrap();
        let o = v.as_object_mut().unwrap();
        for (k, val) in patch {
            o.insert((*k).to_string(), val.clone());
        }
        serde_json::from_value(v).unwrap()
    }

    /// A config with every integration configured so only mode/flags decide.
    fn fully_configured(extra: &[(&str, serde_json::Value)]) -> AppConfig {
        let mut patch = vec![
            ("matrix_access_token", serde_json::json!("tok")),
            ("google_account_primary", serde_json::json!("me@example.com")),
            ("fathom_api_key", serde_json::json!("fk")),
            ("fireflies_api_key", serde_json::json!("ffk")),
            ("meetily_db_path", serde_json::json!("/tmp/meetily.db")),
            ("notion_api_key", serde_json::json!("nk")),
            ("collab_token", serde_json::json!("ct")),
        ];
        patch.extend(extra.iter().map(|(k, v)| (*k, v.clone())));
        cfg(&patch)
    }

    fn started(c: &AppConfig) -> Vec<&'static str> {
        plan_services(c).into_iter().filter(|p| p.start).map(|p| p.name).collect()
    }

    fn plan_for(c: &AppConfig, name: &str) -> ServicePlan {
        plan_services(c).into_iter().find(|p| p.name == name).unwrap()
    }

    #[test]
    fn default_host_mode_starts_everything_configured() {
        let all = started(&fully_configured(&[]));
        assert_eq!(all.len(), 7, "host + all configured + no flags = today's behaviour: {all:?}");
    }

    #[test]
    fn unconfigured_default_config_matches_todays_gates() {
        // Only the scheduler has no credential gate.
        assert_eq!(started(&AppConfig::default()), vec![SVC_SCHEDULER]);
    }

    #[test]
    fn client_mode_starts_nothing_and_says_why() {
        let c = fully_configured(&[("ingest_mode", serde_json::json!("client"))]);
        assert!(started(&c).is_empty());
        for p in plan_services(&c) {
            assert!(p.reason.unwrap().contains("client mode"), "{} must name client mode", p.name);
        }
    }

    #[test]
    fn each_flag_suppresses_only_its_service() {
        let cases = [
            ("disable_message_sync", SVC_MESSAGE),
            ("disable_email_sync", SVC_EMAIL),
            ("disable_calendar_sync", SVC_CALENDAR),
            ("disable_embedding_index", SVC_EMBEDDING),
            ("disable_skill_scheduler", SVC_SCHEDULER),
            ("disable_notion_task_sync", SVC_NOTION),
        ];
        for (flag, svc) in cases {
            let c = fully_configured(&[(flag, serde_json::json!(true))]);
            let s = started(&c);
            assert!(!s.contains(&svc), "{flag} must suppress {svc}");
            assert_eq!(s.len(), 6, "{flag} must suppress ONLY {svc}: {s:?}");
            assert!(plan_for(&c, svc).reason.unwrap().contains(flag));
        }
    }

    #[test]
    fn meetily_flag_keeps_shared_transcript_service_while_other_sources_remain() {
        let c = fully_configured(&[("disable_meetily_sync", serde_json::json!(true))]);
        assert!(started(&c).contains(&SVC_TRANSCRIPT), "Fathom/Fireflies still need the service");
        // ...and only-Meetily + flag means the service has nothing to do.
        let only = cfg(&[
            ("meetily_db_path", serde_json::json!("/tmp/m.db")),
            ("disable_meetily_sync", serde_json::json!(true)),
        ]);
        assert!(!started(&only).contains(&SVC_TRANSCRIPT));
        assert!(plan_for(&only, SVC_TRANSCRIPT).reason.unwrap().contains("disabled"));
    }

    #[test]
    fn client_mode_manager_starts_no_tasks_and_reports_all_disabled() {
        let c = fully_configured(&[("ingest_mode", serde_json::json!("client"))]);
        let m = ServiceManager::start(&c);
        assert!(m.handles.is_empty(), "client mode must spawn no tasks");
        let st = m.status();
        assert_eq!(st.len(), 7);
        for s in st {
            assert!(s.disabled && !s.running, "{} must show disabled", s.name);
            assert!(s.disabled_reason.unwrap().contains("client mode"));
        }
    }

    #[test]
    fn service_status_deserializes_without_new_fields() {
        let st: ServiceStatus = serde_json::from_value(serde_json::json!({
            "name": "x", "running": true, "last_run": null, "last_error": null, "items_processed": 3
        })).unwrap();
        assert!(!st.disabled && st.disabled_reason.is_none());
    }
}
