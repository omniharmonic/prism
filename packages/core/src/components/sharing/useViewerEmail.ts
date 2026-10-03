import { useEffect, useState } from "react";
import { useCollabSharing } from "../../data/CollabSharing";

/** The signed-in account's email when the shell can tell (web/native), else null. */
export function useViewerEmail(): string | null {
  const sharing = useCollabSharing();
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const get = sharing?.getViewer;
    if (!get) return;
    void get()
      .then((v) => alive && setEmail(v?.email ?? null))
      .catch(() => alive && setEmail(null));
    return () => {
      alive = false;
    };
  }, [sharing]);
  return email;
}
