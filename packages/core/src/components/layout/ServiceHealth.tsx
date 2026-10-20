import { useQuery } from "@tanstack/react-query";
import { useVaultStats, useServiceStatus } from "../../app/hooks/useParachute";
import { serviceApi, type BackgroundServiceStatus } from "../../lib/parachute/client";
import { useLivePollMs } from "../../lib/events/channelStatus";
import { formatTime as fmtTime } from "../../lib/datetime/format";

/** What the desktop status bar used to say (it was removed in w16): the vault's note count, whether
 *  Parachute answers, and the background services. Shown in Settings → Services. */
export function ServiceHealth() {
  const { data: stats } = useVaultStats();
  const { data: services } = useServiceStatus();
  const { data: bgServices } = useQuery({
    queryKey: ["services", "background"],
    queryFn: serviceApi.getStatus,
    refetchInterval: useLivePollMs(30_000),
  });
  const noteCount = stats?.totalNotes;
  const parachute = services?.parachute;
  if (noteCount === undefined && parachute === undefined && !bgServices?.length) return null;

  return (
    <section className="prism-settings__section" aria-label="Status">
      <h4>Status</h4>
      <ul className="text-sm" style={{ display: "grid", gap: 6, color: "var(--text-secondary)" }}>
        {noteCount !== undefined && <li>{noteCount} {noteCount === 1 ? "note" : "notes"} in this vault</li>}
        {parachute !== undefined && <li className="flex items-center gap-2"><Dot color={parachute ? "var(--color-success)" : "var(--color-danger)"} /> Parachute {parachute ? "connected" : "not reachable"}</li>}
      </ul>
      {bgServices && bgServices.length > 0 && <BackgroundServices services={bgServices} />}
    </section>
  );
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />;
}

function BackgroundServices({ services }: { services: BackgroundServiceStatus[] }) {
  const active = services.filter((s) => !s.disabled);
  const running = active.filter((s) => s.running);
  return (
    <div style={{ marginTop: 12 }}>
      <p className="text-xs" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
        {active.length === 0 ? "Background sync runs on the Prism Server (client mode)." : `Background sync: ${running.length} of ${active.length} running`}
      </p>
      <ul aria-label="Background sync services" style={{ display: "grid", gap: 6 }}>
        {services.map((svc) => (
          <li key={svc.name} className="flex items-start gap-2 text-xs">
            <span style={{ marginTop: 5 }}><Dot color={svc.disabled ? "var(--text-muted)" : svc.last_error ? "var(--color-danger)" : svc.running ? "var(--color-success)" : "var(--text-muted)"} /></span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium" style={{ color: "var(--text-primary)" }}>{svc.name}</span>
                <span style={{ color: "var(--text-muted)" }}>{svc.disabled ? "Disabled" : `${svc.items_processed} items`}</span>
              </div>
              {svc.last_run && <div style={{ color: "var(--text-muted)" }}>Last run {fmtTime(new Date(svc.last_run))}</div>}
              {svc.disabled && svc.disabled_reason && <div style={{ color: "var(--text-muted)" }}>{svc.disabled_reason}</div>}
              {svc.last_error && <div className="truncate" title={svc.last_error} style={{ color: "var(--color-danger)" }}>{svc.last_error}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
