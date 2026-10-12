import {test,beforeEach,after} from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED="true";process.env.OMNI_SERVICE_TOKEN="test-service-secret-0123456789";
process.env.OMNI_HERMES_URL="http://127.0.0.1:8642";process.env.OMNI_HERMES_KEY="test-hermes-key-0123456789";
import { omniApi } from "../src/routes/omni";
import { db } from "../src/db";
import { config } from "../src/config";
import { resetDb,makeSession,sessionCookie } from "./helpers";
import { createHermesStub } from "../scripts/lib/hermes-stub";
import { setHermesFetchForTests } from "../src/omni/hermes-client";
import { setOmniRecordSourcesForTests } from "../src/omni/records";
import { resetOmniStoreForTests,eventsAfter,getThread,ensureThread,claimTurn,setTurnRun,endTurn } from "../src/omni/store";
import { resetNudgesForTests,nudgeAction,getNudge,nudgeDeliveryDecision,setNudgeSettings,resolveNudgeSource,claimNudgeDigest } from "../src/omni/nudges";
import { interruptDecision } from "../src/omni/nudge-policy";
import { attentionNotificationBody } from "../src/omni/attention-preferences";
import { turnSettled } from "../src/omni/turns";
import { proactiveContext,proactiveMessages,recordProactiveOwnerTurn } from "../src/omni/proactive";
const revision="2026-10-10T12:00:00Z";
const hook={"content-type":"application/json",authorization:`Bearer ${process.env.OMNI_SERVICE_TOKEN}`};
const owner=()=>({"content-type":"application/json",cookie:sessionCookie(makeSession(config.ownerEmail))});
const decision=()=>({decisionId:"decision1",sourceId:"source1",sourceRevision:revision,evidence:[{sourceId:"source1",revision}],title:"A reply would help",summary:"Dana needs the project date",body:"Dana asked about the project date. I prepared this reply for your review:\n\nWe are aiming for Friday.",kind:"reply-owed",expiresAt:Date.now()+3600000,baseScore:.65,priority:.4});
const post=(b:unknown,headers:Record<string,string>=hook)=>omniApi.request("/hooks/proactive",{method:"POST",headers,body:JSON.stringify(b)});
let stub:ReturnType<typeof createHermesStub>;
beforeEach(()=>{resetDb();resetOmniStoreForTests();resetNudgesForTests();db.exec("DELETE FROM omni_proactive_decisions;DELETE FROM omni_proactive_owner_turns");stub=createHermesStub({key:process.env.OMNI_HERMES_KEY!});setHermesFetchForTests(stub.fetch);setOmniRecordSourcesForTests({resolver:async({id})=>({id:id!,path:"mail/dana",tags:["email"],updatedAt:revision})});});
after(()=>{setHermesFetchForTests(null);setOmniRecordSourcesForTests({resolver:null});});
test("authenticated preparation has readable history, replay and no notification bypass",async()=>{
 const d=decision();assert.equal((await post(d,owner())).status,403);assert.equal((await post(d,{...hook,"x-forwarded-for":"8.8.8.8"})).status,403);
 const first=await post(d);assert.equal(first.status,201);const r=await first.json() as {threadId:string;nudgeId:string};
 assert.equal(getThread(r.threadId)!.taskNoteId,"source1");assert.equal(getNudge(config.ownerEmail,r.nudgeId)!.threadId,r.threadId);
 const view=await omniApi.request(`/threads/${r.threadId}`,{headers:owner()});assert.equal(view.status,200);const history=await view.json() as {messages:{role:string;text:string}[]};assert.equal(history.messages[0]!.role,"assistant");assert.ok(history.messages[0]!.text.includes(d.body));assert.ok(history.messages[0]!.text.includes("[Source 1]"));
 assert.equal((await post(d)).status,200);assert.equal(eventsAfter(r.threadId,0).filter(e=>e.payload.t==="text").length,1);assert.equal(stub.sessions.size,1);
 setNudgeSettings(config.ownerEmail,{dial:"off"});assert.notEqual(nudgeDeliveryDecision(config.ownerEmail,r.nudgeId),"now");assert.equal((db.prepare("SELECT count(*) n FROM omni_nudge_pushes").get() as {n:number}).n,0);
 assert.ok((await proactiveContext(config.ownerEmail,r.threadId)).includes("does not authorize"));assert.equal(proactiveMessages(config.ownerEmail,r.threadId).length,1);
});
test("evidence revisions, expiry, payload identity and source uniqueness are enforced",async()=>{
 const d=decision();assert.equal((await post({...d,sourceRevision:"old",evidence:[{sourceId:"source1",revision:"old"}]})).status,409);
 assert.equal((await post({...d,evidence:[]})).status,400);assert.equal((await post({...d,expiresAt:Date.now()-1})).status,409);
 setOmniRecordSourcesForTests({resolver:async()=>null});assert.equal((await post(d)).status,422);assert.equal(stub.sessions.size,0);
 setOmniRecordSourcesForTests({resolver:async({id})=>({id:id!,path:"mail/dana",tags:[],updatedAt:revision})});assert.equal((await post(d)).status,201);assert.equal((await post({...d,body:"Different draft"})).status,409);assert.equal((await post({...d,decisionId:"duplicate"})).status,409);
});
test("changed evidence during session creation cannot publish; retry reconciles session",async()=>{
 const d=decision();let reads=0;setOmniRecordSourcesForTests({resolver:async({id})=>({id:id!,path:"mail/dana",tags:[],updatedAt:++reads===1?revision:"changed"})});assert.equal((await post(d)).status,409);assert.equal(stub.sessions.size,1);assert.equal((db.prepare("SELECT count(*) n FROM omni_proactive_decisions").get() as {n:number}).n,0);
 setOmniRecordSourcesForTests({resolver:async({id})=>({id:id!,path:"mail/dana",tags:[],updatedAt:revision})});assert.equal((await post(d)).status,201);assert.equal(stub.sessions.size,1);
});
test("dismissal/resolution suppress revised work; stale prep cannot enter continuation",async()=>{
 const d=decision();const first=await post(d);const r=await first.json() as {threadId:string;nudgeId:string};setOmniRecordSourcesForTests({resolver:async({id})=>({id:id!,path:"mail/dana",tags:[],updatedAt:"changed"})});assert.equal(await proactiveContext(config.ownerEmail,r.threadId),"");nudgeAction(config.ownerEmail,r.nudgeId,"dismiss");assert.equal((await post({...d,decisionId:"revised",sourceRevision:"changed",evidence:[{sourceId:"source1",revision:"changed"}]})).status,409);nudgeAction(config.ownerEmail,r.nudgeId,"relevant");resolveNudgeSource(config.ownerEmail,"source1");assert.equal((await post({...d,decisionId:"resolved"})).status,409);
});
test("concurrent duplicate requests commit one event",async()=>{
 const d=decision();const results=await Promise.all([post(d),post(d)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(stub.sessions.size,1);const r=await results[0].json() as {threadId:string};assert.equal(eventsAfter(r.threadId,0).filter(e=>e.payload.t==="text").length,1);
});

test("new source revision updates same conversation; failed create receipt recovers stable identity",async()=>{
 const d=decision();let loseResponse=true;
 setHermesFetchForTests(async(input,init)=>{const response=await stub.fetch(input,init);if(loseResponse&&init?.method==="POST"&&String(input).endsWith("/api/sessions")){loseResponse=false;throw new Error("connection lost after create");}return response;});
 assert.equal((await post(d)).status,502);assert.equal(stub.sessions.size,1);
 const retry=await post(d);assert.equal(retry.status,201);const r=await retry.json() as {threadId:string;nudgeId:string};
 setOmniRecordSourcesForTests({resolver:async({id})=>({id:id!,path:"mail/dana",tags:[],updatedAt:"new-revision"})});
 const next=await post({...d,decisionId:"new_version",sourceRevision:"new-revision",evidence:[{sourceId:"source1",revision:"new-revision"}],body:"Dana changed the deadline to Thursday."});assert.equal(next.status,201);assert.equal((await next.json() as {threadId:string}).threadId,r.threadId);assert.equal(stub.sessions.size,1);assert.equal(proactiveMessages(config.ownerEmail,r.threadId).length,2);
});

test("management scope verifies live owner turn, rejects scheduled, ended and subagent sessions",async()=>{
 const threadId="omni-owner-scope";ensureThread({id:threadId});const turn=claimTurn(threadId,null).turn!;setTurnRun(turn.id,"run-owner");
 const b={threadId,sessionId:threadId,change:{operation:"preference",key:"quiet_hours",value:"evening"}};
 const scope=()=>omniApi.request("/hooks/proactive/owner-intent",{method:"POST",headers:hook,body:JSON.stringify(b)});
 assert.equal((await scope()).status,403);recordProactiveOwnerTurn(config.ownerEmail,threadId,turn.id);
 const response=await scope();assert.equal(response.status,200);assert.equal((await response.json() as {turn_id:string}).turn_id,turn.id);
 assert.equal((await omniApi.request("/hooks/proactive/owner-intent",{method:"POST",headers:hook,body:JSON.stringify({...b,sessionId:"subagent-session"})})).status,403);
 endTurn(turn.id,"done");assert.equal((await scope()).status,403);
});

test("different due boundaries share source revision and conversation without duplicate boundary publication",async()=>{
 const d=decision();const first=await post({...d,boundary:"day"});assert.equal(first.status,201);const r=await first.json() as {threadId:string};
 const next=await post({...d,decisionId:"hour_boundary",boundary:"hour"});assert.equal(next.status,201);assert.equal((await next.json() as {threadId:string}).threadId,r.threadId);
 assert.equal((await post({...d,decisionId:"hour_duplicate",boundary:"hour"})).status,409);assert.equal(stub.sessions.size,1);
});
test("bounded preference sync changes durable attention policy, handles undo and refuses stale snapshots",async()=>{
 const sync=(version:number,preferences:unknown,headers:Record<string,string>=hook)=>omniApi.request("/hooks/proactive/preferences",{method:"POST",headers,body:JSON.stringify({version,preferences})});
 assert.equal((await sync(1,{quiet_hours:"09:00-10:00"},owner())).status,403);assert.equal((await sync(1,{daily_budget:100})).status,400);assert.equal((await sync(1,{quiet_hours:"25:00-07:00"})).status,400);
 const d=decision();const created=await post(d);const r=await created.json() as {nudgeId:string};const T=Date.parse("2026-10-12T15:00:00Z");setNudgeSettings(config.ownerEmail,{context:{observedAt:T,inMeeting:false,focus:"none"}});
 assert.equal(nudgeDeliveryDecision(config.ownerEmail,r.nudgeId,T),"digest");
 assert.equal((await sync(1,{quiet_hours:"09:00-10:00",notification_style:"detailed"})).status,200);assert.ok(attentionNotificationBody(config.ownerEmail).includes("source"));assert.equal(nudgeDeliveryDecision(config.ownerEmail,r.nudgeId,T),"hold");assert.equal(claimNudgeDigest(config.ownerEmail,T),null);
 assert.equal((await sync(2,{deadline_only:true})).status,200);assert.equal(nudgeDeliveryDecision(config.ownerEmail,r.nudgeId,T),"hold");
 assert.equal((await sync(1,{})).status,409);assert.equal((await sync(2,{})).status,409);assert.equal((await sync(2,{deadline_only:true})).status,200);
 assert.equal((await sync(3,{})).status,200);assert.equal(attentionNotificationBody(config.ownerEmail),"An item needs your attention");assert.equal(nudgeDeliveryDecision(config.ownerEmail,r.nudgeId,T),"digest");assert.ok(claimNudgeDigest(config.ownerEmail,T));
});
test("configured quiet hours use Denver DST and can silence urgent notifications",()=>{
 for(const T of [Date.parse("2026-11-01T07:30:00Z"),Date.parse("2026-11-01T08:30:00Z")]){
  const n={score:.95,priority:.9,deadline:T+3600000,urgentAt:T,surfaces:0,lastSurfaceAt:null,snoozedUntil:null,dismissed:false};const c={observedAt:T,inMeeting:false,focus:"none" as const};assert.equal(interruptDecision(n,c,"balanced",false,0,T,{quiet_hours:"01:00-02:00"}),"hold");
 }
 assert.ok(attentionNotificationBody(config.ownerEmail).length>0);
});

test("user continuation gets current preparation and bound source; stale preparation is withheld",async()=>{
 const d=decision();const response=await post(d);const r=await response.json() as {threadId:string};let received="";
 const capturing=createHermesStub({key:process.env.OMNI_HERMES_KEY!,script:({message})=>{received=message;return {acts:[{say:"I can review the current source with you."}]};}});
 await capturing.fetch(`${process.env.OMNI_HERMES_URL}/api/sessions`,{method:"POST",headers:{authorization:`Bearer ${process.env.OMNI_HERMES_KEY}`,"content-type":"application/json"},body:JSON.stringify({id:r.threadId})});setHermesFetchForTests(capturing.fetch);
 const proceed=()=>omniApi.request(`/threads/${r.threadId}/turns`,{method:"POST",headers:owner(),body:JSON.stringify({text:"Help me review this."})});
 let turn=await proceed();assert.equal(turn.status,202);await turnSettled((await turn.json() as {turnId:string}).turnId);assert.ok(received.includes(JSON.stringify(d.body).slice(1,-1)));assert.ok(received.includes("source1"));assert.ok(received.includes("does not authorize sending"));
 setOmniRecordSourcesForTests({resolver:async({id})=>({id:id!,path:"mail/dana",tags:[],updatedAt:"new-source-revision"})});turn=await proceed();assert.equal(turn.status,202);await turnSettled((await turn.json() as {turnId:string}).turnId);assert.ok(!received.includes(JSON.stringify(d.body).slice(1,-1)));assert.ok(received.includes("source1"));
});

test("confirmed inactive sources resolve only known fresh preparation, retaining conversation history",async()=>{
 const d=decision();const first=await post(d);const r=await first.json() as {threadId:string;nudgeId:string};
 const resolve=(sources:unknown,headers:Record<string,string>=hook)=>omniApi.request("/hooks/proactive/resolve",{method:"POST",headers,body:JSON.stringify({sources})});
 const refs=[{sourceId:"source1",sourceRevision:"completed-revision"}];assert.equal((await resolve(refs,owner())).status,403);assert.equal((await resolve([{sourceId:"source1"}])).status,400);
 const stale=await resolve(refs);assert.equal(stale.status,200);assert.equal((await stale.json() as {rejected:{error:string}[]}).rejected[0]!.error,"stale_evidence");assert.equal(getNudge(config.ownerEmail,r.nudgeId)!.resolved,false);
 setOmniRecordSourcesForTests({resolver:async({id})=>({id:id!,path:"mail/dana",tags:[],updatedAt:"completed-revision"})});
 const resolved=await resolve([...refs,{sourceId:"never_prepared",sourceRevision:"completed-revision"}]);const result=await resolved.json() as {resolved:string[];ignored:string[]};assert.deepEqual(result.resolved,["source1"]);assert.deepEqual(result.ignored,["never_prepared"]);
 assert.equal(getNudge(config.ownerEmail,r.nudgeId)!.resolved,true);assert.equal(getThread(r.threadId)!.state,"done");assert.equal(getThread(r.threadId)!.unread,0);assert.equal(proactiveMessages(config.ownerEmail,r.threadId).length,1);assert.equal(await proactiveContext(config.ownerEmail,r.threadId),"");assert.equal(nudgeDeliveryDecision(config.ownerEmail,r.nudgeId),"hold");
 assert.deepEqual((await (await resolve(refs)).json() as {ignored:string[]}).ignored,["source1"]);
});
