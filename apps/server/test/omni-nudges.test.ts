import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { consequenceScore, interruptDecision, localClock, type NudgePolicyInput } from "../src/omni/nudge-policy";
import { resolveNudgeSource,nudgeWeeklyAudit,latestNudgeAudit,finishNudgePush,claimNudgeDigest,upsertNudge,listNudges,getNudge,setNudgeSettings,claimNudgePush,nudgeAction,resetNudgesForTests,type Candidate } from "../src/omni/nudges";
const T=Date.parse("2026-10-10T15:00:00Z"); // 09:00 Denver
const base:NudgePolicyInput={score:.65,priority:.4,deadline:null,urgentAt:null,surfaces:0,lastSurfaceAt:null,snoozedUntil:null,dismissed:false};
const context={observedAt:T,inMeeting:false,focus:"none" as const};
const candidate:Candidate={sourceId:"source1",sourcePath:"notes/source1",kind:"reply-owed",title:"Reply owed",summary:"Question",reasons:["Waiting"],senderId:"person1",baseScore:.65,priority:.4,deadline:null,urgentAt:null,commitment:false};
beforeEach(resetNudgesForTests);
test("nudge policy: quiet, meeting, known Work and stale calendar hold; unknown Focus uses OS controls",()=>{
 assert.equal(interruptDecision(base,context,"balanced",false,0,T),"digest");
 assert.equal(interruptDecision(base,{...context,focus:"unknown"},"balanced",false,0,T),"digest");
 for(const c of [null,{...context,observedAt:T-300001},{...context,observedAt:T+1},{...context,focus:"work" as const},{...context,inMeeting:true}])assert.equal(interruptDecision(base,c,"balanced",false,0,T),"hold");
 const quiet=Date.parse("2026-10-11T04:00:00Z");assert.equal(interruptDecision(base,{...context,observedAt:quiet},"balanced",false,0,quiet),"hold");
 assert.equal(interruptDecision({...base,priority:.7,urgentAt:quiet},{...context,observedAt:quiet},"balanced",false,0,quiet),"now");
 assert.equal(interruptDecision({...base,priority:.7,urgentAt:quiet},{...context,observedAt:quiet,inMeeting:true},"balanced",false,0,quiet),"hold");
 assert.equal(interruptDecision({...base,score:.85,deadline:T+3600000},{...context,inMeeting:true},"balanced",false,0,T),"now");
 assert.equal(interruptDecision({...base,score:.85,deadline:T+86400000},{...context,inMeeting:true},"balanced",false,0,T),"hold");
});
test("nudge policy: priority floor reaches digest; dial, kill, repeat and rate caps win",()=>{
 assert.equal(interruptDecision({...base,score:.1,priority:.6},context,"conservative",false,0,T),"digest");
 assert.equal(interruptDecision(base,context,"off",false,0,T),"hold");
 assert.equal(interruptDecision(base,context,"balanced",true,0,T),"hold");
 assert.equal(interruptDecision(base,context,"balanced",false,2,T),"hold");
 assert.equal(interruptDecision({...base,surfaces:2},context,"eager",false,0,T),"later");
 assert.equal(interruptDecision({...base,lastSurfaceAt:T-1000},context,"eager",false,0,T),"hold");
 assert.equal(interruptDecision(base,{...context,observedAt:T+600000},"balanced",false,0,T+600000),"hold");
});
test("nudge policy: Denver DST and deadline/commitment/feedback ranking",()=>{
 assert.equal(localClock(Date.parse("2026-12-10T16:00:00Z")).hour,9);
 assert.equal(localClock(T).hour,9);
 assert.equal(consequenceScore(.5,T-1,true,.05,T),.7999999999999999);
 assert.equal(consequenceScore(.5,T+2*86400000,false,.1,T),.45000000000000007);
});
test("nudge ledger: owner scope, source dedupe, update preserves dismissal/surfaces, atomic claims",()=>{
 const n=upsertNudge("owner",candidate,T);assert.equal(upsertNudge("owner",{...candidate,title:"Updated"},T).id,n.id);
 assert.equal(getNudge("other",n.id),null);assert.deepEqual(listNudges("other"),[]);
 setNudgeSettings("owner",{context},T);
 assert.ok(claimNudgePush("owner",n.id,T));assert.equal(claimNudgePush("owner",n.id,T),null);
 upsertNudge("owner",candidate,T+1);assert.equal(getNudge("owner",n.id)!.surfaces,1);
 const later=T+4*3600000;setNudgeSettings("owner",{context:{...context,observedAt:later}},later);
 assert.ok(claimNudgePush("owner",n.id,later));assert.equal(getNudge("owner",n.id)!.surfaces,2);
 assert.equal(listNudges("owner").length,0);assert.equal(listNudges("owner",true).length,1);
 nudgeAction("owner",n.id,"noise",null,T);upsertNudge("owner",candidate,T);assert.ok(getNudge("owner",n.id)!.dismissed);
 const other=upsertNudge("owner",{...candidate,sourceId:"source2"},T);assert.ok(other.score<candidate.baseScore,"sender feedback lowers later scores");
});
test("nudge ledger: snoozed queue is later, Off keeps queue, persistent rate budget across sources",()=>{
 setNudgeSettings("owner",{dial:"conservative",context},T);
 const first=upsertNudge("owner",candidate,T);const second=upsertNudge("owner",{...candidate,sourceId:"second"},T);
 assert.ok(claimNudgePush("owner",first.id,T));assert.equal(claimNudgePush("owner",second.id,T),null);
 nudgeAction("owner",second.id,"snooze",T+86400000,T);assert.equal(listNudges("owner",false,T).length,1);assert.equal(listNudges("owner",true,T).length,1);
 setNudgeSettings("owner",{dial:"off"},T);assert.equal(listNudges("owner",false,T).length,1);
});

test("resolved sources leave both queues and cannot claim, while new verified source evidence can reopen",()=>{
 const n=upsertNudge("owner",candidate,T);setNudgeSettings("owner",{context},T);
 resolveNudgeSource("owner",candidate.sourceId,T+1);
 assert.deepEqual(listNudges("owner",false,T),[]);assert.deepEqual(listNudges("owner",true,T),[]);
 assert.equal(claimNudgePush("owner",n.id,T),null);assert.equal(claimNudgeDigest("owner",T),null);
 assert.equal(upsertNudge("owner",candidate,T+2).id,n.id);assert.equal(listNudges("owner",false,T).length,1);
});
test("one grouped digest claims all items atomically and consumes one rate slot, including failed delivery",()=>{
 setNudgeSettings("owner",{dial:"conservative",context},T);
 const ids=["a","b","c"].map(sourceId=>upsertNudge("owner",{...candidate,sourceId},T).id);
 const digest=claimNudgeDigest("owner",T)!;assert.deepEqual(new Set(digest.ids),new Set(ids));
 for(const id of ids)assert.equal(getNudge("owner",id)!.surfaces,1);
 for(const claim of digest.claims)finishNudgePush(claim,"failed");
 upsertNudge("owner",{...candidate,sourceId:"d"},T);
 assert.equal(claimNudgeDigest("owner",T),null);
});
test("weekly audit counts only owner views or delivered pushes BEFORE reply; failed claims and later views are missed",()=>{
 const a=upsertNudge("owner",candidate,T);nudgeAction("owner",a.id,"seen",null,T+10);
 const b=upsertNudge("owner",{...candidate,sourceId:"b"},T);nudgeAction("owner",b.id,"seen",null,T+30);
 const c=upsertNudge("owner",{...candidate,sourceId:"c"},T);setNudgeSettings("owner",{context},T);
 const claim=claimNudgePush("owner",c.id,T)!;finishNudgePush(claim,"failed");
 nudgeAction("owner",a.id,"noise",null,T+40);
 nudgeAction("owner",a.id,"seen",null,T+45); // A later re-view must not erase valid earlier catch evidence.
 const r=nudgeWeeklyAudit("owner",[{sourceId:"source1",repliedAt:T+20},{sourceId:"b",repliedAt:T+20},{sourceId:"c",repliedAt:T+20}],T,T+50);
 assert.equal(r.caught,1);assert.equal(r.missed,2);assert.equal(r.noise,1);assert.equal(r.replied,3);
 assert.deepEqual(latestNudgeAudit("owner"),r);assert.equal(latestNudgeAudit("other"),null);
});

test("digest slot persists: a newly arrived item cannot create a second notification next minute",()=>{
 setNudgeSettings("owner",{dial:"balanced",context},T);upsertNudge("owner",candidate,T);
 const first=claimNudgeDigest("owner",T)!;for(const claim of first.claims)finishNudgePush(claim,"failed");
 upsertNudge("owner",{...candidate,sourceId:"new"},T+60000);setNudgeSettings("owner",{context:{...context,observedAt:T+60000}},T+60000);
 assert.equal(claimNudgeDigest("owner",T+60000),null);
 assert.equal(listNudges("owner",false,T+60000).find(n=>n.candidate.sourceId==="new")!.surfaces,0);
});

test("business-hours freshness stays in queue but holds weekend/after-hours notifications",()=>{
 assert.equal(interruptDecision({...base,businessHoursOnly:true},context,"balanced",false,0,T),"hold");
 const weekday=Date.parse("2026-10-12T15:00:00Z");assert.equal(interruptDecision({...base,businessHoursOnly:true},{...context,observedAt:weekday},"balanced",false,0,weekday),"digest");
});
