import {test,beforeEach,after} from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED="true";process.env.OMNI_SERVICE_TOKEN="test-service-secret-0123456789";
process.env.OMNI_HERMES_URL="http://127.0.0.1:8642";process.env.OMNI_HERMES_KEY="test-hermes-key-0123456789";
import { omniApi } from "../src/routes/omni";
import { createHermesStub } from "../scripts/lib/hermes-stub";
import { setHermesFetchForTests } from "../src/omni/hermes-client";
import { turnSettled } from "../src/omni/turns";
import { getThread,getTurn,resetOmniStoreForTests } from "../src/omni/store";
import { config } from "../src/config";
import { resetDb,makeSession,sessionCookie } from "./helpers";
import { issueDeviceToken } from "../src/auth/device";
import { getNudge,resetNudgesForTests,nudgeSettings,upsertNudge,type Candidate } from "../src/omni/nudges";
import { setOmniRecordSourcesForTests } from "../src/omni/records";
const J={"content-type":"application/json"};
const owner=()=>({...J,cookie:sessionCookie(makeSession(config.ownerEmail))});
const hook={...J,authorization:`Bearer ${process.env.OMNI_SERVICE_TOKEN}`};
const candidate:Candidate={sourceId:"source1",sourcePath:"forged/path",kind:"reply-owed",title:"Reply owed",summary:"Question",reasons:["Waiting"],senderId:null,baseScore:.65,priority:.4,deadline:null,urgentAt:null,commitment:false};
const post=(path:string,body:unknown,headers:Record<string,string>=owner())=>omniApi.request(path,{method:"POST",headers,body:JSON.stringify(body)});
beforeEach(()=>{resetDb();resetOmniStoreForTests();resetNudgesForTests();setOmniRecordSourcesForTests({resolver:async({id})=>id==="source1"?{id,path:"actual/source",tags:["email"]}:null});});
after(()=>setOmniRecordSourcesForTests({resolver:null}));
test("nudge routes: owner-only queue/settings/actions; hook token is proposal-only",async()=>{
 assert.equal((await omniApi.request("/nudges")).status,401);
 const member={...J,cookie:sessionCookie(makeSession("other@example.com"))};
 assert.equal((await omniApi.request("/nudges",{headers:member})).status,403);
 assert.equal((await post("/nudges/settings",{},hook)).status,401);
 assert.equal((await post("/hooks/nudges",candidate,owner())).status,403);
 assert.equal((await post("/hooks/nudges",candidate,{...hook,"x-forwarded-for":"8.8.8.8"})).status,403);
 const response=await post("/hooks/nudges",candidate,hook);assert.equal(response.status,201);
 const n=await response.json() as {id:string;candidate:Candidate};assert.equal(n.candidate.sourcePath,"actual/source");
 assert.equal((await post(`/nudges/${n.id}/action`,{action:"dismiss"},hook)).status,401);
 assert.equal((await post(`/nudges/${n.id}/start`,{action:"draft-reply"},hook)).status,401);
 assert.equal((await post(`/nudges/${n.id}/action`,{action:"dismiss"},{...owner(),"x-prism-action-origin":"agent"})).status,403);
 assert.equal((await post(`/nudges/${n.id}/action`,{action:"snooze",until:Date.now()-1})).status,400);
 assert.equal((await post(`/nudges/${n.id}/action`,{action:"dismiss"})).status,200);
});
test("nudge routes: invalid/source-missing proposals rejected, context never defaults to free",async()=>{
 for(const change of [{baseScore:2},{sourceId:"missing"},{deadline:"tomorrow"},{senderId:"https://evil"},{reasons:["x".repeat(301)]}])assert.ok((await post("/hooks/nudges",{...candidate,...change},hook)).status>=400);
 assert.equal((await post("/hooks/nudges/context",{inMeeting:false},hook)).status,200);
 assert.ok(nudgeSettings(config.ownerEmail).context!.observedAt>0);
 assert.equal(nudgeSettings(config.ownerEmail).context!.focus,"unknown");
 const device=issueDeviceToken(config.ownerEmail,"Omni","omni-native");
 assert.equal((await post("/nudges/context",{focus:"none"},{...J,authorization:`Bearer ${device.token}`})).status,200);
 assert.ok(nudgeSettings(config.ownerEmail).context!.observedAt>0);
 assert.equal((await post("/nudges/context",{focus:"none"})).status,403);
});
test("nudge routes: Off and kill switch are human settings, source is required before private work",async()=>{
 const settings=await omniApi.request("/nudges/settings",{method:"PATCH",headers:owner(),body:JSON.stringify({dial:"off",killed:true})});assert.equal(settings.status,200);
 assert.deepEqual(await settings.json(),{dial:"off",killed:true});
 const n=upsertNudge(config.ownerEmail,candidate);
 assert.equal((await omniApi.request("/nudges",{headers:owner()})).status,200);
 assert.equal((await post(`/nudges/${n.id}/start`,{action:"draft-reply"})).status,400);
 setOmniRecordSourcesForTests({resolver:async()=>null});
 assert.equal((await post(`/nudges/${n.id}/start`,{action:"draft-reply"},{...owner(),"idempotency-key":"nudge-start-12345"})).status,422);
});


test("nudge routes: a human private start binds source, retry reuses turn, no executor is called",async()=>{
 const stub=createHermesStub({key:process.env.OMNI_HERMES_KEY!,script:()=>({acts:[{say:"Draft for review only"}]})});
 setHermesFetchForTests(stub.fetch);
 const n=upsertNudge(config.ownerEmail,candidate);
 const h={...owner(),"idempotency-key":"source-draft-start-12345"};
 try {
  const first=await post(`/nudges/${n.id}/start`,{action:"draft-reply"},h);assert.equal(first.status,200);
  const started=await first.json() as {threadId:string;turnId:string};
  assert.equal(getThread(started.threadId)!.taskNoteId,"source1");
  assert.equal(getThread(started.threadId)!.source,"nudge");
  await turnSettled(started.turnId);
  const retry=await post(`/nudges/${n.id}/start`,{action:"draft-reply"},h);
  assert.deepEqual(await retry.json(),started);
  assert.equal(getTurn(started.turnId)!.status,"done");
  assert.equal(stub.sessions.size,1);
 }finally{setHermesFetchForTests(null);}
});

test("service reconciliation and audit require complete evidence, preserve partial failures and remain owner-only",async()=>{
 const n=upsertNudge(config.ownerEmail,candidate);
 assert.equal((await post("/hooks/nudges/resolve",{complete:false,sourceIds:["source1"]},hook)).status,400);
 assert.equal(getNudge(config.ownerEmail,n.id)!.resolved,false);
 assert.equal((await post("/hooks/nudges/resolve",{complete:true,sourceIds:["source1"]},owner())).status,403);
 assert.equal((await post("/hooks/nudges/resolve",{complete:true,sourceIds:["source1"]},hook)).status,200);
 assert.equal((await post(`/nudges/${n.id}/start`,{action:"draft-reply"},{...owner(),"idempotency-key":"resolved-start-12345"})).status,409);
 const now=Date.now(),body={complete:true,since:now-86400000,replies:[{sourceId:"source1",inboundAt:now-3600000,repliedAt:now-1000}]};
 assert.equal((await post("/hooks/nudges/audit",{...body,complete:false},hook)).status,400);
 assert.equal((await post("/hooks/nudges/audit",{...body,replies:[{...body.replies[0],repliedAt:now+100000}]},hook)).status,400);
 assert.equal((await post("/hooks/nudges/audit",body,hook)).status,200);
 assert.equal((await omniApi.request("/nudges/audit",{headers:hook})).status,401);
 const report=await (await omniApi.request("/nudges/audit",{headers:owner()})).json() as {report:{missed:number}};assert.equal(report.report.missed,1);
});
