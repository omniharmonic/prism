//! Idempotent tag-schema seeding for newly created local vaults.
//!
//! Mirrors `apps/server/scripts/lib/seed-tag-schemas.ts` so the desktop
//! `vault_create` path provisions starter schemas exactly like the web/server
//! `seedTagSchemas`. The canonical source of truth —
//! `packages/core/src/lib/schemas/tag-schemas.json` — is **bundled at compile
//! time** via `include_str!`, so the schema travels inside the binary and there
//! is no runtime path dependency (a released `.app` has no repo checkout).
//!
//! Safety contract (CRITICAL — never destructive, matching the server):
//!   - absent tag / bare tag with no schema → create with description + fields
//!   - present tag → ADD missing fields / fill an EMPTY description only;
//!                   NEVER overwrite an existing field def or a non-empty description
//!   - already complete → unchanged (no write)
//!
//! Only `description` + `fields` are seeded; `contentType` / `precedence` are
//! Prism-side renderer concerns and are not vault tag-schema state.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::error::PrismError;

/// Canonical schema source, bundled at compile time. Path is relative to THIS
/// source file (`apps/desktop/src-tauri/src/commands/`) → repo root → packages/core.
const TAG_SCHEMAS_JSON: &str =
    include_str!("../../../../../packages/core/src/lib/schemas/tag-schemas.json");

#[derive(Deserialize)]
struct SchemasFile {
    #[serde(default)]
    tags: HashMap<String, TagEntry>,
}

#[derive(Deserialize)]
struct TagEntry {
    #[serde(default)]
    description: Option<String>,
    /// Field definitions, passed through verbatim to the PUT body.
    #[serde(default)]
    fields: Option<Map<String, Value>>,
}

/// What the seed did, for logging. (Not returned across the IPC boundary.)
#[derive(Debug, Default)]
pub struct SeedSummary {
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub unchanged: usize,
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|t| !t.is_empty())
}

/// Provision tag schemas on a freshly minted vault. Idempotent + additive — safe
/// to run repeatedly. `server_root` is the bare hub root (no `/vault/...`), e.g.
/// `http://localhost:1940`.
pub async fn seed_tag_schemas(
    server_root: &str,
    vault: &str,
    token: &str,
) -> Result<SeedSummary, PrismError> {
    let desired: SchemasFile = serde_json::from_str(TAG_SCHEMAS_JSON)
        .map_err(|e| PrismError::Config(format!("bundled tag-schemas.json is invalid: {e}")))?;

    let base = format!("{}/vault/{}/api", server_root.trim_end_matches('/'), vault);
    let client = reqwest::Client::new();

    // 1. Read existing schemas (name → (description, fields)).
    let existing_list: Vec<Value> = client
        .get(format!("{base}/tags?include_schema=true"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let mut existing: HashMap<String, (String, Map<String, Value>)> = HashMap::new();
    for t in existing_list {
        let name = t.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let desc = t
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let fields = t
            .get("fields")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        existing.insert(name, (desc, fields));
    }

    let mut summary = SeedSummary::default();

    // 2. Per desired tag: create if absent/bare, else additive merge.
    for (tag, entry) in &desired.tags {
        let desired_desc = non_empty(&entry.description).unwrap_or("").to_string();
        let desired_fields = entry.fields.clone().unwrap_or_default();

        let cur = existing.get(tag);
        let has_schema = cur
            .map(|(d, f)| !d.trim().is_empty() || !f.is_empty())
            .unwrap_or(false);

        let (final_desc, final_fields, changed, is_create) = if !has_schema {
            // Absent or bare → create. Skip entirely if there's nothing to seed.
            if desired_desc.is_empty() && desired_fields.is_empty() {
                summary.unchanged += 1;
                continue;
            }
            (desired_desc, desired_fields, true, true)
        } else {
            // Present with a schema → additive merge only.
            let (cur_desc, cur_fields) = cur.unwrap();
            let mut merged = cur_fields.clone();
            let mut added_any = false;
            for (fname, fdef) in &desired_fields {
                if !merged.contains_key(fname) {
                    merged.insert(fname.clone(), fdef.clone());
                    added_any = true;
                }
                // else: field already defined — NEVER overwrite.
            }
            let cur_desc_ne = cur_desc.trim();
            let fill_desc = cur_desc_ne.is_empty() && !desired_desc.is_empty();
            let final_desc = if cur_desc_ne.is_empty() {
                desired_desc
            } else {
                cur_desc_ne.to_string()
            };
            (final_desc, merged, added_any || fill_desc, false)
        };

        if !changed {
            summary.unchanged += 1;
            continue;
        }

        client
            .put(format!("{}/tags/{}", base, urlencoding::encode(tag)))
            .header("Authorization", format!("Bearer {token}"))
            .json(&json!({ "description": final_desc, "fields": final_fields }))
            .send()
            .await?
            .error_for_status()?;

        if is_create {
            summary.created.push(tag.clone());
        } else {
            summary.updated.push(tag.clone());
        }
    }

    Ok(summary)
}
