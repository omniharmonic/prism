/**
 * Google Docs ↔ vault sync (Phase 3), server-side. The desktop's google_docs
 * adapter authenticates via the `gog` CLI (Google OAuth in gog's keyring). Since
 * the Prism server is COLOCATED with `gog` on the Mac mini (verified: `gog`
 * works from a non-GUI process), the server drives Google by shelling to `gog`
 * the same way — reusing the existing auth, no OAuth rework. (For a NON-Mac
 * server, this needs a server-side Google OAuth flow instead; the credential
 * here is just the account email + gog on PATH.)
 *
 * Mirrors clients/google.rs docs_create/write/read/info + sync_cmds sync_google_docs:
 * write streams content via stdin (`--file - --replace`) because gog's Kong
 * parser treats leading `---` (frontmatter) as a flag.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileP = promisify(execFile);
const MAXBUF = 64 * 1024 * 1024;

/** Resolve the gog binary (matches the desktop's which/homebrew fallback). */
export function resolveGog(): string {
  for (const p of ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"]) if (existsSync(p)) return p;
  return "gog"; // rely on PATH
}

export class GoogleDocsClient {
  constructor(
    private account: string,
    private gogBin: string = resolveGog(),
  ) {}

  private async gogJson(args: string[]): Promise<any> {
    const { stdout } = await execFileP(this.gogBin, [...args, "--account", this.account, "--json"], { maxBuffer: MAXBUF });
    return JSON.parse(stdout || "{}");
  }
  private async gogText(args: string[]): Promise<string> {
    const { stdout } = await execFileP(this.gogBin, [...args, "--account", this.account], { maxBuffer: MAXBUF });
    return stdout;
  }

  /** Create a new Google Doc, returns its documentId. */
  async createDoc(title: string): Promise<string> {
    const d = await this.gogJson(["docs", "create", title]);
    const id = d.file?.id ?? d.documentId ?? d.id;
    if (!id) throw new Error(`gog docs create: no doc id in ${JSON.stringify(d).slice(0, 200)}`);
    return String(id);
  }

  /** Replace a doc's content. Streams via stdin (frontmatter-safe). */
  async writeDoc(docId: string, content: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.gogBin, ["docs", "write", docId, "--file", "-", "--replace", "--account", this.account], { stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`gog docs write exited ${code}: ${err.trim()}`))));
      child.stdin.write(content);
      child.stdin.end();
    });
  }

  /** Read a doc as plain text. */
  async readDoc(docId: string): Promise<string> {
    return this.gogText(["docs", "cat", docId]);
  }

  /** The doc's current revisionId — the reliable remote change token (`gog docs
   *  info` returns document.revisionId; there is no modifiedTime there). Compare
   *  against the last-synced revision to detect a remote change. */
  async remoteRevision(docId: string): Promise<string | null> {
    const d = await this.gogJson(["docs", "info", docId]);
    return d.document?.revisionId ?? d.revisionId ?? null;
  }

  /** Best-effort trash (cleanup / unsync). */
  async trashDoc(docId: string): Promise<void> {
    try {
      await this.gogJson(["drive", "trash", docId]);
    } catch {
      /* best effort */
    }
  }
}

export interface GoogleDocsPushResult {
  docId: string;
  created: boolean;
}

/** Push a note to Google Docs: create the doc on first sync (title = note path
 *  leaf), then replace its content. Returns the doc id (persist as remote_id). */
export async function pushNoteToGoogleDoc(client: Pick<GoogleDocsClient, "createDoc" | "writeDoc">, note: { path?: string | null; content: string }, remoteId?: string): Promise<GoogleDocsPushResult> {
  if (!remoteId) {
    const title = (note.path?.split("/").pop() || "Untitled").replace(/\.[^.]+$/, "");
    const docId = await client.createDoc(title);
    await client.writeDoc(docId, note.content);
    return { docId, created: true };
  }
  await client.writeDoc(remoteId, note.content);
  return { docId: remoteId, created: false };
}

/** Pull a Google Doc's text (caller writes it into the note). */
export async function pullGoogleDoc(client: GoogleDocsClient, docId: string): Promise<string> {
  return client.readDoc(docId);
}
