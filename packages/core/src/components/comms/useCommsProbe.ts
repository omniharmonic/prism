import { useQuery } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { commsTransient, commsUnavailable } from "../../lib/comms/model";

/**
 * Which data source Messages reads. The owner with Comms on (and the primary vault active) gets
 * the Comms view (`/api/comms`, D19); everyone else — and a shell without the seam (legacy
 * desktop, fixtures) — keeps the vault notes. One probe listing decides:
 *  - a refusal (`commsUnavailable`: comms off / not the owner / another vault) → the vault view;
 *  - no answer (offline, server restarting: no status) or a 5xx → the vault view too, which the
 *    device's offline read cache can still fill, with a notice and "Try again" — Comms reads are
 *    never cached on the device, so staying on Comms would show nothing;
 *  - a 429 or 4xx → Comms, which shows its own error and Try again.
 * The decision is kept until the person retries (no switch of view under them on reconnect).
 * Keyed by the vault client's scope, which names the account, workspace and vault.
 */
export function useCommsProbe() {
  const vault = useVaultClient();
  const scope = vault.scope?.() ?? null;
  return useQuery({
    queryKey: ["comms", "probe", scope],
    queryFn: () => vault.comms!.listThreads({ folder: "inbox", limit: 1 }),
    enabled: !!vault.comms,
    retry: false,
    staleTime: scope ? 5 * 60_000 : 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
type MessagesSource = "pending" | "comms" | "vault" | "vault-offline";
export function messagesSource(hasComms: boolean, probe: { isPending: boolean; isError: boolean; error: unknown }): MessagesSource {
  if (!hasComms) return "vault";
  if (probe.isPending) return "pending";
  if (!probe.isError) return "comms";
  if (commsUnavailable(probe.error)) return "vault";
  return commsTransient(probe.error) ? "vault-offline" : "comms";
}

