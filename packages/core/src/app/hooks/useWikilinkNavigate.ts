import { useCallback } from "react";
import { useUIStore } from "../stores/ui";
import { useVaultClient } from "../../data/VaultClientContext";
import { inferContentType } from "../../lib/schemas/content-types";
import { navigateWikilink } from "../../lib/wikilinkNavigation";
import { noteLinkTitle } from "../../lib/wikilinks";

/** Shared permission-aware navigation. Ambiguous names open the workspace picker. */
export function useWikilinkNavigate(): (target: string) => void {
  const client = useVaultClient();
  const openTab = useUIStore(s=>s.openTab);
  return useCallback((target:string)=>{
    void navigateWikilink(client,target,note=>openTab(note.id,noteLinkTitle(note),inferContentType(note)));
  },[client,openTab]);
}
