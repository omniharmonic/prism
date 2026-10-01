use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::error::PrismError;

/// Default vault name when the config predates the `parachute_vault` field.
fn default_ingest_mode() -> String {
    "host".to_string()
}

fn default_vault_name() -> String {
    "default".into()
}

/// One vault the desktop app knows how to talk to. The registry (`AppConfig.vaults`)
/// is the desktop-native equivalent of the web/server multi-vault registry: each
/// entry is a fully self-contained connection (its own hub URL, vault name, and
/// write token). The `token` is NEVER surfaced to the frontend (see `VaultSummary`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VaultEntry {
    /// Registry-unique id (slug derived from the label). Stable handle the UI uses.
    pub id: String,
    /// Human label shown in the vault switcher.
    pub label: String,
    /// Parachute server root, e.g. `http://localhost:1940`.
    pub url: String,
    /// Vault name for the scoped REST/MCP path (`/vault/{vault}/api`).
    pub vault: String,
    /// Bearer token (hub-issued JWT) for this vault. Secret — never returned.
    pub token: String,
}

/// Default base URL for the local OpenAI-compatible AI server.
/// LM Studio serves its OpenAI-compatible API at port 1234 under `/v1`.
/// (Ollama's equivalent is `http://localhost:11434/v1`.)
fn default_local_ai_base_url() -> String {
    "http://localhost:1234/v1".into()
}

/// Default provider for background (recurring) skill dispatches.
/// `"claude"` spawns `claude -p` (legacy); `"local"` routes to the
/// OpenAI-compatible local server. Defaults to `"claude"` so existing
/// installs keep their current behavior until the user opts in.
fn default_background_skill_provider() -> String {
    "claude".into()
}

/// Default Prism Server collab WebSocket endpoint (same machine, default port).
fn default_collab_url() -> String {
    "ws://localhost:8787/collab".into()
}

/// App configuration — loaded from prism-config.json, falling back to
/// omniharmonic .env, falling back to defaults.
/// Serializable so it can be persisted and updated at runtime.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    // Core services
    pub matrix_homeserver: String,
    pub matrix_user: String,
    pub matrix_access_token: String,
    pub matrix_device_id: String,
    /// When true, the desktop does NOT run the background message_sync service —
    /// the Prism Server ingests Matrix server-side instead (no double-sync). The
    /// Matrix token stays configured so live messaging / sending still works.
    #[serde(default)]
    pub disable_message_sync: bool,
    /// When true, the desktop skips the FATHOM half of transcript_sync — the Prism
    /// Server ingests Fathom server-side. Meetily (local SQLite) still syncs on the
    /// desktop. The Fathom key stays configured so live use still works.
    #[serde(default)]
    pub disable_fathom_sync: bool,
    /// When true, the desktop skips the FIREFLIES half of transcript_sync — the
    /// Prism Server ingests Fireflies server-side AND deletes each transcript
    /// from Fireflies once it's confirmed in the vault. Must be true once the
    /// server owns Fireflies, so the two don't double-ingest or race on delete.
    /// The Fireflies key stays configured so live use still works.
    #[serde(default)]
    pub disable_fireflies_sync: bool,
    /// "host" (default): this machine runs the background ingest services. "client":
    /// this machine is a pure viewer/editor — NO background service and NO skill
    /// scheduler starts; the Prism Server does all ingest. Anything other than
    /// "client" is treated as host. Takes effect on restart.
    #[serde(default = "default_ingest_mode")]
    pub ingest_mode: String,
    /// Per-service opt-outs (all default false = today's behaviour). Each is checked
    /// where the service starts, alongside the disable_*_sync flags above.
    #[serde(default)]
    pub disable_email_sync: bool,
    #[serde(default)]
    pub disable_calendar_sync: bool,
    /// Skips only the Meetily half of transcript_sync (Fathom/Fireflies unaffected).
    #[serde(default)]
    pub disable_meetily_sync: bool,
    #[serde(default)]
    pub disable_embedding_index: bool,
    #[serde(default)]
    pub disable_skill_scheduler: bool,
    #[serde(default)]
    pub disable_notion_task_sync: bool,
    pub notion_api_key: String,
    pub google_account_primary: String,
    pub google_account_agent: String,
    pub anthropic_api_key: String,
    pub parachute_url: String,
    #[serde(default)]
    pub parachute_api_key: String,
    /// Vault name for the scoped REST/MCP URLs (`/vault/{name}/...`). Almost
    /// always "default" for a single-vault install. Custom serde default so
    /// pre-existing config files (written before this field existed) resolve
    /// to "default" rather than an empty string.
    #[serde(default = "default_vault_name")]
    pub parachute_vault: String,

    // Transcript data sources
    #[serde(default)]
    pub fathom_api_key: String,
    #[serde(default)]
    pub meetily_db_path: String,
    #[serde(default)]
    pub readai_api_key: String,
    #[serde(default)]
    pub otter_api_key: String,
    #[serde(default)]
    pub fireflies_api_key: String,

    // ── Local AI (OpenAI-compatible: LM Studio, Ollama /v1, llama.cpp, vLLM) ──
    /// Base URL of the local OpenAI-compatible server, including the `/v1` path
    /// segment (e.g. `http://localhost:1234/v1`). Used for recurring-skill
    /// processing and as a local provider in the model router.
    #[serde(default = "default_local_ai_base_url")]
    pub local_ai_base_url: String,
    /// Model identifier to request from the local server (the id it exposes via
    /// `/v1/models`, e.g. `"qwen2.5-14b-instruct"`). Empty = none configured.
    #[serde(default)]
    pub local_ai_model: String,
    /// Which provider runs background (recurring) skills: `"claude"` (spawn
    /// `claude -p`, legacy) or `"local"` (OpenAI-compatible server, with a
    /// `claude -p` fallback when the local server is unavailable).
    #[serde(default = "default_background_skill_provider")]
    pub background_skill_provider: String,

    // ── Real-time collaboration (Prism Server /collab) ──
    /// WebSocket URL of the Prism Server's Hocuspocus endpoint. The desktop app
    /// connects here so its edits sync live with web/phone sessions. Defaults to
    /// the local server; point elsewhere if the Prism Server runs on another host.
    #[serde(default = "default_collab_url")]
    pub collab_url: String,
    /// Dedicated owner token presented to /collab (must match the Prism Server's
    /// COLLAB_TOKEN). Kept separate from the vault token. Empty = collab disabled
    /// on desktop (falls back to the offline autosave editor).
    #[serde(default)]
    pub collab_token: String,

    // ── Multi-vault registry (desktop-native) ──
    /// All vaults this install knows about. Empty in a legacy single-vault config;
    /// `normalize_vaults()` synthesizes a "primary" entry from the legacy
    /// `parachute_*` fields so old configs keep working byte-for-byte.
    #[serde(default)]
    pub vaults: Vec<VaultEntry>,
    /// Id of the active vault in `vaults`. Empty/invalid → resolved to the first
    /// entry by `normalize_vaults()`. The active entry is mirrored back into the
    /// legacy `parachute_url`/`parachute_vault`/`parachute_api_key` fields.
    #[serde(default)]
    pub active_vault_id: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            matrix_homeserver: "http://localhost:8008".into(),
            matrix_user: "@prism:localhost".into(),
            matrix_access_token: String::new(),
            matrix_device_id: "PRISM".into(),
            disable_message_sync: false,
            disable_fathom_sync: false,
            disable_fireflies_sync: false,
            ingest_mode: default_ingest_mode(),
            disable_email_sync: false,
            disable_calendar_sync: false,
            disable_meetily_sync: false,
            disable_embedding_index: false,
            disable_skill_scheduler: false,
            disable_notion_task_sync: false,
            notion_api_key: String::new(),
            google_account_primary: String::new(),
            google_account_agent: String::new(),
            anthropic_api_key: String::new(),
            parachute_url: "http://localhost:1940".into(),
            parachute_api_key: String::new(),
            parachute_vault: "default".into(),
            fathom_api_key: String::new(),
            meetily_db_path: String::new(),
            readai_api_key: String::new(),
            otter_api_key: String::new(),
            fireflies_api_key: String::new(),
            local_ai_base_url: default_local_ai_base_url(),
            local_ai_model: String::new(),
            background_skill_provider: default_background_skill_provider(),
            collab_url: default_collab_url(),
            collab_token: String::new(),
            vaults: Vec::new(),
            active_vault_id: String::new(),
        }
    }
}

impl AppConfig {
    /// Migrate/normalize the vault registry. Backward-compatible and idempotent —
    /// safe to call on every load:
    /// 1. If `vaults` is empty (legacy single-vault config), synthesize a single
    ///    "primary" entry from the legacy `parachute_*` fields.
    /// 2. If `active_vault_id` is empty or names a missing entry, point it at the
    ///    first entry.
    /// 3. Mirror the active entry back into the legacy `parachute_url` /
    ///    `parachute_vault` / `parachute_api_key` fields so everything that still
    ///    reads those (background services, MCP wiring, etc.) keeps working.
    /// True when this machine is a pure client (no background ingest at all).
    pub fn is_client_mode(&self) -> bool {
        self.ingest_mode.trim().eq_ignore_ascii_case("client")
    }

    pub fn normalize_vaults(&mut self) {
        if self.vaults.is_empty() {
            let label = if self.parachute_vault.is_empty() {
                "default".to_string()
            } else {
                self.parachute_vault.clone()
            };
            self.vaults.push(VaultEntry {
                id: "primary".into(),
                label,
                url: self.parachute_url.clone(),
                vault: self.parachute_vault.clone(),
                token: self.parachute_api_key.clone(),
            });
        }
        if self.active_vault_id.is_empty()
            || !self.vaults.iter().any(|v| v.id == self.active_vault_id)
        {
            self.active_vault_id = self.vaults[0].id.clone();
        }
        if let Some(active) = self
            .vaults
            .iter()
            .find(|v| v.id == self.active_vault_id)
            .cloned()
        {
            self.parachute_url = active.url;
            self.parachute_vault = active.vault;
            self.parachute_api_key = active.token;
        }
    }

    /// The currently active vault entry. `normalize_vaults()` (always run on load)
    /// guarantees a non-empty registry with a valid `active_vault_id`.
    pub fn active_entry(&self) -> &VaultEntry {
        self.vaults
            .iter()
            .find(|v| v.id == self.active_vault_id)
            .unwrap_or(&self.vaults[0])
    }

    /// Load config from prism-config.json, falling back to defaults.
    ///
    /// On first launch the config file won't exist — we create it with defaults
    /// so Settings UI always has a file to read/write. Users configure
    /// everything through Settings; no external .env required.
    pub fn load() -> Result<Self, PrismError> {
        Self::load_from(&Self::config_path())
    }

    /// `load()` against an explicit path (tests use a temp dir).
    ///
    /// STRICT about an existing file: if it exists but can't be read or parsed,
    /// this returns an error — it must NEVER fall into the first-launch branch,
    /// which writes defaults and would wipe every stored credential. Callers fall
    /// back to the launch-time managed state instead.
    pub fn load_from(config_path: &std::path::Path) -> Result<Self, PrismError> {
        log::debug!("Loading config from {:?} (exists: {})", config_path, config_path.exists());

        if config_path.exists() {
            let content = std::fs::read_to_string(config_path)
                .map_err(|e| PrismError::Io(format!("Read config {:?}: {}", config_path, e)))?;
            let mut config = serde_json::from_str::<AppConfig>(&content)
                .map_err(|e| PrismError::Config(format!("Config {:?} is not valid (left untouched): {}", config_path, e)))?;
            // Try macOS Keychain for Anthropic key if not in config
            if config.anthropic_api_key.is_empty() {
                if let Some(key) = try_keychain_anthropic() {
                    config.anthropic_api_key = key;
                }
            }
            // Auto-discover Meetily if not configured
            if config.meetily_db_path.is_empty() {
                config.meetily_db_path = auto_discover_meetily().unwrap_or_default();
            }
            // Migrate/normalize the vault registry (synthesizes "primary"
            // for legacy single-vault configs; mirrors the active entry).
            config.normalize_vaults();
            return Ok(config);
        }

        // First launch — check for legacy omniharmonic .env to migrate from
        log::info!("No existing config found, checking for legacy .env to migrate");
        let mut config = Self::default();
        if let Some(env_path) = Self::find_legacy_env() {
            if let Ok(vars) = load_env_file(&env_path) {
                log::info!("Migrating config from legacy .env at {:?}", env_path);
                if let Some(v) = vars.get("MATRIX_HOMESERVER") { config.matrix_homeserver = v.clone(); }
                if let Some(v) = vars.get("MATRIX_USER") { config.matrix_user = v.clone(); }
                if let Some(v) = vars.get("MATRIX_ACCESS_TOKEN") { config.matrix_access_token = v.clone(); }
                if let Some(v) = vars.get("MATRIX_DEVICE_ID") { config.matrix_device_id = v.clone(); }
                if let Some(v) = vars.get("NOTION_API_KEY") { config.notion_api_key = v.clone(); }
                if let Some(v) = vars.get("GOOGLE_ACCOUNT_BENJAMIN").or(vars.get("GOOGLE_ACCOUNT_PRIMARY")) {
                    config.google_account_primary = v.clone();
                }
                if let Some(v) = vars.get("GOOGLE_ACCOUNT_AGENT") { config.google_account_agent = v.clone(); }
                if let Some(v) = vars.get("PARACHUTE_URL") { config.parachute_url = v.clone(); }
                if let Some(v) = vars.get("PARACHUTE_API_KEY") { config.parachute_api_key = v.clone(); }
                if let Some(v) = vars.get("PARACHUTE_VAULT") { config.parachute_vault = v.clone(); }
                if let Some(v) = vars.get("FATHOM_API_KEY") { config.fathom_api_key = v.clone(); }
                if let Some(v) = vars.get("MEETILY_DB_PATH") { config.meetily_db_path = v.clone(); }
                if let Some(v) = vars.get("COLLAB_URL") { config.collab_url = v.clone(); }
                if let Some(v) = vars.get("COLLAB_TOKEN") { config.collab_token = v.clone(); }
            }
        }

        // Try keychain for Anthropic key
        if config.anthropic_api_key.is_empty() {
            if let Some(key) = try_keychain_anthropic() {
                config.anthropic_api_key = key;
            }
        }

        // Auto-discover Meetily
        if config.meetily_db_path.is_empty() {
            config.meetily_db_path = auto_discover_meetily().unwrap_or_default();
        }

        // Migrate/normalize the vault registry before first save.
        config.normalize_vaults();

        // Always persist so the file exists for future launches
        match config.save_to(config_path) {
            Ok(_) => log::info!("Created initial config at {:?}", config_path),
            Err(e) => log::error!("Failed to save initial config to {:?}: {}", config_path, e),
        }

        Ok(config)
    }

    /// Parse the existing config file only — no Keychain lookup, no Meetily
    /// discovery, no first-launch write. For hot paths that need values saved
    /// this session (the managed state is launch-time). None = no/invalid file.
    pub fn read_existing() -> Option<Self> {
        let content = std::fs::read_to_string(Self::config_path()).ok()?;
        let mut c = serde_json::from_str::<AppConfig>(&content).ok()?;
        c.normalize_vaults();
        Some(c)
    }

    /// Save config to prism-config.json
    pub fn save(&self) -> Result<(), PrismError> {
        self.save_to(&Self::config_path())
    }

    /// Atomic, private save: write a 0600 temp file in the SAME directory, fsync
    /// it, rename it over the target (atomic on POSIX), fsync the directory. A
    /// crash mid-save can never leave a truncated/half-written config (which the
    /// strict `load_from` would then refuse). An existing file that doesn't parse
    /// is first copied aside to `<name>.corrupt-<ts>` so it is never silently lost.
    pub fn save_to(&self, path: &std::path::Path) -> Result<(), PrismError> {
        use std::io::Write;
        log::debug!("Saving config to {:?}", path);
        let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
        std::fs::create_dir_all(&parent)
            .map_err(|e| PrismError::Io(format!("Create config dir {:?}: {}", parent, e)))?;
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| PrismError::Other(format!("Serialize config: {}", e)))?;

        if let Ok(existing) = std::fs::read_to_string(path) {
            if serde_json::from_str::<AppConfig>(&existing).is_err() {
                let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                let aside = path.with_extension(format!("json.corrupt-{ts}"));
                let _ = std::fs::copy(path, &aside);
                log::warn!("Existing config {:?} did not parse; kept a copy at {:?}", path, aside);
            }
        }

        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("prism-config.json");
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let tmp = parent.join(format!(".{file_name}.tmp-{}-{nanos}", std::process::id()));
        let write = || -> std::io::Result<()> {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(json.as_bytes())?;
            f.sync_all()?;
            drop(f);
            std::fs::rename(&tmp, path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
                if let Ok(d) = std::fs::File::open(&parent) {
                    let _ = d.sync_all();
                }
            }
            Ok(())
        };
        write().map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            PrismError::Io(format!("Write config to {:?}: {}", path, e))
        })
    }

    fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
            .join("prism")
            .join("prism-config.json")
    }

    /// Path to the managed MCP config that the app's `claude -p` agent runs use.
    /// Lives beside `prism-config.json` and is regenerated from the ACTIVE vault
    /// at launch and on every vault switch, so background agents always target the
    /// current vault — independent of the static repo `.mcp.json` (which doesn't
    /// even ship inside a released `.app`).
    pub fn managed_mcp_config_path() -> PathBuf {
        Self::config_path().with_file_name("prism-mcp.json")
    }

    /// (Re)write the managed MCP config so `claude -p` agent runs target the given
    /// vault. `server_root` is the configured URL (a bare hub root, tolerating a
    /// legacy `/api` suffix). The file holds a vault token, so it's chmod 600 on
    /// unix — matching how `.env` secrets are handled.
    pub fn write_managed_mcp_config(
        server_root: &str,
        vault: &str,
        token: &str,
    ) -> Result<PathBuf, PrismError> {
        let root = server_root.trim_end_matches('/');
        let root = root.strip_suffix("/api").unwrap_or(root);
        let url = format!("{}/vault/{}/mcp", root, vault);
        let cfg = serde_json::json!({
            "mcpServers": {
                "parachute-vault": {
                    "type": "http",
                    "url": url,
                    "headers": { "Authorization": format!("Bearer {}", token) }
                }
            }
        });
        let path = Self::managed_mcp_config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| PrismError::Io(format!("Create config dir {:?}: {}", parent, e)))?;
        }
        let json = serde_json::to_string_pretty(&cfg)
            .map_err(|e| PrismError::Other(format!("Serialize MCP config: {}", e)))?;
        std::fs::write(&path, json)
            .map_err(|e| PrismError::Io(format!("Write MCP config to {:?}: {}", path, e)))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(path)
    }

    /// Search common locations for a legacy omniharmonic .env file (one-time migration).
    fn find_legacy_env() -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        let candidates = [
            "iCloud Drive (Archive)/Documents/cursor projects/omniharmonic_agent/.env",
            "omniharmonic_agent/.env",
            "Documents/omniharmonic_agent/.env",
        ];
        for candidate in &candidates {
            let path = home.join(candidate);
            if path.exists() {
                return Some(path);
            }
        }
        None
    }
}

fn load_env_file(path: &std::path::Path) -> Result<HashMap<String, String>, PrismError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| PrismError::Io(format!("Read .env: {}", e)))?;
    let mut vars = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if let Some((key, value)) = line.split_once('=') {
            vars.insert(key.trim().to_string(), value.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    Ok(vars)
}

/// Auto-discover Meetily's SQLite database on macOS.
fn auto_discover_meetily() -> Option<String> {
    let home = dirs::home_dir()?;
    let candidates = [
        "Library/Application Support/com.meetily.ai/meeting_minutes.sqlite",
        "Library/Application Support/ai.meetily.app/meeting_minutes.sqlite",
        "Library/Application Support/meetily/meeting_minutes.sqlite",
        "Library/Application Support/com.meetily.ai/meetily.db",
    ];
    for candidate in &candidates {
        let path = home.join(candidate);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

fn try_keychain_anthropic() -> Option<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "com.prism.anthropic", "-w"])
        .output().ok()?;
    if output.status.success() {
        let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !key.is_empty() { return Some(key); }
    }
    None
}

// ─── Tauri Commands ──────────────────────────────────

/// Real-time collab connection config for the webview: the Prism Server's
/// WebSocket URL and the dedicated owner token. The token is intentionally
/// surfaced to the (trusted) webview ONLY for the local collab connection — it is
/// the dedicated COLLAB_TOKEN, never the vault token. `enabled` is false when no
/// token is configured, so the UI stays on the offline editor.
#[tauri::command]
pub fn get_collab_config(
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    let c = AppConfig::read_existing().unwrap_or_else(|| config.inner().clone());
    Ok(serde_json::json!({
        "url": c.collab_url,
        "token": c.collab_token,
        "enabled": !c.collab_token.is_empty(),
    }))
}

/// The `/api` proxy allowlist: `/integrations` or `/integrations/…` only, with no
/// dot segment (raw or percent-encoded) — the URL parser would otherwise resolve
/// `/integrations/../vaults` to `/api/vaults` and escape the allowlist — and no
/// query/fragment.
pub fn api_path_allowed(path: &str) -> bool {
    // 1. Strict character allowlist on the RAW path: letters, digits, '-', '_',
    //    '/'. No '.', '%', '\\', whitespace/tab/newline (the WHATWG parser strips
    //    tab/newline, so `/.\t./` would become `/../`), '?', '#'.
    if path.is_empty() || !path.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'/') {
        return false;
    }
    if !(path == "/integrations" || path.starts_with("/integrations/")) {
        return false;
    }
    // 2. Parse exactly as reqwest will (same `url` crate) and assert the RESULTING
    //    path is still under /api/integrations and unchanged by normalization.
    let raw = format!("/api{path}");
    match url::Url::parse(&format!("http://prism.invalid{raw}")) {
        Ok(u) => {
            let p = u.path();
            u.query().is_none()
                && u.fragment().is_none()
                && p == raw
                && (p == "/api/integrations" || p.starts_with("/api/integrations/"))
        }
        Err(_) => false,
    }
}

/// HTTP base of the Prism Server (derived from the collab WS url) + the owner
/// collab token, read fresh from disk so a URL/token saved in Settings applies
/// without restarting (the managed state is launch-time only).
fn server_endpoint(state: &AppConfig) -> (String, String) {
    let c = AppConfig::read_existing().unwrap_or_else(|| state.clone());
    (crate::services::embedding_index::http_base_from_collab(&c.collab_url), c.collab_token)
}

/// `" <code>: <detail>"` from a Prism Server JSON error body (`{error, detail}`),
/// so the UI can show why a call failed. Server error bodies never carry secret
/// values; the detail is still capped.
pub fn server_error_suffix(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else { return String::new() };
    let code = v.get("error").and_then(|x| x.as_str()).unwrap_or("");
    let detail: String = v.get("detail").and_then(|x| x.as_str()).unwrap_or("").chars().take(300).collect();
    match (code.is_empty(), detail.is_empty()) {
        (true, true) => String::new(),
        (false, true) => format!(" {code}"),
        (true, false) => format!(": {detail}"),
        (false, false) => format!(" {code}: {detail}"),
    }
}

#[tauri::command]
pub fn get_config_status(
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    // Read fresh from disk so just-saved keys report accurately (see get_full_config).
    let config = AppConfig::load().unwrap_or_else(|_| config.inner().clone());
    Ok(serde_json::json!({
        "matrix": {
            "configured": !config.matrix_access_token.is_empty(),
            "homeserver": config.matrix_homeserver,
            "user": config.matrix_user,
        },
        "notion": {
            "configured": !config.notion_api_key.is_empty(),
        },
        "anthropic": {
            "configured": !config.anthropic_api_key.is_empty(),
        },
        "google": {
            "primary": config.google_account_primary,
            "agent": config.google_account_agent,
        },
        "parachute": {
            "url": config.parachute_url,
            "configured": !config.parachute_api_key.is_empty(),
        },
    }))
}

#[tauri::command]
pub fn set_anthropic_key(key: String) -> Result<(), PrismError> {
    let status = std::process::Command::new("security")
        .args(["add-generic-password", "-s", "com.prism.anthropic", "-a", "default", "-w", &key, "-U"])
        .status()
        .map_err(|e| PrismError::Other(format!("Keychain: {}", e)))?;
    if !status.success() {
        return Err(PrismError::Auth("Failed to store in Keychain".into()));
    }
    Ok(())
}

/// Health snapshot of the *effective* (currently configured) Parachute vault.
/// Unlike `test_parachute` (which probes an arbitrary URL the Settings form is
/// editing), this validates the config the app would actually use: it reports
/// the resolved `parachute_url` / `parachute_vault`, whether an API key is
/// present (never the key itself), and whether the vault answered `/health`.
#[derive(Clone, Debug, Serialize)]
pub struct ConfigHealth {
    /// Effective Parachute server root the app is configured to use.
    pub parachute_url: String,
    /// Effective vault name for the scoped REST/MCP URLs.
    pub parachute_vault: String,
    /// Whether a Parachute API key (Bearer hub JWT) is configured. Never the key.
    pub api_key_present: bool,
    /// Whether `${parachute_url}/health` responded with a success status.
    pub reachable: bool,
    /// Whether the configured API key actually AUTHORIZES against the scoped
    /// vault (an authed read, not just presence). `None` when no key is set or
    /// the vault was unreachable so we couldn't check. (G6: real auth check.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_valid: Option<bool>,
    /// Human-readable detail (error string or status) when not reachable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Validate the live config: ping the configured vault's `/health` and surface
/// the effective connection settings. Reads fresh from disk (like
/// `get_full_config`) so a key saved this session reports accurately, falling
/// back to the launch-time managed state on read error.
#[tauri::command]
pub async fn validate_config(
    config: tauri::State<'_, AppConfig>,
) -> Result<ConfigHealth, PrismError> {
    let config = AppConfig::load().unwrap_or_else(|_| config.inner().clone());

    let http = reqwest::Client::new();
    let (reachable, mut detail) = match http
        .get(format!("{}/health", config.parachute_url))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => (true, None),
        Ok(resp) => (false, Some(format!("vault returned {}", resp.status()))),
        Err(e) => (false, Some(format!("unreachable: {e}"))),
    };

    // G6 — real auth check: only meaningful if the vault is reachable AND a key
    // is set. Hit the scoped vault API with the Bearer key; a 2xx means the token
    // authorizes, a 401/403 means it's present-but-invalid (e.g. expired JWT or a
    // rejected legacy pvt_* token), which `api_key_present` alone can't catch.
    let api_key_present = !config.parachute_api_key.is_empty();
    let token_valid: Option<bool> = if reachable && api_key_present {
        let url = format!(
            "{}/vault/{}/api/notes?limit=1",
            config.parachute_url, config.parachute_vault
        );
        match http
            .get(&url)
            .bearer_auth(&config.parachute_api_key)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => Some(true),
            // Only 401/403 prove the token itself is bad. A 5xx (or any other
            // status) means the vault is flaky, not that the credential is wrong —
            // report inconclusive (None) so we never falsely flag a good token.
            Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                || resp.status() == reqwest::StatusCode::FORBIDDEN =>
            {
                if detail.is_none() {
                    detail = Some(format!("token rejected ({})", resp.status()));
                }
                Some(false)
            }
            Ok(resp) => {
                if detail.is_none() {
                    detail = Some(format!("auth check inconclusive ({})", resp.status()));
                }
                None
            }
            Err(e) => {
                if detail.is_none() {
                    detail = Some(format!("auth check inconclusive: {e}"));
                }
                None
            }
        }
    } else {
        None
    };

    Ok(ConfigHealth {
        parachute_url: config.parachute_url,
        parachute_vault: config.parachute_vault,
        api_key_present,
        reachable,
        token_valid,
        detail,
    })
}

/// Test if Parachute is reachable at a given URL
#[tauri::command]
pub async fn test_parachute(url: String) -> Result<serde_json::Value, PrismError> {
    let resp = reqwest::Client::new()
        .get(format!("{}/health", url))
        .timeout(std::time::Duration::from_secs(5))
        .send().await?;
    if resp.status().is_success() {
        Ok(resp.json().await?)
    } else {
        Err(PrismError::ServiceUnavailable(format!("Parachute at {} returned {}", url, resp.status())))
    }
}

/// Test Matrix connection
#[tauri::command]
pub async fn test_matrix(homeserver: String, access_token: String) -> Result<serde_json::Value, PrismError> {
    let resp = reqwest::Client::new()
        .get(format!("{}/_matrix/client/v3/joined_rooms", homeserver))
        .header("Authorization", format!("Bearer {}", access_token))
        .timeout(std::time::Duration::from_secs(5))
        .send().await?;
    if resp.status().is_success() {
        let data: serde_json::Value = resp.json().await?;
        let count = data["joined_rooms"].as_array().map(|a| a.len()).unwrap_or(0);
        Ok(serde_json::json!({ "ok": true, "rooms": count }))
    } else {
        Err(PrismError::Auth(format!("Matrix auth failed: {}", resp.status())))
    }
}

/// Test Notion connection
#[tauri::command]
pub async fn test_notion(api_key: String) -> Result<serde_json::Value, PrismError> {
    let resp = reqwest::Client::new()
        .post("https://api.notion.com/v1/search")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"query":"","page_size":1}))
        .timeout(std::time::Duration::from_secs(10))
        .send().await?;
    if resp.status().is_success() {
        Ok(serde_json::json!({ "ok": true }))
    } else {
        Err(PrismError::Auth(format!("Notion auth failed: {}", resp.status())))
    }
}

/// Check if claude CLI is installed
#[tauri::command]
pub fn check_claude_cli() -> Result<serde_json::Value, PrismError> {
    let output = std::process::Command::new("which").arg("claude").output();
    match output {
        Ok(o) if o.status.success() => {
            let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            Ok(serde_json::json!({ "installed": true, "path": path }))
        }
        _ => Ok(serde_json::json!({ "installed": false })),
    }
}

/// Mint a collaboration share link for a note via the Prism Server's /acl API —
/// the same path the web app uses, so links live on the real domain and join the
/// current real-time collab. Authenticates as the owner with the dedicated
/// COLLAB_TOKEN (Bearer); the server signs a note-scoped capability and returns
/// the full public link (built from its APP_ORIGIN).
#[tauri::command]
pub async fn create_collab_share_link(
    note_id: String,
    config: tauri::State<'_, AppConfig>,
) -> Result<String, PrismError> {
    let (http_base, collab_token) = server_endpoint(config.inner());
    if collab_token.is_empty() {
        return Err(PrismError::Config(
            "No collab token configured — set it in Settings → Services → Prism Server to share from the desktop app".into(),
        ));
    }

    let resp = reqwest::Client::new()
        .post(format!("{http_base}/acl/notes/{}/links", urlencoding::encode(&note_id)))
        .bearer_auth(&collab_token)
        .json(&serde_json::json!({ "level": "edit", "expiresInDays": 30 }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| PrismError::Other(format!("share-link request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(PrismError::Other(format!("share-link failed: {}", resp.status())));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| PrismError::Other(format!("share-link parse failed: {e}")))?;
    body.get("url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| PrismError::Other("share-link missing url in response".into()))
}

/// Generic proxy to the Prism Server's owner-only `/acl` API, authenticated with
/// the desktop COLLAB_TOKEN (Bearer). This is the single bridge that lets the
/// desktop frontend drive the *full* Google-Docs-style share surface (people
/// grants, capability links, tag-grants) without ever holding the token — the
/// same ACL surface the web app reaches over its session cookie. The frontend
/// builds `path` (e.g. `/notes/123/people`) and `method`; we return the parsed
/// JSON body (null for an empty 2xx, e.g. a 204 on DELETE).
#[tauri::command]
pub async fn acl_request(
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    let (http_base, collab_token) = server_endpoint(config.inner());
    if collab_token.is_empty() {
        return Err(PrismError::Config(
            "No collab token configured — set it in Settings → Services → Prism Server to share from the desktop app".into(),
        ));
    }

    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| PrismError::Other(format!("invalid HTTP method: {method}")))?;
    let mut req = reqwest::Client::new()
        .request(m, format!("{http_base}/acl{path}"))
        .bearer_auth(&collab_token)
        .timeout(std::time::Duration::from_secs(15));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| PrismError::Other(format!("acl request failed: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(PrismError::Other(format!("acl {method} {path} → {status}{}", server_error_suffix(&text))));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| PrismError::Other(format!("acl parse failed: {e}")))
}

/// Narrow proxy to the Prism Server's `/api` gateway, authenticated with the
/// desktop COLLAB_TOKEN (Bearer) — the server treats a local Bearer of the
/// collab/vault token as the owner. Deliberately allowlist-scoped: only the
/// `/integrations` routes (server-side sync-integration credentials + manual
/// sync) are reachable, so this never becomes a generic vault passthrough.
/// Same base-URL derivation + error handling as `acl_request` above.
#[tauri::command]
pub async fn api_request(
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    let (http_base, collab_token) = server_endpoint(config.inner());
    if collab_token.is_empty() {
        return Err(PrismError::Config(
            "No collab token configured — set it in Settings → Services → Prism Server to manage integrations from the desktop app".into(),
        ));
    }
    // Allowlist: only the integrations surface. Everything else stays desktop-native.
    if !api_path_allowed(&path) {
        return Err(PrismError::Other(format!(
            "api path not allowed from the desktop proxy: {path}"
        )));
    }

    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| PrismError::Other(format!("invalid HTTP method: {method}")))?;
    let mut req = reqwest::Client::new()
        .request(m, format!("{http_base}/api{path}"))
        .bearer_auth(&collab_token)
        .timeout(std::time::Duration::from_secs(60));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| PrismError::Other(format!("api request failed: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(PrismError::Other(format!("api {method} {path} → {status}{}", server_error_suffix(&text))));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| PrismError::Other(format!("api parse failed: {e}")))
}

// ── Write-only secrets (docs/credentials.md) ─────────────────────────────────
//
// Every credential in AppConfig is WRITE-ONLY from the webview: `get_full_config`
// returns `""` for it plus a `<key>_set` bool, never the value (not even a masked
// prefix/suffix), and `update_config` MERGES — a non-empty string replaces, an
// empty/whitespace string keeps the stored value, and JSON `null` clears it.
// The one deliberate exception is `get_collab_config`, which hands the dedicated
// COLLAB_TOKEN to the trusted webview because the Hocuspocus WebSocket is opened
// from JS; it is never rendered.

/// Config keys that hold a credential. Order is the Settings UI's.
pub const SECRET_FIELDS: &[&str] = &[
    "parachute_api_key",
    "matrix_access_token",
    "anthropic_api_key",
    "notion_api_key",
    "fathom_api_key",
    "readai_api_key",
    "otter_api_key",
    "fireflies_api_key",
    "collab_token",
];

/// Plain (non-secret) string fields the Settings UI may write. Unchanged
/// semantics: any string value (including "") is stored as-is. (The list pins
/// `plain_slot` in the tests.)
#[cfg_attr(not(test), allow(dead_code))]
const PLAIN_STRING_FIELDS: &[&str] = &[
    "matrix_homeserver",
    "matrix_user",
    "google_account_primary",
    "google_account_agent",
    "parachute_url",
    "parachute_vault",
    "meetily_db_path",
    "local_ai_base_url",
    "local_ai_model",
    "background_skill_provider",
    "collab_url",
];

fn secret_slot<'a>(c: &'a mut AppConfig, key: &str) -> Option<&'a mut String> {
    Some(match key {
        "parachute_api_key" => &mut c.parachute_api_key,
        "matrix_access_token" => &mut c.matrix_access_token,
        "anthropic_api_key" => &mut c.anthropic_api_key,
        "notion_api_key" => &mut c.notion_api_key,
        "fathom_api_key" => &mut c.fathom_api_key,
        "readai_api_key" => &mut c.readai_api_key,
        "otter_api_key" => &mut c.otter_api_key,
        "fireflies_api_key" => &mut c.fireflies_api_key,
        "collab_token" => &mut c.collab_token,
        _ => return None,
    })
}

fn plain_slot<'a>(c: &'a mut AppConfig, key: &str) -> Option<&'a mut String> {
    Some(match key {
        "matrix_homeserver" => &mut c.matrix_homeserver,
        "matrix_user" => &mut c.matrix_user,
        "google_account_primary" => &mut c.google_account_primary,
        "google_account_agent" => &mut c.google_account_agent,
        "parachute_url" => &mut c.parachute_url,
        "parachute_vault" => &mut c.parachute_vault,
        "meetily_db_path" => &mut c.meetily_db_path,
        "local_ai_base_url" => &mut c.local_ai_base_url,
        "local_ai_model" => &mut c.local_ai_model,
        "background_skill_provider" => &mut c.background_skill_provider,
        "collab_url" => &mut c.collab_url,
        _ => return None,
    })
}

/// The webview's view of the config: every non-secret field as before, every
/// secret as `""` + `<key>_set`. Pure (unit-tested).
pub fn redacted_config_view(config: &AppConfig) -> serde_json::Value {
    let mut c = config.clone();
    let mut out = serde_json::json!({
        "matrix_homeserver": c.matrix_homeserver,
        "matrix_user": c.matrix_user,
        "google_account_primary": c.google_account_primary,
        "google_account_agent": c.google_account_agent,
        "parachute_url": c.parachute_url,
        "parachute_vault": c.parachute_vault,
        "meetily_db_path": c.meetily_db_path,
        "local_ai_base_url": c.local_ai_base_url,
        "local_ai_model": c.local_ai_model,
        "background_skill_provider": c.background_skill_provider,
        "collab_url": c.collab_url,
        "ingest_mode": if c.is_client_mode() { "client" } else { "host" },
        "disable_email_sync": c.disable_email_sync,
        "disable_calendar_sync": c.disable_calendar_sync,
        "disable_meetily_sync": c.disable_meetily_sync,
        "disable_embedding_index": c.disable_embedding_index,
        "disable_skill_scheduler": c.disable_skill_scheduler,
        "disable_notion_task_sync": c.disable_notion_task_sync,
    });
    let obj = out.as_object_mut().expect("object");
    for key in SECRET_FIELDS {
        let set = secret_slot(&mut c, key).map(|s| !s.trim().is_empty()).unwrap_or(false);
        // The key stays present (older Settings builds read it) but is ALWAYS empty.
        obj.insert((*key).to_string(), serde_json::Value::String(String::new()));
        obj.insert(format!("{key}_set"), serde_json::Value::Bool(set));
    }
    out
}

/// Merge a Settings `updates` object into `config`. Secrets: non-empty string →
/// replace (trimmed), empty string → keep, `null` → clear. Plain strings: stored
/// as given. Flags/enums as before. Unknown keys are ignored. Returns the secret
/// keys that were CLEARED (so the caller can drop out-of-file copies, e.g. the
/// Anthropic key's Keychain item). Pure (unit-tested).
pub fn apply_config_updates(config: &mut AppConfig, updates: &serde_json::Value) -> Vec<String> {
    let mut cleared = Vec::new();
    let Some(obj) = updates.as_object() else { return cleared };
    for (key, value) in obj {
        if let Some(slot) = secret_slot(config, key) {
            match value {
                serde_json::Value::Null => {
                    slot.clear();
                    cleared.push(key.clone());
                }
                serde_json::Value::String(s) if !s.trim().is_empty() => *slot = s.trim().to_string(),
                _ => {} // blank (or non-string) = keep the stored secret
            }
            continue;
        }
        if let Some(slot) = plain_slot(config, key) {
            if let Some(s) = value.as_str() {
                *slot = s.to_string();
            }
            continue;
        }
        match key.as_str() {
            // Ingest switch (restart required — services are started once at launch).
            "ingest_mode" => {
                if let Some(v) = value.as_str() {
                    config.ingest_mode = if v.eq_ignore_ascii_case("client") { "client".into() } else { "host".into() };
                }
            }
            "disable_email_sync" => if let Some(v) = value.as_bool() { config.disable_email_sync = v; },
            "disable_calendar_sync" => if let Some(v) = value.as_bool() { config.disable_calendar_sync = v; },
            "disable_meetily_sync" => if let Some(v) = value.as_bool() { config.disable_meetily_sync = v; },
            "disable_embedding_index" => if let Some(v) = value.as_bool() { config.disable_embedding_index = v; },
            "disable_skill_scheduler" => if let Some(v) = value.as_bool() { config.disable_skill_scheduler = v; },
            "disable_notion_task_sync" => if let Some(v) = value.as_bool() { config.disable_notion_task_sync = v; },
            _ => {}
        }
    }
    cleared
}

/// Keep the ACTIVE vault registry entry in lock-step with the legacy parachute_*
/// fields just edited from Settings. Capture them BEFORE `normalize_vaults()`,
/// which mirrors the (stale) active entry back over them — doing it in the other
/// order silently reverted every Settings edit of the vault URL/name/key.
pub fn sync_active_vault_entry(c: &mut AppConfig) {
    let (u, vlt, tok) = (c.parachute_url.clone(), c.parachute_vault.clone(), c.parachute_api_key.clone());
    c.normalize_vaults();
    let active_id = c.active_vault_id.clone();
    if let Some(entry) = c.vaults.iter_mut().find(|e| e.id == active_id) {
        entry.url = u.clone();
        entry.vault = vlt.clone();
        entry.token = tok.clone();
    }
    c.parachute_url = u;
    c.parachute_vault = vlt;
    c.parachute_api_key = tok;
}

/// The pure core of `update_config`: STRICT re-read of the on-disk config (a
/// missing/corrupt/unreadable file falls back to the launch-time `managed` state
/// — it never triggers the first-launch save of defaults), then merge `updates`
/// and keep the active vault entry in step. Returns the merged config and the
/// secret keys cleared.
pub fn merged_config_for_update(path: &std::path::Path, managed: &AppConfig, updates: &serde_json::Value) -> (AppConfig, Vec<String>) {
    let mut c = if path.exists() {
        AppConfig::load_from(path).unwrap_or_else(|e| {
            log::warn!("update_config: {e} — merging into the in-memory config instead");
            managed.clone()
        })
    } else {
        managed.clone()
    };
    let cleared = apply_config_updates(&mut c, updates);
    sync_active_vault_entry(&mut c);
    (c, cleared)
}

/// Get the config for the Settings UI. Secrets are REDACTED (`""` + `<key>_set`);
/// see `redacted_config_view`.
#[tauri::command]
pub fn get_full_config(
    config: tauri::State<'_, AppConfig>,
) -> Result<serde_json::Value, PrismError> {
    // Read fresh from disk: `update_config` persists to disk but does NOT mutate
    // the in-memory managed state, so the launch-time `config` would otherwise
    // show stale "not set" for any key saved during this session (the app process
    // outlives a closed window on macOS). Fall back to managed state on read error.
    let config = AppConfig::load().unwrap_or_else(|_| config.inner().clone());
    Ok(redacted_config_view(&config))
}

/// Update config fields and persist (write-only secrets: blank keeps, `null`
/// clears — see `apply_config_updates`). Hot-reloads the Parachute connection
/// into the running client so it takes effect immediately without a restart.
#[tauri::command]
pub fn update_config(
    config: tauri::State<'_, AppConfig>,
    parachute: tauri::State<'_, crate::clients::parachute::ParachuteClient>,
    updates: serde_json::Value,
) -> Result<(), PrismError> {
    // Start from the ON-DISK config, not the launch-time managed state: the managed
    // state never sees this session's saves, so building on it made a second save
    // silently revert the first (e.g. saving the Notion key dropped a Matrix token
    // saved a minute earlier).
    let (new_config, cleared) = merged_config_for_update(&AppConfig::config_path(), config.inner(), &updates);
    if cleared.iter().any(|k| k == "anthropic_api_key") {
        // `load()` falls back to the Keychain item, so a clear must remove it too
        // or the key silently comes back on the next read.
        let _ = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", "com.prism.anthropic"])
            .output();
    }

    // Hot-reload the running client to the (possibly new) url/vault/key so edits
    // take effect immediately without restarting the app.
    let new_key = if new_config.parachute_api_key.is_empty() { None } else { Some(new_config.parachute_api_key.clone()) };
    parachute.set_vault(&new_config.parachute_url, &new_config.parachute_vault, new_key);

    new_config.save()?;
    log::info!("Config updated and saved (parachute connection hot-reloaded)");
    Ok(())
}

/// Auto-discover Meetily database path.
#[tauri::command]
pub fn discover_meetily_path() -> Result<serde_json::Value, PrismError> {
    match auto_discover_meetily() {
        Some(path) => Ok(serde_json::json!({ "found": true, "path": path })),
        None => Ok(serde_json::json!({ "found": false })),
    }
}

/// Check if gog CLI is installed
#[tauri::command]
pub fn check_google_cli() -> Result<serde_json::Value, PrismError> {
    let output = std::process::Command::new("which").arg("gog").output();
    match output {
        Ok(o) if o.status.success() => {
            let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            Ok(serde_json::json!({ "installed": true, "path": path }))
        }
        _ => Ok(serde_json::json!({ "installed": false })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize the defaults, patch keys the way prism-config.json does, read back.
    fn config_from(patch: &[(&str, serde_json::Value)]) -> AppConfig {
        let mut v = serde_json::to_value(AppConfig::default()).expect("serialize defaults");
        let o = v.as_object_mut().unwrap();
        for (k, val) in patch {
            o.insert((*k).to_string(), val.clone());
        }
        serde_json::from_value(v).expect("deserialize patched config")
    }

    /// The desktop's Fireflies sync is disabled by a `#[serde(default)]` bool, so a
    /// mismatch between the JSON key and the field name would deserialize SILENTLY to
    /// `false` and quietly resume double-syncing Fireflies alongside the server (which
    /// also owns deletion). Pin the exact on-disk key name.
    #[test]
    fn disable_fireflies_sync_binds_to_the_snake_case_key() {
        let cfg = config_from(&[("disable_fireflies_sync", serde_json::json!(true))]);
        assert!(cfg.disable_fireflies_sync, "on-disk key must bind to the field");
    }

    /// Absent from an older config file the flag defaults to false — the desktop keeps
    /// syncing. That's why the server cutover REQUIRES writing the key explicitly.
    #[test]
    fn disable_fireflies_sync_defaults_to_false_when_absent() {
        let mut v = serde_json::to_value(AppConfig::default()).unwrap();
        v.as_object_mut().unwrap().remove("disable_fireflies_sync");
        let cfg: AppConfig = serde_json::from_value(v).unwrap();
        assert!(!cfg.disable_fireflies_sync);
    }

    /// The gate in transcript_sync.rs is `!key.is_empty() && !disable`. A configured key
    /// PLUS the flag must evaluate to "do not sync" — that pairing is the whole cutover.
    #[test]
    fn configured_key_plus_disable_flag_means_no_desktop_sync() {
        let cfg = config_from(&[
            ("fireflies_api_key", serde_json::json!("ff_key")),
            ("disable_fireflies_sync", serde_json::json!(true)),
        ]);
        assert!(!cfg.fireflies_api_key.is_empty(), "key stays configured for live use");
        let would_sync = !cfg.fireflies_api_key.is_empty() && !cfg.disable_fireflies_sync;
        assert!(!would_sync, "desktop must not sync Fireflies once the server owns it");
    }

    /// An old prism-config.json with none of the WP0.4 keys must load as host mode with
    /// every per-service flag false — upgrading must not change behaviour.
    #[test]
    fn old_config_without_ingest_keys_loads_as_host_with_all_flags_false() {
        let mut v = serde_json::to_value(AppConfig::default()).unwrap();
        let o = v.as_object_mut().unwrap();
        for k in [
            "ingest_mode", "disable_email_sync", "disable_calendar_sync", "disable_meetily_sync",
            "disable_embedding_index", "disable_skill_scheduler", "disable_notion_task_sync",
        ] {
            assert!(o.remove(k).is_some(), "{k} should be a serialized field");
        }
        let cfg: AppConfig = serde_json::from_value(v).unwrap();
        assert_eq!(cfg.ingest_mode, "host");
        assert!(!cfg.is_client_mode());
        assert!(!cfg.disable_email_sync && !cfg.disable_calendar_sync && !cfg.disable_meetily_sync);
        assert!(!cfg.disable_embedding_index && !cfg.disable_skill_scheduler && !cfg.disable_notion_task_sync);
    }

    #[test]
    fn ingest_keys_bind_to_their_snake_case_names() {
        let cfg = config_from(&[
            ("ingest_mode", serde_json::json!("client")),
            ("disable_email_sync", serde_json::json!(true)),
            ("disable_calendar_sync", serde_json::json!(true)),
            ("disable_meetily_sync", serde_json::json!(true)),
            ("disable_embedding_index", serde_json::json!(true)),
            ("disable_skill_scheduler", serde_json::json!(true)),
            ("disable_notion_task_sync", serde_json::json!(true)),
        ]);
        assert!(cfg.is_client_mode());
        assert!(cfg.disable_email_sync && cfg.disable_calendar_sync && cfg.disable_meetily_sync);
        assert!(cfg.disable_embedding_index && cfg.disable_skill_scheduler && cfg.disable_notion_task_sync);
    }

    #[test]
    fn unknown_ingest_mode_is_treated_as_host() {
        assert!(!config_from(&[("ingest_mode", serde_json::json!("banana"))]).is_client_mode());
        assert!(config_from(&[("ingest_mode", serde_json::json!("Client"))]).is_client_mode());
    }

    // ── write-only secrets: redact + merge ──────────────────────────────────

    /// A config with a distinctive value in EVERY secret field.
    fn all_secrets_set() -> AppConfig {
        let mut c = AppConfig::default();
        for k in SECRET_FIELDS {
            *secret_slot(&mut c, k).unwrap() = format!("SECRET-{k}-0123456789abcdef");
        }
        c
    }

    #[test]
    fn every_secret_field_has_a_slot() {
        let mut c = AppConfig::default();
        for k in SECRET_FIELDS {
            assert!(secret_slot(&mut c, k).is_some(), "{k} has no slot");
            assert!(plain_slot(&mut c, k).is_none(), "{k} must not also be a plain field");
        }
        for k in PLAIN_STRING_FIELDS {
            assert!(plain_slot(&mut c, k).is_some(), "{k} has no slot");
        }
    }

    #[test]
    fn redacted_view_never_contains_a_secret_value_or_fragment() {
        let c = all_secrets_set();
        let view = redacted_config_view(&c);
        let text = view.to_string();
        assert!(!text.contains("SECRET-"), "no secret (or masked prefix) in {text}");
        assert!(!text.contains("cdef"), "no masked suffix either");
        for k in SECRET_FIELDS {
            assert_eq!(view[*k], serde_json::json!(""), "{k} is always empty");
            assert_eq!(view[format!("{k}_set")], serde_json::json!(true), "{k}_set");
        }
        let empty = redacted_config_view(&AppConfig::default());
        for k in SECRET_FIELDS {
            assert_eq!(empty[format!("{k}_set")], serde_json::json!(false), "{k}_set when unset");
        }
        // Non-secret fields are still returned for the form.
        assert_eq!(view["matrix_homeserver"], serde_json::json!(c.matrix_homeserver));
        assert_eq!(view["collab_url"], serde_json::json!(c.collab_url));
    }

    #[test]
    fn whitespace_only_secret_reads_as_not_set() {
        let mut c = AppConfig::default();
        c.notion_api_key = "   ".into();
        assert_eq!(redacted_config_view(&c)["notion_api_key_set"], serde_json::json!(false));
    }

    #[test]
    fn merge_blank_keeps_value_replaces_null_clears() {
        let mut c = all_secrets_set();
        let cleared = apply_config_updates(
            &mut c,
            &serde_json::json!({
                "notion_api_key": "",            // blank → keep
                "fathom_api_key": "   ",         // whitespace → keep
                "matrix_access_token": "  syt_new  ", // value → replace (trimmed)
                "collab_token": null,            // null → clear
                "anthropic_api_key": null,
            }),
        );
        assert_eq!(c.notion_api_key, "SECRET-notion_api_key-0123456789abcdef");
        assert_eq!(c.fathom_api_key, "SECRET-fathom_api_key-0123456789abcdef");
        assert_eq!(c.matrix_access_token, "syt_new");
        assert_eq!(c.collab_token, "");
        assert_eq!(c.anthropic_api_key, "");
        cleared.iter().for_each(|k| assert!(k == "collab_token" || k == "anthropic_api_key"));
        assert_eq!(cleared.len(), 2);
        // Untouched secrets stay.
        assert_eq!(c.otter_api_key, "SECRET-otter_api_key-0123456789abcdef");
    }

    #[test]
    fn merge_ignores_non_string_secret_values_and_unknown_keys() {
        let mut c = all_secrets_set();
        apply_config_updates(&mut c, &serde_json::json!({ "notion_api_key": 42, "parachute_api_key": true, "nonsense": "x" }));
        assert_eq!(c.notion_api_key, "SECRET-notion_api_key-0123456789abcdef");
        assert_eq!(c.parachute_api_key, "SECRET-parachute_api_key-0123456789abcdef");
    }

    #[test]
    fn merge_keeps_plain_field_and_flag_semantics() {
        let mut c = AppConfig::default();
        apply_config_updates(
            &mut c,
            &serde_json::json!({
                "matrix_homeserver": "https://m.example.test",
                "google_account_agent": "agent@example.test",
                "collab_url": "wss://prism.example.test/collab",
                "meetily_db_path": "",
                "ingest_mode": "CLIENT",
                "disable_email_sync": true,
            }),
        );
        assert_eq!(c.matrix_homeserver, "https://m.example.test");
        assert_eq!(c.google_account_agent, "agent@example.test");
        assert_eq!(c.collab_url, "wss://prism.example.test/collab");
        assert_eq!(c.meetily_db_path, "", "plain fields may be cleared with an empty string");
        assert!(c.is_client_mode() && c.disable_email_sync);
    }

    #[test]
    fn redact_then_merge_round_trip_never_loses_a_secret() {
        // An old/naive client that echoes the whole view back must not wipe anything.
        let mut c = all_secrets_set();
        let before = c.clone();
        let view = redacted_config_view(&c);
        apply_config_updates(&mut c, &view);
        for k in SECRET_FIELDS {
            let (mut a, mut b) = (before.clone(), c.clone());
            assert_eq!(secret_slot(&mut a, k).unwrap(), secret_slot(&mut b, k).unwrap(), "{k} survived");
        }
    }

    #[test]
    fn settings_vault_edits_reach_the_active_registry_entry() {
        let mut c = AppConfig::default();
        c.normalize_vaults();
        apply_config_updates(&mut c, &serde_json::json!({ "parachute_url": "http://vault.example.test", "parachute_api_key": "eyJnew" }));
        sync_active_vault_entry(&mut c);
        assert_eq!(c.parachute_url, "http://vault.example.test");
        assert_eq!(c.parachute_api_key, "eyJnew");
        let e = c.active_entry().clone();
        assert_eq!((e.url.as_str(), e.token.as_str()), ("http://vault.example.test", "eyJnew"));
        // …and a reload-style normalize keeps them (no silent revert).
        c.normalize_vaults();
        assert_eq!(c.parachute_api_key, "eyJnew");
    }

    #[test]
    fn api_proxy_allowlist_cannot_be_escaped() {
        for ok in ["/integrations", "/integrations/proton-bridge", "/integrations/proton-bridge/detect-cert", "/integrations/clickup/sync"] {
            assert!(api_path_allowed(ok), "{ok}");
        }
        for bad in [
            "/vaults", "/integrationsX", "/integrations/../vaults", "/integrations/%2e%2e/vaults",
            "/integrations/%2E%2E/notes", "/integrations/x%2f..%2fnotes", "/integrations/./x", "/integrations/x?y=1",
            "/integrations\\..\\vaults", "/integrations/x#frag",
            // security review M1: the WHATWG parser strips tab/CR/LF, so these
            // would resolve to /api/vaults.
            "/integrations/.\t./vaults", "/integrations/\n../vaults", "/integrations/..\r/vaults",
            "/integrations/.\n./.\t./notes", "/integrations/ ../vaults", "/integrations/x\u{0}",
            "/integrations/%09..%2fvaults", "", "integrations", "/integrations/\u{2028}",
        ] {
            assert!(!api_path_allowed(bad), "{bad:?}");
        }
        // Sanity: the url crate really does collapse the tab trick, i.e. the
        // allowlist is what stops it.
        let u = url::Url::parse("http://h/api/integrations/.\t./vaults").unwrap();
        assert_eq!(u.path(), "/api/vaults");
    }

    // ── M2: strict load + atomic save never wipe stored credentials ─────────

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("prism-config-test-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn corrupt_file_is_an_error_and_is_never_overwritten_with_defaults_by_load() {
        let dir = temp_dir("corrupt");
        let path = dir.join("prism-config.json");
        std::fs::write(&path, "{ this is not json").unwrap();
        assert!(AppConfig::load_from(&path).is_err(), "strict: no first-launch fallback");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ this is not json", "file untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_on_corrupt_file_merges_into_managed_state_and_keeps_its_secrets() {
        let dir = temp_dir("update");
        let path = dir.join("prism-config.json");
        std::fs::write(&path, "{\"truncated\": ").unwrap();
        let managed = all_secrets_set();
        let (merged, _) = merged_config_for_update(&path, &managed, &serde_json::json!({ "matrix_user": "@me:example.test" }));
        for k in SECRET_FIELDS {
            let (mut a, mut b) = (managed.clone(), merged.clone());
            assert_eq!(secret_slot(&mut a, k).unwrap(), secret_slot(&mut b, k).unwrap(), "{k} preserved");
        }
        assert_eq!(merged.matrix_user, "@me:example.test");
        // Saving keeps a copy of the unparseable file and writes a valid, private one.
        merged.save_to(&path).unwrap();
        let written: AppConfig = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written.notion_api_key, managed.notion_api_key);
        let aside: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(aside.iter().any(|n| n.contains(".corrupt-")), "corrupt original kept: {aside:?}");
        assert!(!aside.iter().any(|n| n.contains(".tmp-")), "no temp file left: {aside:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_on_valid_file_builds_on_disk_not_launch_state() {
        let dir = temp_dir("valid");
        let path = dir.join("prism-config.json");
        let mut on_disk = all_secrets_set();
        on_disk.meetily_db_path = "/nonexistent/meetily.sqlite".into(); // skip auto-discovery
        on_disk.save_to(&path).unwrap();
        let launch = AppConfig::default(); // stale launch-time state: no secrets
        let (merged, _) = merged_config_for_update(&path, &launch, &serde_json::json!({ "fathom_api_key": "new-fathom" }));
        assert_eq!(merged.fathom_api_key, "new-fathom");
        assert_eq!(merged.notion_api_key, on_disk.notion_api_key, "earlier save not reverted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_error_suffix_surfaces_code_and_detail_only() {
        assert_eq!(server_error_suffix(r#"{"error":"disabled","detail":"PROTON off"}"#), " disabled: PROTON off");
        assert_eq!(server_error_suffix(r#"{"error":"forbidden"}"#), " forbidden");
        assert_eq!(server_error_suffix("not json"), "");
    }
}
