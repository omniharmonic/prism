/**
 * On-disk LRU for proxied media and map assets (Client parity C).
 *
 * Key = SHA-256(namespace + "\0" + url): the directory never contains a URL in
 * a file name. Each entry is `<key>.bin` (bytes) + `<key>.json` (type, expiry,
 * size). An in-memory index (insertion order = recency) is rebuilt lazily from
 * the directory on first use, and the total size is held under `maxBytes` by
 * evicting least-recently-used entries. Expired entries are misses (and are
 * deleted). Files are written to a temp name and renamed, so a crash never
 * leaves a half-written entry that a later read would serve. Entries are 0600,
 * the directory 0700 — fetched images can be private-looking content.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CacheMeta {
  contentType: string;
  /** Epoch ms after which the entry is stale. */
  expiresAt: number;
  size: number;
}

interface IndexEntry {
  size: number;
  expiresAt: number;
}

export class DiskCache {
  private index = new Map<string, IndexEntry>();
  private total = 0;
  private loaded = false;

  constructor(
    readonly dir: string,
    readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  static key(namespace: string, url: string): string {
    return createHash("sha256").update(`${namespace}\0${url}`).digest("hex");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const found: Array<[string, IndexEntry, number]> = [];
    for (const f of readdirSync(this.dir)) {
      const m = /^([0-9a-f]{64})\.json$/.exec(f);
      if (!m) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as CacheMeta & { storedAt?: number };
        if (typeof meta.size === "number" && typeof meta.expiresAt === "number") {
          found.push([m[1]!, { size: meta.size, expiresAt: meta.expiresAt }, meta.storedAt ?? 0]);
        }
      } catch {
        /* unreadable meta: ignored (its .bin is orphaned until evicted by a rewrite) */
      }
    }
    found.sort((a, b) => a[2] - b[2]); // oldest first = least recent
    for (const [k, e] of found) {
      this.index.set(k, e);
      this.total += e.size;
    }
    void this.evict();
  }

  async get(key: string): Promise<{ meta: CacheMeta; body: Buffer } | null> {
    this.load();
    const e = this.index.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      await this.remove(key);
      return null;
    }
    try {
      const [metaRaw, body] = await Promise.all([readFile(join(this.dir, `${key}.json`), "utf8"), readFile(join(this.dir, `${key}.bin`))]);
      const meta = JSON.parse(metaRaw) as CacheMeta;
      if (body.length !== meta.size) {
        await this.remove(key);
        return null;
      }
      // Touch: move to the most-recent end.
      this.index.delete(key);
      this.index.set(key, e);
      return { meta, body };
    } catch {
      await this.remove(key);
      return null;
    }
  }

  async put(key: string, contentType: string, body: Buffer, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0 || body.length > this.maxBytes) return;
    this.load();
    const meta: CacheMeta & { storedAt: number } = { contentType, expiresAt: this.now() + ttlSeconds * 1000, size: body.length, storedAt: this.now() };
    const tmp = `.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(join(this.dir, `${key}.bin${tmp}`), body, { mode: 0o600 });
      await writeFile(join(this.dir, `${key}.json${tmp}`), JSON.stringify(meta), { mode: 0o600 });
      await rename(join(this.dir, `${key}.bin${tmp}`), join(this.dir, `${key}.bin`));
      await rename(join(this.dir, `${key}.json${tmp}`), join(this.dir, `${key}.json`));
    } catch {
      await unlink(join(this.dir, `${key}.bin${tmp}`)).catch(() => {});
      await unlink(join(this.dir, `${key}.json${tmp}`)).catch(() => {});
      return;
    }
    const prev = this.index.get(key);
    if (prev) {
      this.total -= prev.size;
      this.index.delete(key);
    }
    this.index.set(key, { size: body.length, expiresAt: meta.expiresAt });
    this.total += body.length;
    await this.evict();
  }

  private async remove(key: string): Promise<void> {
    const e = this.index.get(key);
    if (e) {
      this.total -= e.size;
      this.index.delete(key);
    }
    await unlink(join(this.dir, `${key}.json`)).catch(() => {});
    await unlink(join(this.dir, `${key}.bin`)).catch(() => {});
  }

  private async evict(): Promise<void> {
    for (const k of this.index.keys()) {
      if (this.total <= this.maxBytes) break;
      await this.remove(k);
    }
  }

  /** Test/diagnostic view. */
  stats(): { entries: number; bytes: number } {
    this.load();
    return { entries: this.index.size, bytes: this.total };
  }
}
