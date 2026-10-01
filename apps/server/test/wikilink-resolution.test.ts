import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildWikilinkIndex, resolveWikilink, parseWikilinks } from "@prism/core/wikilinks";
import { createApp } from "../src/app";
import { resetDb, installFakeVault, makeSession, sessionCookie, grantUser, makeCapability, type FakeVault } from "./helpers";
import { addVaultEntry, addGrant, db } from "../src/db";
import { config } from "../src/config";
import { signCapability } from "../src/auth/capability";

let fv:FakeVault;
beforeEach(()=>{resetDb();fv=installFakeVault();});
afterEach(()=>fv.restore());

test("one resolver prefers IDs/paths, then aliases, then unambiguous titles",()=>{
  const index=buildWikilinkIndex([
    {id:"one",path:"a/Report",metadata:{aliases:["Summary"],title:"First report"}},
    {id:"two",path:"vault/b/Report",metadata:{title:"Summary"}},
    {id:"three",path:"c/Another",metadata:{aliases:["shared","Summary old"]}},
    {id:"four",path:"d/Another",metadata:{aliases:["shared"]}},
    {id:"five",path:"a/Title",displayTitle:"Readable title"},
  ]);
  const id=(target:string)=>{const result=resolveWikilink(target,index);return result.kind==='match'?result.note.id:result.kind;};
  assert.equal(id("one"),"one");
  assert.equal(id("a/Report"),"one");
  assert.equal(id("b/Report"),"two");
  assert.equal(id("vault/a/Report"),"one");
  assert.equal(id("summary"),"one","alias wins over another note's title");
  assert.equal(id("Readable title"),"five");
  assert.equal(id("Report"),"ambiguous");
  assert.equal(id("shared"),"ambiguous");
  assert.equal(id("wrong/Report"),"none","a wrong path must not degrade to filename guessing");
  assert.deepEqual(parseWikilinks('[[open [[one|label]] [[one]]'),{links:['one'],balanced:false});
  assert.deepEqual(parseWikilinks('<p title="[[ignore]]">[[Research &amp; design|R&amp;D]]</p><script>[[ignore too]]</script>'),{links:['Research & design'],balanced:true});
  assert.deepEqual(parseWikilinks('[[Literal &amp; entity]]'),{links:['Literal &amp; entity'],balanced:true});
});

test("interactive candidates are permission-filtered before matching and never include bodies",async()=>{
  fv.put({id:"visible",path:"Team/Report",content:"DO_NOT_RETURN_BODY",tags:["team"],metadata:{aliases:["Weekly"]}});
  fv.put({id:"hidden",path:"Private/Report",content:"PRIVATE",tags:["private"],metadata:{aliases:["Weekly"]}});
  const email="viewer@test.local";
  grantUser(email,"tag","team","view");
  const cookie=sessionCookie(makeSession(email));
  const app=createApp();
  for(const target of ['Weekly','Report','visible','Team/Report']){
    const response=await app.request('/api/wikilinks/resolve?target='+encodeURIComponent(target),{headers:{cookie}});
    assert.equal(response.status,200);
    const body=await response.json() as {kind:string;candidates:{id:string}[]};
    assert.equal(body.kind,'match');assert.equal(body.candidates[0]?.id,'visible');
    assert.ok(!JSON.stringify(body).includes('BODY'));assert.ok(!JSON.stringify(body).includes('Private'));
  }
  const cap=makeCapability('note','visible','view');
  const linked=await app.request('/api/wikilinks/resolve?target=Weekly&t='+encodeURIComponent(cap));
  assert.equal((await linked.json() as {kind:string}).kind,'match');
  db.prepare('DELETE FROM grants').run();
  const revoked=await app.request('/api/wikilinks/resolve?target=Weekly',{headers:{cookie}});
  assert.deepEqual(await revoked.json(),{kind:'none',candidates:[]});
  assert.equal((await app.request('/api/wikilinks/resolve?target=Report')).status,401);
});

test("resolution respects secondary-vault credentials and retired capabilities fail closed",async()=>{
  const app=createApp();
  fv.put({id:'same',path:'Private/Secret',metadata:{aliases:['Target']}});
  addVaultEntry({id:'secondary',label:'Secondary',url:'http://vault.test',vault:'secondary',token:'test-token'});
  fv.putIn('secondary',{id:'same',path:'Secondary/Target'});
  const cookie=sessionCookie(makeSession(config.ownerEmail));
  const response=await app.request('/api/wikilinks/resolve?target=Target',{headers:{cookie,'x-prism-vault':'secondary'}});
  const body=await response.json() as {candidates:{path:string}[]};
  assert.equal(body.candidates[0]?.path,'Secondary/Target');
  addGrant({subject_type:'link',subject:'retired-link',resource_type:'note',resource:'same',level:'view',vault_id:'secondary',created_by:'test'});
  const cap=signCapability({id:'retired-link',exp:Date.now()+60_000});
  db.prepare('DELETE FROM prism_vaults WHERE id=?').run('secondary');
  assert.equal((await app.request('/api/wikilinks/resolve?target=Target&t='+encodeURIComponent(cap))).status,409);
});
