//! Generic structured-output skill executor.
//!
//! Some recurring skills are pure *classification*: read a note, decide a single
//! label, write that label back as a tag. For these, the free-text agentic loop
//! is overkill and fragile — a model that emits slightly malformed JSON or
//! forgets to call `update-note` breaks the run. Structured mode removes both
//! failure modes:
//!
//! 1. The skill note declares `executionMode: "structured"` plus a `structured`
//!    config block (which notes to read, a JSON schema, and how to map the
//!    model's output field to vault tags).
//! 2. For each candidate note, this executor asks the local model for output
//!    conforming to the schema — grammar-constrained on LM Studio/llama.cpp, so
//!    the JSON is guaranteed valid — then applies the resulting tag via the
//!    Parachute REST client. The model never touches a tool.
//!
//! The result: classification that cannot fail on JSON parsing or a missed tool
//! call. The schema lives in the note, so new structured taggers are authored as
//! vault notes with no Rust changes.

use std::collections::{HashMap, HashSet};

use log::{info, warn};
use serde_json::Value;

use crate::clients::local_agent::LocalAgent;
use crate::clients::parachute::ParachuteClient;
use crate::error::PrismError;
use crate::models::note::{ListNotesParams, Note};

/// Per-note content cap (chars). Kept well under the model's token budget: a
/// classification needs only the opening of a message, and an oversized note
/// (e.g. a marketing email that is mostly long tracking URLs) used to tokenize
/// past a 4096-ctx model's limit and fail with HTTP 400 — which, since a failed
/// note never gets the exclude tag, recurred on every run. URLs are stripped
/// first (see `strip_urls`), so this cap applies to readable text.
const MAX_NOTE_CHARS: usize = 2500;
/// Per-note classification timeout (seconds).
const PER_NOTE_TIMEOUT_SECS: u64 = 120;

/// Parsed `structured` config block from an `agent-skill` note's metadata.
#[derive(Debug, Clone)]
pub struct StructuredConfig {
    /// Tags whose notes are candidates. Each is queried separately and unioned
    /// (the vault query takes one tag at a time).
    pub source_tags: Vec<String>,
    /// Skip any candidate already carrying one of these tags (idempotency —
    /// e.g. `["triaged"]` so processed notes aren't reclassified).
    pub exclude_tags: Vec<String>,
    /// Max notes to fetch per source tag.
    pub limit: u32,
    /// JSON Schema the model output must satisfy.
    pub schema: Value,
    /// The output field whose value becomes a tag (e.g. `"importance"`).
    pub result_field: String,
    /// Allowlist of permitted values for `result_field`. A value outside this
    /// list is rejected (defensive — keeps a hallucinated label out of the
    /// vault). Empty = accept any non-empty string.
    pub allowed_values: Vec<String>,
    /// Tags always added after a successful classification (e.g. `["triaged"]`).
    pub also_add_tags: Vec<String>,
    /// Deterministic shortcuts: if a candidate's `metadata.labels` contains one
    /// of these keys, assign the mapped value directly and skip the model call.
    /// Lets the vault encode hard priors (e.g. Gmail's `CATEGORY_PROMOTIONS` →
    /// `low`) without spending a model call — and dodges the worst tokenization
    /// cases (promo emails full of tracking URLs). The value must still satisfy
    /// `allowed_values`. Authored as `structured.shortcutLabels` in the note.
    pub shortcut_labels: HashMap<String, String>,
}

impl StructuredConfig {
    /// Parse the `structured` object out of a skill note's metadata. Returns
    /// `None` (with a logged reason) when required fields are missing.
    pub fn from_metadata(meta: &Value) -> Option<Self> {
        let s = meta.get("structured")?;

        let str_array = |key: &str| -> Vec<String> {
            s.get(key)
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };

        let source_tags = str_array("sourceTags");
        if source_tags.is_empty() {
            warn!("structured skill: 'sourceTags' missing or empty");
            return None;
        }
        let schema = s.get("schema").cloned()?;
        let result_field = s.get("resultField").and_then(|v| v.as_str())?.to_string();

        Some(Self {
            source_tags,
            exclude_tags: str_array("excludeTags"),
            limit: s.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as u32,
            schema,
            result_field,
            allowed_values: str_array("allowedValues"),
            also_add_tags: str_array("alsoAddTags"),
            shortcut_labels: s
                .get("shortcutLabels")
                .and_then(|v| v.as_object())
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

/// Run a structured-output classification skill end to end and return a human
/// summary. `rubric` is the skill note's content — the classification
/// instructions sent to the model as the system prompt.
pub async fn run(
    agent: &LocalAgent,
    parachute: &ParachuteClient,
    rubric: &str,
    cfg: &StructuredConfig,
    model: &str,
) -> Result<String, PrismError> {
    // 1. Gather candidate notes (union across source tags, dedup by id).
    let mut candidates: Vec<Note> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for tag in &cfg.source_tags {
        let notes = parachute
            .list_notes(&ListNotesParams {
                tag: Some(tag.clone()),
                limit: Some(cfg.limit),
                include_content: true,
                ..Default::default()
            })
            .await?;
        for n in notes {
            if seen.insert(n.id.clone()) {
                candidates.push(n);
            }
        }
    }

    // 2. Drop already-processed notes (carry an exclude tag).
    candidates.retain(|n| {
        let tags = n.tags.clone().unwrap_or_default();
        !cfg.exclude_tags.iter().any(|ex| tags.contains(ex))
    });

    let total = candidates.len();
    if total == 0 {
        return Ok("No unprocessed notes to classify.".into());
    }
    info!("structured skill: classifying {total} note(s) on model '{model}'");

    // 3. Classify each note with grammar-constrained structured output.
    // `today` anchors the rubric's relative-time rules ("deadline today/tomorrow"):
    // the model cannot judge urgency without knowing the current date.
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut errors = 0usize;

    for note in &candidates {
        // Deterministic shortcut: a hard label prior (e.g. Gmail
        // CATEGORY_PROMOTIONS → low) skips the model entirely. Saves a call and
        // sidesteps the pathological tokenization of URL-heavy promo mail.
        let label = if let Some(v) = shortcut_label(note, cfg) {
            v
        } else {
            let user_prompt = build_note_prompt(note, &today);

            let result = agent
                .run_structured(
                    rubric,
                    &user_prompt,
                    "classification",
                    cfg.schema.clone(),
                    model,
                    PER_NOTE_TIMEOUT_SECS,
                )
                .await;

            let json = match result {
                Ok(j) => j,
                Err(e) => {
                    warn!("structured skill: classify failed for {}: {e}", note.id);
                    errors += 1;
                    continue;
                }
            };

            let value = json
                .get(&cfg.result_field)
                .and_then(|v| v.as_str())
                .map(str::to_string);

            match value {
                Some(v) if cfg.allowed_values.is_empty() || cfg.allowed_values.contains(&v) => v,
                Some(v) => {
                    warn!("structured skill: value '{v}' not in allowed list; skipping {}", note.id);
                    errors += 1;
                    continue;
                }
                None => {
                    warn!("structured skill: result field '{}' missing for {}", cfg.result_field, note.id);
                    errors += 1;
                    continue;
                }
            }
        };

        // 4. Apply the label tag + any always-on tags via REST.
        let mut to_add = vec![label.clone()];
        to_add.extend(cfg.also_add_tags.iter().cloned());
        match parachute.add_tags(&note.id, &to_add).await {
            Ok(()) => {
                *counts.entry(label).or_default() += 1;
            }
            Err(e) => {
                warn!("structured skill: add_tags failed for {}: {e}", note.id);
                errors += 1;
            }
        }
    }

    // 5. Summarize.
    let mut breakdown: Vec<String> = counts.iter().map(|(k, n)| format!("{k}: {n}")).collect();
    breakdown.sort();
    Ok(format!(
        "Structured tagging complete — {} of {} note(s) classified, {} error(s).\n{}",
        total - errors,
        total,
        errors,
        if breakdown.is_empty() { "(none)".into() } else { breakdown.join(", ") }
    ))
}

/// Build the per-note user prompt. Beyond the title + body, this surfaces the
/// signals the classifier needs but the raw content lacks: the current date (so
/// "deadline today/tomorrow" rules are applicable), the sender, the message's
/// own date, and the source's category labels (e.g. Gmail's CATEGORY_*). URLs
/// are stripped so a link-heavy message can't crowd out its readable text.
fn build_note_prompt(note: &Note, today: &str) -> String {
    let title = note
        .path
        .as_deref()
        .and_then(|p| p.rsplit('/').next())
        .unwrap_or("Untitled");

    let meta = note.metadata.as_ref();
    let meta_str = |key: &str| meta.and_then(|m| m.get(key)).and_then(|v| v.as_str());

    let mut header = format!("Today's date: {today}\n");
    if let Some(from) = meta_str("from") {
        header.push_str(&format!("From: {from}\n"));
    }
    if let Some(date) = meta_str("date") {
        header.push_str(&format!("Message date: {date}\n"));
    }
    let labels = gmail_labels(note);
    if !labels.is_empty() {
        header.push_str(&format!("Source labels: {}\n", labels.join(", ")));
    }

    let body: String = strip_urls(&note.content).chars().take(MAX_NOTE_CHARS).collect();
    format!("{header}Title: {title}\n\n{body}")
}

/// Read a note's source-category labels (e.g. Gmail `CATEGORY_PROMOTIONS`,
/// `IMPORTANT`) from `metadata.labels`. Empty when absent.
fn gmail_labels(note: &Note) -> Vec<String> {
    note.metadata
        .as_ref()
        .and_then(|m| m.get("labels"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Resolve a deterministic label shortcut for a note, if one of its source
/// labels maps to a value in `cfg.shortcut_labels` (and that value is allowed).
fn shortcut_label(note: &Note, cfg: &StructuredConfig) -> Option<String> {
    if cfg.shortcut_labels.is_empty() {
        return None;
    }
    let labels = gmail_labels(note);
    for label in &labels {
        if let Some(value) = cfg.shortcut_labels.get(label) {
            if cfg.allowed_values.is_empty() || cfg.allowed_values.contains(value) {
                return Some(value.clone());
            }
        }
    }
    None
}

/// Collapse URLs to a short placeholder. Marketing emails are mostly long
/// tracking links (`https://l.engage.canva.com/ss/c/u001.Note3it1...`) whose
/// high-entropy characters tokenize far worse than prose — left in, they can
/// push even a short message past a small context window. Tokens containing
/// `://` are replaced with `<link>`; readable text is untouched.
fn strip_urls(content: &str) -> String {
    content
        .split_inclusive(char::is_whitespace)
        .map(|tok| {
            let trimmed = tok.trim_end();
            if trimmed.contains("://") {
                let ws = &tok[trimmed.len()..];
                format!("<link>{ws}")
            } else {
                tok.to_string()
            }
        })
        .collect()
}
