use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum PrismError {
    #[error("Parachute: {0}")]
    Parachute(String),
    #[error("Matrix: {0}")]
    Matrix(String),
    #[error("Google: {0}")]
    Google(String),
    #[error("Notion: {0}")]
    Notion(String),
    #[error("Agent: {0}")]
    Agent(String),
    #[error("Auth: {0}")]
    Auth(String),
    #[error("Sync conflict")]
    SyncConflict { local: String, remote: String },
    #[error("Config: {0}")]
    Config(String),
    #[error("MCP: {0}")]
    Mcp(String),
    #[error("Ollama: {0}")]
    Ollama(String),
    #[error("Git: {0}")]
    Git(String),
    #[error("Service unavailable: {0}")]
    ServiceUnavailable(String),
    #[error("IO: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}

// Tauri requires Serialize for command return errors
impl Serialize for PrismError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<reqwest::Error> for PrismError {
    fn from(e: reqwest::Error) -> Self {
        PrismError::Other(e.to_string())
    }
}

impl From<std::io::Error> for PrismError {
    fn from(e: std::io::Error) -> Self {
        PrismError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for PrismError {
    fn from(e: serde_json::Error) -> Self {
        PrismError::Other(e.to_string())
    }
}
