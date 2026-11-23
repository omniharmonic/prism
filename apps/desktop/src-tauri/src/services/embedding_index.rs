//! Semantic-search indexer (the "embeddings are managed in the Rust backend"
//! workflow). Like the other background sync services, this runs on a timer; it
//! walks the vault and pushes changed notes to the Prism Server's owner-only
//! `/api/index/notes` endpoint, which embeds + stores them. The SERVER owns the
//! vector index and the query path (so web + the desktop both get semantic
//! search instantly); this service is just the automation that keeps the index
//! current — embeddings stay a server-provided service.
//!
//! Incremental by design: we remember each note's `updated_at` and only push
//! notes that are new or changed (the server also skips unchanged content by
//! hash, so a redundant push is cheap). Notes that disappear from the vault are
//! de-indexed.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::watch;

use crate::clients::parachute::ParachuteClient;
use crate::models::note::{ListNotesParams, Note};
use crate::services::ServiceStatus;

const SYNC_INTERVAL_SECS: u64 = 300; // 5 min — embeddings aren't latency-critical
const BATCH: usize = 32; // notes per index request, to bound payload size

/// What changed between sweeps: which note ids to (re)embed and which to drop.
#[derive(Debug, Default, PartialEq)]
pub struct IndexDiff {
    pub upsert: Vec<String>,
    pub delete: Vec<String>,
}

/// Pure diff: a note is upserted if new or its `updated_at` changed; deleted if
/// it was present last sweep but is gone now. `current` is (id, updated_at).
pub fn compute_diff(prev: &HashMap<String, String>, current: &[(String, String)]) -> IndexDiff {
    let mut diff = IndexDiff::default();
    let cur_ids: HashMap<&str, &str> = current.iter().map(|(i, u)| (i.as_str(), u.as_str())).collect();
    for (id, updated) in current {
        match prev.get(id) {
            Some(prev_u) if prev_u == updated => {}
            _ => diff.upsert.push(id.clone()),
        }
    }
    for id in prev.keys() {
        if !cur_ids.contains_key(id.as_str()) {
            diff.delete.push(id.clone());
        }
    }
    diff
}

/// Derive the Prism Server HTTP base from its collab WebSocket url
/// (`ws(s)://host/collab` → `http(s)://host`). Mirrors config.rs's share-link path.
pub fn http_base_from_collab(collab_url: &str) -> String {
    collab_url
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1)
        .trim_end_matches("/collab")
        .trim_end_matches('/')
        .to_string()
}

fn set_err(status: &Arc<std::sync::Mutex<ServiceStatus>>, msg: String) {
    if let Ok(mut s) = status.lock() {
        s.last_error = Some(msg);
    }
}

async fn push_upserts(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    notes: &[&Note],
) -> Result<(), String> {
    for chunk in notes.chunks(BATCH) {
        let body = serde_json::json!({
            "notes": chunk.iter().map(|n| serde_json::json!({ "id": n.id, "content": n.content })).collect::<Vec<_>>(),
        });
        let resp = http
            .post(format!("{base}/api/index/notes"))
            .bearer_auth(token)
            .json(&body)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| format!("index push failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("index push → {}", resp.status()));
        }
    }
    Ok(())
}

async fn push_deletes(http: &reqwest::Client, base: &str, token: &str, ids: &[String]) {
    for id in ids {
        let _ = http
            .delete(format!("{base}/api/index/notes/{}", urlencoding::encode(id)))
            .bearer_auth(token)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await;
    }
}

/// One indexing sweep: list notes, diff against `seen`, push changes. Returns the
/// number of notes (re)indexed. `seen` is updated in place to the new snapshot.
async fn sweep(
    parachute: &ParachuteClient,
    http: &reqwest::Client,
    base: &str,
    token: &str,
    seen: &mut HashMap<String, String>,
) -> Result<u64, String> {
    let notes = parachute
        .list_notes(&ListNotesParams { tag: None, path: None, limit: Some(50_000), offset: None, include_content: true })
        .await
        .map_err(|e| format!("list_notes failed: {e}"))?;

    let current: Vec<(String, String)> = notes
        .iter()
        .map(|n| (n.id.clone(), n.updated_at.clone().unwrap_or_default()))
        .collect();
    let diff = compute_diff(seen, &current);

    if !diff.upsert.is_empty() {
        let by_id: HashMap<&str, &Note> = notes.iter().map(|n| (n.id.as_str(), n)).collect();
        let to_push: Vec<&Note> = diff.upsert.iter().filter_map(|id| by_id.get(id.as_str()).copied()).collect();
        push_upserts(http, base, token, &to_push).await?;
    }
    if !diff.delete.is_empty() {
        push_deletes(http, base, token, &diff.delete).await;
    }

    *seen = current.into_iter().collect();
    Ok(diff.upsert.len() as u64)
}

/// Run the indexer until shutdown.
pub async fn run(
    parachute: Arc<ParachuteClient>,
    collab_url: String,
    collab_token: String,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<std::sync::Mutex<ServiceStatus>>,
) {
    log::info!("Embedding index service starting");
    if let Ok(mut s) = status.lock() {
        s.running = true;
    }
    let base = http_base_from_collab(&collab_url);
    let http = reqwest::Client::new();
    let mut seen: HashMap<String, String> = HashMap::new();

    // Let the app boot before the first (potentially large) sweep.
    tokio::time::sleep(tokio::time::Duration::from_secs(15)).await;

    loop {
        if *shutdown.borrow() {
            log::info!("Embedding index service shutting down");
            break;
        }
        match sweep(&parachute, &http, &base, &collab_token, &mut seen).await {
            Ok(n) => {
                if let Ok(mut s) = status.lock() {
                    s.last_run = Some(chrono::Utc::now().to_rfc3339());
                    s.last_error = None;
                    s.items_processed += n;
                }
                if n > 0 {
                    log::info!("Embedding index: pushed {n} changed note(s)");
                }
            }
            Err(e) => {
                log::warn!("Embedding index sweep failed: {e}");
                set_err(&status, e);
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(SYNC_INTERVAL_SECS)) => {}
            _ = shutdown.changed() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn first_sweep_indexes_everything() {
        let diff = compute_diff(&HashMap::new(), &[("a".into(), "t1".into()), ("b".into(), "t1".into())]);
        let mut up = diff.upsert.clone();
        up.sort();
        assert_eq!(up, vec!["a", "b"]);
        assert!(diff.delete.is_empty());
    }

    #[test]
    fn unchanged_notes_are_skipped() {
        let prev = map(&[("a", "t1"), ("b", "t1")]);
        let diff = compute_diff(&prev, &[("a".into(), "t1".into()), ("b".into(), "t1".into())]);
        assert!(diff.upsert.is_empty());
        assert!(diff.delete.is_empty());
    }

    #[test]
    fn changed_and_new_notes_upsert_removed_notes_delete() {
        let prev = map(&[("a", "t1"), ("b", "t1"), ("c", "t1")]);
        // a changed (t2), b unchanged, c removed, d new.
        let diff = compute_diff(&prev, &[("a".into(), "t2".into()), ("b".into(), "t1".into()), ("d".into(), "t1".into())]);
        let mut up = diff.upsert.clone();
        up.sort();
        assert_eq!(up, vec!["a", "d"]);
        assert_eq!(diff.delete, vec!["c"]);
    }

    #[test]
    fn http_base_derivation() {
        assert_eq!(http_base_from_collab("wss://prism.example.com/collab"), "https://prism.example.com");
        assert_eq!(http_base_from_collab("ws://localhost:8787/collab"), "http://localhost:8787");
    }
}
