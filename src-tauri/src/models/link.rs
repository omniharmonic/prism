use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub source_id: String,
    pub target_id: String,
    /// v2 API may return links with or without relationship — default to None.
    #[serde(default)]
    pub relationship: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    /// v2 responses embedded in notes may omit created_at.
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetLinksParams {
    pub note_id: Option<String>,
    pub relationship: Option<String>,
}

/// Params received from Tauri IPC (camelCase from JS)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateLinkParams {
    pub source_id: String,
    pub target_id: String,
    pub relationship: String,
    pub metadata: Option<serde_json::Value>,
}

/// Params received from Tauri IPC (camelCase from JS)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLinkParams {
    pub source_id: String,
    pub target_id: String,
    pub relationship: String,
}

// CreateLinkBody / DeleteLinkBody removed in v2: link mutations now flow
// through `PATCH /api/notes/:source_id` with `links.add` / `links.remove`.

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GraphNode {
    pub id: String,
    pub path: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub relationship: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GetGraphParams {
    pub depth: Option<u32>,
    pub center_id: Option<String>,
}
