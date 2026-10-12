import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED="true";process.env.OMNI_SERVICE_TOKEN="test-service-secret-0123456789";
import { db, resolveVaultEntry } from "../src/db";
import { resetDb } from "./helpers";
import { omniApi } from "../src/routes/omni";
import { recordProactiveIntake, proactiveIntake, acknowledgeProactiveIntake } from "../src/omni/proactive-intake";
import type { TreeRow } from "../src/tree";
const row=(revision="r1",type="meeting"):TreeRow=>({id:"private-id",title:"PRIVATE TITLE",path:"private/path",tags:[type],type,updatedAt:revision,creator:null,visibility:"private"});
const primary=()=>resolveVaultEntry(undefined).id;
beforeEach(()=>{resetDb();db.exec("DELETE FROM omni_proactive_intake");});
test("relevant committed changes coalesce, bounded max wait and exact acknowledgement",()=>{
 recordProactiveIntake(primary(),{kind:"upsert",row:row(),prev:undefined},1000);
 assert.deepEqual(proactiveIntake(),{generation:1,pending:true,readyAt:121000});
 for(let t=61000;t<=301000;t+=60000)recordProactiveIntake(primary(),{kind:"upsert",row:row(String(t)),prev:row()},t);
 assert.equal(proactiveIntake().readyAt,301000);
 assert.equal(acknowledgeProactiveIntake(1),false);assert.equal(proactiveIntake().pending,true);
 const generation=proactiveIntake().generation;assert.equal(acknowledgeProactiveIntake(generation),true);
 assert.equal(proactiveIntake().pending,false);
 recordProactiveIntake(primary(),{kind:"remove",id:"private-id",prev:row()},400000);
 assert.equal(proactiveIntake().readyAt,520000);
});
test("unchanged, unrelated and secondary vault changes do not wake; cancellation/removal does",()=>{
 assert.equal(recordProactiveIntake(primary(),{kind:"upsert",row:row(),prev:row()}),false);
 assert.equal(recordProactiveIntake(primary(),{kind:"upsert",row:row("r1","report"),prev:undefined}),false);
 assert.equal(recordProactiveIntake("other-vault",{kind:"resync"}),false);
 assert.equal(proactiveIntake().pending,false);
 assert.equal(recordProactiveIntake(primary(),{kind:"upsert",row:row("r2","Task"),prev:undefined}),true);
 assert.equal(recordProactiveIntake(primary(),{kind:"upsert",row:row("cancelled-r2"),prev:row()}),true);
});
test("durable receipt contains only counts/timing and conservative resync survives restart",async()=>{
 recordProactiveIntake(primary(),{kind:"resync"},1000);
 const stored=db.prepare("SELECT * FROM omni_proactive_intake").get();assert.ok(!JSON.stringify(stored).includes("PRIVATE"));
 const headers={"content-type":"application/json",authorization:`Bearer ${process.env.OMNI_SERVICE_TOKEN}`};
 const response=await omniApi.request("/hooks/proactive/intake",{method:"POST",headers,body:"{}"});
 assert.equal(response.status,200);assert.deepEqual(Object.keys(await response.json()).sort(),["generation","pending","readyAt"]);
 assert.equal((await omniApi.request("/hooks/proactive/intake",{method:"POST",headers:{...headers,"x-forwarded-for":"8.8.8.8"},body:"{}"})).status,403);
 assert.equal((await omniApi.request("/hooks/proactive/intake/ack",{method:"POST",headers,body:'{"generation":"1"}'})).status,400);
});
