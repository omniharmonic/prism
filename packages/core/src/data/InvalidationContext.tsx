import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createInvalidator, type InvalidationSource } from "../lib/events/invalidation";
import { setEventChannelLive } from "../lib/events/channelStatus";

const InvalidationSourceContext = createContext<InvalidationSource | null>(null);

/** Provides the host's invalidation channel transport (web: `/api/events`). Optional:
 *  with none (desktop) nothing subscribes and every poll keeps its normal interval. */
export function InvalidationSourceProvider({ source, children }: { source: InvalidationSource | null; children: ReactNode }) {
  return <InvalidationSourceContext.Provider value={source}>{children}</InvalidationSourceContext.Provider>;
}

/**
 * The ONE app-wide subscriber. Mount once inside the QueryClientProvider. Opens the
 * channel, maps events to query invalidations (batched), tracks live/down for the
 * polling fallbacks, and re-opens on a vault switch (the stream is per vault).
 */
export function InvalidationSubscriber() {
  const source = useContext(InvalidationSourceContext);
  const qc = useQueryClient();
  useEffect(() => {
    if (!source) return;
    let close: (() => void) | null = null;
    let inv: ReturnType<typeof createInvalidator> | null = null;
    const start = () => {
      const i = createInvalidator({
        invalidate: (f) => void qc.invalidateQueries(f as never),
        // NP-OF-05: a page this device's tree has never listed was made elsewhere → show it now.
        inTree: (id) => (qc.getQueryData<Array<{ id: string }>>(["vault", "tree"]) ?? []).some((n) => n.id === id),
        // A hidden tab does not refetch the tree; it catches up when it is looked at again.
        visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
      });
      inv = i;
      close = source.open({
        onEvent: (ev) => i.handleEvent(ev),
        onOpen: () => {
          setEventChannelLive(true);
          i.handleOpen();
        },
        onDown: () => setEventChannelLive(false),
      });
    };
    const stop = () => {
      close?.();
      inv?.dispose();
      close = null;
      inv = null;
      setEventChannelLive(false);
    };
    const restart = () => {
      stop();
      start();
    };
    start();
    const onVisible = () => { if (document.visibilityState !== "hidden") inv?.handleVisible(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("prism:vault-changed", restart);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("prism:vault-changed", restart);
      stop();
    };
  }, [source, qc]);
  return null;
}
