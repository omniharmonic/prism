import { db, resolveVaultEntry } from "../db";
import { vaultClient, VaultError } from "../parachute";
import { getEmbedder } from "./embedder";
import { CHUNKER_ID } from "./migration";
import { indexNote, deindexNote } from "./service";
import { IndexJobs } from "./jobs";
import { config } from "../config";

export const indexJobs = new IndexJobs(db, {
  generation: () => ({ model: getEmbedder().id, chunker: CHUNKER_ID }),
  available: (id) => resolveVaultEntry(id).id === id,
  list: (id) => vaultClient(id).listNotes({ limit: 50_000 }),
  index: async (vaultId, noteId) => {
    let note;
    try { note = await vaultClient(vaultId).getNote(noteId); }
    catch (error) {
      if (error instanceof VaultError && error.status === 404) { deindexNote(noteId,vaultId); return "deleted"; }
      throw error;
    }
    return (await indexNote(noteId,note.content ?? "",false,vaultId)).status;
  },
}, config.dbPath !== ":memory:");
