import { useCallback, useEffect, useState } from "react";
import { serverFetch } from "../../lib/transport/serverFetch";
import { lastClientErrors, type ClientErrorReport } from "../../lib/diagnostics/clientErrors";
import { formatDateTime } from "../../lib/datetime/format";
import { Button } from "../ui/Button";

type Row = ClientErrorReport & { id?: number };

const KIND_LABEL: Record<ClientErrorReport["kind"], string> = {
  uncaught: "App stopped",
  boundary: "Screen error",
  error: "Error",
  rejection: "Unhandled failure",
  stall: "Stalled",
};

/**
 * Settings → Advanced → "Client errors" (L-1): what the owner's apps caught — an error that
 * stopped the app, one an error screen showed, unhandled failures, and main-thread stalls.
 * `server`: the owner's own server has the reports from every device (owner only); without it
 * (or when it cannot be read) this device's own kept errors are shown.
 */
export function ClientErrorLog({ server }: { server: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [source, setSource] = useState<"server" | "device">("device");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (server) {
      try {
        const r = await serverFetch("/api/admin/client-errors?limit=20");
        if (r.ok) {
          setRows(((await r.json()) as { errors: Row[] }).errors);
          setSource("server");
          return;
        }
      } catch { /* fall back to this device's own record */ }
    }
    setRows(lastClientErrors());
    setSource("device");
  }, [server]);
  useEffect(() => { void load(); }, [load]);

  const clear = async () => {
    setBusy(true);
    try {
      if (source === "server") await serverFetch("/api/admin/client-errors", { method: "DELETE" });
      try { localStorage.removeItem("prism:client-errors"); } catch { /* private mode */ }
      await load();
    } finally { setBusy(false); }
  };

  if (rows === null) return null;
  return (
    <section className="prism-settings__section" aria-label="Client errors">
      <h4>Client errors</h4>
      <p className="prism-settings__hint" style={{ marginBottom: 8 }}>
        {source === "server" ? "Reported by your apps to this server (newest first)." : "Kept on this device (newest first)."}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Nothing recorded.</p>
      ) : (
        <>
          <ul className="text-sm" style={{ display: "grid", gap: 8, color: "var(--text-secondary)" }}>
            {rows.map((r, i) => (
              <li key={r.id ?? `${r.at}-${i}`}>
                <details>
                  <summary style={{ cursor: "pointer", color: "var(--text-primary)" }}>
                    {KIND_LABEL[r.kind] ?? r.kind} · {formatDateTime(r.at, { dateStyle: "medium", timeStyle: "short" })}
                    {r.platform ? ` · ${r.platform}` : ""}{r.build ? ` ${r.build}` : ""}
                  </summary>
                  <div style={{ marginTop: 6 }}>{r.message}{r.detail ? ` (${r.detail})` : ""}</div>
                  {r.route && <div>On {r.route}</div>}
                  {r.stack && <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", marginTop: 6, opacity: 0.8 }}>{r.stack}</pre>}
                </details>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" className="mt-3" loading={busy} onClick={() => void clear()}>
            Clear
          </Button>
        </>
      )}
    </section>
  );
}
