/**
 * A tiny in-memory vault for the folder/database sync tests (injected through
 * the services' test seams — no global fetch stub). Honours path_prefix, tags,
 * if_updated_at (409) and path conflicts on create (409), like Parachute 0.7.9.
 */
import type { Note } from "../src/parachute";
import { VaultConflictError } from "../src/parachute";

let clock = Date.parse("2026-09-01T00:00:00.000Z");
export const tick = (): string => new Date((clock += 1000)).toISOString();

export class FakeSyncVault {
  notes = new Map<string, Note>();
  writes: Array<{ op: "create" | "update"; id: string; body: unknown }> = [];
  private seq = 0;

  put(n: Partial<Note> & { id: string }): Note {
    const note: Note = { content: "", path: null, metadata: null, tags: [], createdAt: tick(), updatedAt: tick(), ...n };
    this.notes.set(note.id, note);
    return note;
  }

  async listNotes(opts: { pathPrefix?: string; tags?: string[]; includeContent?: boolean } = {}): Promise<Note[]> {
    let list = [...this.notes.values()];
    if (opts.pathPrefix) list = list.filter((n) => (n.path ?? "").startsWith(opts.pathPrefix!));
    for (const t of opts.tags ?? []) list = list.filter((n) => (n.tags ?? []).includes(t));
    return list.map((n) => (opts.includeContent ? { ...n } : { ...n, content: "" }));
  }

  async getNote(id: string): Promise<Note> {
    const n = this.notes.get(id);
    if (!n) throw new Error(`GET /notes/${id}: 404`);
    return { ...n };
  }

  async createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note> {
    if (p.path && [...this.notes.values()].some((n) => n.path === p.path)) throw new VaultConflictError(409, { error: "path_conflict" }, "POST /notes: 409");
    const n = this.put({ id: `v-${++this.seq}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? [] });
    this.writes.push({ op: "create", id: n.id, body: p });
    return { ...n };
  }

  async updateNote(id: string, p: { content?: string; metadata?: Record<string, unknown>; ifUpdatedAt?: string }): Promise<Note> {
    const n = this.notes.get(id);
    if (!n) throw new Error(`PATCH /notes/${id}: 404`);
    if (p.ifUpdatedAt && p.ifUpdatedAt !== n.updatedAt) throw new VaultConflictError(409, { error: "conflict" }, `PATCH /notes/${id}: 409`);
    if (p.content !== undefined) n.content = p.content;
    if (p.metadata) n.metadata = { ...(n.metadata ?? {}), ...p.metadata }; // RFC 7386 merge (flat)
    n.updatedAt = tick();
    this.writes.push({ op: "update", id, body: p });
    return { ...n };
  }
}
