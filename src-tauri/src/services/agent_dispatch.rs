use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::CreateNoteParams;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Dispatch {
    pub id: String,
    pub skill: String,
    pub prompt: String,
    pub status: DispatchStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub duration_secs: Option<u64>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub note_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DispatchStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// Manages background agent dispatches.
/// Each dispatch spawns a Claude Code CLI process with MCP access.
pub struct DispatchManager {
    dispatches: Arc<Mutex<HashMap<String, Dispatch>>>,
    parachute: Arc<ParachuteClient>,
}

impl DispatchManager {
    pub fn new() -> Self {
        Self {
            dispatches: Arc::new(Mutex::new(HashMap::new())),
            parachute: Arc::new(ParachuteClient::new(1940, None)),
        }
    }

    /// Start a new dispatch. Spawns a Claude Code process in the background
    /// and tracks its status.
    pub async fn dispatch(
        &self,
        skill: &str,
        prompt: &str,
        context: Option<&str>,
    ) -> Result<String, PrismError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();

        let dispatch = Dispatch {
            id: id.clone(),
            skill: skill.to_string(),
            prompt: prompt.to_string(),
            status: DispatchStatus::Running,
            started_at: now.to_rfc3339(),
            completed_at: None,
            duration_secs: None,
            output: None,
            error: None,
            note_id: None,
        };

        {
            let mut dispatches = self.dispatches.lock().await;
            dispatches.insert(id.clone(), dispatch);
        }

        // Build the full prompt with system context
        let full_prompt = if let Some(ctx) = context {
            format!("{}\n\n{}", ctx, prompt)
        } else {
            format!(
                "You are an agent running a background task in Prism. \
                 Use the Parachute MCP tools to read and write vault notes as needed.\n\n\
                 Task: {}\n\n\
                 When done, output a concise summary of what you did and any results.",
                prompt
            )
        };

        // Spawn the Claude process
        let dispatches = self.dispatches.clone();
        let dispatch_id = id.clone();
        let parachute_url = "http://localhost:1940".to_string();

        // We need to run claude CLI — get the binary path and env from the client
        // Since ClaudeClient doesn't expose internals, we'll spawn via its run method
        // in a background task
        let prompt_owned = full_prompt.clone();
        let skill_owned = skill.to_string();

        let claude_bin = which_claude();
        let prism_root = find_prism_root();
        log::info!("Dispatch {}: spawning claude at {:?} in {:?}", dispatch_id, claude_bin, prism_root);

        let clean_env: HashMap<String, String> = std::env::vars()
            .filter(|(k, _)| k != "CLAUDECODE")
            .collect();

        let child = tokio::process::Command::new(&claude_bin)
            .args(&[
                "-p",
                "--model", "sonnet",
                "--dangerously-skip-permissions",
                &prompt_owned,
            ])
            .current_dir(&prism_root)
            .envs(&clean_env)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();

        match child {
            Ok(child) => {

                // Spawn a task to wait for completion
                let process_dispatches = dispatches.clone();
                let process_id = dispatch_id.clone();
                let persist_parachute = self.parachute.clone();
                let persist_skill = skill.to_string();

                tauri::async_runtime::spawn(async move {
                    let start = std::time::Instant::now();

                    // Wait with timeout (10 minutes max)
                    let result = tokio::time::timeout(
                        std::time::Duration::from_secs(600),
                        child.wait_with_output(),
                    ).await;

                    let elapsed = start.elapsed().as_secs();

                    let mut dispatches = process_dispatches.lock().await;
                    if let Some(dispatch) = dispatches.get_mut(&process_id) {
                        // Skip if already cancelled
                        if dispatch.status == DispatchStatus::Cancelled {
                            return;
                        }

                        dispatch.duration_secs = Some(elapsed);
                        dispatch.completed_at = Some(chrono::Utc::now().to_rfc3339());

                        match result {
                            Ok(Ok(output)) => {
                                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

                                if output.status.success() {
                                    log::info!("Dispatch {} stdout ({} chars): {}", process_id, stdout.len(), &stdout[..stdout.len().min(500)]);
                                    if !stderr.is_empty() {
                                        log::debug!("Dispatch {} stderr: {}", process_id, &stderr[..stderr.len().min(300)]);
                                    }
                                    dispatch.status = DispatchStatus::Completed;
                                    dispatch.output = Some(stdout);
                                } else {
                                    log::warn!("Dispatch {} failed. stderr: {} stdout: {}", process_id, &stderr[..stderr.len().min(300)], &stdout[..stdout.len().min(300)]);
                                    dispatch.status = DispatchStatus::Failed;
                                    dispatch.error = Some(if stderr.is_empty() { stdout } else { stderr });
                                }
                            }
                            Ok(Err(e)) => {
                                dispatch.status = DispatchStatus::Failed;
                                dispatch.error = Some(format!("Process error: {}", e));
                            }
                            Err(_) => {
                                dispatch.status = DispatchStatus::Failed;
                                dispatch.error = Some("Timed out after 10 minutes".into());
                            }
                        }

                        log::info!(
                            "Dispatch {} ({}) completed: {:?} in {}s",
                            process_id, dispatch.skill, dispatch.status, elapsed
                        );

                        // Auto-persist completed dispatches to Parachute
                        if dispatch.status == DispatchStatus::Completed {
                            let dispatch_clone = dispatch.clone();
                            let parachute = persist_parachute.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(e) = persist_to_vault(&parachute, &dispatch_clone).await {
                                    log::warn!("Failed to persist dispatch {}: {}", dispatch_clone.id, e);
                                }
                            });
                        }
                    }
                });
            }
            Err(e) => {
                let mut dispatches = self.dispatches.lock().await;
                if let Some(dispatch) = dispatches.get_mut(&id) {
                    dispatch.status = DispatchStatus::Failed;
                    dispatch.error = Some(format!("Failed to spawn claude: {}", e));
                    dispatch.completed_at = Some(chrono::Utc::now().to_rfc3339());
                }
                return Err(PrismError::Agent(format!("Failed to spawn: {}", e)));
            }
        }

        Ok(id)
    }

    /// Get all dispatches (active and completed).
    pub async fn list(&self) -> Vec<Dispatch> {
        let dispatches = self.dispatches.lock().await;
        let mut list: Vec<Dispatch> = dispatches.values().cloned().collect();
        list.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        list
    }

    /// Cancel a running dispatch.
    pub async fn cancel(&self, id: &str) -> Result<(), PrismError> {
        let mut dispatches = self.dispatches.lock().await;
        if let Some(dispatch) = dispatches.get_mut(id) {
            if dispatch.status == DispatchStatus::Running {
                dispatch.status = DispatchStatus::Cancelled;
                dispatch.completed_at = Some(chrono::Utc::now().to_rfc3339());
                // Note: the actual process kill would need the PID, which is tricky
                // since we spawned it via tokio. For now, just mark as cancelled.
                Ok(())
            } else {
                Err(PrismError::Agent("Dispatch is not running".into()))
            }
        } else {
            Err(PrismError::Agent("Dispatch not found".into()))
        }
    }

    /// Save a completed dispatch as a Parachute note for persistence.
    pub async fn persist_dispatch(
        &self,
        parachute: &ParachuteClient,
        id: &str,
    ) -> Result<String, PrismError> {
        let dispatches = self.dispatches.lock().await;
        let dispatch = dispatches.get(id)
            .ok_or_else(|| PrismError::Agent("Dispatch not found".into()))?;

        if dispatch.status == DispatchStatus::Running {
            return Err(PrismError::Agent("Cannot persist a running dispatch".into()));
        }

        let date = &dispatch.started_at[..10];
        let slug = dispatch.skill.replace(' ', "-").to_lowercase();
        let path = format!("vault/agent/dispatches/{}/{}", date, slug);

        let mut content = format!("# Agent Dispatch: {}\n\n", dispatch.skill);
        content.push_str(&format!("**Status:** {:?}\n", dispatch.status));
        content.push_str(&format!("**Started:** {}\n", dispatch.started_at));
        if let Some(ref completed) = dispatch.completed_at {
            content.push_str(&format!("**Completed:** {}\n", completed));
        }
        if let Some(secs) = dispatch.duration_secs {
            content.push_str(&format!("**Duration:** {}s\n", secs));
        }
        content.push_str(&format!("\n## Prompt\n\n{}\n", dispatch.prompt));
        if let Some(ref output) = dispatch.output {
            content.push_str(&format!("\n## Output\n\n{}\n", output));
        }
        if let Some(ref error) = dispatch.error {
            content.push_str(&format!("\n## Error\n\n{}\n", error));
        }

        let metadata = serde_json::json!({
            "type": "agent-dispatch",
            "skill": dispatch.skill,
            "status": format!("{:?}", dispatch.status).to_lowercase(),
            "startedAt": dispatch.started_at,
            "completedAt": dispatch.completed_at,
            "durationSecs": dispatch.duration_secs,
        });

        let note = parachute.create_note(&CreateNoteParams {
            content,
            path: Some(path),
            metadata: Some(metadata),
            tags: Some(vec!["agent-dispatch".into()]),
        }).await?;

        Ok(note.id)
    }
}

/// Persist a dispatch result to Parachute as a note.
async fn persist_to_vault(
    parachute: &ParachuteClient,
    dispatch: &Dispatch,
) -> Result<(), PrismError> {
    let date = &dispatch.started_at[..10];
    let slug = dispatch.skill.replace(' ', "-").to_lowercase();
    let short_id = &dispatch.id[..8];
    let path = format!("vault/agent/dispatches/{}/{}-{}", date, slug, short_id);

    let mut content = format!("# Agent: {}\n\n", dispatch.skill);
    content.push_str(&format!("**Status:** {:?}\n", dispatch.status));
    content.push_str(&format!("**Started:** {}\n", dispatch.started_at));
    if let Some(ref completed) = dispatch.completed_at {
        content.push_str(&format!("**Completed:** {}\n", completed));
    }
    if let Some(secs) = dispatch.duration_secs {
        content.push_str(&format!("**Duration:** {}s\n", secs));
    }
    if let Some(ref output) = dispatch.output {
        content.push_str(&format!("\n---\n\n{}\n", output));
    }
    if let Some(ref error) = dispatch.error {
        content.push_str(&format!("\n## Error\n\n{}\n", error));
    }

    let metadata = serde_json::json!({
        "type": "agent-dispatch",
        "skill": dispatch.skill,
        "status": format!("{:?}", dispatch.status).to_lowercase(),
        "startedAt": dispatch.started_at,
        "completedAt": dispatch.completed_at,
        "durationSecs": dispatch.duration_secs,
    });

    parachute.create_note(&CreateNoteParams {
        content,
        path: Some(path),
        metadata: Some(metadata),
        tags: Some(vec!["agent-dispatch".into(), "agent-output".into()]),
    }).await?;

    log::info!("Persisted dispatch {} to vault", dispatch.id);
    Ok(())
}

/// Find the Prism project root (where .mcp.json lives).
/// In dev: current_dir works. In release .app bundle: fall back to known paths.
fn find_prism_root() -> std::path::PathBuf {
    // Try current dir first (works in dev)
    let cwd = std::env::current_dir().unwrap_or_default();
    if cwd.join(".mcp.json").exists() {
        return cwd;
    }

    // Known path (production)
    let known = dirs::home_dir()
        .unwrap_or_default()
        .join("iCloud Drive (Archive)/Documents/cursor projects/prism");
    if known.join(".mcp.json").exists() {
        return known;
    }

    // Last resort: search common locations
    log::warn!("Could not find Prism project root with .mcp.json, using fallback");
    known
}

fn which_claude() -> String {
    std::process::Command::new("which")
        .arg("claude")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            let home = dirs::home_dir().unwrap_or_default();
            let npm_global = home.join(".npm-global/bin/claude");
            if npm_global.exists() {
                return npm_global.to_string_lossy().to_string();
            }
            "claude".to_string()
        })
}
