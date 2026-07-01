/**
 * LIVE end-to-end check of the SERVER SYNC ROUTES (not just the adapters):
 * drives the real `sync` Hono app the way the web/mobile client does — an owner
 * session cookie + x-prism-vault header → resolveActor → the per-tenant secret
 * store → the adapter → the live external service. Proves the full production
 * wiring (auth + credential lookup + dispatch), which the per-adapter verify
 * scripts don't exercise.
 *
 *   Covers:  POST /api/sync/github/{push,pull}      (GitHub, directory)
 *            POST /api/sync/note/:id/{push,pull}     (Google Docs, per-note)
 *   Skips:   Notion — desktop token is 401 (credential, not code).
 *
 *   DB_PATH=/tmp/sync-routes.db node --import tsx scripts/verify-sync-routes.ts
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

// SECRETS_KEY must exist BEFORE importing the secret store.
process.env.SECRETS_KEY ??= crypto.randomBytes(32).toString("base64");
process.env.DB_PATH ??= `/tmp/sync-routes-${Date.now()}.db`;

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${l}${d ? ` — ${d}` : ""}`); c ? pass++ : fail++; };
const J = { "content-type": "application/json" };

async function main() {
  const { sync } = await import("../src/routes/sync.js");
  const { config } = await import("../src/config.js");
  const { addVaultEntry, setMembership } = await import("../src/db.js");
  const { putSecret } = await import("../src/secrets.js");
  const { makeSession, sessionCookie } = await import("../test/helpers.js");
  const { GoogleDocsClient } = await import("../src/worker/googledocs.js");
  const { GitHubClient } = await import("../src/worker/github.js");

  const ghToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const gogAccount = "benjamin@opencivics.co";
  const runId = Date.now();
  const vname = `syncrt${runId}`;
  const settle = () => new Promise((r) => setTimeout(r, 2500));

  // ── Stand up a throwaway vault + register it server-side + store creds ──
  execFileSync("parachute-vault", ["create", vname, "--no-mirror", "--json"], { encoding: "utf8" });
  const vtok = execFileSync("parachute", ["auth", "mint-token", "--scope", `vault:${vname}:write`, "--expires-in", "86400"], { encoding: "utf8" }).trim();
  addVaultEntry({ id: vname, label: vname, url: "http://localhost:1940", vault: vname, token: vtok });
  setMembership(vname, config.ownerEmail, "owner", "e2e"); // the UI seeds this on vault create

  putSecret(vname, config.ownerEmail, "github", JSON.stringify({ token: ghToken }));
  putSecret(vname, config.ownerEmail, "google", JSON.stringify({ account: gogAccount }));
  const cookie = sessionCookie(makeSession(config.ownerEmail));
  const H = { ...J, cookie, "x-prism-vault": vname };
  ok("throwaway vault registered + creds stored + owner session", true, vname);

  const base = `http://localhost:1940/vault/${vname}/api`;
  const vh = { Authorization: `Bearer ${vtok}`, "Content-Type": "application/json" };
  const createNote = async (p: unknown) => (await fetch(`${base}/notes`, { method: "POST", headers: vh, body: JSON.stringify(p) })).json();
  const getNote = async (id: string) => (await fetch(`${base}/notes/${encodeURIComponent(id)}`, { headers: vh })).json();

  // ── 1. GitHub route: push a directory, confirm the file lands ──
  console.log("=== GitHub route (POST /api/sync/github/push) ===");
  const ghClient = new GitHubClient(ghToken);
  const owner = await ghClient.login();
  const repo = "prism-sync-e2e";
  const cr = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "prism-server" },
    body: JSON.stringify({ name: repo, private: true, auto_init: true }),
  });
  if (!cr.ok && cr.status !== 422) { console.log("  repo create failed", cr.status, await cr.text()); process.exit(1); }
  await settle();
  const leaf = `rt${runId}`;
  await createNote({ content: "# Route\n\npushed via the sync ROUTE.", path: `vault/${vname}/${leaf}`, tags: ["note"], metadata: { title: "Route" } });

  const pushRes = await sync.request("/github/push", { method: "POST", headers: H, body: JSON.stringify({ owner, repo, vaultPath: `vault/${vname}` }) });
  const pushBody = (await pushRes.json()) as { pushed?: number };
  ok("github/push → 200 + pushed>=1", pushRes.status === 200 && (pushBody.pushed ?? 0) >= 1, `status=${pushRes.status} pushed=${pushBody.pushed}`);
  await settle();
  const file = await ghClient.getFile(owner, repo, `${leaf}.md`, "main");
  ok("file landed in repo via route", !!file && file.content.includes("pushed via the sync ROUTE"));

  // edit in GitHub → pull via route
  const fresh = await ghClient.getFile(owner, repo, `${leaf}.md`, "main");
  await ghClient.putFile(owner, repo, `${leaf}.md`, "---\ntitle: Route\n---\n\n# Route\n\nEDITED VIA ROUTE PULL.", "edit", "main", fresh!.sha);
  await settle();
  const pullRes = await sync.request("/github/pull", { method: "POST", headers: H, body: JSON.stringify({ owner, repo, vaultPath: `vault/${vname}` }) });
  const pullBody = (await pullRes.json()) as { pulled?: number };
  ok("github/pull → 200 + pulled>=1", pullRes.status === 200 && (pullBody.pulled ?? 0) >= 1, `status=${pullRes.status} pulled=${pullBody.pulled}`);
  const notes = (await (await fetch(`${base}/notes?path_prefix=vault/${vname}&include_content=true&limit=100`, { headers: vh })).json()) as Array<{ path: string; content: string }>;
  ok("vault note reflects the GitHub edit (via route)", notes.some((n) => n.path === `vault/${vname}/${leaf}` && n.content.includes("EDITED VIA ROUTE PULL")));

  // ── 2. Google Docs route: per-note push (create doc), then pull it back ──
  console.log("=== Google Docs route (POST /api/sync/note/:id/push) ===");
  const gnote = (await createNote({ content: "# GDoc route\n\nsynced through the note route.", path: `vault/${vname}/gdoc${runId}`, tags: ["note"], metadata: { title: "GDoc route", sync: [{ adapter: "google-docs" }] } })) as { id: string };
  const gPush = await sync.request(`/note/${gnote.id}/push`, { method: "POST", headers: H, body: "{}" });
  const gPushBody = (await gPush.json()) as { results?: Array<{ adapter: string; remote_id?: string; pushed?: boolean; error?: string }> };
  const gres = gPushBody.results?.[0];
  ok("note/push google-docs → doc created + remote_id", gPush.status === 200 && !!gres?.remote_id && gres?.pushed === true, `${JSON.stringify(gres)}`);

  let docId: string | undefined;
  if (gres?.remote_id) {
    docId = gres.remote_id;
    // remote_id persisted back onto the note's metadata.sync[]?
    const after = (await getNote(gnote.id)) as { metadata?: { sync?: Array<{ remote_id?: string }> } };
    ok("remote_id persisted to note metadata.sync[]", after.metadata?.sync?.[0]?.remote_id === docId);
    // pull it back
    const gPull = await sync.request(`/note/${gnote.id}/pull`, { method: "POST", headers: H, body: "{}" });
    ok("note/pull google-docs → 200 pulled", gPull.status === 200 && ((await gPull.json()) as { pulled?: boolean }).pulled === true, `status=${gPull.status}`);
  }

  // ── teardown ──
  console.log("=== teardown ===");
  try { const s = (await ghClient.getFile(owner, repo, `${leaf}.md`, "main"))?.sha; if (s) await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${leaf}.md`, { method: "DELETE", headers: { Authorization: `Bearer ${ghToken}`, "Content-Type": "application/json", "User-Agent": "prism-server" }, body: JSON.stringify({ message: "cleanup", sha: s, branch: "main" }) }); } catch { /* */ }
  if (docId) { try { await new GoogleDocsClient(gogAccount).trashDoc(docId); console.log("  trashed google doc"); } catch { /* */ } }
  try { execFileSync("parachute-vault", ["remove", vname, "--yes"]); console.log("  removed vault"); } catch { /* */ }

  console.log(`\n=== ${fail === 0 ? "PASS — server sync ROUTES work end-to-end (GitHub + Google Docs)" : `${fail} FAILED`} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
