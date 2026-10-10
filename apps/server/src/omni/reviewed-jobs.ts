/** Only these reviewed local nudge wrappers may bypass agent-job routing checks. */
import {promises as fs,constants} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
const PINS:Record<string,string>={
 "omni-nudges-sweep.sh":"7511e15e7c51f54c9e5bcb6d5e13d9d25b289facd4bd5340947a195f25ce8c8b",
 "omni-nudges-context.sh":"418a3fb822d389b30152bd3481616ee8f326d4f0eff1cc123389401d34903f91",
 "omni-nudges-audit.sh":"15dd47cab26389f6b31522955a8c7427a01b5bcd538189860a33279f2891f308",
};
export async function reviewedNudgeJob(job:Record<string,unknown>):Promise<boolean>{
 if(job.deliver!=="local"||job.no_agent!==true||job.monitor||job.monitor_script||job.monitor_url||typeof job.script!=="string"||!Object.hasOwn(PINS,job.script)) return false;
 const root=process.env.OMNI_REVIEWED_JOB_SCRIPTS_DIR;
 if(!root||!path.isAbsolute(root)) return false;
 try {
  const directory=path.resolve(root);
  let ancestor=path.parse(directory).root;
  for(const part of directory.slice(ancestor.length).split(path.sep)){ancestor=path.join(ancestor,part);const entry=await fs.lstat(ancestor);if(entry.isSymbolicLink()||!entry.isDirectory())return false;}
  const before=await fs.lstat(directory);
  if(!before.isDirectory()||before.isSymbolicLink()) return false;
  const filename=path.join(directory,job.script);const metadata=await fs.lstat(filename);
  if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>16384) return false;
  const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
   const stat=await handle.stat();if(stat.dev!==metadata.dev||stat.ino!==metadata.ino||!stat.isFile())return false;
   const buffer=Buffer.alloc(16385);let count=0;
   while(count<buffer.length){const read=await handle.read(buffer,count,buffer.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
   if(count>16384)return false;
   const after=await handle.stat();const current=await fs.lstat(filename);const parent=await fs.lstat(directory);
   if(after.mtimeMs!==stat.mtimeMs||after.size!==stat.size||current.isSymbolicLink()||current.dev!==stat.dev||current.ino!==stat.ino||parent.dev!==before.dev||parent.ino!==before.ino)return false;
   return createHash("sha256").update(buffer.subarray(0,count)).digest("hex")===PINS[job.script];
  }finally{await handle.close();}
 }catch{return false;}
}
