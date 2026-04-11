use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncConfig {
    pub adapter: String,
    pub remote_id: String,
    pub last_synced: String,
    pub direction: String,
    pub conflict_strategy: String,
    pub auto_sync: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "status")]
pub enum SyncResult {
    #[serde(rename = "no_change")]
    NoChange,
    #[serde(rename = "pushed")]
    Pushed { content: String },
    #[serde(rename = "pulled")]
    Pulled { content: String },
    #[serde(rename = "conflict")]
    Conflict { local: String, remote: String },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncStatus {
    pub adapter: String,
    pub remote_id: String,
    pub state: SyncState,
    pub last_synced: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    Synced,
    Syncing,
    Conflict,
    Error,
    NeverSynced,
}
