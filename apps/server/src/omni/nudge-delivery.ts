import { apnsEnabled,countLiveApnsTokens,sendApnsToOwner } from "../apns";
import { omniConfig } from "./config";
import { attentionNotificationBody } from "./attention-preferences";
import { claimNudgePush,claimNudgeDigest,nudgeDeliveryDecision,finishNudgePush,listNudges,getNudge,type Nudge } from "./nudges";
import { nudgeAlert,digestAlert } from "./push-text";
import { resolveNote } from "./records";
/**
 * Lock-screen wording follows each device's preview setting (push-text.ts): `generic` shows
 * only the fixed sentence; `title` a headline; `title_preview` (Omni's default) the headline
 * and a short plain summary. Policy — quiet hours, the digest slots and the 2-surface cap —
 * is decided before any wording (nudges.ts / nudge-policy.ts) and is unchanged by it.
 */
async function senderName(n:Nudge|null):Promise<string|null>{
 const id=n?.candidate.senderId;if(!id)return null;
 try{const p=await resolveNote({id});return p&&!p.trashed?p.title??null:null;}catch{return null;}
}
export async function deliverNudges(now=Date.now()):Promise<void> {
 const owner=omniConfig.ownerEmail();
 if(!omniConfig.enabled()||!apnsEnabled()||!countLiveApnsTokens(owner,"omni"))return;
 for(const n of listNudges(owner,false,now)) {
  if(nudgeDeliveryDecision(owner,n.id,now)!=="now")continue;
  const claim=claimNudgePush(owner,n.id,now);if(claim===null)continue;
  try {
   const generic=attentionNotificationBody(owner),sender=await senderName(n);
   const result=await sendApnsToOwner(owner,row=>({payload:{aps:{alert:nudgeAlert(n,row.preview,generic,sender,now),sound:"default","interruption-level":"active",category:"OMNI_NUDGE","thread-id":"omni-nudges"},type:"omni",category:"OMNI_NUDGE",id:n.id,url:`omni://nudge/${n.id}`},collapseId:`omni-nudge-${n.id}`}),"omni");
   finishNudgePush(claim,result.sent>0?"sent":"failed");
  }catch{finishNudgePush(claim,"failed");}
 }
 const digest=claimNudgeDigest(owner,now);
 if(digest){
  let outcome:"sent"|"failed"="failed";
  try {
   // The eligible list is ranked (score, then recency): its first item is the top one.
   const top=digest.ids.length?getNudge(owner,digest.ids[0]!):null,generic=attentionNotificationBody(owner,digest.ids.length),sender=await senderName(top);
   const result=await sendApnsToOwner(owner,row=>({payload:{aps:{alert:digestAlert(digest.ids.length,top,row.preview,generic,sender,now),sound:"default","interruption-level":"active",category:"OMNI_NUDGE","thread-id":"omni-nudges"},type:"omni",category:"OMNI_NUDGE",ids:digest.ids.slice(0,50),count:digest.ids.length,url:"omni://nudge/digest"},collapseId:"omni-nudge-digest"}),"omni");outcome=result.sent>0?"sent":"failed";
  }catch{}
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
