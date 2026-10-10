import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reviewedNudgeJob} from '../src/omni/reviewed-jobs';
test('only exact reviewed local wrappers are manageable, mutations and links fail closed',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reviewed-jobs-')));const prior=process.env.OMNI_REVIEWED_JOB_SCRIPTS_DIR;process.env.OMNI_REVIEWED_JOB_SCRIPTS_DIR=root;
 try{
  for(const name of ['sweep','context','audit']){
   const script=`omni-nudges-${name}.sh`;const bytes=await fs.readFile(new URL(`./fixtures/reviewed-nudge-jobs/${script}`,import.meta.url));await fs.writeFile(path.join(root,script),bytes);
   const job={deliver:'local',no_agent:true,script};assert.equal(await reviewedNudgeJob(job),true);
   for(const change of [{deliver:'origin'},{no_agent:false},{monitor_script:'anything'},{monitor:{}},{script:'../'+script},{script:'omni-sweep.sh'}]) assert.equal(await reviewedNudgeJob({...job,...change}),false);
   await fs.appendFile(path.join(root,script),'# changed');assert.equal(await reviewedNudgeJob(job),false);
   await fs.unlink(path.join(root,script));await fs.writeFile(path.join(root,script+'.real'),bytes);await fs.symlink(script+'.real',path.join(root,script));assert.equal(await reviewedNudgeJob(job),false);
  }
  delete process.env.OMNI_REVIEWED_JOB_SCRIPTS_DIR;assert.equal(await reviewedNudgeJob({deliver:'local',no_agent:true,script:'omni-nudges-sweep.sh'}),false);
 }finally{if(prior===undefined)delete process.env.OMNI_REVIEWED_JOB_SCRIPTS_DIR;else process.env.OMNI_REVIEWED_JOB_SCRIPTS_DIR=prior;await fs.rm(root,{recursive:true,force:true});}
});
