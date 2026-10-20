/** Content-free source coverage for the proactive coordinator's primary vault only. */
import { resolveVaultEntry } from "../db";
import { getSourceHealth, type SourceHealth } from "../worker/health";
type Coverage=Pick<SourceHealth,"name"|"status"|"kind"|"lastSuccessAt"|"staleAfterMs">&{failureStreak:number;reconcileOwed:number;reconcileStuck:number};
const count=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
type Reader=()=>Promise<SourceHealth[]>;
let reader:Reader=()=>getSourceHealth();
export function setProactiveHealthReaderForTests(value:Reader|null):void {reader=value??(()=>getSourceHealth());}
export async function proactiveSourceHealth():Promise<{sources:Coverage[];checkedAt:string}> {
 const primary=resolveVaultEntry(undefined).id;
 const sources:Coverage[]=(await reader()).filter(source=>source.vaultId===primary).map(source=>{
  const owed=source.detail?.reconcileOwed??0,stuck=source.detail?.reconcileStuck??0;
  const valid=count(source.failureStreak)&&count(owed)&&count(stuck);
  return {name:source.name,status:valid?source.status:"failing",kind:source.kind,lastSuccessAt:source.lastSuccessAt,staleAfterMs:source.staleAfterMs,failureStreak:count(source.failureStreak)?source.failureStreak:0,reconcileOwed:count(owed)?owed:0,reconcileStuck:count(stuck)?stuck:0};
 });
 return {sources,checkedAt:new Date().toISOString()};
}
