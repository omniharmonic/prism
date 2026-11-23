/**
 * `prism backup`: a consistent snapshot of the server database and, when Prism owns
 * Parachute, of the hub and vault databases — the same rules as scripts/backup-parachute.sh:
 *  - SQLite files through the ONLINE backup API (consistent mid-write), never `cp` of a
 *    WAL database; each copy made a single self-contained file and integrity-checked;
 *  - the folder is 0700 (it holds the `.env` and tokens);
 *  - retention runs only after a verified backup: keep the newest N, plus any whose label
 *    contains "keep" or "baseline".
 * prism-server.db and Parachute are snapshotted together because the server DB carries
 * governance trust (the signature ledger) that must match the vault.
 */
import { chmodSync, copyFileSync, createReadStream, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative } from "node:path";
import { ensureDir, writeFileAtomic } from "./fsutil";
import type { Layout } from "./paths";
import { DIR_MODE, SECRET_FILE_MODE } from "./paths";

/** The part of better-sqlite3 the backup uses (injected: the CLI loads it from the bundle). */
export interface SqliteDb {
  backup(dest: string): Promise<unknown>;
  pragma(sql: string, opts?: { simple?: boolean }): unknown;
  close(): void;
}
export type OpenSqlite = (path: string, opts: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDb;

export interface DbEntry {
  source: string;
  file: string;
  bytes: number;
  sha256: string;
  integrity: string;
}

export interface BackupResult {
  ok: boolean;
  dir: string;
  databases: DbEntry[];
  files: string[];
  pruned: string[];
  problems: string[];
}

export function backupLabel(raw: string | undefined): string {
  const l = (raw ?? "manual").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return l || "manual";
}

export function backupStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const NAME = /^\d{8}T\d{6}Z-[a-z0-9-]+$/;

/** Which backup folders retention removes: everything past the newest `keep`, except pinned ones and `current`. */
export function selectPrune(names: string[], keep: number, current: string): string[] {
  if (keep <= 0) return [];
  const sorted = names.filter((n) => NAME.test(n)).sort().reverse();
  let n = 0;
  const out: string[] = [];
  for (const d of sorted) {
    if (/baseline|keep/.test(d)) continue;
    n += 1;
    if (n > keep && d !== current) out.push(d);
  }
  return out;
}

async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function snapshotSqlite(open: OpenSqlite, src: string, dst: string): Promise<{ integrity: string }> {
  const db = open(src, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dst);
  } finally {
    db.close();
  }
  const copy = open(dst, {});
  try {
    // A copy of a WAL database is not self-contained without its -wal/-shm: make it one file.
    copy.pragma("journal_mode = DELETE");
    const ic = String(copy.pragma("integrity_check", { simple: true }));
    return { integrity: ic };
  } finally {
    copy.close();
  }
}

/** The databases to snapshot: the server DB, and Parachute's when `parachuteHome` is Prism's. */
export function databasesToBackUp(layout: Layout, parachuteHome: string | null): Array<{ src: string; rel: string }> {
  const out: Array<{ src: string; rel: string }> = [];
  if (existsSync(layout.db)) out.push({ src: layout.db, rel: "prism/prism-server.db" });
  if (parachuteHome && existsSync(parachuteHome)) {
    const hub = join(parachuteHome, "hub.db");
    if (existsSync(hub)) out.push({ src: hub, rel: "parachute/hub.db" });
    const vaults = join(parachuteHome, "vault", "data");
    if (existsSync(vaults)) {
      for (const name of readdirSync(vaults).sort()) {
        const v = join(vaults, name, "vault.db");
        if (existsSync(v)) out.push({ src: v, rel: `parachute/vault/data/${name}/vault.db` });
      }
    }
  }
  return out;
}

export async function runBackup(opts: {
  layout: Layout;
  open: OpenSqlite;
  label?: string;
  keep?: number;
  parachuteHome: string | null;
  now?: Date;
  versions: Record<string, string | null>;
}): Promise<BackupResult> {
  const { layout, open } = opts;
  const name = `${backupStamp(opts.now ?? new Date())}-${backupLabel(opts.label)}`;
  const dir = join(layout.backups, name);
  ensureDir(layout.backups, DIR_MODE);
  ensureDir(dir, DIR_MODE);
  const problems: string[] = [];
  const databases: DbEntry[] = [];
  for (const { src, rel } of databasesToBackUp(layout, opts.parachuteHome)) {
    const dst = join(dir, rel);
    ensureDir(join(dst, ".."), DIR_MODE);
    try {
      const { integrity } = await snapshotSqlite(open, src, dst);
      // SQLite creates the copy under the process umask (0644): the databases hold every note and credential.
      chmodSync(dst, 0o600);
      if (integrity !== "ok") problems.push(`${rel}: integrity_check said ${integrity}`);
      databases.push({ source: src, file: rel, bytes: statSync(dst).size, sha256: await sha256(dst), integrity });
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`);
    }
  }
  // Small config files, plain copies (0600: the .env holds every secret).
  const files: string[] = [];
  const copies: Array<[string, string]> = [
    [layout.envFile, "config/.env"],
    [layout.state, "state.json"],
    [layout.dataVersionFile, "data/DATA_VERSION"],
  ];
  if (opts.parachuteHome) {
    const vaults = join(opts.parachuteHome, "vault", "data");
    if (existsSync(vaults)) for (const n of readdirSync(vaults)) copies.push([join(vaults, n, "vault.yaml"), `parachute/vault/data/${n}/vault.yaml`]);
  }
  for (const [src, rel] of copies) {
    if (!existsSync(src)) continue;
    const dst = join(dir, rel);
    ensureDir(join(dst, ".."), DIR_MODE);
    copyFileSync(src, dst);
    files.push(rel);
  }
  const ok = problems.length === 0;
  const manifest = { name, createdAt: (opts.now ?? new Date()).toISOString(), ok, versions: opts.versions, databases: databases.map((d) => ({ ...d, source: relative(layout.prefix, d.source) || basename(d.source) })), files, problems };
  writeFileAtomic(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", SECRET_FILE_MODE);
  const pruned: string[] = [];
  if (ok) {
    for (const old of selectPrune(readdirSync(layout.backups), opts.keep ?? 5, name)) {
      rmSync(join(layout.backups, old), { recursive: true, force: true });
      pruned.push(old);
    }
  }
  return { ok, dir, databases, files, pruned, problems };
}
