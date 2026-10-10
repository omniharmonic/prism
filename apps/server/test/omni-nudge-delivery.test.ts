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
const dir=mkdtempSync(join(tmpdir(),"omni-nudge-push-"));const keyPath=join(dir,"synthetic.p8");
writeFileSync(keyPath,generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});
const T=Date.parse("2026-10-10T15:00:00Z");let requests:ApnsRequest[]=[];
const candidate:Candidate={sourceId:"source1",sourcePath:"private/source",kind:"reply-owed",title:"PRIVATE_NAME",summary:"PRIVATE_BODY",reasons:["PRIVATE_REASON"],senderId:null,baseScore:.65,priority:.4,deadline:null,urgentAt:null,commitment:false};
beforeEach(()=>{resetDb();resetNudgesForTests();requests=[];configureApns({keyPath,keyId:"TESTKEY123",teamId:"TEAM123456",transport:{close:()=>{},send:async r=>{requests.push(r);return {status:200,body:""};}},sleep:async()=>{}});});
after(()=>{_resetApns();rmSync(dir,{recursive:true,force:true});});
function register(kind:"omni"|"prism",hex:string){const d=issueDeviceToken(config.ownerEmail,"Native",kind==="omni"?"omni-native":"prism-native");saveApnsToken({deviceId:d.id,token:hex.repeat(64),environment:"sandbox",email:config.ownerEmail,vaultId:"default",application:kind});}
test("nudge delivery: only Omni device/topic, ids-only standard Focus-respecting payload, repeat dedupe",async()=>{
 register("omni","a");register("prism","b");const n=upsertNudge(config.ownerEmail,candidate,T);setNudgeSettings(config.ownerEmail,{context:{observedAt:T,inMeeting:false,focus:"unknown"}},T);
 await deliverNudges(T);await deliverNudges(T);
 assert.equal(requests.length,1);assert.equal(requests[0]!.headers["apns-topic"],"com.benjaminlife.omni");
 const body=JSON.parse(requests[0]!.body);assert.equal(body.aps.category,"OMNI_NUDGE");assert.equal(body.aps["interruption-level"],"active");assert.equal(body.url,`omni://nudge/${n.id}`);
 assert.doesNotMatch(requests[0]!.body,/PRIVATE_NAME|PRIVATE_BODY|PRIVATE_REASON|private\/source|source1/);
 assert.equal(getNudge(config.ownerEmail,n.id)!.surfaces,1);
});
test("nudge delivery: absent Omni registrations, stale meeting evidence and kill switch consume no surfaces",async()=>{
 register("prism","b");const n=upsertNudge(config.ownerEmail,candidate,T);setNudgeSettings(config.ownerEmail,{context:{observedAt:T,inMeeting:false,focus:"unknown"}},T);
 await deliverNudges(T);assert.equal(getNudge(config.ownerEmail,n.id)!.surfaces,0);
 register("omni","a");await deliverNudges(T+300001);assert.equal(requests.length,0);
 setNudgeSettings(config.ownerEmail,{killed:true},T);await deliverNudges(T);assert.equal(requests.length,0);assert.equal(getNudge(config.ownerEmail,n.id)!.surfaces,0);
});
