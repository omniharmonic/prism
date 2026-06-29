use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use crate::clients::local_agent::LocalAgent;
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::CreateNoteParams;

/// System prompt for recurring skills running on a local model via the agentic
/// tool loop. Mirrors the data-access rules used for the `claude -p` path but is
/// phrased for the actual Parachute MCP tool names the local agent sees.
const LOCAL_AGENT_SYSTEM: &str = "You are a background agent for Prism, a desktop knowledge-management app. \
All vault data lives in the Parachute knowledge graph and is reachable ONLY through the provided \
parachute-vault tools (query-notes, create-note, update-note, delete-note, list-tags, update-tag, \
find-path, vault-info). There is no filesystem: paths like \"vault/tasks/active/foo\" are Parachute note \
paths you pass to those tools, never files on disk. Use the tools to read and write the vault; do not \
fabricate results. Work through the task step by step, then end with a short plain-text summary of what \
you changed.";

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
///
/// Each dispatch runs a recurring skill either on a local OpenAI-compatible
/// model (when `background_provider == "local"` and a [`LocalAgent`] is wired)
/// or by spawning a `claude -p` subprocess (the legacy path). When the local
/// path is selected but the local server fails, it falls back to `claude -p` so
/// scheduled runs keep working during the transition.
pub struct DispatchManager {
    dispatches: Arc<Mutex<HashMap<String, Dispatch>>>,
    parachute: Arc<ParachuteClient>,
    /// Local agent for the `"local"` background provider. `None` if the local
    /// server/MCP couldn't be reached at startup.
    local_agent: Option<Arc<LocalAgent>>,
    /// `"claude"` (spawn `claude -p`) or `"local"` (use `local_agent`, with a
    /// `claude -p` fallback).
    background_provider: String,
    /// Model id to request from the local server.
    local_model: String,
}

impl DispatchManager {
    pub fn new(
        parachute_url: &str,
        parachute_vault: &str,
        parachute_api_key: Option<String>,
        local_agent: Option<Arc<LocalAgent>>,
        background_provider: String,
        local_model: String,
    ) -> Self {
        Self {
            dispatches: Arc::new(Mutex::new(HashMap::new())),
            parachute: Arc::new(ParachuteClient::new(parachute_url, parachute_vault, parachute_api_key)),
            local_agent,
            background_provider,
            local_model,
        }
    }

    /// Repoint the background dispatch stack at a different vault with no restart.
    /// The report-note writer (`parachute`) follows immediately. The `claude -p`
    /// agent path follows via the regenerated managed MCP config (rewritten by the
    /// caller). `reconnect_local_mcp` handles the optional local-model MCP session.
    pub fn set_vault(&self, url: &str, vault: &str, token: Option<String>) {
        self.parachute.set_vault(url, vault, token);
    }

    /// Reconnect the local-model agent's vault MCP session to `mcp_url` (no-op when
    /// no local agent is wired). Best-effort: logs and swallows reconnect errors so
    /// a vault switch never fails on the opt-in local path.
    pub async fn reconnect_local_mcp(&self, mcp_url: &str, api_key: Option<&str>) {
        if let Some(agent) = &self.local_agent {
            if let Err(e) = agent.reconnect_mcp(mcp_url, api_key).await {
                log::warn!("local agent MCP reconnect failed (vault switch): {e}");
            }
        }
    }

    /// Resolve the effective routing for a dispatch, honoring optional per-skill
    /// overrides and falling back to the global background defaults.
    ///
    /// Returns `(use_local, model)`: `use_local` is true when the effective
    /// provider is local (`"local"`/`"ollama"`), a local agent is wired, and a
    /// non-empty model id is available; `model` is the local model id to request.
    fn effective_routing(
        &self,
        provider_override: Option<&str>,
        model_override: Option<&str>,
    ) -> (bool, String) {
        let provider = provider_override
            .filter(|p| !p.is_empty())
            .unwrap_or(&self.background_provider);
        let model = model_override
            .filter(|m| !m.is_empty())
            .unwrap_or(&self.local_model)
            .to_string();
        let is_local = provider == "local" || provider == "ollama";
        let use_local = is_local && self.local_agent.is_some() && !model.is_empty();
        (use_local, model)
    }

    /// Start a new agentic dispatch on the local model or a `claude -p`
    /// subprocess, per the effective routing. `provider_override` /
    /// `model_override` come from the skill's metadata (per-skill override);
    /// pass `None` to use the global background defaults.
    pub async fn dispatch(
        &self,
        skill: &str,
        prompt: &str,
        context: Option<&str>,
        provider_override: Option<&str>,
        model_override: Option<&str>,
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
                "You are a background agent for Prism, a desktop knowledge management app.\n\n\
                 ## CRITICAL: Data access rules\n\n\
                 - ALL vault data lives in the Parachute database, accessed ONLY via the \
                 parachute-vault MCP server tools (search-notes, get-note, create-note, \
                 update-note, list-tags, traverse-links, etc.).\n\
                 - NEVER write vault data using filesystem tools (Write, Bash). \
                 The vault is NOT on the local filesystem.\n\
                 - The Read tool is available ONLY for reading temp files that Claude Code \
                 creates when MCP responses are too large. Do NOT use Read to explore the filesystem.\n\
                 - When a task mentions paths like \"vault/meetings/...\" or \"vault/tasks/...\", \
                 these are Parachute note paths passed to MCP tools, NOT filesystem paths.\n\
                 - Do NOT search the filesystem for vault content. There may be an unrelated \
                 Obsidian vault on disk — ignore it completely.\n\n\
                 ## Task\n\n{}\n\n\
                 When done, output a concise summary of what you did and any results.",
                prompt
            )
        };

        // Route the dispatch: local model (agentic loop) or claude -p subprocess.
        let (use_local, model) = self.effective_routing(provider_override, model_override);
        if use_local {
            let agent = self.local_agent.clone().expect("effective_routing checked is_some");
            let dispatches = self.dispatches.clone();
            let parachute = self.parachute.clone();
            let id_c = id.clone();
            let skill_c = skill.to_string();
            let prompt_c = prompt.to_string();
            let claude_prompt = full_prompt.clone(); // used only if the local path fails

            tauri::async_runtime::spawn(async move {
                let start = std::time::Instant::now();
                log::info!("Dispatch {}: running '{}' on local model '{}'", id_c, skill_c, model);

                // Bound the whole agentic loop at 25 min; each model call gets 10 min.
                // Use the dispatch id as the context key so each scheduled run starts
                // with a clean conversation (no stale history bleeding across runs).
                let res = tokio::time::timeout(
                    std::time::Duration::from_secs(1500),
                    agent.run_agentic(LOCAL_AGENT_SYSTEM, &prompt_c, &id_c, &model, 600),
                ).await;

                match res {
                    Ok(Ok(output)) => {
                        finalize_dispatch(
                            &dispatches, &parachute, &id_c,
                            DispatchStatus::Completed, Some(output), None,
                            start.elapsed().as_secs(),
                        ).await;
                    }
                    Ok(Err(e)) => {
                        log::warn!("Dispatch {}: local model failed ({}); falling back to claude -p", id_c, e);
                        spawn_claude_process(dispatches, parachute, id_c, skill_c, claude_prompt);
                    }
                    Err(_) => {
                        log::warn!("Dispatch {}: local model timed out after 25m; falling back to claude -p", id_c);
                        spawn_claude_process(dispatches, parachute, id_c, skill_c, claude_prompt);
                    }
                }
            });

            return Ok(id);
        }

        // Default path: spawn a claude -p subprocess.
        spawn_claude_process(
            self.dispatches.clone(),
            self.parachute.clone(),
            id.clone(),
            skill.to_string(),
            full_prompt,
        );

        Ok(id)
    }

    /// Dispatch a structured-output classification skill.
    ///
    /// `rubric` is the skill note content (classification instructions) and
    /// `structured_meta` is the note's full metadata, from which the
    /// `structured` config block is parsed. Runs on the local model when
    /// available (the schema guarantee only holds there); otherwise falls back
    /// to a `claude -p` agentic run using the rubric as the task prompt.
    pub async fn dispatch_structured(
        &self,
        skill: &str,
        rubric: &str,
        structured_meta: serde_json::Value,
        provider_override: Option<&str>,
        model_override: Option<&str>,
    ) -> Result<String, PrismError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        {
            let mut dispatches = self.dispatches.lock().await;
            dispatches.insert(
                id.clone(),
                Dispatch {
                    id: id.clone(),
                    skill: skill.to_string(),
                    prompt: rubric.to_string(),
                    status: DispatchStatus::Running,
                    started_at: now.to_rfc3339(),
                    completed_at: None,
                    duration_secs: None,
                    output: None,
                    error: None,
                    note_id: None,
                },
            );
        }

        // Structured mode needs the local model (for grammar-constrained output).
        let (use_local, model) = self.effective_routing(provider_override, model_override);
        if use_local {
            let cfg = match crate::services::structured_skill::StructuredConfig::from_metadata(&structured_meta) {
                Ok(c) => c,
                Err(reason) => {
                    finalize_dispatch(
                        &self.dispatches, &self.parachute, &id,
                        DispatchStatus::Failed, None,
                        Some(format!("structured skill misconfigured: {reason}")),
                        0,
                    ).await;
                    return Ok(id);
                }
            };

            let agent = self.local_agent.clone().expect("effective_routing checked is_some");
            let dispatches = self.dispatches.clone();
            let parachute = self.parachute.clone();
            let rubric = rubric.to_string();
            let id_c = id.clone();

            tauri::async_runtime::spawn(async move {
                let start = std::time::Instant::now();
                let (status, output, error) =
                    match crate::services::structured_skill::run(&agent, &parachute, &rubric, &cfg, &model).await {
                        Ok(summary) => (DispatchStatus::Completed, Some(summary), None),
                        Err(e) => (DispatchStatus::Failed, None, Some(e.to_string())),
                    };
                finalize_dispatch(&dispatches, &parachute, &id_c, status, output, error, start.elapsed().as_secs()).await;
            });

            return Ok(id);
        }

        // No local model — fall back to claude -p, running the rubric agentically.
        log::warn!("Dispatch {}: structured skill '{}' has no local model; falling back to claude -p", id, skill);
        let fallback_prompt = format!(
            "You are a background agent for Prism. Apply the following classification rubric to the \
             matching vault notes, using the parachute-vault MCP tools to read notes and to add the \
             resulting tags via update-note. Be idempotent — skip notes that already carry the result \
             tag.\n\n{}",
            rubric
        );
        spawn_claude_process(
            self.dispatches.clone(),
            self.parachute.clone(),
            id.clone(),
            skill.to_string(),
            fallback_prompt,
        );
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

/// Spawn a `claude -p` subprocess for a dispatch and, in a background task,
/// wait for it, record the terminal state, and persist the result. Used both as
/// the default background path and as the fallback when the local model fails.
fn spawn_claude_process(
    dispatches: Arc<Mutex<HashMap<String, Dispatch>>>,
    parachute: Arc<ParachuteClient>,
    id: String,
    _skill: String,
    full_prompt: String,
) {
    let claude_bin = which_claude();
    let prism_root = find_prism_root();
    log::info!("Dispatch {}: spawning claude at {:?} in {:?}", id, claude_bin, prism_root);

    let mut clean_env: HashMap<String, String> = std::env::vars()
        .filter(|(k, _)| k != "CLAUDECODE")
        .collect();

    // macOS .app bundles inherit a minimal PATH that excludes Homebrew/nvm/fnm.
    ensure_node_in_path(&mut clean_env);

    // Raise the stream idle watchdog from 90s to 300s — MCP-heavy skills go
    // silent while large result sets stream back. The 30-min wall clock below
    // still bounds true hangs.
    clean_env
        .entry("CLAUDE_STREAM_IDLE_TIMEOUT_MS".to_string())
        .or_insert_with(|| "300000".to_string());

    // Pass --mcp-config explicitly rather than relying on global auto-discovery.
    // A future Claude Code release makes --bare the default for -p, which skips
    // auto-discovery of ~/.claude/settings.json MCP servers; passing an explicit
    // config keeps Parachute MCP available in this fallback path regardless.
    // Prefer the MANAGED config (regenerated from the active vault on every switch,
    // and present even in a released `.app`); fall back to the repo `.mcp.json`.
    let managed = crate::commands::config::AppConfig::managed_mcp_config_path();
    let mcp_config = if managed.exists() {
        managed
    } else {
        prism_root.join(".mcp.json")
    };
    let mut args = vec![
        "-p".to_string(),
        "--model".to_string(), "sonnet".to_string(),
        "--dangerously-skip-permissions".to_string(),
        // Block filesystem write/search tools — agents must use Parachute MCP, not
        // local files (there may be an unrelated Obsidian vault on disk). Read stays
        // allowed: Claude Code spills large MCP responses to temp files it must Read.
        "--disallowedTools".to_string(),
        "Write,Edit,Bash,Glob,Grep".to_string(),
    ];
    if mcp_config.exists() {
        args.push("--mcp-config".to_string());
        args.push(mcp_config.to_string_lossy().to_string());
    }
    args.push("--".to_string());
    args.push(full_prompt);

    let child = tokio::process::Command::new(&claude_bin)
        .args(&args)
        .current_dir(&prism_root)
        .envs(&clean_env)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    match child {
        Ok(child) => {
            tauri::async_runtime::spawn(async move {
                let start = std::time::Instant::now();
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(1800),
                    child.wait_with_output(),
                ).await;
                let elapsed = start.elapsed().as_secs();

                let (status, output, error) = match result {
                    Ok(Ok(out)) => {
                        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                        if out.status.success() {
                            log::info!("Dispatch {} claude stdout ({} chars)", id, stdout.len());
                            (DispatchStatus::Completed, Some(stdout), None)
                        } else {
                            log::warn!("Dispatch {} claude failed: {}", id, &stderr[..stderr.len().min(300)]);
                            (DispatchStatus::Failed, None, Some(if stderr.is_empty() { stdout } else { stderr }))
                        }
                    }
                    Ok(Err(e)) => (DispatchStatus::Failed, None, Some(format!("Process error: {}", e))),
                    Err(_) => (DispatchStatus::Failed, None, Some("Timed out after 30 minutes".into())),
                };

                finalize_dispatch(&dispatches, &parachute, &id, status, output, error, elapsed).await;
            });
        }
        Err(e) => {
            tauri::async_runtime::spawn(async move {
                let mut guard = dispatches.lock().await;
                if let Some(d) = guard.get_mut(&id) {
                    d.status = DispatchStatus::Failed;
                    d.error = Some(format!("Failed to spawn claude: {}", e));
                    d.completed_at = Some(chrono::Utc::now().to_rfc3339());
                }
            });
        }
    }
}

/// Record a dispatch's terminal state in the map and persist it to the vault.
/// No-op if the dispatch was cancelled while running.
async fn finalize_dispatch(
    dispatches: &Arc<Mutex<HashMap<String, Dispatch>>>,
    parachute: &Arc<ParachuteClient>,
    id: &str,
    status: DispatchStatus,
    output: Option<String>,
    error: Option<String>,
    elapsed: u64,
) {
    let snapshot = {
        let mut guard = dispatches.lock().await;
        let Some(d) = guard.get_mut(id) else { return };
        if d.status == DispatchStatus::Cancelled {
            return;
        }
        d.status = status;
        d.output = output;
        d.error = error;
        d.duration_secs = Some(elapsed);
        d.completed_at = Some(chrono::Utc::now().to_rfc3339());
        log::info!("Dispatch {} ({}) -> {:?} in {}s", id, d.skill, d.status, elapsed);
        d.clone()
    };

    if matches!(snapshot.status, DispatchStatus::Completed | DispatchStatus::Failed) {
        if let Err(e) = persist_to_vault(parachute, &snapshot).await {
            log::warn!("Failed to persist dispatch {}: {}", snapshot.id, e);
        }
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

/// Ensure the PATH in the environment includes directories where `node` is likely installed.
/// macOS .app bundles inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that won't
/// include Homebrew, nvm, fnm, or volta-managed Node.js installations.
fn ensure_node_in_path(env: &mut HashMap<String, String>) {
    let current_path = env.get("PATH").cloned().unwrap_or_default();

    // Check if node is already reachable in the current PATH
    let node_found = std::process::Command::new("node")
        .arg("--version")
        .env("PATH", &current_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if node_found {
        return;
    }

    let home = dirs::home_dir().unwrap_or_default();
    let extra_dirs: Vec<std::path::PathBuf> = vec![
        // Homebrew (Apple Silicon + Intel)
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        // bun
        home.join(".bun/bin"),
        // nvm
        home.join(".nvm/versions/node"),
        // fnm
        home.join(".local/share/fnm/aliases/default/bin"),
        home.join("Library/Application Support/fnm/aliases/default/bin"),
        // volta
        home.join(".volta/bin"),
        // Global npm
        home.join(".npm-global/bin"),
    ];

    let mut additions = Vec::new();
    for dir in &extra_dirs {
        if dir.to_string_lossy().contains(".nvm/versions/node") {
            // nvm: find the latest installed version
            if let Ok(entries) = std::fs::read_dir(dir) {
                if let Some(latest) = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().join("bin/node").exists())
                    .max_by_key(|e| e.file_name())
                {
                    let bin = latest.path().join("bin");
                    if !current_path.contains(&*bin.to_string_lossy()) {
                        additions.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        } else if dir.exists() && !current_path.contains(&*dir.to_string_lossy()) {
            additions.push(dir.to_string_lossy().to_string());
        }
    }

    if !additions.is_empty() {
        let new_path = format!("{}:{}", additions.join(":"), current_path);
        log::info!("Augmented PATH for subprocess: added {}", additions.join(", "));
        env.insert("PATH".to_string(), new_path);
    }
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
