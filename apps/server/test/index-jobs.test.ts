import Database from "better-sqlite3";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { IndexJobs, IndexJobConflict, type IndexJobDeps } from "../src/rag/jobs";

let db: Database.Database;
let jobs: IndexJobs;
let deps: IndexJobDeps;
let calls: string[];
beforeEach(() => {
  db = new Database(":memory:");
  calls = [];
  deps = {
    generation: () => ({ model: "test-v1", chunker: "paragraph-v1" }),
    available: () => true,
    list: async () => Array.from({ length: 23 }, (_, i) => ({ id: `note-${String(i).padStart(2, "0")}` })),
    index: async (vault, id) => { calls.push(`${vault}:${id}`); return "indexed"; },
  };
  jobs = new IndexJobs(db, deps, false);
});
afterEach(() => db.close());

test("rebuild checkpoints ten sequential notes and resumes after a process restart", async () => {
  const job = jobs.start("vault-a");
  assert.equal(jobs.start("vault-a").id,job.id,"repeated start joins active work");
  await jobs.runSlice(1000);
  assert.equal(calls.length,10,"a requested oversized slice is bounded");
  assert.equal(jobs.current("vault-a")?.processed,10);
  jobs = new IndexJobs(db,deps,false); // fresh process against the same durable state
  assert.equal(jobs.current("vault-a")?.state,"paused");
  jobs.resume("vault-a",job.id);
  await jobs.runSlice();
  await jobs.runSlice();
  assert.equal(jobs.current("vault-a")?.state,"completed");
  assert.equal(new Set(calls).size,23);
  assert.equal(calls.length,23,"committed successful items are not reprocessed");
});

test("only failed notes are retried and raw errors never enter status", async () => {
  let failing = true;
  deps.list = async () => [{ id: "ok" }, { id: "retry" }, { id: "removed" }];
  deps.index = async (vault,id) => {
    calls.push(`${vault}:${id}`);
    if (id === "retry" && failing) throw new Error("private document text and endpoint key");
    return id === "removed" ? "deleted" : "indexed";
  };
  const job = jobs.start("a");
  await jobs.runSlice();
  assert.equal(jobs.current("a")?.failed,1);
  assert.equal(jobs.current("a")?.deleted,1);
  assert.equal(jobs.current("a")?.state,"failed");
  assert.ok(!JSON.stringify(jobs.current("a")).includes("private"));
  failing = false;
  jobs.resume("a",job.id);
  await jobs.runSlice();
  assert.equal(jobs.current("a")?.state,"completed");
  assert.deepEqual(calls,["a:ok","a:removed","a:retry","a:retry"]);
});

test("pause drains an admitted note and admits no following note", async () => {
  let release!: () => void;
  let entered!: () => void;
  const admitted = new Promise<void>(r => { entered = r; });
  deps.index = async (vault,id) => { calls.push(`${vault}:${id}`); entered(); await new Promise<void>(r => { release=r; }); return "indexed"; };
  const job = jobs.start("a");
  const slice = jobs.runSlice();
  await admitted;
  assert.equal(jobs.pause("a",job.id)?.state,"pausing");
  assert.throws(() => jobs.resume("a",job.id),IndexJobConflict);
  release();
  await slice;
  assert.equal(calls.length,1);
  assert.equal(jobs.current("a")?.state,"paused");
  assert.equal(jobs.current("a")?.processed,1);
});

test("jobs do not expose or mutate another vault and only one rebuild runs", async () => {
  const job = jobs.start("a");
  assert.equal(jobs.current("b"),null);
  assert.equal(jobs.pause("b",job.id),null);
  assert.equal(jobs.resume("b",job.id),null);
  assert.throws(() => jobs.start("b"),IndexJobConflict);
  await jobs.runSlice(1);
  assert.deepEqual(calls,["a:note-00"]);
});

test("model/chunker transitions cannot silently resume the old generation", async () => {
  const job = jobs.start("a");
  await jobs.runSlice(1);
  jobs.pause("a",job.id);
  deps.generation = () => ({model:"test-v2",chunker:"paragraph-v2"});
  assert.throws(() => jobs.resume("a",job.id),IndexJobConflict);
  const next = jobs.start("a");
  assert.notEqual(next.id,job.id);
  assert.equal(next.model,"test-v2");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM search_index_job_items WHERE job_id=?").get(job.id) as {n:number}).n,0);
});

test("a removed vault fails closed before another body is read", async () => {
  jobs.start("a");
  await jobs.runSlice(1);
  deps.available = () => false;
  await jobs.runSlice();
  assert.equal(calls.length,1);
  assert.equal(jobs.current("a")?.state,"failed");
});

test("truncated inventories cannot report a complete rebuild", async () => {
  deps.list = async () => Array.from({length:50_000},(_,i)=>({id:String(i)}));
  jobs.start("a");
  await jobs.runSlice();
  assert.equal(jobs.current("a")?.state,"failed");
  assert.equal(calls.length,0);
});
