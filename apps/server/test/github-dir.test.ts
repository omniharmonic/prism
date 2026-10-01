/**
 * GitHub folder sync core (Client parity B): the desktop serialization/path rules
 * (ported from github.rs and pinned by its own unit tests), path-traversal
 * refusal, and `pushDirectory` against an in-memory GitHub — one commit per push,
 * blob-SHA no-op skip, conflict strategies, empty repo / new branch bootstrap,
 * racing fast-forward retry, size caps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertWikilinks,
  gitBlobSha,
  GitHubGitClient,
  isUnderVaultPath,
  mapVaultPathToRepoPath,
  normalizeExtension,
  normalizeVaultPath,
  parseRemote,
  pushDirectory,
  relativeLink,
  safeRepoPath,
  serializeNoteMarkdown,
  validBranch,
  type GitHubDirConfig,
} from "../src/worker/github-dir";
import type { Note } from "../src/parachute";
import { createFakeGitHub } from "./fake-github";
import { FakeSyncVault } from "./fake-sync-vault";

const cfg = (over: Partial<GitHubDirConfig> = {}): GitHubDirConfig => ({
  id: "c1",
  vaultId: "primary",
  vaultPath: "vault/docs",
  owner: "acme",
  repo: "notes",
  branch: "main",
  fileExtension: ".md",
  commitStrategy: "batched",
  conflictStrategy: "local-wins",
  autoSync: false,
  idMap: {},
  blobMap: {},
  lastSynced: "",
  ...over,
});

const note = (over: Partial<Note> & { id: string }): Note => ({ content: "", path: null, metadata: null, tags: [], createdAt: "", updatedAt: "", ...over });

// ── desktop parity: pure rules ───────────────────────────────────────────────

test("map_vault_path: strips the prefix, adds the extension, keeps an existing one; 'md' == '.md'", () => {
  const c = cfg({ vaultPath: "vault/projects/docs" });
  assert.equal(mapVaultPathToRepoPath("vault/projects/docs/readme", c), "readme.md");
  assert.equal(mapVaultPathToRepoPath("vault/projects/docs/sub/page", c), "sub/page.md");
  assert.equal(mapVaultPathToRepoPath("vault/projects/docs/file.txt", c), "file.txt");
  assert.equal(mapVaultPathToRepoPath("vault/docs/john-thiel", cfg({ fileExtension: "md" })), "john-thiel.md");
  assert.equal(normalizeExtension("md"), ".md");
  assert.equal(normalizeExtension(".md"), ".md");
  assert.equal(normalizeExtension("../x"), null);
});

test("is_under_vault_path matches on a segment boundary only", () => {
  assert.equal(isUnderVaultPath("vault/projects/opencivics/a", "vault/projects/opencivics"), true);
  assert.equal(isUnderVaultPath("vault/projects/opencivics", "vault/projects/opencivics"), true);
  assert.equal(isUnderVaultPath("vault/projects/opencivics-labs/a", "vault/projects/opencivics"), false);
});

test("relative links + wikilink conversion (desktop test vectors)", () => {
  assert.equal(relativeLink("people/peter-thiel.md", "people/alex-karp.md"), "alex-karp.md");
  assert.equal(relativeLink("people/peter-thiel.md", "concepts/mimesis.md"), "../concepts/mimesis.md");
  assert.equal(relativeLink("README.md", "people/peter-thiel.md"), "people/peter-thiel.md");
  const lookup = new Map([
    ["peter thiel", "people/peter-thiel.md"],
    ["mimesis", "concepts/mimesis.md"],
  ]);
  assert.equal(
    convertWikilinks("Talked to [[Peter Thiel]] about [[mimesis|girardian theory]] and [[Unknown Person]].", "people/alex-karp.md", lookup),
    "Talked to [Peter Thiel](peter-thiel.md) about [girardian theory](../concepts/mimesis.md) and [[Unknown Person]].",
  );
  const l2 = new Map([["vault/people/alex-karp", "people/alex-karp.md"]]);
  assert.equal(convertWikilinks("Co-founded with [[vault/people/alex-karp]].", "people/peter-thiel.md", l2), "Co-founded with [alex-karp](alex-karp.md).");
  const plain = "Use [link](http://example.com) and an array like [1, 2, 3].";
  assert.equal(convertWikilinks(plain, "x.md", new Map()), plain);
});

test("serialize: frontmatter like serde_yaml (title, tags, vault_path, sorted metadata) then body", () => {
  const out = serializeNoteMarkdown(
    note({ id: "1", content: "# Hello\n\nBody here.", path: "vault/notes/hello", metadata: { type: "doc", title: "Hello", count: 3, done: false, when: "2026-01-01", flag: "true" }, tags: ["greeting", "test"] }),
    "notes/hello.md",
    new Map(),
  );
  assert.equal(
    out,
    "---\ntitle: Hello\ntags:\n- greeting\n- test\nvault_path: vault/notes/hello\ncount: 3\ndone: false\nflag: 'true'\ntype: doc\nwhen: 2026-01-01\n---\n\n# Hello\n\nBody here.",
  );
  // No metadata, no tags, no path → just the body.
  assert.equal(serializeNoteMarkdown(note({ id: "2", content: "plain" }), "x.md", new Map()), "plain");
  // Title falls back to the path's file stem; quoting of indicator strings.
  const s = serializeNoteMarkdown(note({ id: "3", content: "", path: "vault/x/my-page", metadata: { a: "x: y", b: "- item", c: "" } }), "my-page.md", new Map());
  assert.match(s, /^---\ntitle: my-page\nvault_path: vault\/x\/my-page\na: 'x: y'\nb: '- item'\nc: ''\n---\n\n$/);
});

test("safeRepoPath refuses traversal, absolute paths, .git and control characters", () => {
  for (const bad of ["../x.md", "a/../../x.md", "/etc/passwd", ".git/config", "a/.GIT/hooks/x", "a//b.md", "a\\b.md", "a/\u0000.md", "./x.md", ""]) {
    assert.throws(() => safeRepoPath(bad), undefined, bad);
  }
  assert.equal(safeRepoPath("people/peter-thiel.md"), "people/peter-thiel.md");
  assert.equal(safeRepoPath(".github/notes.md"), ".github/notes.md");
});

test("remote / branch / folder validation", () => {
  assert.deepEqual(parseRemote("acme/notes"), { owner: "acme", repo: "notes" });
  assert.deepEqual(parseRemote("https://github.com/acme/notes.git"), { owner: "acme", repo: "notes" });
  assert.deepEqual(parseRemote("git@github.com:acme/notes.git"), { owner: "acme", repo: "notes" });
  for (const bad of ["https://evil.com/acme/notes", "https://user:pw@github.com/a/b", "acme/../x", "acme", "https://github.com/a/b/c", "file:///etc/passwd"]) {
    assert.equal(parseRemote(bad), null, bad);
  }
  assert.equal(validBranch("main"), true);
  assert.equal(validBranch("feature/x"), true);
  for (const bad of ["../main", "-x", "a..b", "a//b", "x.lock", "a@{b", "/x", ".hidden"]) assert.equal(validBranch(bad), false, bad);
  assert.equal(normalizeVaultPath("vault/docs/"), "vault/docs");
  assert.equal(normalizeVaultPath("vault/../etc"), null);
  assert.equal(normalizeVaultPath(""), null);
});

// ── pushDirectory against the fake GitHub ────────────────────────────────────

function setup(over: Partial<GitHubDirConfig> = {}, ghOpts: Parameters<typeof createFakeGitHub>[0] = {}) {
  const gh = createFakeGitHub(ghOpts);
  const client = new GitHubGitClient(gh.tokenOk, gh.fetch);
  const vault = new FakeSyncVault();
  vault.put({ id: "a", path: "vault/docs/alpha", content: "Alpha links [[beta]].", metadata: { title: "Alpha" }, tags: ["doc"] });
  vault.put({ id: "b", path: "vault/docs/sub/beta", content: "Beta body", metadata: null, tags: [] });
  vault.put({ id: "x", path: "vault/docs-other/gamma", content: "out of scope" });
  return { gh, client, vault, c: cfg(over) };
}

test("push all: ONE commit with every in-scope note; wikilinks resolved; out-of-scope ignored; token only to api.github.com", async () => {
  const { gh, client, vault, c } = setup();
  const before = gh.commitCount("main");
  const out = await pushDirectory(client, vault, c, { kind: "all" });
  assert.deepEqual(out.result.pushed.sort(), ["alpha.md", "sub/beta.md"]);
  assert.equal(gh.commitCount("main"), before + 1);
  assert.match(gh.commits.get(gh.branches.get("main")!)!.message, /^Prism sync: 2 file\(s\) updated$/);
  assert.match(gh.file("main", "alpha.md")!, /Alpha links \[beta\]\(sub\/beta\.md\)\./);
  assert.equal(gh.file("main", "gamma.md"), undefined);
  assert.deepEqual(out.result.pulled, ["README.md"]); // unmatched repo file = candidate only
  assert.equal(out.idMap.a, "alpha.md");
  assert.equal(out.blobMap["alpha.md"], gitBlobSha(gh.file("main", "alpha.md")!));
  assert.ok(gh.calls.every((x) => x.url.startsWith("https://api.github.com/") && x.authorization === `Bearer ${gh.tokenOk}`));
});

test("no-op skip: a second push with nothing changed makes no commit and downloads no file", async () => {
  const { gh, client, vault, c } = setup();
  const first = await pushDirectory(client, vault, c, { kind: "all" });
  const commits = gh.commitCount("main");
  gh.calls.length = 0;
  const second = await pushDirectory(client, vault, { ...c, idMap: first.idMap, blobMap: first.blobMap }, { kind: "all" });
  assert.equal(second.result.commit, null);
  assert.equal(second.result.unchanged, 2);
  assert.equal(gh.commitCount("main"), commits);
  assert.ok(!gh.calls.some((x) => x.method !== "GET"), "only reads");
  assert.ok(!gh.calls.some((x) => /\/contents\//.test(x.url)), "no file downloads");
});

test("conflicts: a file edited on GitHub since Prism wrote it — local-wins overwrites, remote-wins keeps it", async () => {
  for (const strategy of ["local-wins", "remote-wins"] as const) {
    const { gh, client, vault, c } = setup({ conflictStrategy: strategy });
    const first = await pushDirectory(client, vault, c, { kind: "all" });
    gh.commitDirect("main", { "alpha.md": "edited on github\n" });
    vault.notes.get("a")!.content = "Alpha edited in Prism";
    const out = await pushDirectory(client, vault, { ...c, idMap: first.idMap, blobMap: first.blobMap }, { kind: "all" });
    if (strategy === "local-wins") {
      assert.deepEqual(out.result.pushed, ["alpha.md"]);
      assert.match(gh.file("main", "alpha.md")!, /Alpha edited in Prism/);
    } else {
      assert.deepEqual(out.result.pushed, []);
      assert.equal(out.result.conflicts[0]!.path, "alpha.md");
      assert.equal(gh.file("main", "alpha.md"), "edited on github\n");
    }
  }
});

test("remote-wins still pushes a note edited only in Prism (the remote is what Prism last wrote)", async () => {
  const { gh, client, vault, c } = setup({ conflictStrategy: "remote-wins" });
  const first = await pushDirectory(client, vault, c, { kind: "all" });
  vault.notes.get("b")!.content = "Beta v2";
  const out = await pushDirectory(client, vault, { ...c, idMap: first.idMap, blobMap: first.blobMap }, { kind: "all" });
  assert.deepEqual(out.result.pushed, ["sub/beta.md"]);
  assert.equal(out.result.conflicts.length, 0);
  assert.match(gh.file("main", "sub/beta.md")!, /Beta v2/);
});

test("push-file: one note → 'Update <file>' commit; a note outside the folder is refused", async () => {
  const { gh, client, vault, c } = setup();
  const out = await pushDirectory(client, vault, c, { kind: "notes", ids: ["b"], single: true });
  assert.deepEqual(out.result.pushed, ["sub/beta.md"]);
  assert.equal(gh.commits.get(gh.branches.get("main")!)!.message, "Update beta.md");
  const refused = await pushDirectory(client, vault, c, { kind: "notes", ids: ["x"], single: true });
  assert.deepEqual(refused.result.pushed, []);
  assert.match(refused.result.errors[0]![1], /not under the sync folder/);
});

test("path traversal from a hostile note path never reaches GitHub", async () => {
  const { gh, client, vault, c } = setup();
  vault.put({ id: "evil", path: "vault/docs/../../.git/hooks/post-commit", content: "boom" });
  vault.put({ id: "evil2", path: "vault/docs/sub/.git/config", content: "boom" });
  const out = await pushDirectory(client, vault, c, { kind: "all" });
  assert.ok(out.result.errors.some(([p]) => p.includes("..")));
  assert.ok(out.result.errors.some(([p]) => p.includes(".git")));
  for (const call of gh.calls.filter((x) => x.method === "POST" && x.url.endsWith("/git/trees"))) {
    for (const e of call.body.tree) assert.ok(!e.path.includes("..") && !e.path.includes(".git/"), e.path);
  }
});

test("size caps: an oversize note is skipped with an error; others still go out", async () => {
  const { gh, client, vault, c } = setup();
  vault.notes.get("a")!.content = "x".repeat(2000);
  const out = await pushDirectory(client, vault, c, { kind: "all" }, { maxFileBytes: 1000, maxBatchBytes: 1e9, maxFiles: 100, treeChunk: 300 });
  assert.deepEqual(out.result.pushed, ["sub/beta.md"]);
  assert.match(out.result.errors[0]![1], /larger than/);
  assert.equal(gh.file("main", "alpha.md"), undefined);
});

test("empty repository: first file bootstraps the branch, the rest ride one commit", async () => {
  const { gh, client, vault, c } = setup({}, { empty: true });
  const out = await pushDirectory(client, vault, c, { kind: "all" });
  assert.ok(gh.file("main", "alpha.md"));
  assert.ok(gh.file("main", "sub/beta.md"));
  assert.equal(gh.commitCount("main"), 2);
  assert.equal(out.result.pushed.length + out.result.unchanged, 2);
});

test("new branch: created from the default branch", async () => {
  const { gh, client, vault, c } = setup({ branch: "prism-sync" });
  await pushDirectory(client, vault, c, { kind: "all" });
  assert.ok(gh.file("prism-sync", "alpha.md"));
  assert.equal(gh.file("prism-sync", "README.md"), "# readme\n"); // history kept
  assert.equal(gh.file("main", "alpha.md"), undefined);
});

test("racing push: a non-fast-forward is recomputed once against the new head", async () => {
  const { gh, client, vault, c } = setup();
  gh.raceNextRefUpdate = true;
  const out = await pushDirectory(client, vault, c, { kind: "all" });
  assert.ok(out.result.commit);
  assert.ok(gh.file("main", "OTHER.md"), "the racing commit survives");
  assert.ok(gh.file("main", "alpha.md"));
});
