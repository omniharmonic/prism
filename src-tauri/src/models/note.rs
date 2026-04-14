use serde::{Deserialize, Deserializer, Serialize};

/// Deserialize a possibly-null string as an empty string
fn deserialize_null_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<String>::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    #[serde(default, deserialize_with = "deserialize_null_string")]
    pub content: String,
    pub path: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndex {
    pub id: String,
    pub path: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub tags: Option<Vec<String>>,
    pub metadata: Option<serde_json::Value>,
    pub byte_size: Option<u64>,
    pub preview: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListNotesParams {
    pub tag: Option<String>,
    pub path: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteParams {
    pub content: String,
    pub path: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub tags: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TagCount {
    /// Parachute API returns "name", we rename to "tag" for the frontend
    #[serde(alias = "name")]
    pub tag: String,
    pub count: u32,
}

/// Vault stats returned by `GET /api/vault?include_stats=true` (v2).
/// Response shape: `{ totalNotes, tagCount, notesByMonth, topTags, ... }`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultStats {
    pub total_notes: u64,
    pub tag_count: u64,
    /// v2 response doesn't include link_count at the top level. Default 0.
    #[serde(default)]
    pub link_count: u64,
}
