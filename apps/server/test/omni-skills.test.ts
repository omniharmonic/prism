import {test,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import path from "node:path";
import os from "node:os";
import {listSkills,readSkill,saveSkill,SKILL_CAP} from "../src/omni/skills";
let directory:string;
beforeEach(async()=>{directory=await fs.mkdtemp(path.join(os.tmpdir(),"omni-skills-test-"));process.env.OMNI_SKILLS_DIR=path.join(directory,"skills");await fs.mkdir(process.env.OMNI_SKILLS_DIR);});
afterEach(async()=>{delete process.env.OMNI_SKILLS_DIR;delete process.env.OMNI_SKILLS_READ_ROOTS;await fs.rm(directory,{recursive:true,force:true});});
async function local(){const folder=path.join(directory,"skills","sample");await fs.mkdir(folder);await fs.writeFile(path.join(folder,"SKILL.md"),"# Test\nInstructions\n");await fs.writeFile(path.join(folder,"helper.py"),"preserve");return folder;}
test("saves only existing SKILL.md, preserving other files and using revision CAS",async()=>{
 const folder=await local();const summary=(await listSkills())[0]!;const original=await readSkill(summary.id);
 const updated=await saveSkill(summary.id,"# Updated\n",original.revision!);
 assert.equal(updated.text,"# Updated\n");assert.notEqual(updated.revision,original.revision);
 assert.equal(await fs.readFile(path.join(folder,"helper.py"),"utf8"),"preserve");
 await assert.rejects(saveSkill(summary.id,"Stale",original.revision!),/skill_revision_conflict/);
});
test("linked folders/files cannot be written or read outside explicit read roots",async()=>{
 const external=path.join(directory,"external");await fs.mkdir(external);await fs.writeFile(path.join(external,"SKILL.md"),"external");
 await fs.symlink(external,path.join(directory,"skills","linked"));
 const summary=(await listSkills())[0]!;assert.equal(summary.editable,false);
 assert.equal((await readSkill(summary.id)).text,undefined);
 process.env.OMNI_SKILLS_READ_ROOTS=external;
 const readable=await readSkill(summary.id);assert.equal(readable.text,"external");assert.equal(readable.editable,false);
 await assert.rejects(saveSkill(summary.id,"Replace",readable.revision!),/skill_read_only/);
 assert.equal(await fs.readFile(path.join(external,"SKILL.md"),"utf8"),"external");
});
test("final-file symlink and path-shaped client IDs fail closed",async()=>{
 const folder=await local();await fs.unlink(path.join(folder,"SKILL.md"));await fs.writeFile(path.join(directory,"outside"),"private");await fs.symlink(path.join(directory,"outside"),path.join(folder,"SKILL.md"));
 const summary=(await listSkills())[0]!;assert.equal(summary.editable,false);assert.equal((await readSkill(summary.id)).text,undefined);
 await assert.rejects(readSkill("../../outside"),/not_found/);
});
test("bounded reads and writes reject oversized skills",async()=>{
 const folder=await local();const id=(await listSkills())[0]!.id;const previous=await readSkill(id);
 await assert.rejects(saveSkill(id,"x".repeat(SKILL_CAP+1),previous.revision!),/skill_too_large/);
 await fs.writeFile(path.join(folder,"SKILL.md"),"x".repeat(SKILL_CAP+1));await assert.rejects(readSkill(id),/skill_too_large/);
});
test("concurrent saves cannot overwrite each other",async()=>{
 await local();const id=(await listSkills())[0]!.id;const original=await readSkill(id);
 const results=await Promise.allSettled([saveSkill(id,"First",original.revision!),saveSkill(id,"Second",original.revision!)]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
 assert.equal(results.filter(r=>r.status==="rejected").length,1);
});
test("changed ancestor links cannot turn an existing skill into an external write",async()=>{
 const folder=await local();const summary=(await listSkills())[0]!;const original=await readSkill(summary.id);
 const external=path.join(directory,"external");await fs.mkdir(external);await fs.writeFile(path.join(external,"SKILL.md"),"Keep external");
 await fs.rename(folder,folder+"-old");await fs.symlink(external,folder);
 await assert.rejects(saveSkill(summary.id,"Overwrite",original.revision!),/skill_read_only/);
 assert.equal(await fs.readFile(path.join(external,"SKILL.md"),"utf8"),"Keep external");
});
test("invalid text and deep catalogs fail visibly",async()=>{
 const folder=await local();const id=(await listSkills())[0]!.id;
 await fs.writeFile(path.join(folder,"SKILL.md"),Buffer.from([0xff,0xfe]));await assert.rejects(readSkill(id),/skill_invalid_text/);
 await fs.mkdir(path.join(directory,"skills","a","b","c","d","e"),{recursive:true});
 await assert.rejects(listSkills(),/skills_too_deep/);
});
