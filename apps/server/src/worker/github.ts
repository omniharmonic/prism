/**
 * GitHub ↔ vault sync (Phase 3), server-side. A Node port of the desktop's
 * github adapter that uses the GitHub HTTP Contents API + a token (from the
 * secret store) instead of shelling out to `git`/`gh` with a local clone — so it
 * runs on the server AND is portable (no working tree on disk).
 *
 * Sync unit: a vault path-prefix ⇄ a repo/branch. push = serialize each note to
 * markdown+frontmatter and PUT it; pull = read the repo's markdown files and
 * upsert them into the vault (the desktop only *detected* remote files and never
 * imported them — this implements the real pull). Note shape / frontmatter match
 * the desktop's serialize_note_to_markdown.
 */
import type { Note } from "../parachute";

export interface GitHubSyncConfig {
  owner: string;
  repo: string;
  branch: string;
  /** Vault path prefix this repo mirrors (e.g. "vault/projects"). */
  vaultPath: string;
  /** File extension for notes without one (default ".md"). */
  fileExtension?: string;
}

/** The vault surface the sync adapters need (real vaultClient satisfies it). */
export interface SyncVault {
  listNotes(opts: { pathPrefix?: string; tags?: string[]; includeContent?: boolean }): Promise<Note[]>;
  getNote(id: string): Promise<Note>;
  createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note>;
  updateNote(id: string, p: { content?: string; metadata?: Record<string, unknown> }): Promise<Note>;
}

type FetchLike = typeof fetch;
const GH = "https://api.github.com";
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export class GitHubClient {
  constructor(
    private token: string,
    private fetchImpl: FetchLike = fetch,
  ) {}
  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "User-Agent": "prism-server", "X-GitHub-Api-Version": "2022-11-28" };
  }
  async login(): Promise<string> {
    const r = await this.fetchImpl(`${GH}/user`, { headers: this.headers() });
    if (!r.ok) throw new Error(`github /user → ${r.status}`);
    return ((await r.json()) as { login: string }).login;
  }
  /** File content + blob sha, or null if it doesn't exist. */
  async getFile(owner: string, repo: string, path: string, branch: string): Promise<{ sha: string; content: string } | null> {
    const r = await this.fetchImpl(`${GH}/repos/${owner}/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(branch)}`, { headers: this.headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`github getFile ${path} → ${r.status}`);
    const j = (await r.json()) as { sha: string; content: string; encoding: string };
    return { sha: j.sha, content: Buffer.from(j.content, "base64").toString("utf8") };
  }
  async putFile(owner: string, repo: string, path: string, content: string, message: string, branch: string, sha?: string): Promise<void> {
    const body = { message, content: Buffer.from(content, "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) };
    const r = await this.fetchImpl(`${GH}/repos/${owner}/${repo}/contents/${enc(path)}`, { method: "PUT", headers: { ...this.headers(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`github putFile ${path} → ${r.status} ${await r.text()}`);
  }
  /** Recursive tree of the branch (paths + blob shas). */
  async listTree(owner: string, repo: string, branch: string): Promise<Array<{ path: string; type: string }>> {
    const r = await this.fetchImpl(`${GH}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers: this.headers() });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`github listTree → ${r.status}`);
    return ((await r.json()) as { tree: Array<{ path: string; type: string }> }).tree ?? [];
  }
}

// ── serialization (matches the desktop serialize_note_to_markdown) ────────────

const yamlScalar = (v: unknown): string => {
  if (typeof v === "string") return /[:#\-\n"]|^\s|\s$/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
};

export function serializeNote(note: Note): string {
  const meta = note.metadata ?? {};
  const lines: string[] = [];
  const title = (meta.title as string) ?? (note.path ? note.path.split("/").pop()!.replace(/\.[^.]+$/, "") : undefined);
  if (title) lines.push(`title: ${yamlScalar(title)}`);
  if (note.tags?.length) lines.push(`tags:\n${note.tags.map((t) => `  - ${yamlScalar(t)}`).join("\n")}`);
  if (note.path) lines.push(`vault_path: ${yamlScalar(note.path)}`);
  for (const [k, v] of Object.entries(meta)) {
    if (k === "title" || v == null) continue;
    if (Array.isArray(v)) lines.push(`${k}:\n${v.map((x) => `  - ${yamlScalar(x)}`).join("\n")}`);
    else if (typeof v === "object") lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${yamlScalar(v)}`);
  }
  const fm = lines.join("\n").trimEnd();
  const body = note.content ?? "";
  return fm ? `---\n${fm}\n---\n\n${body}` : body;
}

/** Repo-relative path for a note (strip the vault prefix, ensure the extension). */
export function repoPathFor(note: Note, config: GitHubSyncConfig): string {
  const ext = (config.fileExtension ?? ".md").startsWith(".") ? (config.fileExtension ?? ".md") : `.${config.fileExtension}`;
  let p = (note.path ?? note.id).replace(new RegExp(`^${config.vaultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "").replace(/^\/+/, "");
  if (!/\.[^/.]+$/.test(p)) p += ext;
  return p;
}

/** Strip YAML frontmatter → { metadata title/tags, body }. */
export function parseFrontmatter(text: string): { title?: string; tags?: string[]; vaultPath?: string; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { body: text };
  const fm = m[1]!;
  const body = text.slice(m[0].length).replace(/^\n+/, ""); // drop the blank line after the FM block
  const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "");
  const vaultPath = fm.match(/^vault_path:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "");
  const tags = [...fm.matchAll(/^\s+-\s+(.+)$/gm)].map((x) => x[1]!.replace(/^["']|["']$/g, ""));
  return { title, tags: tags.length ? tags : undefined, vaultPath, body };
}

export interface GitHubSyncResult {
  pushed: number;
  pulled: number;
}

/** Push every note under the config's vault prefix to the repo (create/update;
 *  skips unchanged files). */
export async function pushToGitHub(client: GitHubClient, vault: SyncVault, config: GitHubSyncConfig): Promise<number> {
  const notes = await vault.listNotes({ pathPrefix: config.vaultPath, includeContent: true });
  let pushed = 0;
  for (const n of notes) {
    const path = repoPathFor(n, config);
    const content = serializeNote(n);
    const existing = await client.getFile(config.owner, config.repo, path, config.branch);
    if (existing && existing.content === content) continue;
    await client.putFile(config.owner, config.repo, path, content, `Prism sync: ${n.path ?? n.id}`, config.branch, existing?.sha);
    pushed++;
  }
  return pushed;
}

/** Pull the repo's markdown files into the vault (upsert by vault_path/prefix
 *  path). The desktop never implemented this; here it's real. */
export async function pullFromGitHub(client: GitHubClient, vault: SyncVault, config: GitHubSyncConfig): Promise<number> {
  const tree = await client.listTree(config.owner, config.repo, config.branch);
  const mdFiles = tree.filter((t) => t.type === "blob" && /\.mdx?$/.test(t.path));
  const existing = await vault.listNotes({ pathPrefix: config.vaultPath, includeContent: true });
  // Parachute normalizes note paths by stripping the file extension, so match on
  // the extension-stripped path (both the stored path and the pull target).
  const stripExt = (p: string) => p.replace(/\.mdx?$/, "");
  const byPath = new Map(existing.map((n) => [stripExt(n.path ?? ""), n] as const));
  let pulled = 0;
  for (const f of mdFiles) {
    const file = await client.getFile(config.owner, config.repo, f.path, config.branch);
    if (!file) continue;
    const { title, tags, vaultPath, body } = parseFrontmatter(file.content);
    const targetPath = stripExt(vaultPath ?? `${config.vaultPath.replace(/\/$/, "")}/${f.path}`);
    const note = byPath.get(targetPath);
    if (note) {
      if (note.content !== body) {
        await vault.updateNote(note.id, { content: body });
        pulled++;
      }
    } else {
      await vault.createNote({ content: body, path: targetPath, tags: tags ?? [], metadata: { ...(title ? { title } : {}), source: "github" } });
      pulled++;
    }
  }
  return pulled;
}
