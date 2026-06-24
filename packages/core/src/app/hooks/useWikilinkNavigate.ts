import { useCallback } from "react";
import { useNotes } from "./useParachute";
import { useUIStore } from "../stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";

/**
 * Resolve a wikilink target (a path, note name, or `path/to/note`) to a vault
 * note and open it in a tab. Shared by every in-app editor (DocumentRenderer +
 * the collaborative editors) so clicking `[[links]]` navigates consistently.
 *
 * Must be used inside the VaultClientProvider tree (it reads the notes list).
 * The full-page share route resolves links differently (see CollabPage).
 */
export function useWikilinkNavigate(): (target: string) => void {
  const openTab = useUIStore((s) => s.openTab);
  const { data: allNotes } = useNotes();

  return useCallback(
    (rawTarget: string) => {
      if (!allNotes) return;
      // Normalize both sides: links may carry a `vault/` prefix the stored note
      // paths don't (e.g. `[[vault/messages/email/foo]]`), which previously
      // broke resolution. Match on the full (prefix-stripped) path or filename.
      const target = rawTarget.replace(/^vault\//, "").trim().toLowerCase();
      if (!target) return;
      const targetName = target.split("/").pop() || target;
      const matched = allNotes.find((n) => {
        const path = (n.path || "").replace(/^vault\//, "").toLowerCase();
        const name = path.split("/").pop() || "";
        return path === target || name === targetName;
      });
      if (matched) {
        const type = inferContentType(matched);
        openTab(matched.id, matched.path?.split("/").pop() || matched.id, type);
      }
    },
    [allNotes, openTab],
  );
}
