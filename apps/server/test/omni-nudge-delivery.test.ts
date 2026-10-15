import {test,beforeEach,after} from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
process.env.OMNI_ENABLED="true";
import {config} from "../src/config";
import {resetDb} from "./helpers";
import {issueDeviceToken} from "../src/auth/device";
import {configureApns,_resetApns,saveApnsToken,type ApnsRequest} from "../src/apns";
import {upsertNudge,getNudge,setNudgeSettings,resetNudgesForTests,type Candidate} from "../src/omni/nudges";
import {deliverNudges} from "../src/omni/nudge-delivery";
import {setOmniRecordSourcesForTests} from "../src/omni/records";
const dir=mkdtempSync(join(tmpdir(),"omni-nudge-push-"));const keyPath=join(dir,"synthetic.p8");
writeFileSync(keyPath,generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});
const T=Date.parse("2026-10-10T15:00:00Z");let requests:ApnsRequest[]=[];
const candidate:Candidate={sourceId:"source1",sourcePath:"private/source",kind:"reply-owed",title:"PRIVATE_NAME",summary:"PRIVATE_BODY",reasons:["PRIVATE_REASON"],senderId:null,baseScore:.65,priority:.4,deadline:null,urgentAt:null,commitment:false};
beforeEach(()=>{resetDb();resetNudgesForTests();requests=[];configureApns({keyPath,keyId:"TESTKEY123",teamId:"TEAM123456",transport:{close:()=>{},send:async r=>{requests.push(r);return {status:200,body:""};}},sleep:async()=>{}});});
after(()=>{_resetApns();rmSync(dir,{recursive:true,force:true});});
/** Privacy tests pin `generic` explicitly: an Omni registration that names no preview (null here) defaults to title_preview. */
function register(kind:"omni"|"prism",hex:string,preview:"generic"|"title"|"title_preview"|null="generic"){const d=issueDeviceToken(config.ownerEmail,"Native",kind==="omni"?"omni-native":"prism-native");saveApnsToken({deviceId:d.id,token:hex.repeat(64),environment:"sandbox",email:config.ownerEmail,vaultId:"default",application:kind,...(preview?{preview}:{})});}
test("nudge delivery: only Omni device/topic, ids-only standard Focus-respecting payload, repeat dedupe",async()=>{
 register("omni","a");register("prism","b");const n=upsertNudge(config.ownerEmail,candidate,T);setNudgeSettings(config.ownerEmail,{context:{observedAt:T,inMeeting:false,focus:"unknown"}},T);
 await deliverNudges(T);await deliverNudges(T);
 assert.equal(requests.length,1);assert.equal(requests[0]!.headers["apns-topic"],"com.benjaminlife.omni");
 const body=JSON.parse(requests[0]!.body);assert.equal(body.aps.category,"OMNI_NUDGE");assert.equal(body.aps["interruption-level"],"active");assert.equal(body.url,"omni://nudge/digest");assert.deepEqual(body.ids,[n.id]);
 assert.doesNotMatch(requests[0]!.body,/PRIVATE_NAME|PRIVATE_BODY|PRIVATE_REASON|private\/source|source1/);
 assert.equal(getNudge(config.ownerEmail,n.id)!.surfaces,1);
});
test("nudge delivery: absent Omni registrations, stale meeting evidence and kill switch consume no surfaces",async()=>{
 register("prism","b");const n=upsertNudge(config.ownerEmail,candidate,T);setNudgeSettings(config.ownerEmail,{context:{observedAt:T,inMeeting:false,focus:"unknown"}},T);
 await deliverNudges(T);assert.equal(getNudge(config.ownerEmail,n.id)!.surfaces,0);
 register("omni","a");await deliverNudges(T+300001);assert.equal(requests.length,0);
 setNudgeSettings(config.ownerEmail,{killed:true},T);await deliverNudges(T);assert.equal(requests.length,0);assert.equal(getNudge(config.ownerEmail,n.id)!.surfaces,0);
});

test("digest groups multiple candidates into one privacy-safe notification and urgent delivery stays single",async()=>{
 register("omni","a");setNudgeSettings(config.ownerEmail,{context:{observedAt:T,inMeeting:false,focus:"unknown"}},T);
 const items=["a","b","c"].map(sourceId=>upsertNudge(config.ownerEmail,{...candidate,sourceId},T));
 await deliverNudges(T);assert.equal(requests.length,1);const payload=JSON.parse(requests[0]!.body);
 assert.deepEqual(new Set(payload.ids),new Set(items.map(n=>n.id)));assert.equal(payload.count,3);
 for(const n of items)assert.equal(getNudge(config.ownerEmail,n.id)!.surfaces,1);
 assert.doesNotMatch(requests[0]!.body,/PRIVATE/);
 const later=T+10*60000;setNudgeSettings(config.ownerEmail,{context:{observedAt:later,inMeeting:false,focus:"unknown"}},later);
 const urgent=upsertNudge(config.ownerEmail,{...candidate,sourceId:"urgent",baseScore:.9,deadline:later+3600000},later);
 await deliverNudges(later);assert.equal(requests.length,2);assert.equal(JSON.parse(requests[1]!.body).id,urgent.id);
});

const alerts=()=>requests.map(r=>JSON.parse(r.body).aps.alert as {title:string;body:string});
test("nudge delivery: each device's preview setting decides the wording; the default is an informative headline + summary",async()=>{
 setOmniRecordSourcesForTests({resolver:async({id})=>id==="person-alice"?{id,path:"people/alice-chen",tags:["person"],title:"Alice Chen"}:null});
 try{
  register("omni","a","generic");register("omni","b","title");register("omni","c",null);
  const later=T+10*60000;setNudgeSettings(config.ownerEmail,{context:{observedAt:later,inMeeting:false,focus:"unknown"}},later);
  const n=upsertNudge(config.ownerEmail,{...candidate,title:"Q3 budget",summary:"**Can you** send the [deck](https://x.example/deck) before Friday?",senderId:"person-alice",baseScore:.9,deadline:later+3600000},later);
  await deliverNudges(later);
  assert.equal(requests.length,3);assert.ok(requests.every(r=>JSON.parse(r.body).id===n.id));
  assert.deepEqual(alerts(),[
   {title:"Omni",body:"An item needs your attention"},
   {title:"Reply owed: Alice Chen",body:"An item needs your attention"},
   {title:"Reply owed: Alice Chen",body:"Can you send the deck before Friday?"},
  ]);
 }finally{setOmniRecordSourcesForTests({resolver:null});}
});
test("nudge delivery: headlines name the kind — meeting minutes, task due, operational title — and stay bounded",async()=>{
 const {nudgeHeadline,nudgeBody}=await import("../src/omni/push-text");
 const meeting=upsertNudge(config.ownerEmail,{...candidate,sourceId:"m",kind:"meeting",title:"Ops sync",summary:"# Ops sync\n\nAgenda",deadline:T+15*60000},T);
 assert.equal(nudgeHeadline(meeting,null,T),"Meeting in 15 min: Ops sync");
 const task=upsertNudge(config.ownerEmail,{...candidate,sourceId:"t",kind:"task",title:"File taxes",deadline:T+3600000},T);
 assert.equal(nudgeHeadline(task,null,T),"Task due soon: File taxes");
 const owed=upsertNudge(config.ownerEmail,{...candidate,sourceId:"o",title:"x".repeat(300)},T);
 assert.ok(Array.from(nudgeHeadline(owed,null,T)).length<=80);
 assert.equal(nudgeBody({candidate:{...candidate,summary:"Same",title:"Same",reasons:["Waiting 30 h"]}}),"Waiting 30 h","a summary that only repeats the title gives way to the reason");
});
test("nudge delivery: the digest names the count and the top item on informative devices only",async()=>{
 register("omni","a","generic");register("omni","c","title_preview");setNudgeSettings(config.ownerEmail,{context:{observedAt:T,inMeeting:false,focus:"unknown"}},T);
 upsertNudge(config.ownerEmail,{...candidate,sourceId:"low",title:"Newsletter",summary:"Weekly digest"},T);
 upsertNudge(config.ownerEmail,{...candidate,sourceId:"top",title:"Contract",summary:"Please sign today",baseScore:.75},T);
 await deliverNudges(T);
 assert.equal(requests.length,2);
 assert.deepEqual(alerts(),[
  {title:"Omni",body:"Your attention digest is ready"},
  {title:"2 items need you",body:"Top: Reply owed: Contract — Please sign today"},
 ]);
 for(const r of requests)assert.equal(JSON.parse(r.body).count,2);
});
