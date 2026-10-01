/**
 * In-memory GitHub (Git Data API + the bits of the REST API the folder sync
 * uses), served through an injected fetch — never the network. One repository
 * per instance. Blob SHAs are real git blob ids, so the sync's local-SHA
 * comparison is exercised exactly as against github.com.
 */
import { createHash } from "node:crypto";
import { gitBlobSha } from "../src/worker/github-dir";

export interface FakeGitHubCall {
  method: string;
  url: string;
  authorization: string | null;
  body: any;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  calls: FakeGitHubCall[];
  owner: string;
  repo: string;
  defaultBranch: string;
  canPush: boolean;
  isPrivate: boolean;
  tokenOk: string;
  branches: Map<string, string>; // branch → commit sha
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  trees: Map<string, Map<string, string>>; // tree sha → path → blob sha
  blobs: Map<string, string>; // blob sha → content
  /** Simulate a concurrent push on the next ref update (422 once). */
  raceNextRefUpdate: boolean;
  /** Commit files directly on a branch (someone editing on GitHub). */
  commitDirect(branch: string, files: Record<string, string>, message?: string): string;
  /** Content of `path` at the head of `branch`. */
  file(branch: string, path: string): string | undefined;
  commitCount(branch: string): number;
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
let counter = 0;

export function createFakeGitHub(opts: { owner?: string; repo?: string; empty?: boolean; canPush?: boolean; token?: string } = {}): FakeGitHub {
  const gh: FakeGitHub = {
    fetch: null as unknown as typeof fetch,
    calls: [],
    owner: opts.owner ?? "acme",
    repo: opts.repo ?? "notes",
    defaultBranch: "main",
    canPush: opts.canPush ?? true,
    isPrivate: true,
    tokenOk: opts.token ?? "ghp_testtoken",
    branches: new Map(),
    commits: new Map(),
    trees: new Map(),
    blobs: new Map(),
    raceNextRefUpdate: false,
    commitDirect(branch, files, message = "direct") {
      const head = gh.branches.get(branch);
      const base = head ? new Map(gh.trees.get(gh.commits.get(head)!.tree)!) : new Map<string, string>();
      for (const [p, c] of Object.entries(files)) {
        const b = gitBlobSha(c);
        gh.blobs.set(b, c);
        base.set(p, b);
      }
      const t = putTree(base);
      const c = sha1(`commit${++counter}`);
      gh.commits.set(c, { tree: t, parents: head ? [head] : [], message });
      gh.branches.set(branch, c);
      return c;
    },
    file(branch, path) {
      const head = gh.branches.get(branch);
      if (!head) return undefined;
      const b = gh.trees.get(gh.commits.get(head)!.tree)!.get(path);
      return b ? gh.blobs.get(b) : undefined;
    },
    commitCount(branch) {
      let n = 0;
      let cur = gh.branches.get(branch);
      while (cur) {
        n++;
        cur = gh.commits.get(cur)?.parents[0];
      }
      return n;
    },
  };
  function putTree(m: Map<string, string>): string {
    const key = sha1(`tree:${[...m.entries()].sort().map(([p, b]) => `${p}=${b}`).join(";")}`);
    gh.trees.set(key, new Map(m));
    return key;
  }
  if (!opts.empty) gh.commitDirect("main", { "README.md": "# readme\n" }, "init");

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  gh.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    gh.calls.push({ method, url: url.href, authorization: headers.Authorization ?? null, body });
    if (url.origin !== "https://api.github.com") return new Response("wrong host", { status: 599 });
    if (headers.Authorization !== `Bearer ${gh.tokenOk}`) return json({ message: "Bad credentials" }, 401);
    const p = url.pathname;
    if (p === "/user" && method === "GET") return json({ login: "octo" });
    const base = `/repos/${gh.owner}/${gh.repo}`;
    if (!p.startsWith(base)) return json({ message: "Not Found" }, 404);
    const sub = p.slice(base.length);
    if (sub === "" && method === "GET") return json({ default_branch: gh.defaultBranch, private: gh.isPrivate, permissions: { push: gh.canPush } });
    let m: RegExpMatchArray | null;
    if ((m = sub.match(/^\/git\/ref\/heads\/(.+)$/)) && method === "GET") {
      if (gh.branches.size === 0) return json({ message: "Git Repository is empty." }, 409);
      const b = gh.branches.get(decodeURIComponent(m[1]!));
      return b ? json({ ref: `refs/heads/${m[1]}`, object: { sha: b, type: "commit" } }) : json({ message: "Not Found" }, 404);
    }
    if ((m = sub.match(/^\/git\/commits\/([0-9a-f]+)$/)) && method === "GET") {
      const c = gh.commits.get(m[1]!);
      return c ? json({ sha: m[1], tree: { sha: c.tree } }) : json({ message: "Not Found" }, 404);
    }
    if ((m = sub.match(/^\/git\/trees\/([0-9a-f]+)$/)) && method === "GET") {
      const t = gh.trees.get(m[1]!);
      if (!t) return json({ message: "Not Found" }, 404);
      const entries: Array<{ path: string; type: string; sha: string }> = [];
      const dirs = new Set<string>();
      for (const [path, sha] of t) {
        entries.push({ path, type: "blob", sha });
        const segs = path.split("/");
        for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
      }
      for (const d of dirs) entries.push({ path: d, type: "tree", sha: sha1(`dir:${d}`) });
      return json({ sha: m[1], tree: entries, truncated: false });
    }
    if (sub === "/git/trees" && method === "POST") {
      if (gh.branches.size === 0) return json({ message: "Git Repository is empty." }, 409);
      const baseTree = body.base_tree ? gh.trees.get(body.base_tree) : new Map<string, string>();
      if (!baseTree) return json({ message: "base_tree not found" }, 422);
      const next = new Map(baseTree);
      for (const e of body.tree) {
        if (typeof e.content !== "string") return json({ message: "content required" }, 422);
        const b = gitBlobSha(e.content);
        gh.blobs.set(b, e.content);
        next.set(e.path, b);
      }
      return json({ sha: putTree(next) }, 201);
    }
    if (sub === "/git/commits" && method === "POST") {
      const c = sha1(`commit${++counter}`);
      gh.commits.set(c, { tree: body.tree, parents: body.parents, message: body.message });
      return json({ sha: c }, 201);
    }
    if ((m = sub.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "PATCH") {
      if (!gh.canPush) return json({ message: "forbidden" }, 403);
      const branch = decodeURIComponent(m[1]!);
      if (gh.raceNextRefUpdate) {
        gh.raceNextRefUpdate = false;
        gh.commitDirect(branch, { "OTHER.md": `someone else ${counter}\n` }, "racing push");
        return json({ message: "Update is not a fast forward" }, 422);
      }
      const cur = gh.branches.get(branch);
      const c = gh.commits.get(body.sha);
      if (!c || (cur && !c.parents.includes(cur))) return json({ message: "Update is not a fast forward" }, 422);
      gh.branches.set(branch, body.sha);
      return json({ ref: `refs/heads/${branch}`, object: { sha: body.sha } });
    }
    if (sub === "/git/refs" && method === "POST") {
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      if (gh.branches.has(branch)) return json({ message: "Reference already exists" }, 422);
      gh.branches.set(branch, body.sha);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if ((m = sub.match(/^\/contents\/(.+)$/)) && method === "PUT") {
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      gh.commitDirect(body.branch, { [path]: Buffer.from(body.content, "base64").toString("utf8") }, body.message);
      return json({ content: { path } }, 201);
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return gh;
}
