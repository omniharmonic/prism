/** Durable reservation: an uncertain Hermes POST must never be repeated automatically. */
import { db } from "../db";
db.exec(`CREATE TABLE IF NOT EXISTS omni_job_creations (
 owner TEXT NOT NULL, idem_key TEXT NOT NULL, digest TEXT NOT NULL, thread_id TEXT NOT NULL,
 response TEXT, status INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY(owner, idem_key)
)`);
export function reserveJobCreation(owner: string, key: string, digest: string, threadId: string) {
  const inserted = db.prepare("INSERT OR IGNORE INTO omni_job_creations(owner,idem_key,digest,thread_id,created_at) VALUES(?,?,?,?,?)").run(owner,key,digest,threadId,Date.now()).changes === 1;
  const row = db.prepare("SELECT digest,thread_id,response,status FROM omni_job_creations WHERE owner=? AND idem_key=?").get(owner,key) as {digest:string;thread_id:string;response:string|null;status:number|null};
  return { inserted, ...row };
}
export function finishJobCreation(owner: string,key:string,status:number,response:Record<string,unknown>) {
  db.prepare("UPDATE omni_job_creations SET status=?,response=? WHERE owner=? AND idem_key=?").run(status,JSON.stringify(response),owner,key);
}
export function resetJobCreationsForTests() { db.exec("DELETE FROM omni_job_creations"); }
