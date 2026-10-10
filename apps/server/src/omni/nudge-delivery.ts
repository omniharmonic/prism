import { apnsEnabled,countLiveApnsTokens,sendApnsToOwner } from "../apns";
import { omniConfig } from "./config";
import { claimNudgePush,finishNudgePush,listNudges } from "./nudges";
/** IDs only on lock screen; content is fetched through the owner-authenticated queue. */
export async function deliverNudges(now=Date.now()):Promise<void> {
 const owner=omniConfig.ownerEmail();
 if(!omniConfig.enabled()||!apnsEnabled()||!countLiveApnsTokens(owner,"omni"))return;
 for(const n of listNudges(owner,false,now)) {
  const claim=claimNudgePush(owner,n.id,now);if(claim===null)continue;
  try {
   const result=await sendApnsToOwner(owner,{payload:{aps:{alert:{title:"Omni",body:"An item needs your attention"},sound:"default","interruption-level":"active",category:"OMNI_NUDGE","thread-id":"omni-nudges"},type:"omni",category:"OMNI_NUDGE",id:n.id,url:`omni://nudge/${n.id}`},collapseId:`omni-nudge-${n.id}`},"omni");
   finishNudgePush(claim,result.sent>0?"sent":"failed");
  }catch{finishNudgePush(claim,"failed");}
 }
}
let timer:ReturnType<typeof setInterval>|null=null;
let running=false;
export function startNudgeDelivery():void {
 if(timer)return;
 timer=setInterval(()=>{if(running)return;running=true;void deliverNudges().catch(()=>console.error("[omni] nudge delivery failed")).finally(()=>{running=false;});},60_000);
 timer.unref();
}
