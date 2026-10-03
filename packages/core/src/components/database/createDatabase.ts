import type { VaultClient } from "../../data/VaultClient";
import type { Note } from "../../lib/types";
import { defaultConfig } from "./config";

/**
 * Create a database page over `tag` (see ./config.ts for the model). Exported
 * for any "new page" surface: `createDatabaseNote(client, "task", "Projects/Launch plan")`.
 */
export async function createDatabaseNote(client: VaultClient, tag: string, path: string, description = ""): Promise<Note> {
  return client.createNote({
    content: description,
    path,
    metadata: { prism_type: "database", title: path.split("/").pop() || tag, prism_database: defaultConfig(tag) },
  });
}
