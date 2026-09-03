/**
 * LIVE end-to-end check of server-side GitHub sync: create a throwaway private
 * repo, create a throwaway vault with a note, PUSH the note → confirm the file
 * lands in the repo, edit the repo file, PULL → confirm the vault note updates.
 * Cleans up both. Uses the `gh` CLI's token (server would read it from the
 * secret store). Proves the adapter works server-side without a local clone.
 *
 *   DB_PATH=/tmp/gh-e2e.db node --import tsx scripts/verify-github-sync.ts
 */
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${l}${d ? ` — ${d}` : ""}`); c ? pass++ : fail++; };

function restVault(url: string, vault: string, token: string) {
  const base = `${url}/vault/${vault}/api`;
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    async listNotes({ pathPrefix, includeContent }: { pathPrefix?: string; tags?: string[]; includeContent?: boolean }) {
      const sp = new URLSearchParams({ limit: "1000" });
      if (includeContent) sp.set("include_content", "true");
      if (pathPrefix) sp.set("path_prefix", pathPrefix);
      const r = await fetch(`${base}/notes?${sp}`, { headers: h });
      if (!r.ok) throw new Error(`list ${r.status}`);
      return r.json() as Promise<any[]>;
    },
    async getNote(id: string) {
      const r = await fetch(`${base}/notes/${encodeURIComponent(id)}`, { headers: h });
      if (!r.ok) throw new Error(`get ${r.status}`);
      return r.json();
    },
    async createNote(p: any) {
      const r = await fetch(`${base}/notes`, { method: "POST", headers: h, body: JSON.stringify(p) });
      if (!r.ok) throw new Error(`create ${r.status} ${await r.text()}`);
      return r.json();
    },
    async updateNote(id: string, p: any) {
      const r = await fetch(`${base}/notes/${encodeURIComponent(id)}`, { method: "PATCH", headers: h, body: JSON.stringify({ ...p, force: true }) });
      if (!r.ok) throw new Error(`update ${r.status}`);
      return r.json();
    },
  };
}

async function main() {
  const { GitHubClient, pushToGitHub, pullFromGitHub } = await import("../src/worker/github.js");
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const client = new GitHubClient(token);
  const owner = await client.login();
  ok("github token valid", !!owner, `user=${owner}`);

  const repo = "prism-sync-e2e";
  // create throwaway private repo (auto_init so the branch exists)
  const cr = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "prism-server" },
    body: JSON.stringify({ name: repo, private: true, auto_init: true }),
  });
  if (!cr.ok && cr.status !== 422) { console.log("  repo create failed:", cr.status, await cr.text()); process.exit(1); }
  ok("throwaway repo ready", true, `${owner}/${repo}`);
  await new Promise((r) => setTimeout(r, 1500));

  // Unique names per run: fresh vault (recreating a name reuses stale SQLite →
  // 500) AND a fresh repo file (reusing one file races GitHub's eventual
  // consistency / blob-sha).
  const runId = Date.now();
  const vname = `ghe2e${runId}`;
  const leaf = `n${runId}`;
  const repoFile = `${leaf}.md`;
  const config = { owner, repo, branch: "main", vaultPath: `vault/${vname}`, fileExtension: ".md" };
  const settle = () => new Promise((r) => setTimeout(r, 2500));

  execFileSync("parachute-vault", ["create", vname, "--no-mirror", "--json"], { encoding: "utf8" });
  const vtok = execFileSync("parachute", ["auth", "mint-token", "--scope", `vault:${vname}:write`, "--expires-in", "86400"], { encoding: "utf8" }).trim();
  const vault = restVault("http://localhost:1940", vname, vtok);
  await vault.createNote({ content: "# Hello\n\nfrom the server-side GitHub sync.", path: `vault/${vname}/${leaf}`, tags: ["note"], metadata: { title: "Hello" } });

  console.log("=== PUSH (vault → repo) ===");
  const pushed = await pushToGitHub(client, vault as any, config);
  ok("pushed note to repo", pushed >= 1, `pushed=${pushed}`);
  await settle();
  const file = await client.getFile(owner, repo, repoFile, "main");
  ok("file exists in repo with frontmatter + body", !!file && file.content.includes("from the server-side GitHub sync") && file.content.includes("title: Hello"));

  console.log("=== PULL (repo → vault) ===");
  // edit the repo file (fresh sha), then pull (no vault_path in FM → pull derives from config)
  const fresh = await client.getFile(owner, repo, repoFile, "main");
  await client.putFile(owner, repo, repoFile, "---\ntitle: Hello\n---\n\n# Hello\n\nEDITED IN GITHUB.", "edit", "main", fresh!.sha);
  await settle();
  const pulled = await pullFromGitHub(client, vault as any, config);
  ok("pulled changes into vault", pulled >= 1, `pulled=${pulled}`);
  const notes = await vault.listNotes({ pathPrefix: config.vaultPath, includeContent: true });
  const n = notes.find((x) => x.path === `${config.vaultPath}/${leaf}`);
  ok("vault note reflects the GitHub edit", !!n && n.content.includes("EDITED IN GITHUB"));

  console.log(`\n=== ${fail === 0 ? "PASS — server-side GitHub sync works (push + pull)" : "see failures"} ===`);
  console.log("=== teardown ===");
  try { const s = (await client.getFile(owner, repo, repoFile, "main"))?.sha; if (s) await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${repoFile}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "prism-server" }, body: JSON.stringify({ message: "cleanup", sha: s, branch: "main" }) }); } catch { /* */ }
  try { execFileSync("parachute-vault", ["remove", vname, "--yes"]); console.log("  removed vault"); } catch { /* */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("crashed:", e);
  try { execFileSync("parachute-vault", ["remove", "gh-e2e", "--yes"]); } catch { /* */ }
  process.exit(1);
});
