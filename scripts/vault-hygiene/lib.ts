/**
 * Shared plumbing for the vault-hygiene scripts (schema fixes + data migrations).
 *
 * Every script here follows the same contract (qa/vault-migrations.md):
 *   - READ-ONLY by default. A dry run prints counts and a few note ids/paths —
 *     never a note body, never a token.
 *   - `--apply` writes, and only together with `--backup-confirmed` (the operator
 *     took `scripts/backup-parachute.sh` first).
 *   - Note writes are compare-and-set (`if_updated_at` from a FRESH read), never
 *     `force`; a 409 is reported and skipped (re-run to pick it up).
 *   - Writes are paced (`--rate`, writes per second) and every write appends the
 *     values it replaced to a JSONL undo log (0600) that `undo.ts` replays.
 *   - A vault URL on :1940 (the production vault) or the public production host
 *     is refused unless `--production` is passed explicitly.
 *
 * Everything that touches the network goes through `Ctx.fetch`, so the tests run
 * the scripts against an in-memory fake vault.
 */
import { appendFileSync, readFileSync } from "node:fs";

export interface Ctx {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Append one line to the undo log (tests capture it in memory). */
  appendUndo: (path: string, line: string) => void;
  /** Clock for log names (tests pin it). */
  now: () => Date;
}

export function defaultCtx(): Ctx {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    log: (l) => console.log(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    appendUndo: (path, line) => appendFileSync(path, line + "\n", { mode: 0o600 }),
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------- arguments

export interface Args {
  flags: Set<string>;
  values: Map<string, string[]>;
  get(name: string): string | undefined;
  all(name: string): string[];
  has(name: string): boolean;
}

/** `--flag`, `--key value`, `--key=value`; repeated keys accumulate. */
export function parseArgs(argv: string[], valued: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument: ${a}`);
    const eq = a.indexOf("=");
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (valued.includes(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      values.set(name, [...(values.get(name) ?? []), v]);
    } else {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.add(name);
    }
  }
  return {
    flags,
    values,
    get: (n) => values.get(n)?.at(-1),
    all: (n) => values.get(n) ?? [],
    has: (n) => flags.has(n),
  };
}

export class UsageError extends Error {}

/** Hosts that ARE production, whatever port they answer on. */
export const PRODUCTION_HOSTS = ["agent.omniharmonic.com"];
/** The production vault's port. */
export const PRODUCTION_PORT = "1940";

/**
 * Parse and vet a vault (or Prism) URL. A URL that looks like production is
 * refused unless the operator said `--production` — in dry runs too, so nobody
 * reads production by accident.
 */
export function guardTarget(raw: string | undefined, production: boolean, what = "--vault-url"): URL {
  if (!raw) throw new UsageError(`${what} is required (there is no default target)`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`${what} is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`${what} must be http(s)`);
  if (u.username || u.password) throw new UsageError(`${what} must not carry credentials`);
  const looksProduction = u.port === PRODUCTION_PORT || PRODUCTION_HOSTS.includes(u.hostname.toLowerCase());
  if (looksProduction && !production) {
    throw new UsageError(`${u.host} looks like the PRODUCTION vault; pass --production explicitly to target it`);
  }
  return u;
}

/** `--apply` needs `--backup-confirmed`; returns true when this run writes. */
export function writeMode(args: Args): boolean {
  if (!args.has("apply")) return false;
  if (!args.has("backup-confirmed")) {
    throw new UsageError("--apply needs --backup-confirmed (run scripts/backup-parachute.sh first and keep the archive)");
  }
  return true;
}

export function rateOf(args: Args): number {
  const raw = args.get("rate");
  if (raw === undefined) return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 20) throw new UsageError("--rate must be a number of writes per second, 0 < rate <= 20");
  return n;
}

/** Remove anything that looks like a bearer credential from a message. */
export function scrub(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt redacted]")
    .replace(/\b(p[dpv]t?_[A-Za-z0-9]{8,})/g, "[token redacted]");
}

// ---------------------------------------------------------------- vault API

export interface VaultNote {
  id: string;
  path?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  content?: string;
  updatedAt?: string;
  createdAt?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Minimal vault REST client (`<url>/vault/<name>/api`). */
export class VaultApi {
  private readonly base: string;
  constructor(
    private readonly ctx: Ctx,
    url: URL,
    vault: string,
    private readonly token: string,
  ) {
    if (!/^[A-Za-z0-9_-]+$/.test(vault)) throw new UsageError("--vault must be a plain vault name");
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, "")}/vault/${vault}/api`;
  }

  private async req(path: string, init: RequestInit = {}, token = this.token): Promise<Response> {
    const res = await this.ctx.fetch(`${this.base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, scrub(`${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`));
    }
    return res;
  }

  async listNotes(opts: { tag?: string; pathPrefix?: string; includeContent?: boolean; includeMetadata?: string[] } = {}): Promise<VaultNote[]> {
    const sp = new URLSearchParams({ limit: "50000", sort: "desc" });
    if (opts.tag) sp.append("tag", opts.tag);
    if (opts.pathPrefix) sp.set("path_prefix", opts.pathPrefix);
    sp.set("include_content", opts.includeContent ? "true" : "false");
    if (opts.includeMetadata?.length) sp.set("include_metadata", opts.includeMetadata.join(","));
    return (await this.req(`/notes?${sp}`)).json() as Promise<VaultNote[]>;
  }

  /** Full read (body + metadata) — the fresh copy every write is built on. */
  async getNote(id: string): Promise<VaultNote | null> {
    try {
      return (await (await this.req(`/notes/${encodeURIComponent(id)}`)).json()) as VaultNote;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  /** Compare-and-set PATCH. NEVER sends `force`. */
  async patch(id: string, body: { content?: string; metadata?: Record<string, unknown> }, ifUpdatedAt: string): Promise<VaultNote> {
    if (!ifUpdatedAt) throw new Error("refusing a write without if_updated_at");
    const payload: Record<string, unknown> = { if_updated_at: ifUpdatedAt };
    if (body.content !== undefined) payload.content = body.content;
    if (body.metadata !== undefined) payload.metadata = body.metadata;
    return (await (await this.req(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) })).json()) as VaultNote;
  }

  async getTags(): Promise<VaultTag[]> {
    return (await this.req(`/tags?include_schema=true`)).json() as Promise<VaultTag[]>;
  }

  async putTag(name: string, body: { description: string; fields: Record<string, FieldDef> }, adminToken: string): Promise<void> {
    await this.req(`/tags/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(body) }, adminToken);
  }
}

export interface FieldDef {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  indexed?: boolean;
  [k: string]: unknown;
}

export interface VaultTag {
  name: string;
  count?: number;
  description?: string | null;
  fields?: Record<string, FieldDef> | null;
}

// ---------------------------------------------------------------- writes

/** Paces writes to `perSecond`. */
export class Throttle {
  private last = 0;
  constructor(
    private readonly ctx: Ctx,
    private readonly perSecond: number,
  ) {}
  async wait(): Promise<void> {
    const gap = 1000 / this.perSecond;
    const now = Date.now();
    const due = this.last + gap;
    if (this.last && due > now) await this.ctx.sleep(due - now);
    this.last = Date.now();
  }
}

/** One undo record per write. `before` holds exactly the values the write replaced. */
export type UndoRecord =
  | {
      kind: "vault-patch";
      script: string;
      at: string;
      id: string;
      path: string | null;
      /** The note's revision AFTER our write; undo only applies on top of it. */
      afterUpdatedAt: string;
      before: { content?: string; metadata?: Record<string, unknown> };
    }
  | { kind: "prism-trash"; script: string; at: string; id: string; path: string | null; canonicalId: string };

export class UndoLog {
  constructor(
    private readonly ctx: Ctx,
    readonly path: string,
  ) {}
  append(rec: UndoRecord): void {
    this.ctx.appendUndo(this.path, JSON.stringify(rec));
  }
}

export function undoLogPath(args: Args, ctx: Ctx, script: string): string {
  return args.get("undo-log") ?? `vault-hygiene-undo-${script}-${ctx.now().toISOString().replace(/[:.]/g, "-")}.jsonl`;
}

export function readUndoLog(path: string): UndoRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as UndoRecord);
}

/** Read-token resolution shared by the migrations. */
export function readToken(ctx: Ctx): string {
  const t = ctx.env.PARACHUTE_TOKEN?.trim();
  if (!t) throw new UsageError("PARACHUTE_TOKEN is not set (a vault:<name>:write token; reads only in a dry run)");
  return t;
}

export function sample<T>(xs: T[], n = 10): T[] {
  return xs.slice(0, n);
}

export const ref = (n: { id: string; path?: string | null }): string => `${n.id} ${n.path ?? "(no path)"}`;

/** Tags whose notes are owned by an ingester: never rewritten by these scripts. */
export const INGEST_OWNED_TAGS = ["email", "message-thread", "message-archive"];
export const TRASH_TAG = "prism-trashed";

export function isLive(n: VaultNote): boolean {
  return !(n.tags ?? []).includes(TRASH_TAG) && typeof n.metadata?.prism_trashed_at !== "string";
}

/** Run a CLI `main`, turning usage errors into a non-zero exit with a one-line reason. */
export async function runCli(main: (argv: string[], ctx: Ctx) => Promise<number>): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2), defaultCtx());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${scrub(msg)}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
