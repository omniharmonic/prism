import { useState, useEffect } from "react";
import { X, Check, AlertCircle, Loader2, Database, MessageSquare, Mail, Cloud, Sparkles, Palette } from "lucide-react";
import { configApi } from "../../lib/agent/client";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

interface ConfigStatus {
  matrix: { configured: boolean; homeserver: string; user: string };
  notion: { configured: boolean };
  anthropic: { configured: boolean };
  google: { primary: string; agent: string };
}

export function Settings({ open, onClose }: SettingsProps) {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [_anthropicKey, _setAnthropicKey] = useState("");

  useEffect(() => {
    if (open) {
      setLoading(true);
      configApi.getStatus()
        .then(setStatus)
        .catch(() => setStatus(null))
        .finally(() => setLoading(false));
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="glass-elevated rounded-xl w-[520px] max-h-[80vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid var(--glass-border)" }}>
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Settings</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--glass-hover)]">
            <X size={18} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-auto px-6 py-4 space-y-6" style={{ maxHeight: "calc(80vh - 72px)" }}>
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={20} className="animate-spin" style={{ color: "var(--text-muted)" }} />
            </div>
          ) : (
            <>
              {/* Connections */}
              <Section title="Connections">
                {/* Parachute */}
                <ConnectionRow
                  icon={<Database size={16} />}
                  name="Parachute Vault"
                  status="connected"
                  detail="localhost:1940"
                />

                {/* Matrix */}
                <ConnectionRow
                  icon={<MessageSquare size={16} />}
                  name="Matrix (Messaging)"
                  status={status?.matrix.configured ? "connected" : "not_configured"}
                  detail={status?.matrix.configured
                    ? `${status.matrix.user} @ ${status.matrix.homeserver}`
                    : "Loaded from omniharmonic .env"
                  }
                />

                {/* Google */}
                <ConnectionRow
                  icon={<Mail size={16} />}
                  name="Google (Gmail, Calendar, Docs)"
                  status="needs_oauth"
                  detail={`Accounts: ${status?.google.primary}, ${status?.google.agent}`}
                />

                {/* Notion */}
                <ConnectionRow
                  icon={<Cloud size={16} />}
                  name="Notion"
                  status={status?.notion.configured ? "connected" : "not_configured"}
                  detail={status?.notion.configured ? "API key loaded from .env" : "Not configured"}
                />

                {/* Claude */}
                <div className="py-2">
                  <div className="flex items-center gap-3">
                    <Sparkles size={16} style={{ color: "var(--text-secondary)" }} />
                    <div className="flex-1">
                      <div className="text-sm" style={{ color: "var(--text-primary)" }}>Claude (Agent)</div>
                      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                        Uses native Claude Code CLI — no API key needed
                      </div>
                    </div>
                    <StatusBadge status="connected" />
                  </div>
                </div>
              </Section>

              {/* Configuration source */}
              <Section title="Configuration">
                <div className="glass-inset p-3 rounded-lg text-xs space-y-1" style={{ color: "var(--text-secondary)" }}>
                  <div>Credentials loaded from:</div>
                  <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                    ~/iCloud Drive (Archive)/Documents/cursor projects/omniharmonic_agent/.env
                  </div>
                  <div className="mt-2">Claude Code runs in:</div>
                  <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                    ~/iCloud Drive (Archive)/Documents/cursor projects/prism/
                  </div>
                  <div className="mt-2">Parachute MCP configured via:</div>
                  <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                    .mcp.json → parachute-vault server
                  </div>
                </div>
              </Section>

              {/* Appearance */}
              <Section title="Appearance">
                <div className="flex items-center gap-3 py-1">
                  <Palette size={16} style={{ color: "var(--text-secondary)" }} />
                  <span className="text-sm" style={{ color: "var(--text-primary)" }}>Theme</span>
                  <span className="text-xs ml-auto" style={{ color: "var(--text-muted)" }}>
                    Dark (glass) — only theme for now
                  </span>
                </div>
              </Section>

              {/* About */}
              <Section title="About">
                <div className="text-xs space-y-1" style={{ color: "var(--text-muted)" }}>
                  <div><strong style={{ color: "var(--text-secondary)" }}>Prism</strong> v0.1.0</div>
                  <div>The universal interface for your entire digital life.</div>
                  <div>Built with Tauri 2.x, React 19, TipTap 3, Claude Code</div>
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function ConnectionRow({ icon, name, status, detail }: {
  icon: React.ReactNode;
  name: string;
  status: "connected" | "not_configured" | "needs_oauth";
  detail: string;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span style={{ color: "var(--text-secondary)" }}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm" style={{ color: "var(--text-primary)" }}>{name}</div>
        <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>{detail}</div>
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

function StatusBadge({ status }: { status: "connected" | "not_configured" | "needs_oauth" }) {
  switch (status) {
    case "connected":
      return (
        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
          style={{ background: "rgba(111,207,151,0.15)", color: "var(--color-success)" }}>
          <Check size={10} /> Connected
        </span>
      );
    case "needs_oauth":
      return (
        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
          style={{ background: "rgba(242,201,76,0.15)", color: "var(--color-warning)" }}>
          <AlertCircle size={10} /> Needs OAuth
        </span>
      );
    default:
      return (
        <span className="text-xs px-2 py-0.5 rounded-full"
          style={{ background: "var(--glass)", color: "var(--text-muted)" }}>
          Not configured
        </span>
      );
  }
}
