use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use crate::clients::claude_args::{
    build_claude_args, ClaudeRunner, ClaudeUse, OutputFormat, Persistence, RunMcpConfig, VaultMcpTarget,
};
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
    /// The hardened `claude -p` recipe (WP0.1d): binary, env allowlist, empty cwd.
    claude: Arc<ClaudeRunner>,
    /// Kill switches for running `claude -p` dispatches (cancel → child killed,
    /// per-run MCP config deleted).
    cancels: CancelMap,
}

type CancelMap = Arc<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>;

/// Everything `spawn_claude_process` needs, cloned out of the manager so it can
/// run from a detached task (the local-model fallback path).
#[derive(Clone)]
struct ClaudeCtx {
    dispatches: Arc<Mutex<HashMap<String, Dispatch>>>,
    parachute: Arc<ParachuteClient>,
    runner: Arc<ClaudeRunner>,
    cancels: CancelMap,
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
            claude: Arc::new(ClaudeRunner::from_host()),
            cancels: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    fn claude_ctx(&self) -> ClaudeCtx {
        ClaudeCtx {
            dispatches: self.dispatches.clone(),
            parachute: self.parachute.clone(),
            runner: self.claude.clone(),
            cancels: self.cancels.clone(),
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
                 parachute-vault MCP server tools (query-notes, create-note, update-note, \
                 list-tags, find-path, vault-info).\n\
                 - You have NO file, shell, or web access — only the vault MCP tools. \
                 The vault is NOT on the local filesystem.\n\
                 - Keep MCP queries narrow (filters, limits, `include_metadata`) so results \
                 stay small.\n\
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
            let ctx = self.claude_ctx();
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
                        spawn_claude_process(ctx, id_c, claude_prompt);
                    }
                    Err(_) => {
                        log::warn!("Dispatch {}: local model timed out after 25m; falling back to claude -p", id_c);
                        spawn_claude_process(ctx, id_c, claude_prompt);
                    }
                }
            });

            return Ok(id);
        }

        // Default path: spawn a claude -p subprocess.
        spawn_claude_process(self.claude_ctx(), id.clone(), full_prompt);

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
        spawn_claude_process(self.claude_ctx(), id.clone(), fallback_prompt);
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
                // A `claude -p` run is killed (kill_on_drop) and its per-run MCP
                // config deleted. A local-model run is only marked cancelled.
                if let Some(n) = self.cancels.lock().ok().and_then(|m| m.get(id).cloned()) {
                    n.notify_one();
                }
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

/// Spawn a hardened `claude -p` subprocess for a dispatch and, in a background
/// task, wait for it, record the terminal state, and persist the result. Used both
/// as the default background path and as the fallback when the local model fails.
/// The kill switch is registered BEFORE the task starts, so a cancel can never
/// miss a run.
fn spawn_claude_process(ctx: ClaudeCtx, id: String, full_prompt: String) {
    let cancel = Arc::new(tokio::sync::Notify::new());
    if let Ok(mut m) = ctx.cancels.lock() {
        m.insert(id.clone(), cancel.clone());
    }
    log::info!("Dispatch {}: spawning hardened claude at {:?}", id, ctx.runner.claude_bin);
    tauri::async_runtime::spawn(async move {
        let start = std::time::Instant::now();
        let outcome = match VaultMcpTarget::active() {
            Ok(target) => {
                run_claude_dispatch(
                    &ctx.runner, &target, &std::env::temp_dir(), &full_prompt,
                    std::time::Duration::from_secs(1800), &cancel,
                ).await
            }
            Err(e) => (DispatchStatus::Failed, None, Some(e.to_string())),
        };
        if let Ok(mut m) = ctx.cancels.lock() {
            m.remove(&id);
        }
        let (status, output, error) = outcome;
        // A cancelled dispatch is already marked; finalize_dispatch no-ops on it.
        finalize_dispatch(&ctx.dispatches, &ctx.parachute, &id, status, output, error, start.elapsed().as_secs()).await;
    });
}

/// One background `claude -p` run with the `Dispatch` allowlist (vault read +
/// write, never delete). The per-run MCP config lives in `mcp_base` only for the
/// life of this call; on timeout or cancel the child is killed (kill_on_drop).
async fn run_claude_dispatch(
    runner: &ClaudeRunner,
    target: &VaultMcpTarget,
    mcp_base: &std::path::Path,
    prompt: &str,
    timeout: std::time::Duration,
    cancel: &tokio::sync::Notify,
) -> (DispatchStatus, Option<String>, Option<String>) {
    let mcp = match RunMcpConfig::create_in(mcp_base, target) {
        Ok(m) => m,
        Err(e) => return (DispatchStatus::Failed, None, Some(e.to_string())),
    };
    let child = build_claude_args(ClaudeUse::Dispatch, "sonnet", OutputFormat::Text, &Persistence::OneShot, mcp.path(), prompt)
        .and_then(|args| runner.command(&args))
        .and_then(|mut cmd| cmd.spawn().map_err(|e| PrismError::Agent(format!("Failed to spawn claude: {}", e))));
    let child = match child {
        Ok(c) => c,
        Err(e) => return (DispatchStatus::Failed, None, Some(e.to_string())),
    };
    let outcome = tokio::select! {
        r = tokio::time::timeout(timeout, child.wait_with_output()) => match r {
            Ok(Ok(out)) => {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if out.status.success() {
                    (DispatchStatus::Completed, Some(stdout), None)
                } else {
                    log::warn!("claude dispatch failed: {}", stderr.chars().take(300).collect::<String>());
                    (DispatchStatus::Failed, None, Some(if stderr.is_empty() { stdout } else { stderr }))
                }
            }
            Ok(Err(e)) => (DispatchStatus::Failed, None, Some(format!("Process error: {}", e))),
            Err(_) => (DispatchStatus::Failed, None, Some(format!("Timed out after {} minutes", timeout.as_secs() / 60))),
        },
        _ = cancel.notified() => (DispatchStatus::Cancelled, None, Some("Cancelled".into())),
    };
    drop(mcp); // explicit: the token file is gone before we report
    outcome
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clients::claude_args::claude_env;
    use std::path::{Path, PathBuf};

    /// A throwaway dir with a fake `claude` that records its argv/cwd and the
    /// per-run MCP config it was handed, then runs `body`. Never the real CLI.
    fn fake_claude(body: &str) -> (PathBuf, ClaudeRunner) {
        let base = std::env::temp_dir().join(format!("prism-dispatch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("mcp")).unwrap();
        let bin = base.join("claude");
        let rec = base.display();
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{rec}/args'\npwd > '{rec}/cwd'\n\
             while [ $# -gt 0 ]; do if [ \"$1\" = --mcp-config ]; then cp \"$2\" '{rec}/mcp-seen'; fi; shift; done\n{body}\n"
        );
        std::fs::write(&bin, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let runner = ClaudeRunner {
            claude_bin: bin.to_string_lossy().to_string(),
            env: claude_env(std::env::vars(), Path::new("/tmp"), "/bin/sh", None),
            cwd: base.join("agent-cwd"),
        };
        (base, runner)
    }

    fn target() -> VaultMcpTarget {
        VaultMcpTarget::new("http://127.0.0.1:9", "test", "tok")
    }

    fn leftover_mcp(base: &Path) -> usize {
        std::fs::read_dir(base.join("mcp")).unwrap().count()
    }

    #[tokio::test]
    async fn dispatch_runs_hardened_and_cleans_up() {
        let (base, runner) = fake_claude("echo done");
        let cancel = tokio::sync::Notify::new();
        let (status, out, err) = run_claude_dispatch(
            &runner, &target(), &base.join("mcp"), "the task", std::time::Duration::from_secs(20), &cancel,
        ).await;
        assert_eq!(status, DispatchStatus::Completed, "{err:?}");
        assert_eq!(out.as_deref(), Some("done"));
        let args = std::fs::read_to_string(base.join("args")).unwrap();
        assert!(!args.contains("dangerously"));
        assert!(args.contains("--strict-mcp-config\n--mcp-config\n"));
        assert!(args.contains("--permission-mode\ndontAsk\n"));
        assert!(args.contains("--no-session-persistence\n"));
        assert!(!args.contains("delete-note"));
        assert!(args.ends_with("--\nthe task\n"));
        // ran from the agent cwd, which is still empty
        let cwd = std::fs::read_to_string(base.join("cwd")).unwrap();
        assert!(cwd.trim().ends_with("agent-cwd"), "{cwd}");
        assert_eq!(std::fs::read_dir(base.join("agent-cwd")).unwrap().count(), 0);
        // the child saw the vault-only config; it is gone afterwards
        let seen: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(base.join("mcp-seen")).unwrap()).unwrap();
        assert_eq!(seen["mcpServers"].as_object().unwrap().len(), 1);
        assert_eq!(leftover_mcp(&base), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[tokio::test]
    async fn dispatch_failure_and_timeout_clean_up() {
        let (base, runner) = fake_claude("echo boom >&2; exit 3");
        let cancel = tokio::sync::Notify::new();
        let (status, _, err) = run_claude_dispatch(
            &runner, &target(), &base.join("mcp"), "p", std::time::Duration::from_secs(20), &cancel,
        ).await;
        assert_eq!(status, DispatchStatus::Failed);
        assert_eq!(err.as_deref(), Some("boom"));
        assert_eq!(leftover_mcp(&base), 0);
        std::fs::remove_dir_all(&base).unwrap();

        let (base, runner) = fake_claude("sleep 30");
        let t0 = std::time::Instant::now();
        let (status, _, _) = run_claude_dispatch(
            &runner, &target(), &base.join("mcp"), "p", std::time::Duration::from_millis(300), &cancel,
        ).await;
        assert_eq!(status, DispatchStatus::Failed);
        assert!(t0.elapsed() < std::time::Duration::from_secs(10));
        assert_eq!(leftover_mcp(&base), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[tokio::test]
    async fn dispatch_cancel_kills_and_cleans_up() {
        let (base, runner) = fake_claude("sleep 30");
        let cancel = std::sync::Arc::new(tokio::sync::Notify::new());
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            c2.notify_one();
        });
        let t0 = std::time::Instant::now();
        let (status, _, _) = run_claude_dispatch(
            &runner, &target(), &base.join("mcp"), "p", std::time::Duration::from_secs(60), &cancel,
        ).await;
        assert_eq!(status, DispatchStatus::Cancelled);
        assert!(t0.elapsed() < std::time::Duration::from_secs(10));
        assert_eq!(leftover_mcp(&base), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[tokio::test]
    async fn dispatch_refuses_a_non_empty_cwd() {
        let (base, runner) = fake_claude("echo should-not-run");
        std::fs::create_dir_all(base.join("agent-cwd")).unwrap();
        std::fs::write(base.join("agent-cwd/CLAUDE.md"), "planted").unwrap();
        let cancel = tokio::sync::Notify::new();
        let (status, _, err) = run_claude_dispatch(
            &runner, &target(), &base.join("mcp"), "p", std::time::Duration::from_secs(20), &cancel,
        ).await;
        assert_eq!(status, DispatchStatus::Failed);
        assert!(err.unwrap().contains("not empty"));
        assert!(!base.join("args").exists(), "the binary must not have run");
        assert_eq!(leftover_mcp(&base), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
