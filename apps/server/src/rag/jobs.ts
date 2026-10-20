/** Durable, paced rebuilds. Persist IDs/progress, never a vault's document bodies. */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { IndexResult } from "./service";

export type IndexJobState = "queued" | "running" | "pausing" | "paused" | "completed" | "failed";
export interface IndexJob {
  id: string; vaultId: string; model: string; chunker: string; state: IndexJobState;
  total: number; processed: number; indexed: number; skipped: number; deleted: number; failed: number;
  startedAt: number; updatedAt: number; error: string | null;
}
interface Row { id: string; vault_id: string; model: string; chunker: string; state: IndexJobState; initialized: number; started_at: number; updated_at: number; error: string | null }
export interface IndexJobDeps {
  generation(): { model: string; chunker: string };
  available(vaultId: string): boolean;
  list(vaultId: string): Promise<Array<{ id: string }>>;
  index(vaultId: string, noteId: string): Promise<IndexResult["status"] | "deleted">;
}
export class IndexJobConflict extends Error {}
const ACTIVE = "('queued','running','pausing')";
const LIST_LIMIT = 50_000;

export class IndexJobs {
  private draining = false;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  constructor(private db: Database.Database, private deps: IndexJobDeps, private autoRun = true) {
    db.exec(`CREATE TABLE IF NOT EXISTS search_index_jobs (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, model TEXT NOT NULL, chunker TEXT NOT NULL,
      state TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS search_index_job_items (
      job_id TEXT NOT NULL REFERENCES search_index_jobs(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(job_id,note_id)
    );
    CREATE INDEX IF NOT EXISTS search_index_job_pending ON search_index_job_items(job_id,state);
    CREATE UNIQUE INDEX IF NOT EXISTS search_index_one_active ON search_index_jobs((1)) WHERE state IN ${ACTIVE};`);
    // A restart never silently launches an expensive rebuild. Resume explicitly
    // from the last committed item; an interrupted single write hash-skips.
    db.prepare(`UPDATE search_index_jobs SET state='paused', error='Server restarted. Resume to continue.', updated_at=? WHERE state IN ${ACTIVE}`).run(Date.now());
  }
  private row(id: string, vaultId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM search_index_jobs WHERE id=? AND vault_id=?").get(id, vaultId) as Row | undefined;
  }
  private publicJob(row: Row): IndexJob {
    const counts = this.db.prepare("SELECT state, COUNT(*) n FROM search_index_job_items WHERE job_id=? GROUP BY state").all(row.id) as { state: string; n: number }[];
    const n = Object.fromEntries(counts.map(c => [c.state, c.n]));
    const total = counts.reduce((sum, c) => sum + c.n, 0);
    return { id: row.id, vaultId: row.vault_id, model: row.model, chunker: row.chunker, state: row.state,
      total, processed: total - (n.pending ?? 0), indexed: n.indexed ?? 0, skipped: (n.skipped ?? 0) + (n.empty ?? 0),
      deleted: n.deleted ?? 0, failed: n.failed ?? 0, startedAt: row.started_at, updatedAt: row.updated_at, error: row.error };
  }
  current(vaultId: string): IndexJob | null {
    const row = this.db.prepare("SELECT * FROM search_index_jobs WHERE vault_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(vaultId) as Row | undefined;
    return row ? this.publicJob(row) : null;
  }
  start(vaultId: string): IndexJob {
    const active = this.db.prepare(`SELECT * FROM search_index_jobs WHERE state IN ${ACTIVE}`).get() as Row | undefined;
    if (active?.vault_id === vaultId) return this.publicJob(active); // safe retry while active
    if (active) throw new IndexJobConflict("Another search update is running. Try again when it finishes.");
    if (!this.deps.available(vaultId)) throw new IndexJobConflict("This vault is no longer available.");
    const generation = this.deps.generation();
    const id = randomUUID(), now = Date.now();
    this.db.prepare("INSERT INTO search_index_jobs(id,vault_id,model,chunker,state,started_at,updated_at) VALUES(?,?,?,?,'queued',?,?)")
      .run(id, vaultId, generation.model, generation.chunker, now, now);
    // Keep one current job per vault. Completed progress needs no unbounded item history.
    this.db.prepare("DELETE FROM search_index_job_items WHERE job_id IN (SELECT id FROM search_index_jobs WHERE vault_id=? AND id!=?)").run(vaultId,id);
    this.db.prepare("DELETE FROM search_index_jobs WHERE vault_id=? AND id!=?").run(vaultId,id);
    this.schedule();
    return this.publicJob(this.row(id, vaultId)!);
  }
  pause(vaultId: string, id: string): IndexJob | null {
    const row = this.row(id, vaultId);
    if (!row) return null;
    if (row.state === "running" || row.state === "queued") {
      this.db.prepare("UPDATE search_index_jobs SET state=?, updated_at=? WHERE id=?").run(this.draining ? "pausing" : "paused", Date.now(), id);
    }
    return this.publicJob(this.row(id, vaultId)!);
  }
  resume(vaultId: string, id: string): IndexJob | null {
    const row = this.row(id, vaultId);
    if (!row) return null;
    if (row.state === "running" || row.state === "queued") return this.publicJob(row);
    if (row.state === "pausing") throw new IndexJobConflict("Waiting for the current note to finish.");
    const gen = this.deps.generation();
    if (gen.model !== row.model || gen.chunker !== row.chunker) throw new IndexJobConflict("Search settings changed. Start a new update.");
    if (!this.deps.available(vaultId)) throw new IndexJobConflict("This vault is no longer available.");
    if (this.db.prepare(`SELECT 1 FROM search_index_jobs WHERE state IN ${ACTIVE}`).get()) throw new IndexJobConflict("Another search update is running.");
    this.db.transaction(() => {
      this.db.prepare("UPDATE search_index_job_items SET state='pending' WHERE job_id=? AND state='failed'").run(id);
      this.db.prepare("UPDATE search_index_jobs SET state='queued', error=NULL, updated_at=? WHERE id=?").run(Date.now(), id);
    })();
    this.schedule();
    return this.publicJob(this.row(id,vaultId)!);
  }
  private schedule() {
    if (!this.autoRun || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; void this.runSlice(); }, 50);
    this.scheduled.unref();
  }
  /** At most ten bodies per slice, one in memory at a time. Exported for deterministic tests. */
  async runSlice(maxItems = 10): Promise<void> {
    if (this.draining) return;
    const row = this.db.prepare(`SELECT * FROM search_index_jobs WHERE state IN ${ACTIVE}`).get() as Row | undefined;
    if (!row) return;
    this.draining = true;
    const setState = (state: IndexJobState, error: string | null = null) =>
      this.db.prepare("UPDATE search_index_jobs SET state=?, error=?, updated_at=? WHERE id=?").run(state, error, Date.now(), row.id);
    try {
      if (row.state === "pausing") { setState("paused"); return; }
      const gen = this.deps.generation();
      if (!this.deps.available(row.vault_id) || gen.model !== row.model || gen.chunker !== row.chunker) {
        setState("failed", "Vault or search settings changed. Start a new update."); return;
      }
      setState("running");
      if (!row.initialized) {
        const notes = await this.deps.list(row.vault_id);
        // A capped list cannot be claimed as a complete rebuild.
        if (notes.length >= LIST_LIMIT) { setState("failed", "This vault exceeds the current update limit. Existing search remains available."); return; }
        this.db.transaction(() => {
          const put = this.db.prepare("INSERT OR IGNORE INTO search_index_job_items(job_id,note_id) VALUES(?,?)");
          for (const note of notes) put.run(row.id, note.id);
          this.db.prepare("UPDATE search_index_jobs SET initialized=1 WHERE id=?").run(row.id);
        })();
      }
      const items = this.db.prepare("SELECT note_id FROM search_index_job_items WHERE job_id=? AND state='pending' ORDER BY note_id LIMIT ?")
        .all(row.id, Math.max(1, Math.min(10, maxItems))) as { note_id: string }[];
      for (const item of items) {
        if (this.row(row.id,row.vault_id)?.state === "pausing") { setState("paused"); return; }
        if (!this.deps.available(row.vault_id)) { setState("failed", "This vault is no longer available."); return; }
        let outcome: string;
        try { outcome = await this.deps.index(row.vault_id, item.note_id); }
        catch { outcome = "failed"; } // no note bodies, endpoint URLs or credentials in job output
        this.db.transaction(() => {
          this.db.prepare("UPDATE search_index_job_items SET state=? WHERE job_id=? AND note_id=?").run(outcome,row.id,item.note_id);
          this.db.prepare("UPDATE search_index_jobs SET updated_at=? WHERE id=?").run(Date.now(),row.id);
        })();
      }
      if (this.row(row.id,row.vault_id)?.state === "pausing") setState("paused");
      else if (!this.db.prepare("SELECT 1 FROM search_index_job_items WHERE job_id=? AND state='pending' LIMIT 1").get(row.id)) {
        const failed = this.db.prepare("SELECT 1 FROM search_index_job_items WHERE job_id=? AND state='failed' LIMIT 1").get(row.id);
        setState(failed ? "failed" : "completed", failed ? "Some notes could not be updated. Retry to continue from those notes." : null);
      }
    } catch { setState("failed", "Search update could not reach this vault. Retry to continue."); }
    finally {
      this.draining = false;
      if (this.db.prepare(`SELECT 1 FROM search_index_jobs WHERE state IN ${ACTIVE}`).get()) this.schedule();
    }
  }
}
