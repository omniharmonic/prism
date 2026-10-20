//! End-to-end verification harness for the local-model recurring-skill path.
//!
//! Drives the real `LocalAgent` against a live LM Studio server and the live
//! Parachute vault MCP — exercising both execution modes:
//!   1. `run_structured` — grammar-constrained classification (the message-classify path).
//!   2. `run_agentic`     — the vault tool-calling loop.
//!
//! Run with LM Studio serving on :1234 and Parachute on :1940:
//!   cd src-tauri && cargo run --example local_agent_e2e
//!
//! Reads the MCP URL + bearer token from the project `.mcp.json`.

use serde_json::{json, Value};

use prism_app_lib::clients::local_agent::LocalAgent;
use prism_app_lib::clients::mcp_client::PrismMcpClient;

const MODEL: &str = "qwen/qwen3.5-9b";
const LM_STUDIO: &str = "http://127.0.0.1:1234/v1";

#[tokio::main]
async fn main() {
    // --- locate and parse .mcp.json (project root is cwd's parent when run from src-tauri) ---
    let raw = std::fs::read_to_string("../.mcp.json")
        .or_else(|_| std::fs::read_to_string(".mcp.json"))
        .expect("could not read .mcp.json from ../ or .");
    let cfg: Value = serde_json::from_str(&raw).expect("invalid .mcp.json");
    let server = &cfg["mcpServers"]["parachute-vault"];
    let mcp_url = server["url"].as_str().expect("missing mcp url").to_string();
    let token = server["headers"]["Authorization"]
        .as_str()
        .map(|h| h.trim_start_matches("Bearer ").to_string());

    println!("→ connecting MCP at {mcp_url}");
    let mcp = PrismMcpClient::connect(&mcp_url, token.as_deref())
        .await
        .expect("MCP connect failed");
    println!("✓ MCP connected — {} tools\n", mcp.tools().len());

    let agent = LocalAgent::new(LM_STUDIO, None, mcp);

    println!("→ checking LM Studio health…");
    assert!(agent.health().await, "LM Studio not reachable at {LM_STUDIO}");
    println!("✓ LM Studio reachable\n");

    // ── TEST 1: structured classification ─────────────────────────────
    println!("══ TEST 1: run_structured (grammar-constrained classification) ══");
    let schema = json!({
        "type": "object", "additionalProperties": false, "required": ["importance"],
        "properties": {
            "importance": {"type": "string", "enum": ["urgent","action-required","informational","low"]},
            "reason": {"type": "string"}
        }
    });
    let rubric = "You are an email triage classifier. Assign exactly one importance label \
                  (urgent / action-required / informational / low) and return JSON per the schema.";
    let allowed = ["urgent", "action-required", "informational", "low"];

    let cases = [
        ("urgent-ish", "Board deck is due tomorrow 9am — please send your section tonight. — Dana (co-founder)"),
        ("low-ish", "🔥 50% OFF EVERYTHING this weekend only! Unsubscribe at the bottom."),
        ("info-ish", "GitHub: your workflow 'CI' succeeded on main. No action needed."),
    ];

    let mut structured_pass = 0;
    for (name, msg) in cases {
        match agent.run_structured(rubric, msg, "classification", schema.clone(), MODEL, 120).await {
            Ok(v) => {
                let label = v.get("importance").and_then(|x| x.as_str()).unwrap_or("<none>");
                let ok = allowed.contains(&label);
                println!("  [{}] {} → importance={:?}  json={}", if ok {"PASS"} else {"FAIL"}, name, label, v);
                if ok { structured_pass += 1; }
            }
            Err(e) => println!("  [FAIL] {name} → error: {e}"),
        }
    }
    println!("  structured: {structured_pass}/{} produced a valid label\n", cases.len());

    // ── TEST 2: agentic tool loop ─────────────────────────────────────
    println!("══ TEST 2: run_agentic (vault tool-calling loop) ══");
    let sys = "You are a vault agent. Use the parachute-vault tools to answer. Be concise.";
    let task = "Use query-notes with tag \"task\" and limit 3 to fetch a few task notes. \
                Then reply with one sentence stating how many you retrieved and one example title.";
    match agent.run_agentic(sys, task, "e2e-agentic", MODEL, 300).await {
        Ok(out) => {
            let ok = !out.trim().is_empty();
            println!("  [{}] agentic output ({} chars):\n  {}", if ok {"PASS"} else {"FAIL"}, out.len(), out.replace('\n', "\n  "));
        }
        Err(e) => println!("  [FAIL] agentic → error: {e}"),
    }

    println!("\n✓ e2e harness complete");
}
