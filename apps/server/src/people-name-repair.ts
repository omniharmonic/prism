// The person-name repair (scripts/people-names.ts): a person note with NO metadata.name gets
// metadata.name = the name its body's heading gives (person-name.ts) — never metadata.title (this
// vault keeps job titles there), never a body write, never a name taken from the path alone.
// Compare-and-set, each write read back to verify, paced; the undo log gets an "intent" entry BEFORE
// each write and is completed after it, so a crash between the two still leaves an undo record.
// Undo removes the name only while the note still holds exactly what the repair wrote.
import fs from "node:fs";
import { VaultConflictError, VaultError, type Note } from "./parachute";
import { assessPersonName } from "./person-name";
import { isNonHumanPerson, isTombstone, mergedIntoRef } from "./identity";
import { declaredViolations, shapeViolations } from "./vault-shapes";

export interface NameVault {
  listNotes(o: { tags?: string[]; includeContent?: boolean; includeMetadata?: string[] }): Promise<Note[]>;
  getNote(id: string, o?: { includeContent?: boolean; includeMetadata?: string[] }): Promise<Note>;
  updateNote(id: string, p: { metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note>;
}

export const NAME_REPAIR_METADATA = ["name", "type", "status", "merged_into", "mergedInto", "superseded_by"];

export interface NameRepairEntry { id: string; written: string; state: "intent" | "written"; updatedAt: string | null }
export interface NameRepairLog { batchId: string; vaultId: string; at: string; entries: NameRepairEntry[] }

/**
 * Person notes, their problems, and the ones a repair would write (live humans only). A note with no
 * name is read once WITH its body (paced) so only a real heading counts — never the vault's
 * displayTitle, which for a body without a heading is just its first line of prose (re-review N1).
 */
export async function surveyNames(vault: NameVault, o: { paceMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ notes: Note[]; problems: Map<string, string[]>; todo: Array<{ note: Note; name: string }> }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notes = (await vault.listNotes({ tags: ["person"], includeContent: false, includeMetadata: NAME_REPAIR_METADATA }))
    .filter((n) => (n.tags ?? []).includes("person"));
  const problems = new Map<string, string[]>();
  const todo: Array<{ note: Note; name: string }> = [];
  for (const n of notes) {
    const lean = assessPersonName({ ...n, content: null });
    for (const p of lean.problems) problems.set(p, [...(problems.get(p) ?? []), n.id]);
    const nameless = !(typeof n.metadata?.name === "string" && n.metadata.name.trim());
    if (!nameless || isTombstone(n) || mergedIntoRef(n) !== null || isNonHumanPerson(n)) continue;
    await sleep(o.paceMs ?? 0);
    let full: Note;
    try { full = await vault.getNote(n.id, { includeContent: true, includeMetadata: ["name"] }); } catch { continue; }
    const a = assessPersonName({ ...n, content: full.content ?? "", displayTitle: null });
    if (a.repairName) todo.push({ note: n, name: a.repairName });
  }
  return { notes, problems, todo };
}

export async function applyNameRepair(
  vault: NameVault, todo: Array<{ note: Note; name: string }>, log: NameRepairLog,
  o: { save: (log: NameRepairLog) => void; paceMs: number; sleep?: (ms: number) => Promise<void>; limit?: number },
): Promise<{ written: number; changed: number; shape: number; unverified: number; failed: number }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out = { written: 0, changed: 0, shape: 0, unverified: 0, failed: 0 };
  for (const { note, name } of todo.slice(0, o.limit ?? todo.length)) {
    const patch = { name };
    if (shapeViolations(patch, "person").length || declaredViolations(patch, "person").length) { out.shape++; continue; }
    await sleep(o.paceMs);
    try {
      // Fresh read: still no name? (the listing may be minutes old)
      const cur = await vault.getNote(note.id, { includeContent: false, includeMetadata: ["name"] });
      if (!cur.updatedAt || (typeof cur.metadata?.name === "string" && cur.metadata.name.trim())) { out.changed++; continue; }
      const entry: NameRepairEntry = { id: note.id, written: name, state: "intent", updatedAt: null };
      log.entries.push(entry);
      o.save(log); // intent BEFORE the write (review M8)
      const updated = await vault.updateNote(note.id, { metadata: patch, ifUpdatedAt: cur.updatedAt });
      const check = await vault.getNote(note.id, { includeContent: false, includeMetadata: ["name"] });
      entry.state = "written";
      entry.updatedAt = updated.updatedAt ?? null;
      o.save(log);
      if (check.metadata?.name === name) out.written++;
      else out.unverified++;
    } catch (err) {
      if (err instanceof VaultConflictError) out.changed++;
      else out.failed++;
    }
  }
  return out;
}

export async function undoNameRepair(vault: NameVault, log: NameRepairLog, o: { paceMs: number; sleep?: (ms: number) => Promise<void> }): Promise<{ restored: number; changed: number; missing: number; failed: number }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out = { restored: 0, changed: 0, missing: 0, failed: 0 };
  for (const e of log.entries) {
    await sleep(o.paceMs);
    try {
      const cur = await vault.getNote(e.id, { includeContent: false, includeMetadata: ["name"] });
      if (cur.metadata?.name !== e.written || !cur.updatedAt) { if (e.state === "written") out.changed++; continue; } // an intent that never landed: nothing to do
      await vault.updateNote(e.id, { metadata: { name: null }, ifUpdatedAt: cur.updatedAt });
      out.restored++;
    } catch (err) {
      if (err instanceof VaultConflictError) out.changed++;
      else if (err instanceof VaultError && err.status === 404) out.missing++;
      else out.failed++;
    }
  }
  return out;
}

export const readRepairLog = (file: string): NameRepairLog => JSON.parse(fs.readFileSync(file, "utf8")) as NameRepairLog;
