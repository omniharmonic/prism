/** Bounded owner attention preferences mirrored from the internal management ledger. */
import { db } from "../db";
import { canonicalJson } from "./approvals";
export interface AttentionPreferences {notification_style?:"concise"|"detailed";deadline_only?:boolean;quiet_hours?:string}
db.exec(`CREATE TABLE IF NOT EXISTS omni_attention_preferences(owner_email TEXT PRIMARY KEY,version INTEGER NOT NULL,preferences TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
export class AttentionPreferenceError extends Error {constructor(public code:string,public status:400|409){super(code);}}
export function validateAttentionPreferences(value:unknown):AttentionPreferences {
 if(!value||typeof value!=="object"||Array.isArray(value))throw new AttentionPreferenceError("invalid_preferences",400);
 const b=value as Record<string,unknown>;
 if(Object.keys(b).some(k=>!["notification_style","deadline_only","quiet_hours"].includes(k))||b.notification_style!==undefined&&!["concise","detailed"].includes(b.notification_style as string)||b.deadline_only!==undefined&&typeof b.deadline_only!=="boolean"||b.quiet_hours!==undefined&&(typeof b.quiet_hours!=="string"||! /^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(b.quiet_hours)))throw new AttentionPreferenceError("invalid_preferences",400);
 return b as AttentionPreferences;
}
export function attentionPreferences(owner:string):AttentionPreferences {
 const row=db.prepare("SELECT preferences FROM omni_attention_preferences WHERE owner_email=?").get(owner) as {preferences:string}|undefined;
 return row?JSON.parse(row.preferences):{};
}
export const syncAttentionPreferences=db.transaction((owner:string,version:unknown,value:unknown):{version:number;preferences:AttentionPreferences;replayed:boolean}=>{
 if(typeof version!=="number"||!Number.isSafeInteger(version)||version<0)throw new AttentionPreferenceError("invalid_preference_version",400);
 const preferences=validateAttentionPreferences(value),encoded=canonicalJson(preferences);
 const old=db.prepare("SELECT version,preferences FROM omni_attention_preferences WHERE owner_email=?").get(owner) as {version:number;preferences:string}|undefined;
 if(old&&version<old.version)throw new AttentionPreferenceError("stale_preference_version",409);
 if(old&&version===old.version){if(old.preferences!==encoded)throw new AttentionPreferenceError("preference_version_conflict",409);return {version,preferences,replayed:true};}
 db.prepare("INSERT INTO omni_attention_preferences VALUES(?,?,?,?) ON CONFLICT(owner_email) DO UPDATE SET version=excluded.version,preferences=excluded.preferences,updated_at=excluded.updated_at").run(owner,version,encoded,Date.now());
 return {version,preferences,replayed:false};
});
/** Notification style changes generic wording only, never private lock-screen content. */
export function attentionNotificationBody(owner:string,digestCount?:number):string {
 const detailed=attentionPreferences(owner).notification_style==="detailed";
 if(digestCount!==undefined)return detailed?`Your attention digest has ${digestCount} prepared items to review in Omni.`:"Your attention digest is ready";
 return detailed?"Omni prepared an update. Open it to review the source and next step.":"An item needs your attention";
}
