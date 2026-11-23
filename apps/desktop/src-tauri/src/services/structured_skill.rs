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
/// Retry cap (chars): if the first attempt fails (e.g. an unusually long note
/// still overflows a small context window), retry once with a much shorter body
/// — the message opening alone is enough to classify.
const RETRY_NOTE_CHARS: usize = 800;
/// Per-note classification timeout (seconds).
const PER_NOTE_TIMEOUT_SECS: u64 = 120;
/// Tag applied to a note that fails classification even after a retry. It marks
/// the note for human review and (via the exclusion check below) stops it from
/// recurring as an error every run — without giving it a real importance label
/// it didn't earn, so nothing is silently buried.
const REVIEW_TAG: &str = "triage-failed";

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
    /// `Err(reason)` naming the specific missing/invalid field, so a
    /// misconfigured skill surfaces an actionable error instead of a generic one.
    pub fn from_metadata(meta: &Value) -> Result<Self, String> {
        let s = meta.get("structured").ok_or(
            "missing 'structured' config block (executionMode is 'structured' but no \
             'structured' object is set in the skill note's metadata)",
        )?;

        let str_array = |key: &str| -> Vec<String> {
            s.get(key)
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };

        let source_tags = str_array("sourceTags");
        if source_tags.is_empty() {
            return Err("'structured.sourceTags' is missing or empty".into());
        }
        let schema = s.get("schema").cloned().ok_or("'structured.schema' is missing")?;
        let result_field = s
            .get("resultField")
            .and_then(|v| v.as_str())
            .ok_or("'structured.resultField' is missing")?
            .to_string();

        Ok(Self {
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

    // 2. Drop already-processed notes (carry an exclude tag) and notes already
    //    flagged for review (a prior run couldn't classify them) — the latter
    //    keeps a single unclassifiable note from erroring on every run forever.
    candidates.retain(|n| {
        let tags = n.tags.clone().unwrap_or_default();
        !tags.iter().any(|t| t == REVIEW_TAG)
            && !cfg.exclude_tags.iter().any(|ex| tags.contains(ex))
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
    let mut flagged = 0usize;
    let mut errors = 0usize;

    for note in &candidates {
        // Deterministic shortcut: a hard label prior (e.g. Gmail
        // CATEGORY_PROMOTIONS → low) skips the model entirely. Saves a call and
        // sidesteps the pathological tokenization of URL-heavy promo mail.
        let label = if let Some(v) = shortcut_label(note, cfg) {
            v
        } else {
            match classify_one(agent, rubric, cfg, model, note, &today).await {
                Ok(label) => label,
                // Couldn't classify even after a retry: flag for review rather
                // than erroring forever. The note gets no importance label, so
                // it can't pass as handled; it's just removed from the queue and
                // made queryable via REVIEW_TAG.
                Err(reason) => {
                    warn!("structured skill: flagging {} for review: {reason}", note.id);
                    match parachute.add_tags(&note.id, &[REVIEW_TAG.to_string()]).await {
                        Ok(()) => flagged += 1,
                        Err(e) => {
                            warn!("structured skill: failed to flag {}: {e}", note.id);
                            errors += 1;
                        }
                    }
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
    let classified = total - flagged - errors;
    let mut summary = format!(
        "Structured tagging complete — {classified} of {total} note(s) classified"
    );
    if flagged > 0 {
        summary.push_str(&format!(", {flagged} flagged for review ({REVIEW_TAG})"));
    }
    if errors > 0 {
        summary.push_str(&format!(", {errors} error(s)"));
    }
    summary.push_str(&format!(
        ".\n{}",
        if breakdown.is_empty() { "(none)".into() } else { breakdown.join(", ") }
    ));
    Ok(summary)
}

/// Classify one note, retrying once with a hard-truncated prompt if the first
/// attempt fails at the transport/model layer (e.g. a still-too-long note). A
/// model response that parses but yields a missing or disallowed value is not
/// retried (grammar-constrained output makes that a real, non-transient issue).
/// Returns the validated label or a human-readable failure reason.
async fn classify_one(
    agent: &LocalAgent,
    rubric: &str,
    cfg: &StructuredConfig,
    model: &str,
    note: &Note,
    today: &str,
) -> Result<String, String> {
    let caps = [MAX_NOTE_CHARS, RETRY_NOTE_CHARS];
    for (attempt, &cap) in caps.iter().enumerate() {
        let user_prompt = build_note_prompt(note, today, cap);
        match agent
            .run_structured(rubric, &user_prompt, "classification", cfg.schema.clone(), model, PER_NOTE_TIMEOUT_SECS)
            .await
        {
            Ok(json) => {
                return match json.get(&cfg.result_field).and_then(|v| v.as_str()) {
                    Some(v) if cfg.allowed_values.is_empty() || cfg.allowed_values.iter().any(|a| a == v) => {
                        Ok(v.to_string())
                    }
                    Some(v) => Err(format!("value '{v}' not in allowed list")),
                    None => Err(format!("result field '{}' missing", cfg.result_field)),
                };
            }
            Err(e) => {
                let last = attempt + 1 == caps.len();
                if last {
                    return Err(e.to_string());
                }
                warn!("structured skill: attempt {} failed for {} ({e}); retrying truncated", attempt + 1, note.id);
            }
        }
    }
    Err("classification failed".into())
}

/// Build the per-note user prompt. Beyond the title + body, this surfaces the
/// signals the classifier needs but the raw content lacks: the current date (so
/// "deadline today/tomorrow" rules are applicable), the sender, the message's
/// own date, and the source's category labels (e.g. Gmail's CATEGORY_*). URLs
/// are stripped so a link-heavy message can't crowd out its readable text.
/// `cap` bounds the included body length (smaller on a retry).
fn build_note_prompt(note: &Note, today: &str, cap: usize) -> String {
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

    let body: String = strip_urls(&note.content).chars().take(cap).collect();
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
