//! Evaluation harness for the structured recurring-skill path on MOCK data.
//!
//! Drives the real `structured_skill::run` executor (the exact code
//! `DispatchManager::dispatch_structured` runs) using the real `message-classify`
//! skill's rubric + schema pulled from the vault — but scoped to a dedicated
//! `eval-mock` tag so it classifies ONLY the mock notes this harness creates,
//! never the user's real email/message-thread notes.
//!
//! Flow: create labeled mock notes → run executor → re-read each note and score
//! predicted vs. expected label, confirm `triaged` applied → delete mock notes.
//!
//!   cd src-tauri && cargo run --example recurring_skill_eval

use prism_app_lib::clients::local_agent::LocalAgent;
use prism_app_lib::clients::mcp_client::PrismMcpClient;
use prism_app_lib::clients::parachute::ParachuteClient;
use prism_app_lib::models::note::{CreateNoteParams, ListNotesParams};
use prism_app_lib::services::structured_skill::StructuredConfig;
use serde_json::{json, Value};

const MODEL: &str = "qwen/qwen3.5-9b";
const LM_STUDIO: &str = "http://127.0.0.1:1234/v1";
const PARACHUTE: &str = "http://127.0.0.1:1940";
const VAULT: &str = "default";
const MOCK_TAG: &str = "eval-mock";

/// (kind-tag, expected-label, content). `kind-tag` mirrors how the real skill
/// sources notes (email vs message-thread).
const CASES: &[(&str, &str, &str)] = &[
    ("email", "urgent", "Subject: WIRE DEADLINE 5pm TODAY\n\nLegal needs your signed approval on the acquisition wire before 5pm today or we lose the closing window. Please confirm ASAP."),
    ("email", "urgent", "Subject: Board deck — your section\n\nHi Benjamin, the board deck is due tomorrow 9am. I still need your strategy section tonight. — Dana (co-founder)"),
    ("email", "action-required", "Subject: PRD review\n\nCould you review the attached product requirements doc and approve or send edits by Thursday? Thanks."),
    ("message-thread", "action-required", "Hey, trying to schedule the partnership sync — what time works for you next week, Tue or Wed afternoon?"),
    ("email", "informational", "Subject: This Week in AI — Issue #212\n\nThe weekly roundup of model releases and papers. Read online. Unsubscribe anytime."),
    ("message-thread", "informational", "GitHub: ✅ Workflow 'CI' succeeded on main (commit a1b2c3). No action needed."),
    ("email", "low", "Subject: 🎉 FLASH SALE — 70% OFF EVERYTHING\n\nThis weekend only! Shop now before it's gone. Click here. Unsubscribe."),
    ("message-thread", "low", "LinkedIn: You have 3 new connection suggestions and 1 person viewed your profile this week."),
];

#[tokio::main]
async fn main() {
    // --- MCP token from .mcp.json ---
    let raw = std::fs::read_to_string("../.mcp.json")
        .or_else(|_| std::fs::read_to_string(".mcp.json"))
        .expect("read .mcp.json");
    let cfg: Value = serde_json::from_str(&raw).unwrap();
    let server = &cfg["mcpServers"]["parachute-vault"];
    let mcp_url = server["url"].as_str().unwrap().to_string();
    let token = server["headers"]["Authorization"]
        .as_str()
        .map(|h| h.trim_start_matches("Bearer ").to_string());

    let parachute = ParachuteClient::new(PARACHUTE, VAULT, token.clone());
    let mcp = PrismMcpClient::connect(&mcp_url, token.as_deref()).await.expect("MCP connect");
    let agent = LocalAgent::new(LM_STUDIO, None, mcp);
    assert!(agent.health().await, "LM Studio unreachable");
    println!("✓ MCP + LM Studio connected\n");

    // --- 1. create labeled mock notes ---
    println!("→ creating {} mock notes (tag '{}')…", CASES.len(), MOCK_TAG);
    let mut created: Vec<(String, &str)> = Vec::new(); // (note_id, expected_label)
    for (i, (kind, expected, content)) in CASES.iter().enumerate() {
        let note = parachute
            .create_note(&CreateNoteParams {
                content: content.to_string(),
                path: Some(format!("vault/agent/test/eval-mock-{:02}", i)),
                metadata: Some(json!({ "type": kind, "expected": expected, "eval": true })),
                tags: Some(vec![MOCK_TAG.to_string(), kind.to_string()]),
            })
            .await
            .expect("create mock note");
        created.push((note.id, expected));
    }
    println!("✓ created {} notes\n", created.len());

    // --- 2. pull the REAL skill rubric + schema, scope it to the mock tag ---
    let skill = parachute
        .list_notes(&ListNotesParams {
            path: Some("vault/agent/skills/message-classify".into()),
            include_content: true,
            ..Default::default()
        })
        .await
        .expect("read skill note");
    let skill = skill.into_iter().next().expect("message-classify note not found");
    let rubric = skill.content.clone();
    let meta = skill.metadata.clone().expect("skill metadata");

    let mut sc = StructuredConfig::from_metadata(&meta).expect("parse structured config");
    sc.source_tags = vec![MOCK_TAG.to_string()]; // scope to mock data ONLY
    sc.exclude_tags = vec!["triaged".to_string()];
    println!("→ running structured executor on mock data (model {MODEL})…\n");

    // --- 3. run the real executor ---
    let summary = prism_app_lib::services::structured_skill::run(&agent, &parachute, &rubric, &sc, MODEL)
        .await
        .expect("executor run");
    println!("executor summary: {summary}\n");

    // --- 4. score predicted vs expected, confirm tags written ---
    println!("══ RESULTS ══");
    let labels = ["urgent", "action-required", "informational", "low"];
    let mut correct = 0;
    for (id, expected) in &created {
        let note = parachute.get_note(id).await.expect("re-read note");
        let tags = note.tags.unwrap_or_default();
        let predicted = labels.iter().find(|l| tags.contains(&l.to_string())).copied().unwrap_or("<none>");
        let triaged = tags.contains(&"triaged".to_string());
        let hit = predicted == *expected;
        if hit { correct += 1; }
        println!(
            "  {} expected={:<16} predicted={:<16} triaged={}",
            if hit { "✓" } else { "✗" }, expected, predicted, triaged
        );
    }
    println!("\naccuracy: {correct}/{} ({:.0}%)", created.len(), 100.0 * correct as f64 / created.len() as f64);

    // --- 5. cleanup ---
    println!("\n→ deleting mock notes…");
    let mut deleted = 0;
    for (id, _) in &created {
        if parachute.delete_note(id).await.is_ok() {
            deleted += 1;
        }
    }
    println!("✓ deleted {deleted}/{} mock notes", created.len());
}
