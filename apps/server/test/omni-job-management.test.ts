import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hermes, setHermesFetchForTests } from "../src/omni/hermes-client";
import { reserveJobCreation, finishJobCreation, resetJobCreationsForTests } from "../src/omni/job-creations";
process.env.OMNI_HERMES_URL = "http://127.0.0.1:8642";
process.env.OMNI_HERMES_KEY = "test-job-management-key";
afterEach(() => { setHermesFetchForTests(null); resetJobCreationsForTests(); });
test("run requires background dispatch rather than rescheduling", async () => {
 setHermesFetchForTests(async () => Response.json({job:{id:"abcdef012345",next_run:"now"}}));
 await assert.rejects(hermes.jobAction("abcdef012345","run"), /did not confirm job dispatch/);
 setHermesFetchForTests(async () => Response.json({job:{id:"abcdef012345",executed:true,execution_mode:"background"}}));
 assert.equal((await hermes.jobAction("abcdef012345","run")).executed,true);
});
test("creation uses a validated server-selected owner thread", async () => {
 setHermesFetchForTests(async (_url,init) => {
  assert.equal(new Headers(init.headers).get("X-Omni-Thread"),"omni_abcdef");
  assert.equal(JSON.parse(String(init.body)).deliver,"local");
  return Response.json({job:{id:"abcdef012345"}});
 });
 await hermes.createJob({name:"Test",deliver:"local"},"omni_abcdef");
 await assert.rejects(hermes.createJob({name:"Test"},"api"), /Invalid job thread/);
});
test("uncertain reservations survive retry and remain owner scoped", () => {
 assert.equal(reserveJobCreation("owner","test-key","digest","omni_abc").inserted,true);
 const retry=reserveJobCreation("owner","test-key","digest","omni_def");
 assert.equal(retry.inserted,false); assert.equal(retry.thread_id,"omni_abc"); assert.equal(retry.response,null);
 assert.equal(reserveJobCreation("other","test-key","digest","omni_def").inserted,true);
 assert.equal(reserveJobCreation("owner","test-key","different","omni_def").digest,"digest");
});
test("created routing failure replays without a second creation", () => {
 reserveJobCreation("owner","test-key","digest","omni_abc");
 finishJobCreation("owner","test-key",503,{error:"job_approval_routing_unavailable",created:true});
 const retry=reserveJobCreation("owner","test-key","digest","omni_def");
 assert.equal(retry.status,503); assert.equal(JSON.parse(retry.response!).created,true);
});
