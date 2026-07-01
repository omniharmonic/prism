/**
 * LIVE check of server-side Notion sync. Reads the Notion integration token from
 * the desktop config; if it's valid, does a real round-trip (create a subpage
 * under an accessible page → push markdown → pull it back → archive). If the
 * token is invalid (as the currently-stored one is), it reports that clearly —
 * the adapter is built + unit-tested, but a live round-trip needs a fresh token.
 *
 *   node --import tsx scripts/verify-notion-sync.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

async function main() {
  const { NotionClient, createNotionPage, pushNotionPage, pullNotionPage } = await import("../src/worker/notion.js");
  const cfg = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/prism/prism-config.json`, "utf8"));
  const apiKey = String(cfg.notion_api_key || "");
  if (!apiKey) { console.log("  ✗ no notion_api_key in config"); process.exit(2); }
  const client = new NotionClient(apiKey);

  console.log("=== 1. token check (whoami) ===");
  try {
    const who = await client.whoami();
    console.log(`  ✓ token VALID — bot=${who}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/401|unauthorized|invalid/i.test(msg)) {
      console.log("  ⚠ token INVALID — the stored Notion integration token is expired/revoked.");
      console.log("    The server-side Notion adapter is built + unit-tested; a live round-trip");
      console.log("    needs a fresh token: create/re-share a Notion integration, then store it via");
      console.log("    PUT /api/integrations/notion { apiKey } (or the desktop config).");
      process.exit(3); // distinct code: adapter OK, credential needs refresh
    }
    console.log("  ✗ whoami failed:", msg);
    process.exit(1);
  }

  console.log("=== 2. find an accessible parent page ===");
  const sres = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { property: "object", value: "page" }, page_size: 5 }),
  });
  const pages = ((await sres.json()) as { results?: any[] }).results ?? [];
  const parent = pages.find((p: any) => p.object === "page");
  if (!parent) { console.log("  ✗ the integration can't see any page to create under — share a page with it."); process.exit(4); }
  console.log(`  ✓ parent page ${parent.id}`);

  console.log("=== 3. create → push → pull round-trip ===");
  const marker = `prism-notion-e2e-${Date.now()}`;
  const md = `# ${marker}\n## Section\n- alpha\n- beta\n\nbody paragraph`;
  const pageId = await createNotionPage(client, parent.id, marker, md);
  console.log(`  created page ${pageId}`);
  await pushNotionPage(client, pageId, `# ${marker}\n\nREPLACED BY SERVER.`);
  const pulled = await pullNotionPage(client, pageId);
  const ok = pulled.includes("REPLACED BY SERVER");
  console.log(`  ${ok ? "✓" : "✗"} push+pull round-trip`);

  // archive (Notion has no hard delete via API)
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, { method: "PATCH", headers: { Authorization: `Bearer ${apiKey}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" }, body: JSON.stringify({ archived: true }) });
  console.log(`\n=== ${ok ? "PASS — server-side Notion sync works" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
