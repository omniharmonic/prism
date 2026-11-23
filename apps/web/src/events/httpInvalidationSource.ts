/**
 * The web shell's invalidation channel (Arch v2 WP7.2): `GET /api/events` over
 * `streamServerSSE` (so the PWA cookie and the native bearer both work; never a
 * bare EventSource/fetch). Sends ids-only hints the core maps to query invalidations.
 * Vault/workspace come from `contextHeaders()`; capability viewers send their token.
 *
 * Reconnects with streamSSE's backoff; every reconnect makes the core resync. A
 * final failure (401/403/404: anon, old server) leaves the channel "down", so every
 * poll keeps its normal interval.
 */
import { parseInvalidationEvent, type InvalidationSource } from "@prism/core/shell";
import { streamServerSSE } from "../transport";
import { capabilityHeader, contextHeaders } from "../config";

export const httpInvalidationSource: InvalidationSource = {
  open(h) {
    const ac = new AbortController();
    void streamServerSSE("/api/events", {
      headers: { ...capabilityHeader(), ...contextHeaders() },
      signal: ac.signal,
      onOpen: () => h.onOpen(),
      onEvent: (m) => {
        const ev = parseInvalidationEvent(m.data);
        if (ev) h.onEvent(ev);
      },
      onError: () => h.onDown(),
    }).then(
      () => h.onDown(),
      () => h.onDown(),
    );
    return () => ac.abort();
  },
};
