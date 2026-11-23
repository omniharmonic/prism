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
//! Only `description` + `fields` (+ `parent_names`) are seeded; `contentType` /
//! `precedence` are Prism-side renderer concerns and are not vault tag-schema state.
//!
//! Vault compatibility (same rules as the server seeder):
//!   - `indexed: true` is only sent on `string` fields we declare (vault 0.6.x
//!     500s — after a partial write — indexing anything else; 0.7.x 400s).
//!     Fields echoed back from the vault keep `indexed` for the types 0.7.x can
//!     index (string/integer/boolean/reference/date) and lose it otherwise.
//!   - vault ≥0.7.1 gates schema writes behind `vault:<name>:admin`; the PUTs
//!     use `admin_token` when given, and a 403 becomes an actionable error.

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
    /// Field definitions, passed through (minus non-string `indexed`) to the PUT body.
    #[serde(default)]
    fields: Option<Map<String, Value>>,
    /// Is-a parents (tag hierarchy), set only when the vault tag has none yet.
    #[serde(default)]
    parent_names: Option<Vec<String>>,
}

/// Types vault 0.7.x can index. Anything else carrying `indexed: true` is rejected.
const INDEXABLE_V07: [&str; 5] = ["string", "integer", "boolean", "reference", "date"];

/// Drop `indexed` from every field whose `type` fails `keep`.
fn strip_indexed(fields: &Map<String, Value>, keep: impl Fn(&str) -> bool) -> Map<String, Value> {
    fields
        .iter()
        .map(|(name, def)| {
            let mut def = def.clone();
            if let Some(obj) = def.as_object_mut() {
                let indexed = obj.get("indexed").and_then(Value::as_bool).unwrap_or(false);
                let ty = obj.get("type").and_then(Value::as_str).unwrap_or("");
                if indexed && !keep(ty) {
                    obj.remove("indexed");
                }
            }
            (name.clone(), def)
        })
        .collect()
}

/// Turn a failed schema request into an error an operator can act on.
async fn schema_error(resp: reqwest::Response, what: &str, vault: &str) -> PrismError {
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let error_type = body.get("error_type").and_then(Value::as_str).unwrap_or("");
    if status.as_u16() == 403 && error_type == "insufficient_scope" {
        return PrismError::Parachute(format!(
            "{what}: schema writes need vault:{vault}:admin (vault ≥0.7.1 refuses them with a write token) — \
             mint one with `parachute auth mint-token --scope vault:{vault}:admin --ephemeral`"
        ));
    }
    PrismError::Parachute(format!("{what}: {status} {error_type} {body}"))
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
    admin_token: Option<&str>,
) -> Result<SeedSummary, PrismError> {
    let write_token = admin_token.unwrap_or(token);
    let desired: SchemasFile = serde_json::from_str(TAG_SCHEMAS_JSON)
        .map_err(|e| PrismError::Config(format!("bundled tag-schemas.json is invalid: {e}")))?;

    let base = format!("{}/vault/{}/api", server_root.trim_end_matches('/'), vault);
    let client = reqwest::Client::new();

    // 1. Read existing schemas (name → (description, fields)).
    let resp = client
        .get(format!("{base}/tags?include_schema=true"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(schema_error(resp, "GET /tags", vault).await);
    }
    let existing_list: Vec<Value> = resp.json().await?;
    let mut existing: HashMap<String, (String, Map<String, Value>, bool)> = HashMap::new();
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
        let has_parents = t
            .get("parent_names")
            .and_then(Value::as_array)
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        existing.insert(name, (desc, strip_indexed(&fields, |t| INDEXABLE_V07.contains(&t)), has_parents));
    }

    let mut summary = SeedSummary::default();

    // 2. Per desired tag: create if absent/bare, else additive merge.
    for (tag, entry) in &desired.tags {
        let desired_desc = non_empty(&entry.description).unwrap_or("").to_string();
        let desired_fields = strip_indexed(&entry.fields.clone().unwrap_or_default(), |t| t == "string");
        let desired_parents = entry.parent_names.clone().unwrap_or_default();

        let cur = existing.get(tag);
        let has_schema = cur
            .map(|(d, f, _)| !d.trim().is_empty() || !f.is_empty())
            .unwrap_or(false);

        let (final_desc, final_fields, changed, is_create, send_parents) = if !has_schema {
            // Absent or bare → create. Skip entirely if there's nothing to seed.
            if desired_desc.is_empty() && desired_fields.is_empty() && desired_parents.is_empty() {
                summary.unchanged += 1;
                continue;
            }
            (desired_desc, desired_fields, true, true, !desired_parents.is_empty())
        } else {
            // Present with a schema → additive merge only.
            let (cur_desc, cur_fields, cur_has_parents) = cur.unwrap();
            // parent_names: only when the vault tag has none (never clobber a hierarchy).
            let add_parents = !cur_has_parents && !desired_parents.is_empty();
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
            (final_desc, merged, added_any || fill_desc || add_parents, false, add_parents)
        };

        if !changed {
            summary.unchanged += 1;
            continue;
        }

        let mut body = json!({ "description": final_desc, "fields": final_fields });
        if send_parents {
            body["parent_names"] = json!(desired_parents);
        }
        let resp = client
            .put(format!("{}/tags/{}", base, urlencoding::encode(tag)))
            .header("Authorization", format!("Bearer {write_token}"))
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(schema_error(resp, &format!("PUT /tags/{tag}"), vault).await);
        }

        if is_create {
            summary.created.push(tag.clone());
        } else {
            summary.updated.push(tag.clone());
        }
    }

    Ok(summary)
}
