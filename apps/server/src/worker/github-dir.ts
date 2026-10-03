/**
 * GitHub FOLDER sync, server-side (Client parity B). The port of the legacy
 * desktop's directory sync (`apps/desktop/src-tauri/src/sync/adapters/github.rs`
 * + `commands/github_cmds.rs`), which kept a local clone and shelled out to
 * `git`/`gh`. The server does the same job over the GitHub **Git Data API** with
 * the stored `github` credential:
 *
 *   ref → commit → recursive tree   (what the branch holds, with blob SHAs)
 *   compare each note's serialized markdown by its git BLOB SHA (computed
 *     locally, so an unchanged file costs no download at all)
 *   POST /git/trees (base_tree + only the changed files) → POST /git/commits
 *     → PATCH /git/refs (fast-forward only)
 *
 * so a push of N changed notes is ONE commit, exactly like the desktop's
 * `git add … && git commit && git push` — with no working tree on disk, no `git`
 * binary and no `gh` login on the server. (Why not a clone: the desktop needed
 * one only because it used the CLI; a clone on the server would be a second copy
 * of the vault folder on disk per repo, a `git` dependency, and a credential
 * helper for the token. The API gives the same atomic one-commit semantics.)
 *
 * Behaviour carried over from the desktop (pinned by test/github-dir.test.ts):
 *  - scope = notes whose path is under `vault_path` on a SEGMENT boundary;
 *  - repo path = vault path minus the prefix, + `file_extension` when the leaf has
 *    no extension ("md" and ".md" both accepted);
 *  - markdown = YAML frontmatter (title, tags, vault_path, then every other
 *    metadata key in key order — serde_json's map is sorted) + the content with
 *    `[[wikilinks]]` rewritten to relative markdown links resolved against the
 *    synced set (unresolved links stay as written);
 *  - commit message "Prism sync: N file(s) updated" (one note: "Update <file>"),
 *    author "Prism Sync <prism@local>";
 *  - repo files with the sync extension that no note maps to are reported as
 *    `pulled` CANDIDATES and are not imported (the desktop never imported them;
 *    the stateless `POST /api/sync/github/pull` still exists for that);
 *  - files are never deleted from the repo.
 *
 * Deliberate changes (all write less or refuse more):
 *  - conflict detection is real: a file whose remote blob is not the one Prism
 *    last pushed (`blob_map`) was changed on GitHub. `local-wins` overwrites it,
 *    `remote-wins` leaves it and reports a conflict. (The desktop compared with its
 *    clone, so under remote-wins it stopped pushing a note forever after its first
 *    local edit; and the UI's `remote_wins` spelling never matched `remote-wins`.)
 *  - every repo path goes through `safeRepoPath` (no `..`, no absolute path, no
 *    `.git/`, no control characters) and per-file / per-batch size caps;
 *  - push-file refuses a note outside the sync folder (the desktop pushed it under
 *    its full vault path).
 */
import { stripIdentity } from "../identity-keys";
import { createHash } from "node:crypto";
import type { Note } from "../parachute";

// ── config shape ─────────────────────────────────────────────────────────────

export type CommitStrategy = "per_save" | "batched" | "manual";
export type GhConflictStrategy = "local-wins" | "remote-wins";

export interface GitHubDirConfig {
  id: string;
  vaultId: string;
  vaultPath: string;
  owner: string;
  repo: string;
  branch: string;
  fileExtension: string;
  commitStrategy: CommitStrategy;
  conflictStrategy: GhConflictStrategy;
  autoSync: boolean;
  /** note id → repo-relative path (desktop field, now actually maintained). */
  idMap: Record<string, string>;
  /** repo path → blob SHA Prism last pushed / saw identical (conflict detection). */
  blobMap: Record<string, string>;
  lastSynced: string;
}

// ── validation (outbound-safety) ─────────────────────────────────────────────

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** "owner/repo", "https://github.com/owner/repo(.git)(/)" or "git@github.com:owner/repo.git"
 *  → {owner, repo}, or null. Only github.com remotes are accepted. */
export function parseRemote(input: string): { owner: string; repo: string } | null {
  let s = (input ?? "").trim();
  if (!s || s.length > 300) return null;
  const ssh = /^git@github\.com:(.+)$/i.exec(s);
  if (ssh) s = ssh[1]!;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.hostname.toLowerCase() !== "github.com" && u.hostname.toLowerCase() !== "www.github.com") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    s = u.pathname;
  }
  s = s.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = s.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** Git ref-name rules (subset, conservative). */
export function validBranch(b: string): boolean {
  if (!b || b.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(b)) return false;
  if (b.startsWith("/") || b.startsWith("-") || b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock")) return false;
  if (b.includes("..") || b.includes("//") || b.includes("@{")) return false;
  return b.split("/").every((seg) => seg && !seg.startsWith("."));
}

/** "md" | ".md" | "" → ".md" | "" (desktop normalize_extension), or null if unsafe. */
export function normalizeExtension(ext: string): string | null {
  const t = (ext ?? "").replace(/^\.+/, "");
  if (!t) return "";
  return /^[A-Za-z0-9]{1,16}$/.test(t) ? `.${t}` : null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A vault path prefix to sync: no traversal segments, no control chars. Trailing
 *  slashes trimmed. Returns null when unsafe. "" (whole vault) is refused. */
export function normalizeVaultPath(p: string): string | null {
  const t = (p ?? "").trim().replace(/\/+$/, "");
  // "/" and "" would put the WHOLE vault in scope; a leading "/" is never a vault path.
  if (!t || t.startsWith("/") || t.length > 1000 || CONTROL.test(t) || t.includes("\\")) return null;
  const segs = t.replace(/^\/+/, "").split("/");
  if (segs.some((s) => !s || s === "." || s === "..")) return null;
  return t;
}

/** Throws unless `p` is a safe, relative, normalized repo path (the ONLY gate
 *  between a vault note path and a path written into someone's repository). */
export function safeRepoPath(p: string): string {
  if (typeof p !== "string" || !p) throw new Error("empty repo path");
  if (CONTROL.test(p) || p.includes("\\")) throw new Error("repo path has control characters or a backslash");
  if (p.startsWith("/")) throw new Error("absolute repo path");
  if (Buffer.byteLength(p) > 4096) throw new Error("repo path too long");
  // Invisible / bidi characters can make ".git" look like something else (and
  // some filesystems fold them away): refuse them outright.
  if (INVISIBLE.test(p)) throw new Error("repo path has invisible characters");
  const segs = p.split("/");
  for (const s of segs) {
    if (!s) throw new Error("empty path segment");
    if (s === "." || s === "..") throw new Error("path traversal segment");
    // Mirrors git's verify_path: ".git" in any case, with trailing dots/spaces
    // (Windows folds them), its NTFS 8.3 short name "git~1", and after NFKC.
    const folded = s.normalize("NFKC").toLowerCase().replace(/[. ]+$/, "");
    if (folded === ".git" || folded === "git~1" || folded.startsWith(".git")) throw new Error(".git is not writable");
    // Review M2: no dot-files/dirs at all — .github/ (Actions workflows),
    // .gitmodules, .gitattributes, .gitignore change how the repo behaves.
    if (s.startsWith(".") || s.normalize("NFKC").startsWith(".")) throw new Error("dot-files and dot-directories are not writable");
    if (/[. ]$/.test(s)) throw new Error("path segment ends with a dot or space");
    if (Buffer.byteLength(s) > 255) throw new Error("path segment too long");
  }
  return p;
}

// Zero-width, bidi controls, soft hyphen, BOM.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

// ── path mapping (desktop is_under_vault_path / map_vault_path_to_repo_path) ──

export function isUnderVaultPath(notePath: string, vaultPath: string): boolean {
  const base = vaultPath.replace(/\/+$/, "");
  if (!base) return true;
  return notePath === base || notePath.startsWith(`${base}/`);
}

/** Rust `Path::file_stem`: the leaf minus its last extension (a leading dot is not one). */
export function fileStem(p: string): string {
  const leaf = p.split("/").filter(Boolean).pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

function hasExtension(p: string): boolean {
  const leaf = p.split("/").pop() ?? "";
  return leaf.lastIndexOf(".") > 0;
}

export function mapVaultPathToRepoPath(vaultPath: string, cfg: Pick<GitHubDirConfig, "vaultPath" | "fileExtension">): string {
  const stripped = (vaultPath.startsWith(cfg.vaultPath) ? vaultPath.slice(cfg.vaultPath.length) : vaultPath).replace(/^\/+/, "");
  const ext = normalizeExtension(cfg.fileExtension) || ".md";
  // Review M2: every written file carries the sync extension. A leaf that already
  // ends in it is kept; any other "extension" (file.txt, v1.2) gets it appended
  // (file.txt.md) — the desktop wrote file.txt / any extension as-is.
  if (hasExtension(stripped) && stripped.toLowerCase().endsWith(ext.toLowerCase())) return stripped;
  return `${stripped}${ext}`;
}

// ── wikilinks (desktop build_wikilink_lookup / relative_link / convert_wikilinks) ─

export function buildWikilinkLookup(notes: Note[], cfg: Pick<GitHubDirConfig, "vaultPath" | "fileExtension">): Map<string, string> {
  const map = new Map<string, string>();
  const put = (k: string, v: string) => {
    if (!map.has(k)) map.set(k, v);
  };
  for (const n of notes) {
    if (!n.path) continue;
    const repoRel = mapVaultPathToRepoPath(n.path, cfg);
    put(n.path.toLowerCase(), repoRel);
    const stem = fileStem(n.path);
    if (stem) put(stem.toLowerCase(), repoRel);
    const title = n.metadata?.title;
    if (typeof title === "string") put(title.toLowerCase(), repoRel);
  }
  return map;
}

export function relativeLink(fromRepoPath: string, toRepoPath: string): string {
  const fromParts = fromRepoPath.split("/").slice(0, -1).filter(Boolean);
  const toParts = toRepoPath.split("/").filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
  const out: string[] = [];
  for (let i = common; i < fromParts.length; i++) out.push("..");
  out.push(...toParts.slice(common));
  return out.length ? out.join("/") : toRepoPath;
}

export function convertWikilinks(content: string, currentRepoPath: string, lookup: Map<string, string>): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    if (content[i] === "[" && content[i + 1] === "[") {
      const close = content.indexOf("]]", i + 2);
      if (close !== -1) {
        const inner = content.slice(i + 2, close);
        if (!inner.includes("\n")) {
          const bar = inner.indexOf("|");
          const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
          const explicit = bar === -1 ? null : inner.slice(bar + 1).trim();
          const targetPath = lookup.get(target.toLowerCase());
          if (targetPath !== undefined) {
            const display = explicit ?? (target.includes("/") ? target.split("/").pop()! : target);
            out += `[${display}](${relativeLink(currentRepoPath, targetPath)})`;
          } else {
            out += content.slice(i, close + 2);
          }
          i = close + 2;
          continue;
        }
      }
    }
    out += content[i];
    i++;
  }
  return out;
}

// ── YAML frontmatter (serde_yaml 0.9-compatible for the shapes notes carry) ───
// The repos the desktop pushed were written by serde_yaml; matching its output
// keeps the first server push from rewriting every file just for formatting.

const YAML_NULL = /^(?:~|null|Null|NULL)$/;
const YAML_BOOL = /^(?:true|True|TRUE|false|False|FALSE)$/;
const YAML_INT = /^[-+]?(?:[0-9]+|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/;
const YAML_FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$|^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/;

function yamlString(s: string, indent: string): string {
  if (s === "") return "''";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f\u0085\u2028\u2029\ufeff]/.test(s) || s.includes("\t")) return JSON.stringify(s);
  if (s.includes("\n")) {
    const trailing = /\n+$/.exec(s)?.[0].length ?? 0;
    if (/(^|\n) /.test(s) || /[ ]\n/.test(s) || /[ ]$/.test(s.replace(/\n+$/, ""))) return JSON.stringify(s);
    const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+";
    const body = s.replace(/\n+$/, "").split("\n");
    const pad = `${indent}  `;
    const lines = body.map((l) => (l ? `${pad}${l}` : ""));
    for (let k = 1; k < trailing; k++) lines.push("");
    return `|${chomp}\n${lines.join("\n")}`;
  }
  if (YAML_NULL.test(s) || YAML_BOOL.test(s) || YAML_INT.test(s) || YAML_FLOAT.test(s)) return `'${s}'`;
  const plainOk =
    !/^\s|\s$/.test(s) &&
    !/^[#,\[\]{}&*!|>'"%@`]/.test(s) &&
    !/^[-?:](\s|$)/.test(s) &&
    !s.startsWith("---") &&
    !s.startsWith("...") &&
    !s.includes(": ") &&
    !s.includes(" #") &&
    !s.endsWith(":");
  if (plainOk) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

function yamlNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (!Number.isFinite(n)) return Number.isNaN(n) ? ".nan" : n > 0 ? ".inf" : "-.inf";
  return String(n);
}

const isScalar = (v: unknown) => v === null || typeof v !== "object";

function yamlScalar(v: unknown, indent: string): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return yamlNumber(v);
  return yamlString(String(v), indent);
}

/** Emit `key: value` lines for a mapping at `indent`. */
function yamlMapping(entries: Array<[string, unknown]>, indent: string): string[] {
  const lines: string[] = [];
  for (const [k, v] of entries) {
    const key = yamlString(k, indent);
    if (Array.isArray(v)) {
      if (!v.length) lines.push(`${indent}${key}: []`);
      else {
        lines.push(`${indent}${key}:`);
        lines.push(...yamlSequence(v, indent));
      }
    } else if (v && typeof v === "object") {
      const sub = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (!sub.length) lines.push(`${indent}${key}: {}`);
      else {
        lines.push(`${indent}${key}:`);
        lines.push(...yamlMapping(sub, `${indent}  `));
      }
    } else {
      lines.push(`${indent}${key}: ${yamlScalar(v, indent)}`);
    }
  }
  return lines;
}

function yamlSequence(items: unknown[], indent: string): string[] {
  const lines: string[] = [];
  for (const it of items) {
    if (isScalar(it)) lines.push(`${indent}- ${yamlScalar(it, `${indent}  `)}`);
    else if (Array.isArray(it)) {
      if (!it.length) lines.push(`${indent}- []`);
      else {
        const sub = yamlSequence(it, `${indent}  `);
        lines.push(`${indent}- ${sub[0]!.trimStart()}`, ...sub.slice(1));
      }
    } else {
      const sub = Object.entries(it as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (!sub.length) lines.push(`${indent}- {}`);
      else {
        const m = yamlMapping(sub, `${indent}  `);
        lines.push(`${indent}- ${m[0]!.trimStart()}`, ...m.slice(1));
      }
    }
  }
  return lines;
}

/** Desktop serialize_note_to_markdown. */
export function serializeNoteMarkdown(note: Note, currentRepoPath: string, lookup: Map<string, string>): string {
  // Who created/edited a note never leaves the server in an export (writer-stamp.ts).
  const meta = note.metadata && typeof note.metadata === "object" ? stripIdentity(note.metadata) : {};
  const entries: Array<[string, unknown]> = [];
  const title = typeof meta.title === "string" ? meta.title : note.path ? fileStem(note.path) : undefined;
  if (title !== undefined) entries.push(["title", title]);
  if (note.tags?.length) entries.push(["tags", note.tags]);
  if (note.path) entries.push(["vault_path", note.path]);
  // serde_json::Map (no preserve_order) iterates keys sorted.
  for (const k of Object.keys(meta).sort()) {
    if (k === "title" || k === "tags" || k === "vault_path") {
      // serde_yaml Mapping::insert replaces an existing key in place.
      if (k !== "title") {
        const ix = entries.findIndex(([e]) => e === k);
        if (ix >= 0) entries[ix] = [k, meta[k]];
        else entries.push([k, meta[k]]);
      }
      continue;
    }
    entries.push([k, meta[k]]);
  }
  const fm = yamlMapping(entries, "").join("\n").trimEnd();
  const body = convertWikilinks(note.content ?? "", currentRepoPath, lookup);
  return fm ? `---\n${fm}\n---\n\n${body}` : body;
}

/** git's blob object id: sha1("blob <len>\0" + bytes). */
export function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

// ── GitHub Git Data API client (injectable fetch; api.github.com ONLY) ────────

type FetchLike = typeof fetch;
export const GITHUB_API = "https://api.github.com";
const encSeg = (s: string) => encodeURIComponent(s);
const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly op: string,
    detail?: string,
  ) {
    super(`github ${op} → ${status}${detail ? ` (${detail})` : ""}`);
  }
}

export interface RemoteTreeEntry {
  path: string;
  type: string;
  sha: string;
}

export class GitHubGitClient {
  constructor(
    private token: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async call(op: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await this.fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "prism-server",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
    });
    let json: any = null;
    try {
      json = await r.json();
    } catch {
      /* empty body */
    }
    return { status: r.status, json };
  }

  private fail(op: string, res: { status: number; json: any }): never {
    // Only GitHub's short `message` (never a request echo), scrubbed + capped.
    const msg = typeof res.json?.message === "string" ? scrubMessage(res.json.message) : undefined;
    throw new GitHubApiError(res.status, op, msg);
  }

  async user(): Promise<{ login: string } | { status: number }> {
    const res = await this.call("user", "GET", "/user");
    if (res.status === 200 && typeof res.json?.login === "string") return { login: res.json.login };
    return { status: res.status };
  }

  async repo(owner: string, repo: string): Promise<{ defaultBranch: string; canPush: boolean; private: boolean } | null> {
    const res = await this.call("repo", "GET", `/repos/${encSeg(owner)}/${encSeg(repo)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail("repo", res);
    return {
      defaultBranch: typeof res.json?.default_branch === "string" ? res.json.default_branch : "main",
      canPush: res.json?.permissions?.push === true,
      private: res.json?.private === true,
    };
  }

  /** Commit SHA at refs/heads/<branch>, or null (no such branch / empty repo). */
  async headSha(owner: string, repo: string, branch: string): Promise<string | null> {
    const res = await this.call("ref", "GET", `/repos/${encSeg(owner)}/${encSeg(repo)}/git/ref/heads/${encPath(branch)}`);
    if (res.status === 404 || res.status === 409) return null;
    if (res.status !== 200) this.fail("ref", res);
    const sha = res.json?.object?.sha;
    if (typeof sha !== "string") throw new GitHubApiError(502, "ref", "malformed ref");
    return sha;
  }

  async commitTree(owner: string, repo: string, commitSha: string): Promise<string> {
    const res = await this.call("commit", "GET", `/repos/${encSeg(owner)}/${encSeg(repo)}/git/commits/${encSeg(commitSha)}`);
    if (res.status !== 200) this.fail("commit", res);
    const t = res.json?.tree?.sha;
    if (typeof t !== "string") throw new GitHubApiError(502, "commit", "malformed commit");
    return t;
  }

  async tree(owner: string, repo: string, treeSha: string): Promise<{ entries: RemoteTreeEntry[]; truncated: boolean }> {
    const res = await this.call("tree", "GET", `/repos/${encSeg(owner)}/${encSeg(repo)}/git/trees/${encSeg(treeSha)}?recursive=1`);
    if (res.status !== 200) this.fail("tree", res);
    const raw = Array.isArray(res.json?.tree) ? res.json.tree : [];
    return {
      entries: raw
        .filter((e: any) => typeof e?.path === "string" && typeof e?.sha === "string")
        .map((e: any) => ({ path: e.path, type: String(e.type), sha: e.sha })),
      truncated: res.json?.truncated === true,
    };
  }

  async createTree(owner: string, repo: string, baseTree: string | null, files: Array<{ path: string; content: string }>): Promise<string> {
    const body: Record<string, unknown> = {
      tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    };
    if (baseTree) body.base_tree = baseTree;
    const res = await this.call("create-tree", "POST", `/repos/${encSeg(owner)}/${encSeg(repo)}/git/trees`, body);
    if (res.status !== 201 && res.status !== 200) this.fail("create-tree", res);
    return res.json.sha as string;
  }

  async createCommit(owner: string, repo: string, message: string, tree: string, parents: string[]): Promise<string> {
    const res = await this.call("create-commit", "POST", `/repos/${encSeg(owner)}/${encSeg(repo)}/git/commits`, {
      message,
      tree,
      parents,
      author: { name: "Prism Sync", email: "prism@local" },
    });
    if (res.status !== 201 && res.status !== 200) this.fail("create-commit", res);
    return res.json.sha as string;
  }

  /** Fast-forward refs/heads/<branch>. Returns false on a non-fast-forward (422). */
  async updateRef(owner: string, repo: string, branch: string, sha: string): Promise<boolean> {
    const res = await this.call("update-ref", "PATCH", `/repos/${encSeg(owner)}/${encSeg(repo)}/git/refs/heads/${encPath(branch)}`, { sha, force: false });
    if (res.status === 200) return true;
    if (res.status === 422) return false;
    this.fail("update-ref", res);
  }

  async createRef(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    const res = await this.call("create-ref", "POST", `/repos/${encSeg(owner)}/${encSeg(repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    if (res.status !== 201 && res.status !== 200) this.fail("create-ref", res);
  }

  /** Contents API create — used ONLY to give an EMPTY repository its first commit
   *  (the Git Data API refuses to work on a repo with no commits). */
  async createFileInEmptyRepo(owner: string, repo: string, path: string, content: string, message: string, branch: string): Promise<void> {
    const res = await this.call("bootstrap", "PUT", `/repos/${encSeg(owner)}/${encSeg(repo)}/contents/${encPath(path)}`, {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      author: { name: "Prism Sync", email: "prism@local" },
    });
    if (res.status !== 201 && res.status !== 200) this.fail("bootstrap", res);
  }
}

export function scrubMessage(s: string): string {
  return s
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "[redacted]")
    .slice(0, 200);
}

// ── the push ────────────────────────────────────────────────────────────────

export interface DirSyncVault {
  listNotes(opts: { pathPrefix?: string; includeContent?: boolean; includeMetadata?: string[] }): Promise<Note[]>;
  getNote(id: string): Promise<Note>;
}

export interface DirectorySyncResult {
  /** Repo paths written in this commit. */
  pushed: string[];
  /** Repo files with the sync extension no note maps to (candidates; not imported). */
  pulled: string[];
  /** Files changed on GitHub since Prism last wrote them that remote-wins kept. */
  conflicts: Array<{ path: string; reason: string }>;
  /** [repo path or note id, message]. */
  errors: Array<[string, string]>;
  unchanged: number;
  commit: string | null;
}

export interface PushLimits {
  maxFileBytes: number;
  maxBatchBytes: number;
  maxFiles: number;
  /** Tree entries per POST /git/trees request. */
  treeChunk: number;
}

export function pushLimits(): PushLimits {
  const n = (k: string, d: number) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    maxFileBytes: n("GITHUB_SYNC_MAX_FILE_BYTES", 5 * 1024 * 1024),
    maxBatchBytes: n("GITHUB_SYNC_MAX_BATCH_BYTES", 50 * 1024 * 1024),
    maxFiles: n("GITHUB_SYNC_MAX_FILES", 5000),
    treeChunk: n("GITHUB_SYNC_TREE_CHUNK", 300),
  };
}

export type PushScope = { kind: "all" } | { kind: "notes"; ids: string[]; single?: boolean };

/** Updated bookkeeping the caller persists when the push succeeded. */
export interface PushOutcome {
  result: DirectorySyncResult;
  idMap: Record<string, string>;
  blobMap: Record<string, string>;
}

/**
 * One push of `scope` (every note under the folder, or a set of note ids) as ONE
 * commit. Never deletes repo files; never writes the vault. Idempotent: a second
 * run with nothing changed makes no commit.
 */
export async function pushDirectory(
  gh: GitHubGitClient,
  vault: DirSyncVault,
  cfg: GitHubDirConfig,
  scope: PushScope,
  limits: PushLimits = pushLimits(),
  /** May this note leave the vault? (security review M1: the config creator's
   *  view right; others' private notes never). Default: every note. */
  canView: (n: Note) => boolean = () => true,
): Promise<PushOutcome> {
  const result: DirectorySyncResult = { pushed: [], pulled: [], conflicts: [], errors: [], unchanged: 0, commit: null };
  const idMap = { ...cfg.idMap };
  const blobMap = { ...cfg.blobMap };
  const ext = normalizeExtension(cfg.fileExtension) || ".md";
  const inFolder = (n: Note) => !!n.path && isUnderVaultPath(n.path, cfg.vaultPath) && canView(n);

  // 1. What to push, and the in-scope set for wikilink resolution.
  let inScope: Note[];
  let targets: Note[];
  if (scope.kind === "all") {
    inScope = (await vault.listNotes({ pathPrefix: cfg.vaultPath, includeContent: true })).filter(inFolder);
    targets = inScope;
  } else {
    inScope = (
      await vault.listNotes({ pathPrefix: cfg.vaultPath, includeContent: false, includeMetadata: ["title", "prism_creator", "prism_visibility"] })
    ).filter(inFolder);
    targets = [];
    for (const id of [...new Set(scope.ids)]) {
      let n: Note;
      try {
        n = await vault.getNote(id);
      } catch {
        result.errors.push([id, "note not found"]);
        continue;
      }
      if (!n.path || !isUnderVaultPath(n.path, cfg.vaultPath)) {
        // A note moved out of the folder (auto-sync) or the wrong note (push-file).
        if (scope.single) result.errors.push([id, "note is not under the sync folder"]);
        continue;
      }
      if (!canView(n)) {
        if (scope.single) result.errors.push([id, "note is private to someone else"]);
        continue;
      }
      targets.push(n);
      if (!inScope.some((x) => x.id === n.id)) inScope.push(n);
      else inScope = inScope.map((x) => (x.id === n.id ? n : x));
    }
  }
  const lookup = buildWikilinkLookup(inScope, cfg);

  // 2. Serialize + sanitize + cap.
  const files: Array<{ path: string; content: string; sha: string; noteId: string }> = [];
  const seenPaths = new Set<string>();
  for (const n of targets) {
    let repoPath: string;
    try {
      repoPath = safeRepoPath(mapVaultPathToRepoPath(n.path!, cfg));
    } catch (e) {
      result.errors.push([n.path ?? n.id, (e as Error).message]);
      continue;
    }
    if (seenPaths.has(repoPath)) {
      result.errors.push([repoPath, "two notes map to the same repo path"]);
      continue;
    }
    seenPaths.add(repoPath);
    const content = serializeNoteMarkdown(n, repoPath, lookup);
    if (Buffer.byteLength(content) > limits.maxFileBytes) {
      result.errors.push([repoPath, `file larger than ${limits.maxFileBytes} bytes`]);
      continue;
    }
    files.push({ path: repoPath, content, sha: gitBlobSha(content), noteId: n.id });
  }

  // 3. Remote state (retry once on a racing fast-forward).
  for (let attempt = 0; attempt < 2; attempt++) {
    result.pushed = [];
    result.conflicts = [];
    result.pulled = [];
    result.unchanged = 0;
    const errorsBefore = result.errors.length;

    let head = await gh.headSha(cfg.owner, cfg.repo, cfg.branch);
    let createBranch = false;
    if (!head) {
      const info = await gh.repo(cfg.owner, cfg.repo);
      if (!info) throw new GitHubApiError(404, "repo", "repository not found or the token cannot see it");
      const base = info.defaultBranch !== cfg.branch ? await gh.headSha(cfg.owner, cfg.repo, info.defaultBranch) : null;
      if (base) {
        head = base;
        createBranch = true;
      } else if (files.length) {
        // Empty repository: the first file creates the branch (Contents API), then
        // everything else rides one normal commit on top of it.
        const first = files[0]!;
        await gh.createFileInEmptyRepo(cfg.owner, cfg.repo, first.path, first.content, `Prism sync: initial commit`, cfg.branch);
        head = await gh.headSha(cfg.owner, cfg.repo, cfg.branch);
        if (!head) throw new GitHubApiError(502, "bootstrap", "branch missing after the first commit");
      } else {
        return { result, idMap, blobMap };
      }
    }
    const baseTree = await gh.commitTree(cfg.owner, cfg.repo, head);
    const tree = await gh.tree(cfg.owner, cfg.repo, baseTree);
    if (tree.truncated) throw new GitHubApiError(413, "tree", "repository tree too large for one listing");
    const remote = new Map(tree.entries.map((e) => [e.path, e] as const));

    // 4. Decide per file.
    const changed: typeof files = [];
    let batchBytes = 0;
    for (const f of files) {
      const r = remote.get(f.path);
      if (r && r.type !== "blob") {
        result.errors.push([f.path, "a directory exists at this path in the repository"]);
        continue;
      }
      if (r && r.sha === f.sha) {
        result.unchanged++;
        blobMap[f.path] = f.sha;
        idMap[f.noteId] = f.path;
        continue;
      }
      if (r) {
        const remoteChangedExternally = blobMap[f.path] !== r.sha;
        if (remoteChangedExternally && cfg.conflictStrategy === "remote-wins") {
          result.conflicts.push({ path: f.path, reason: "changed on GitHub since Prism last wrote it; remote-wins kept it" });
          continue;
        }
      }
      if (changed.length >= limits.maxFiles || batchBytes + Buffer.byteLength(f.content) > limits.maxBatchBytes) {
        result.errors.push([f.path, "batch cap reached; run push again for the rest"]);
        continue;
      }
      batchBytes += Buffer.byteLength(f.content);
      changed.push(f);
    }

    // Candidates for pulling (desktop scan_unmatched_files), full pushes only.
    if (scope.kind === "all" && ext) {
      const mine = new Set(files.map((f) => f.path));
      for (const e of tree.entries) {
        if (e.type !== "blob" || !e.path.endsWith(ext) || mine.has(e.path)) continue;
        if (e.path.split("/").some((s) => s.toLowerCase() === ".git")) continue;
        result.pulled.push(e.path);
      }
    }

    if (!changed.length) {
      if (createBranch) await gh.createRef(cfg.owner, cfg.repo, cfg.branch, head);
      return { result, idMap, blobMap };
    }

    // 5. One commit: chained trees (chunked bodies), one commit, fast-forward.
    let treeSha = baseTree;
    for (let i = 0; i < changed.length; i += limits.treeChunk) {
      treeSha = await gh.createTree(cfg.owner, cfg.repo, treeSha, changed.slice(i, i + limits.treeChunk).map((f) => ({ path: f.path, content: f.content })));
    }
    const message =
      scope.kind === "notes" && scope.single && changed.length === 1
        ? `Update ${changed[0]!.path.split("/").pop()}`
        : `Prism sync: ${changed.length} file(s) updated`;
    const commit = await gh.createCommit(cfg.owner, cfg.repo, message, treeSha, [head]);
    let ok: boolean;
    if (createBranch) {
      await gh.createRef(cfg.owner, cfg.repo, cfg.branch, commit);
      ok = true;
    } else ok = await gh.updateRef(cfg.owner, cfg.repo, cfg.branch, commit);
    if (!ok) {
      // Someone pushed in between: recompute against the new head once.
      result.errors.length = errorsBefore;
      continue;
    }
    for (const f of changed) {
      result.pushed.push(f.path);
      blobMap[f.path] = f.sha;
      idMap[f.noteId] = f.path;
    }
    result.commit = commit;
    return { result, idMap, blobMap };
  }
  throw new GitHubApiError(409, "update-ref", "the branch kept moving; try again");
}
