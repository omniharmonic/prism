import { useState, useEffect } from "react";
import { X, Loader2, Database, MessageSquare, Mail, Cloud, Sparkles, Sun, Moon, Plus, Trash2 } from "lucide-react";
import { configApi } from "../../lib/agent/client";
import { useSettingsStore, type Theme } from "../../app/stores/settings";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

const FONT_OPTIONS = [
  "Inter", "System UI", "SF Pro", "Helvetica Neue",
  "Roboto", "Source Sans Pro", "IBM Plex Sans", "Lato",
];

const EDITOR_FONT_OPTIONS = [
  "Newsreader", "Georgia", "Merriweather", "Lora",
  "Source Serif Pro", "Crimson Text", "Libre Baskerville",
];

const MONO_FONT_OPTIONS = [
  "JetBrains Mono", "SF Mono", "Fira Code", "Source Code Pro",
  "IBM Plex Mono", "Cascadia Code", "Menlo",
];

export function Settings({ open, onClose }: SettingsProps) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);

  const {
    theme, setTheme,
    fontFamily, setFontFamily,
    fontSize, setFontSize,
    editorFontFamily, setEditorFontFamily,
    monoFontFamily, setMonoFontFamily,
    vaults, addVault, removeVault, setActiveVault, activeVaultUrl,
    defaultSyncDirection, setDefaultSyncDirection,
  } = useSettingsStore();

  const [newVaultName, setNewVaultName] = useState("");
  const [newVaultUrl, setNewVaultUrl] = useState("");

  useEffect(() => {
    if (open) {
      setLoading(true);
      configApi.getStatus()
        .then((s) => setStatus(s as unknown as Record<string, unknown>))
        .catch(() => setStatus(null))
        .finally(() => setLoading(false));
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="glass-elevated rounded-xl w-[560px] max-h-[85vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid var(--glass-border)" }}>
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Settings</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--glass-hover)]">
            <X size={18} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>

        <div className="overflow-auto px-6 py-4 space-y-6" style={{ maxHeight: "calc(85vh - 72px)" }}>
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin" style={{ color: "var(--text-muted)" }} /></div>
          ) : (
            <>
              {/* Appearance */}
              <Section title="Appearance">
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm" style={{ color: "var(--text-primary)" }}>Theme</span>
                  <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
                    {(["dark", "light"] as Theme[]).map((t) => (
                      <button key={t} onClick={() => setTheme(t)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs"
                        style={{ background: theme === t ? "var(--glass-active)" : "transparent", color: "var(--text-primary)" }}>
                        {t === "dark" ? <Moon size={12} /> : <Sun size={12} />}
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                <Row label="UI Font">
                  <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} className="h-7 rounded-md px-2 text-xs outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                    {FONT_OPTIONS.map((f) => <option key={f} value={f} style={{ background: "var(--bg-elevated)" }}>{f}</option>)}
                  </select>
                </Row>

                <Row label="Editor Font">
                  <select value={editorFontFamily} onChange={(e) => setEditorFontFamily(e.target.value)} className="h-7 rounded-md px-2 text-xs outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                    {EDITOR_FONT_OPTIONS.map((f) => <option key={f} value={f} style={{ background: "var(--bg-elevated)" }}>{f}</option>)}
                  </select>
                </Row>

                <Row label="Code Font">
                  <select value={monoFontFamily} onChange={(e) => setMonoFontFamily(e.target.value)} className="h-7 rounded-md px-2 text-xs outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                    {MONO_FONT_OPTIONS.map((f) => <option key={f} value={f} style={{ background: "var(--bg-elevated)" }}>{f}</option>)}
                  </select>
                </Row>

                <Row label="Font Size">
                  <div className="flex items-center gap-2">
                    <input type="range" min={11} max={18} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="w-24" />
                    <span className="text-xs w-8" style={{ color: "var(--text-secondary)" }}>{fontSize}px</span>
                  </div>
                </Row>
              </Section>

              {/* Vaults */}
              <Section title="Vaults">
                <div className="space-y-1">
                  {vaults.map((v) => (
                    <div key={v.url} className="flex items-center gap-2 py-1">
                      <button onClick={() => setActiveVault(v.url)}
                        className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-[var(--glass-hover)]"
                        style={{ background: v.url === activeVaultUrl ? "var(--glass-active)" : "transparent" }}>
                        <Database size={12} style={{ color: v.url === activeVaultUrl ? "var(--color-success)" : "var(--text-muted)" }} />
                        <div>
                          <div className="text-xs" style={{ color: "var(--text-primary)" }}>{v.name}</div>
                          <div className="text-xs" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{v.url}</div>
                        </div>
                      </button>
                      {vaults.length > 1 && (
                        <button onClick={() => removeVault(v.url)} className="p-1 rounded hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-muted)" }}>
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-2 glass-inset p-2 rounded-lg space-y-1.5">
                  <div className="text-xs" style={{ color: "var(--text-muted)" }}>Add Parachute vault:</div>
                  <div className="flex gap-1">
                    <input value={newVaultName} onChange={(e) => setNewVaultName(e.target.value)} placeholder="Name"
                      className="flex-1 h-6 rounded px-2 text-xs outline-none"
                      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
                    <input value={newVaultUrl} onChange={(e) => setNewVaultUrl(e.target.value)} placeholder="http://localhost:1940"
                      className="flex-1 h-6 rounded px-2 text-xs outline-none"
                      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }} />
                  </div>
                  <button onClick={() => { if (newVaultName && newVaultUrl) { addVault(newVaultName, newVaultUrl); setNewVaultName(""); setNewVaultUrl(""); } }}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-[var(--glass-hover)]" style={{ color: "var(--color-accent)" }}>
                    <Plus size={11} /> Add
                  </button>
                </div>
              </Section>

              {/* Connections */}
              <Section title="Connections">
                <Conn icon={<Database size={14} />} name="Parachute" ok detail={activeVaultUrl} />
                <Conn icon={<MessageSquare size={14} />} name="Matrix"
                  ok={!!(status as Record<string, Record<string, unknown>>)?.matrix?.configured}
                  detail="Via omniharmonic .env" />
                <Conn icon={<Mail size={14} />} name="Google (gog CLI)" ok detail="Gmail, Calendar, Docs" />
                <Conn icon={<Cloud size={14} />} name="Notion"
                  ok={!!(status as Record<string, Record<string, unknown>>)?.notion?.configured}
                  detail="API key from .env" />
                <Conn icon={<Sparkles size={14} />} name="Claude Code" ok detail="Native CLI" />
              </Section>

              {/* Sync */}
              <Section title="Sync">
                <Row label="Default direction">
                  <select value={defaultSyncDirection} onChange={(e) => setDefaultSyncDirection(e.target.value as "push"|"pull"|"bidirectional")}
                    className="h-7 rounded-md px-2 text-xs outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                    <option value="push" style={{ background: "var(--bg-elevated)" }}>Push</option>
                    <option value="pull" style={{ background: "var(--bg-elevated)" }}>Pull</option>
                    <option value="bidirectional" style={{ background: "var(--bg-elevated)" }}>Bidirectional</option>
                  </select>
                </Row>
              </Section>

              {/* About */}
              <Section title="About">
                <div className="text-xs space-y-1" style={{ color: "var(--text-muted)" }}>
                  <div><strong style={{ color: "var(--text-secondary)" }}>Prism</strong> v0.1.0</div>
                  <div>The universal interface for your entire digital life.</div>
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
  return <div><h3 className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>{title}</h3>{children}</div>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between py-1.5"><span className="text-sm" style={{ color: "var(--text-primary)" }}>{label}</span>{children}</div>;
}

function Conn({ icon, name, ok, detail }: { icon: React.ReactNode; name: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span style={{ color: "var(--text-secondary)" }}>{icon}</span>
      <div className="flex-1">
        <div className="text-sm" style={{ color: "var(--text-primary)" }}>{name}</div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>{detail}</div>
      </div>
      <span className="w-2 h-2 rounded-full" style={{ background: ok ? "var(--color-success)" : "var(--color-danger)" }} />
    </div>
  );
}
