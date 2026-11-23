import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { resetDb, installFakeVault, grantUser, makeSession, sessionCookie, type FakeVault } from "./helpers";
import { config } from "../src/config";
import { resetProjectInventoryForTests } from "../src/routes/projects";
let fv: FakeVault;
beforeEach(() => { resetDb(); resetProjectInventoryForTests(); fv = installFakeVault(); });
afterEach(() => fv.restore());
const req = (kind = "documents", email = config.ownerEmail, extra = "") => createApp().request(`/api/projects/p/related?kind=${kind}${extra}`, { headers: { cookie: sessionCookie(makeSession(email)), "X-Prism-Vault": "primary" } });
function seed() {
 fv.put({id:"p",path:"vault/projects/alpha/PROJECT",tags:["project","team"],metadata:{title:"Alpha",slug:"alpha"},content:"PRIVATE_BODY"});
 for (const [id,tags,ref] of [["m",["meeting","team"],"[[vault/projects/alpha/PROJECT|Alpha]]"],["t",["task","team"],"p"],["d",["team"],"alpha"],["person",["person","team"],"vault/projects/alpha"],["secret",["secret"],"alpha"]] as const) fv.put({id,path:`Notes/${id}`,tags:[...tags],metadata:{projects:[ref]},content:"PRIVATE_BODY"});
 fv.put({id:"legacy",tags:["team"],metadata:{project:"alpha"}});
 fv.put({id:"trash",tags:["team","prism-trashed"],metadata:{projects:["alpha"]}});
 fv.put({id:"stale",tags:["team"],metadata:{projects:["other"],project:"alpha"}});
}
test("sections include untagged documents and aliases without bodies, stale fields or trash", async () => {
 seed(); grantUser("reader@test.local","tag","team","view");
 for (const [kind,ids] of [["meetings",["m"]],["tasks",["t"]],["people",["person"]],["documents",["d","legacy"]]] as const) {
  const res=await req(kind,"reader@test.local"); assert.equal(res.status,200); const page=await res.json() as any;
  assert.deepEqual(page.items.map((x:any)=>x.id).sort(),[...ids].sort()); assert.equal(page.total,ids.length); assert.ok(!JSON.stringify(page).includes("PRIVATE_BODY"));
 }
 assert.ok(!fv.calls.some(c=>c.search.includes("include_content=true")));
});
test("ACLs apply to project and counts even with shared inventory cache",async()=>{
 seed(); await req(); grantUser("reader@test.local","tag","team","view");
 const page=await (await req("documents","reader@test.local")).json() as any;assert.equal(page.total,2);
 assert.equal((await req("documents","outsider@test.local")).status,404);
});
test("paging is stable and failures differ from an empty section",async()=>{
 seed(); for(let i=0;i<22;i++)fv.put({id:`doc${i}`,metadata:{projects:["p"]}});
 const first=await (await req()).json() as any;assert.equal(first.items.length,6);assert.ok(first.next);
 const second=await (await req("documents",config.ownerEmail,`&after=${first.next}`)).json() as any;assert.equal(second.items.length,6);
 assert.equal((await req("documents",config.ownerEmail,"&after=gone")).status,409);
 fv.failReads=true;assert.equal((await req()).status,503);
});
