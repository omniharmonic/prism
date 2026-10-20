import { useCallback, useEffect, useRef, useState } from "react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";

/** Every canvas action reads current access; saved card labels are not authority. */
export function useCanvasNoteAccess() {
  const client = useVaultClient();
  const mounted = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const read = useCallback(async (id: string) => {
    const audience = () => client.scope?.() ?? useAgentChatStore.getState().scope;
    const scope = audience();
    setError("");
    try {
      const note = await client.getNote(id);
      if (!mounted.current || audience() !== scope) throw Error("Workspace changed");
      return note;
    } catch {
      if (mounted.current && audience() === scope)
        setError("This note could not be loaded or your access changed. Try again to check its current state.");
      throw Error("Note unavailable");
    }
  }, [client]);
  return { read, error };
}
