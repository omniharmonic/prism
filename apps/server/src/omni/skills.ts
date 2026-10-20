/** Owner-only SKILL.md editor. Local filesystem administrators remain trusted. */
import { promises as fs, constants, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const SKILL_CAP = 64 * 1024;
const inside = (root: string, file: string) => file.startsWith(root + path.sep);
export class SkillError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
export interface SkillRecord { id: string; name: string; location: string; editable: boolean; reason?: string; revision?: string; text?: string }
type Item = {relative:string;filename:string};
type Chain = {filename:string;stat:Stats}[];
const same = (a: Stats,b: Stats) => a.dev===b.dev && a.ino===b.ino;
async function configuredRoot() {
 const value=process.env.OMNI_SKILLS_DIR;
 if(!value || !path.isAbsolute(value)) throw new SkillError("skills_not_configured",503);
 try { const real=await fs.realpath(value); if(!(await fs.stat(real)).isDirectory()) throw new Error(); return real; }
 catch { throw new SkillError("skills_not_configured",503); }
}
async function chain(base:string,filename:string):Promise<Chain> {
 if(!inside(base,filename)) throw new SkillError("skill_read_only",403);
 let cursor=base; const result:Chain=[];
 for(const segment of ["",...path.relative(base,filename).split(path.sep)]) {
  cursor=segment?path.join(cursor,segment):cursor;
  const stat=await fs.lstat(cursor);
  if(stat.isSymbolicLink()) throw new SkillError("skill_read_only",403);
  result.push({filename:cursor,stat});
 }
 if(!result.at(-1)!.stat.isFile()) throw new SkillError("skill_read_only",403);
 return result;
}
async function unchanged(snapshot:Chain) {
 for(const entry of snapshot) { const current=await fs.lstat(entry.filename); if(current.isSymbolicLink() || !same(current,entry.stat)) throw new SkillError("skill_revision_conflict",409); }
}
async function entries() {
 const base=await configuredRoot(); const files:Item[]=[]; let visited=0;
 const rootStat=await fs.lstat(base);
 async function scan(dir:string,depth:number) {
  if(depth>4) throw new SkillError("skills_too_deep",413);
  if(++visited>500) throw new SkillError("skills_too_many",413);
  const before=await fs.lstat(dir); if(!before.isDirectory() || before.isSymbolicLink()) return;
  const children=await fs.readdir(dir,{withFileTypes:true});
  const after=await fs.lstat(dir); if(!same(before,after)||after.isSymbolicLink()) throw new SkillError("skills_changed",409);
  for(const item of children.sort((a,b)=>a.name.localeCompare(b.name))) {
   if(item.name.startsWith(".")) continue;
   const filename=path.join(dir,item.name);
   if(item.name==="SKILL.md") files.push({relative:path.relative(base,filename),filename});
   else if(item.isDirectory()) await scan(filename,depth+1);
   else if(item.isSymbolicLink()) {
    const candidate=path.join(filename,"SKILL.md");
    try { if((await fs.stat(candidate)).isFile()) files.push({relative:path.relative(base,candidate),filename:candidate}); } catch { /* broken link */ }
   }
   if(files.length>500) throw new SkillError("skills_too_many",413);
  }
 }
 await scan(base,0);
 if(!same(rootStat,await fs.lstat(base))) throw new SkillError("skills_changed",409);
 return {base,files};
}
async function boundedRead(filename:string,snapshot:Chain) {
 await unchanged(snapshot);
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const stat=await handle.stat(); if(!same(stat,snapshot.at(-1)!.stat)||!stat.isFile()) throw new SkillError("skill_revision_conflict",409);
  if(stat.size>SKILL_CAP) throw new SkillError("skill_too_large",413);
  const buffer=Buffer.alloc(SKILL_CAP+1); let count=0;
  while(count<buffer.length) { const read=await handle.read(buffer,count,buffer.length-count,count); if(!read.bytesRead) break; count+=read.bytesRead; }
  if(count>SKILL_CAP) throw new SkillError("skill_too_large",413);
  const after=await handle.stat();
  if(stat.mtimeMs!==after.mtimeMs || stat.size!==after.size) throw new SkillError("skill_revision_conflict",409);
  await unchanged(snapshot); return buffer.subarray(0,count);
 } finally { await handle.close(); }
}
async function record(base:string,item:Item,detail:boolean):Promise<SkillRecord> {
 let editable=true; let snapshot:Chain|undefined;
 try { snapshot=await chain(base,item.filename); } catch(e) { if(e instanceof SkillError && e.status===403) editable=false; else throw e; }
 const result:SkillRecord={id:hash(item.relative).slice(0,32),name:path.basename(path.dirname(item.filename)),location:item.relative,editable};
 if(!editable) result.reason="Linked skill: edit its source repository instead.";
 if(!detail) return result;
 let filename=item.filename;
 if(!snapshot) {
  filename=await fs.realpath(item.filename);
  const roots=(process.env.OMNI_SKILLS_READ_ROOTS??"").split(path.delimiter).filter(r=>path.isAbsolute(r));
  let readRoot:string|undefined;
  for(const value of roots) { const real=await fs.realpath(value).catch(()=>null); if(real&&inside(real,filename)) {readRoot=real;break;} }
  if(!readRoot) { result.reason="Linked source is outside the configured readable roots."; return result; }
  snapshot=await chain(readRoot,filename);
 }
 const buffer=await boundedRead(filename,snapshot);
 try { result.text=new TextDecoder("utf-8",{fatal:true}).decode(buffer); } catch { throw new SkillError("skill_invalid_text",422); }
 result.revision=hash(buffer); return result;
}
async function lookup(id:string) {
 if(!/^[a-f0-9]{32}$/.test(id)) throw new SkillError("not_found",404);
 const {base,files}=await entries(); const matches=files.filter(f=>hash(f.relative).slice(0,32)===id);
 if(matches.length!==1) throw new SkillError("not_found",404);
 return {base,item:matches[0]!};
}
export async function listSkills():Promise<SkillRecord[]> { const {base,files}=await entries(); return Promise.all(files.map(f=>record(base,f,false))); }
export async function readSkill(id:string):Promise<SkillRecord> { const {base,item}=await lookup(id); return record(base,item,true); }
const saving=new Set<string>();
export async function saveSkill(id:string,text:string,revision:string):Promise<SkillRecord> {
 if(Buffer.byteLength(text)>SKILL_CAP) throw new SkillError("skill_too_large",413);
 if(!/^[a-f0-9]{64}$/.test(revision)) throw new SkillError("skill_revision_required",400);
 if(saving.has(id)) throw new SkillError("skill_revision_conflict",409);
 saving.add(id); let temporary:string|undefined;
 try {
  const {base,item}=await lookup(id); const snapshot=await chain(base,item.filename);
  const buffer=await boundedRead(item.filename,snapshot);
  if(hash(buffer)!==revision) throw new SkillError("skill_revision_conflict",409);
  temporary=path.join(path.dirname(item.filename),`.omni-skill-${randomBytes(12).toString("hex")}`);
  await unchanged(snapshot);
  const temp=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { await temp.writeFile(text,"utf8"); await temp.chmod(snapshot.at(-1)!.stat.mode&0o777); await temp.sync(); } finally {await temp.close();}
  await unchanged(snapshot);
  if(hash(await boundedRead(item.filename,snapshot))!==revision) throw new SkillError("skill_revision_conflict",409);
  await fs.rename(temporary,item.filename); temporary=undefined;
  return record(base,item,true);
 } finally {if(temporary) await fs.unlink(temporary).catch(()=>{});saving.delete(id);}
}
