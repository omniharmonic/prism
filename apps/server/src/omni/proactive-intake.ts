/** Durable content-free wake admission; hourly reconciliation remains the repair path. */
import { db, resolveVaultEntry } from "../db";
import { subscribeTreeChanges, type TreeChange, type TreeRow } from "../tree";
import { omniConfig } from "./config";
db.exec(`CREATE TABLE IF NOT EXISTS omni_proactive_intake (vault_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, acknowledged INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL)`);
type Row={generation:number;acknowledged:number;first_at:number;last_at:number};
const relevant=(r:TreeRow|undefined)=>!!r && [r.type,r.prismType,...r.tags].some(t=>["email","message-thread","task","promise","commitment","meeting","transcript","trip"].includes((t??"").toLowerCase()));
export function recordProactiveIntake(vaultId:string,change:TreeChange,now=Date.now()):boolean {
 if(vaultId!==resolveVaultEntry(undefined).id)return false;
 if(change.kind!=="resync" && !relevant(change.prev) && !(change.kind==="upsert"&&relevant(change.row)))return false;
 if(change.kind==="upsert" && change.prev && change.row.updatedAt===change.prev.updatedAt && change.row.trashedAt===change.prev.trashedAt)return false;
 db.prepare(`INSERT INTO omni_proactive_intake VALUES(?,1,0,?,?) ON CONFLICT(vault_id) DO UPDATE SET generation=generation+1,first_at=CASE WHEN generation=acknowledged THEN excluded.first_at ELSE first_at END,last_at=excluded.last_at`).run(vaultId,now,now);
 return true;
}
export function proactiveIntake(now=Date.now()):{generation:number;pending:boolean;readyAt:number|null} {
 const r=db.prepare("SELECT * FROM omni_proactive_intake WHERE vault_id=?").get(resolveVaultEntry(undefined).id) as Row|undefined;
 const pending=!!r&&r.generation>r.acknowledged;
 return {generation:r?.generation??0,pending,readyAt:pending?Math.min(r!.last_at+120000,r!.first_at+300000):null};
}
export function acknowledgeProactiveIntake(generation:unknown):boolean {
 if(typeof generation!=="number"||!Number.isSafeInteger(generation)||generation<1)throw new Error("invalid_generation");
 return db.prepare("UPDATE omni_proactive_intake SET acknowledged=? WHERE vault_id=? AND generation=? AND acknowledged<?").run(generation,resolveVaultEntry(undefined).id,generation,generation).changes===1;
}
let starting=false;let subscribed=false;let retry:ReturnType<typeof setTimeout>|undefined;
export function startProactiveIntake():void {
 if(!omniConfig.enabled()||starting||subscribed)return;
 starting=true;
 const entry=resolveVaultEntry(undefined);
 void subscribeTreeChanges(entry,c=>recordProactiveIntake(entry.id,c)).then(()=>{
  subscribed=true;recordProactiveIntake(entry.id,{kind:"resync"});
 }).catch(()=>{retry=setTimeout(()=>startProactiveIntake(),30000);retry.unref();}).finally(()=>{starting=false;});
}
