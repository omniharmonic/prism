/** Owner-local nudge ledger. Source uniqueness and push claims survive restarts. No outward actions here. */
import { db } from "../db";
import { omniConfig } from "./config";
import { newId } from "./store";
import { consequenceScore, interruptDecision, type Dial, type InterruptContext, type NudgePolicyInput } from "./nudge-policy";

db.exec(`
CREATE TABLE IF NOT EXISTS omni_nudges (
 id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, source_id TEXT NOT NULL, candidate TEXT NOT NULL,
 score REAL NOT NULL, priority REAL NOT NULL, deadline INTEGER, urgent_at INTEGER,
 surfaces INTEGER NOT NULL DEFAULT 0, last_surface_at INTEGER, snoozed_until INTEGER,
 dismissed INTEGER NOT NULL DEFAULT 0, thread_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(owner_email,source_id)
);
CREATE INDEX IF NOT EXISTS omni_nudges_queue ON omni_nudges(owner_email,dismissed,updated_at);
CREATE TABLE IF NOT EXISTS omni_nudge_settings (
 owner_email TEXT PRIMARY KEY, dial TEXT NOT NULL DEFAULT 'balanced', killed INTEGER NOT NULL DEFAULT 0,
 context TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS omni_feedback (
 id INTEGER PRIMARY KEY AUTOINCREMENT, owner_email TEXT NOT NULL, nudge_id TEXT NOT NULL,
 source_id TEXT NOT NULL, sender_id TEXT, kind TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS omni_feedback_owner ON omni_feedback(owner_email,ts);
CREATE TABLE IF NOT EXISTS omni_nudge_pushes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, owner_email TEXT NOT NULL, nudge_id TEXT NOT NULL,
 ts INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT 'claimed'
);
CREATE INDEX IF NOT EXISTS omni_nudge_pushes_rate ON omni_nudge_pushes(owner_email,ts);
`);
export const NUDGE_KINDS = ["reply-owed", "unprocessed", "task", "commitment", "meeting", "job", "freshness"] as const;
export interface Candidate {
 sourceId: string; kind: typeof NUDGE_KINDS[number]; title: string; summary: string; reasons: string[];
 sourcePath: string; senderId: string | null; baseScore: number; priority: number;
 deadline: number | null; urgentAt: number | null; commitment: boolean;
}
interface Raw { id: string; owner_email: string; source_id: string; candidate: string; score: number; priority: number; deadline: number | null; urgent_at: number | null; surfaces: number; last_surface_at: number | null; snoozed_until: number | null; dismissed: number; thread_id: string | null; created_at: number; updated_at: number }
export interface Nudge extends NudgePolicyInput { sourceLink: string; id: string; candidate: Candidate; threadId: string | null; createdAt: number; updatedAt: number }
const view = (r: Raw): Nudge => ({ sourceLink:`${omniConfig.appOrigin()}/page/${encodeURIComponent(r.source_id)}`, id:r.id, candidate:JSON.parse(r.candidate), score:r.score, priority:r.priority, deadline:r.deadline, urgentAt:r.urgent_at, surfaces:r.surfaces, lastSurfaceAt:r.last_surface_at, snoozedUntil:r.snoozed_until, dismissed:!!r.dismissed, threadId:r.thread_id, createdAt:r.created_at, updatedAt:r.updated_at });
export function getNudge(owner: string, id: string): Nudge | null { const r=db.prepare("SELECT * FROM omni_nudges WHERE owner_email=? AND id=?").get(owner,id) as Raw|undefined; return r?view(r):null; }
export function listNudges(owner: string, later=false, now=Date.now()): Nudge[] {
 const state = later ? "(dismissed=1 OR surfaces>=2 OR COALESCE(snoozed_until,0)>?)" : "dismissed=0 AND surfaces<2 AND COALESCE(snoozed_until,0)<=?";
 return (db.prepare(`SELECT * FROM omni_nudges WHERE owner_email=? AND ${state} ORDER BY score DESC,updated_at DESC,id LIMIT 200`).all(owner,now) as Raw[]).map(view);
}
export function nudgeSettings(owner: string): { dial: Dial; killed: boolean; context: InterruptContext|null } {
 const r=db.prepare("SELECT * FROM omni_nudge_settings WHERE owner_email=?").get(owner) as {dial:Dial;killed:number;context:string|null}|undefined;
 return r?{dial:r.dial,killed:!!r.killed,context:r.context?JSON.parse(r.context):null}:{dial:"balanced",killed:false,context:null};
}
export function setNudgeSettings(owner: string, patch: Partial<{dial:Dial;killed:boolean;context:InterruptContext}>, now=Date.now()): void {
 const s={...nudgeSettings(owner),...patch};db.prepare("INSERT INTO omni_nudge_settings(owner_email,dial,killed,context,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_email) DO UPDATE SET dial=excluded.dial,killed=excluded.killed,context=excluded.context,updated_at=excluded.updated_at").run(owner,s.dial,+s.killed,s.context?JSON.stringify(s.context):null,now);
}
export const upsertNudge = db.transaction((owner: string, c: Candidate, now=Date.now()): Nudge => {
 const old=db.prepare("SELECT * FROM omni_nudges WHERE owner_email=? AND source_id=?").get(owner,c.sourceId) as Raw|undefined;
 const count=(db.prepare("SELECT count(*) n FROM omni_feedback WHERE owner_email=? AND kind='noise' AND (source_id=? OR (sender_id IS NOT NULL AND sender_id=?)) AND ts>?").get(owner,c.sourceId,c.senderId,now-90*86_400_000) as {n:number}).n;
 const relevant=(db.prepare("SELECT count(*) n FROM omni_feedback WHERE owner_email=? AND kind='relevant' AND (source_id=? OR (sender_id IS NOT NULL AND sender_id=?)) AND ts>?").get(owner,c.sourceId,c.senderId,now-90*86_400_000) as {n:number}).n;
 const score=consequenceScore(c.baseScore,c.deadline,c.commitment,Math.min(.3,count*.05)-Math.min(.1,relevant*.02),now);
 const id=old?.id??newId("nud");
 db.prepare("INSERT INTO omni_nudges(id,owner_email,source_id,candidate,score,priority,deadline,urgent_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_email,source_id) DO UPDATE SET candidate=excluded.candidate,score=excluded.score,priority=excluded.priority,deadline=excluded.deadline,urgent_at=excluded.urgent_at,updated_at=excluded.updated_at").run(id,owner,c.sourceId,JSON.stringify(c),score,c.priority,c.deadline,c.urgentAt,now,now);
 return getNudge(owner,id)!;
});
export function nudgeAction(owner:string,id:string,action:"noise"|"relevant"|"dismiss"|"snooze",until:number|null=null,now=Date.now()):Nudge|null {
 const n=getNudge(owner,id);if(!n)return null;
 if(action==="snooze")db.prepare("UPDATE omni_nudges SET snoozed_until=?,updated_at=? WHERE owner_email=? AND id=?").run(until,now,owner,id);
 else if(action==="relevant")db.prepare("UPDATE omni_nudges SET dismissed=0,updated_at=? WHERE owner_email=? AND id=?").run(now,owner,id);
 else db.prepare("UPDATE omni_nudges SET dismissed=1,updated_at=? WHERE owner_email=? AND id=?").run(now,owner,id);
 db.prepare("INSERT INTO omni_feedback(owner_email,nudge_id,source_id,sender_id,kind,ts) VALUES(?,?,?,?,?,?)").run(owner,id,n.candidate.sourceId,n.candidate.senderId,action,now);
 return getNudge(owner,id);
}
export function bindNudgeThread(owner:string,id:string,threadId:string):void { db.prepare("UPDATE omni_nudges SET thread_id=? WHERE owner_email=? AND id=? AND thread_id IS NULL").run(threadId,owner,id); }
/** Claim under SQLite transaction BEFORE transport; delivery uncertainty never permits more than two interrupts. */
export const claimNudgePush = db.transaction((owner:string,id:string,now=Date.now()):number|null=>{
 const n=getNudge(owner,id);if(!n)return null;const s=nudgeSettings(owner);
 const count=(db.prepare("SELECT count(*) n FROM omni_nudge_pushes WHERE owner_email=? AND ts>?").get(owner,now-3_600_000) as {n:number}).n;
 const decision=interruptDecision(n,s.context,s.dial,s.killed,count,now);
 if(decision!=="now"&&decision!=="digest")return null;
 db.prepare("UPDATE omni_nudges SET surfaces=surfaces+1,last_surface_at=? WHERE owner_email=? AND id=?").run(now,owner,id);
 return Number(db.prepare("INSERT INTO omni_nudge_pushes(owner_email,nudge_id,ts) VALUES(?,?,?)").run(owner,id,now).lastInsertRowid);
});
export function finishNudgePush(claim:number,outcome:"sent"|"failed"):void {db.prepare("UPDATE omni_nudge_pushes SET outcome=? WHERE id=?").run(outcome,claim);}
export function resetNudgesForTests():void {db.exec("DELETE FROM omni_nudges;DELETE FROM omni_nudge_settings;DELETE FROM omni_feedback;DELETE FROM omni_nudge_pushes;");}
