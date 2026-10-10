import { apnsEnabled,countLiveApnsTokens,sendApnsToOwner } from "../apns";
import { omniConfig } from "./config";
import { claimNudgePush,claimNudgeDigest,nudgeDeliveryDecision,finishNudgePush,listNudges } from "./nudges";
/** IDs only on lock screen; content is fetched through the owner-authenticated queue. */
export async function deliverNudges(now=Date.now()):Promise<void> {
 const owner=omniConfig.ownerEmail();
 if(!omniConfig.enabled()||!apnsEnabled()||!countLiveApnsTokens(owner,"omni"))return;
 for(const n of listNudges(owner,false,now)) {
  if(nudgeDeliveryDecision(owner,n.id,now)!=="now")continue;
  const claim=claimNudgePush(owner,n.id,now);if(claim===null)continue;
  try {
   const result=await sendApnsToOwner(owner,{payload:{aps:{alert:{title:"Omni",body:"An item needs your attention"},sound:"default","interruption-level":"active",category:"OMNI_NUDGE","thread-id":"omni-nudges"},type:"omni",category:"OMNI_NUDGE",id:n.id,url:`omni://nudge/${n.id}`},collapseId:`omni-nudge-${n.id}`},"omni");
   finishNudgePush(claim,result.sent>0?"sent":"failed");
  }catch{finishNudgePush(claim,"failed");}
 }
 const digest=claimNudgeDigest(owner,now);
 if(digest){
  let outcome:"sent"|"failed"="failed";
  try {const result=await sendApnsToOwner(owner,{payload:{aps:{alert:{title:"Omni",body:"Your attention digest is ready"},sound:"default","interruption-level":"active",category:"OMNI_NUDGE","thread-id":"omni-nudges"},type:"omni",category:"OMNI_NUDGE",ids:digest.ids.slice(0,50),count:digest.ids.length,url:"omni://nudge/digest"},collapseId:"omni-nudge-digest"},"omni");outcome=result.sent>0?"sent":"failed";}catch{}
  for(const claim of digest.claims)finishNudgePush(claim,outcome);
 }

}
let timer:ReturnType<typeof setInterval>|null=null;
let running=false;
export function startNudgeDelivery():void {
 if(timer)return;
 timer=setInterval(()=>{if(running)return;running=true;void deliverNudges().catch(()=>console.error("[omni] nudge delivery failed")).finally(()=>{running=false;});},60_000);
 timer.unref();
}
