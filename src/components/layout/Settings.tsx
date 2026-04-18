import { useState, useEffect, useCallback } from "react";
import { X, Database, MessageSquare, Mail, Cloud, Sparkles, Sun, Moon, Plus, Trash2, Search, Check, Video, Mic } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type Theme } from "../../app/stores/settings";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

const FONT_OPTIONS = ["Inter", "System UI", "SF Pro", "Helvetica Neue", "Roboto", "Source Sans Pro", "IBM Plex Sans", "Lato"];
const EDITOR_FONT_OPTIONS = ["Newsreader", "Georgia", "Merriweather", "Lora", "Source Serif Pro", "Crimson Text", "Libre Baskerville"];
const MONO_FONT_OPTIONS = ["JetBrains Mono", "SF Mono", "Fira Code", "Source Code Pro", "IBM Plex Mono", "Cascadia Code", "Menlo"];

export function Settings({ open, onClose }: SettingsProps) {
  const [tab, setTab] = useState<"services" | "sources" | "appearance">("services");
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  const {
    theme, setTheme,
    fontFamily, setFontFamily,
    fontSize, setFontSize,
    editorFontFamily, setEditorFontFamily,
    monoFontFamily, setMonoFontFamily,
    vaults, addVault, removeVault, setActiveVault, activeVaultUrl,
    defaultSyncDirection, setDefaultSyncDirection,
    sidebarLabel, setSidebarLabel,
  } = useSettingsStore();

  const [newVaultName, setNewVaultName] = useState("");
  const [newVaultUrl, setNewVaultUrl] = useState("");

  const loadConfig = useCallback(() => {
    invoke<Record<string, unknown>>("get_full_config").then(setConfig);
  }, []);

  useEffect(() => {
    if (open) loadConfig();
  }, [open, loadConfig]);

  const handleSave = async (key: string, value: string) => {
    setSaving(key);
    await invoke("update_config", { updates: { [key]: value } });
    setSavedKeys((prev) => new Set(prev).add(key));
    await loadConfig();
    setEditValues((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setSaving(null);
    // Clear saved indicator after 2s
    setTimeout(() => setSavedKeys((prev) => { const n = new Set(prev); n.delete(key); return n; }), 2000);
  };

  const handleDiscoverMeetily = async () => {
    const result = await invoke<{ found: boolean; path?: string }>("discover_meetily_path");
    if (result.found && result.path) {
      setEditValues((prev) => ({ ...prev, meetily_db_path: result.path! }));
    }
  };

  if (!open) return null;

  const tabs = [
    { id: "services" as const, label: "Services" },
    { id: "sources" as const, label: "Data Sources" },
    { id: "appearance" as const, label: "Appearance" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="glass-elevated rounded-xl w-[620px] max-h-[85vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header with tabs */}
        <div className="px-6 pt-4 pb-0" style={{ borderBottom: "1px solid var(--glass-border)" }}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Settings</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-[var(--glass-hover)]">
              <X size={18} style={{ color: "var(--text-muted)" }} />
            </button>
          </div>
          <div className="flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors"
                style={{
                  color: tab === t.id ? "var(--text-primary)" : "var(--text-muted)",
                  background: tab === t.id ? "var(--glass-active)" : "transparent",
                  borderBottom: tab === t.id ? "2px solid var(--color-accent)" : "2px solid transparent",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-auto px-6 py-4 space-y-6" style={{ maxHeight: "calc(85vh - 100px)" }}>
          {/* Services Tab */}
          {tab === "services" && config && (
            <>
              <Section title="Core Services">
                <p className="text-[10px] mb-3" style={{ color: "var(--text-muted)" }}>
                  Configure connections to core infrastructure. Changes take effect on restart.
                </p>
                <ServiceField
                  icon={<Database size={14} />}
                  label="Parachute"
                  desc="Knowledge graph vault"
                  fields={[
                    { key: "parachute_url", label: "URL", value: config.parachute_url as string, placeholder: "http://localhost:1940" },
                    { key: "parachute_api_key", label: "API Key", value: config.parachute_api_key as string, placeholder: "pvt_...", sensitive: true, isSet: config.parachute_api_key_set as boolean },
                  ]}
                  isSet={!!(config.parachute_api_key_set)}
                  editValues={editValues}
                  saving={saving}
                  savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))}
                  onSave={handleSave}
                />
                <ServiceField
                  icon={<MessageSquare size={14} />}
                  label="Matrix"
                  desc="Messaging (WhatsApp, Telegram, Discord via bridges)"
                  fields={[
                    { key: "matrix_homeserver", label: "Homeserver", value: config.matrix_homeserver as string, placeholder: "http://localhost:8008" },
                    { key: "matrix_user", label: "User", value: config.matrix_user as string, placeholder: "@user:localhost" },
                    { key: "matrix_access_token", label: "Access Token", value: config.matrix_access_token as string, placeholder: "syt_...", sensitive: true, isSet: config.matrix_access_token_set as boolean },
                  ]}
                  isSet={config.matrix_access_token_set as boolean}
                  editValues={editValues}
                  saving={saving}
                  savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))}
                  onSave={handleSave}
                />
                <ServiceField
                  icon={<Mail size={14} />}
                  label="Google"
                  desc="Gmail, Calendar, Docs (via gog CLI)"
                  fields={[
                    { key: "google_account_primary", label: "Primary Account", value: config.google_account_primary as string, placeholder: "you@gmail.com" },
                    { key: "google_account_agent", label: "Agent Account", value: (config.google_account_agent as string) || "", placeholder: "agent@gmail.com" },
                  ]}
                  isSet={!!(config.google_account_primary as string)}
                  editValues={editValues}
                  saving={saving}
                  savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))}
                  onSave={handleSave}
                />
                <ServiceField
                  icon={<Sparkles size={14} />}
                  label="Claude"
                  desc="AI agent (Claude Code CLI + Anthropic API)"
                  fields={[
                    { key: "anthropic_api_key", label: "API Key", value: config.anthropic_api_key as string, placeholder: "sk-ant-...", sensitive: true, isSet: config.anthropic_api_key_set as boolean },
                  ]}
                  isSet={config.anthropic_api_key_set as boolean}
                  editValues={editValues}
                  saving={saving}
                  savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))}
                  onSave={handleSave}
                />
              </Section>

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
                          <div className="text-[10px]" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{v.url}</div>
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
                  <div className="flex gap-1">
                    <input value={newVaultName} onChange={(e) => setNewVaultName(e.target.value)} placeholder="Name"
                      className="flex-1 h-6 rounded px-2 text-xs outline-none"
                      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
                    <input value={newVaultUrl} onChange={(e) => setNewVaultUrl(e.target.value)} placeholder="http://localhost:1940"
                      className="flex-1 h-6 rounded px-2 text-xs outline-none"
                      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }} />
                    <button onClick={() => { if (newVaultName && newVaultUrl) { addVault(newVaultName, newVaultUrl); setNewVaultName(""); setNewVaultUrl(""); } }}
                      className="px-2 py-1 rounded text-xs hover:bg-[var(--glass-hover)]" style={{ color: "var(--color-accent)" }}>
                      <Plus size={11} />
                    </button>
                  </div>
                </div>
              </Section>

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
            </>
          )}

          {/* Data Sources Tab */}
          {tab === "sources" && config && (
            <>
              <Section title="Meeting Transcripts">
                <p className="text-[10px] mb-3" style={{ color: "var(--text-muted)" }}>
                  Connect transcript services to automatically pull meeting recordings into your vault.
                  Transcripts are ingested every 10 minutes and enriched by the meeting processor skill.
                </p>
                <SourceField icon={<Video size={14} />} label="Fathom" desc="Meeting recording & AI summaries"
                  fieldKey="fathom_api_key" placeholder="Fathom API key" sensitive
                  value={config.fathom_api_key as string} isSet={config.fathom_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} />

                <SourceField icon={<Mic size={14} />} label="Meetily" desc="Local meeting transcription (SQLite)"
                  fieldKey="meetily_db_path" placeholder="/path/to/meeting_minutes.sqlite"
                  value={config.meetily_db_path as string} isSet={!!(config.meetily_db_path as string)}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave}
                  extra={
                    <button onClick={handleDiscoverMeetily} className="px-2 py-0.5 rounded text-[10px] hover:bg-[var(--glass-hover)]" style={{ color: "var(--color-accent)", border: "1px solid var(--glass-border)" }} title="Auto-discover Meetily database">
                      <Search size={10} />
                    </button>
                  } />

                <SourceField icon={<Video size={14} />} label="Read.ai" desc="Meeting copilot & transcription"
                  fieldKey="readai_api_key" placeholder="Read.ai API key" sensitive
                  value={config.readai_api_key as string} isSet={config.readai_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} />

                <SourceField icon={<Mic size={14} />} label="Otter.ai" desc="Meeting notes & transcription"
                  fieldKey="otter_api_key" placeholder="Otter API key" sensitive
                  value={config.otter_api_key as string} isSet={config.otter_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} />

                <SourceField icon={<Mic size={14} />} label="Fireflies.ai" desc="AI meeting assistant"
                  fieldKey="fireflies_api_key" placeholder="Fireflies API key" sensitive
                  value={config.fireflies_api_key as string} isSet={config.fireflies_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} />
              </Section>

              <Section title="Knowledge Sources">
                <SourceField icon={<Cloud size={14} />} label="Notion" desc="Workspace & knowledge base"
                  fieldKey="notion_api_key" placeholder="Notion API key" sensitive
                  value={config.notion_api_key as string} isSet={config.notion_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} />
              </Section>
            </>
          )}

          {/* Appearance Tab */}
          {tab === "appearance" && (
            <>
              <Section title="Theme">
                <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
                  {(["dark", "light"] as Theme[]).map((t) => (
                    <button key={t} onClick={() => setTheme(t)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs"
                      style={{ background: theme === t ? "var(--glass-active)" : "transparent", color: "var(--text-primary)" }}>
                      {t === "dark" ? <Moon size={12} /> : <Sun size={12} />}
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </Section>

              <Section title="Typography">
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
                <Row label="Sidebar Label">
                  <input value={sidebarLabel} onChange={(e) => setSidebarLabel(e.target.value)}
                    className="h-7 rounded-md px-2 text-xs outline-none w-32"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
                    placeholder="Projects" />
                </Row>
              </Section>

              <Section title="About">
                <div className="text-xs space-y-1" style={{ color: "var(--text-muted)" }}>
                  <div><strong style={{ color: "var(--text-secondary)" }}>Prism</strong> v0.1.2</div>
                  <div>Agentic knowledge management powered by Parachute + Claude.</div>
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Shared Components ──────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><h3 className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>{title}</h3>{children}</div>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between py-1.5"><span className="text-sm" style={{ color: "var(--text-primary)" }}>{label}</span>{children}</div>;
}

// ─── Service Field (multi-field config card) ─────────────────

function ServiceField({ icon, label, desc, fields, isSet, editValues, saving, savedKeys, onEdit, onSave }: {
  icon: React.ReactNode;
  label: string;
  desc: string;
  fields: Array<{ key: string; label: string; value: string; placeholder: string; sensitive?: boolean; isSet?: boolean }>;
  isSet: boolean;
  editValues: Record<string, string>;
  saving: string | null;
  savedKeys: Set<string>;
  onEdit: (key: string, value: string) => void;
  onSave: (key: string, value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg mb-2" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-[var(--glass-hover)] transition-colors rounded-lg">
        <span style={{ color: "var(--text-secondary)" }}>{icon}</span>
        <div className="flex-1">
          <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>{label}</div>
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{desc}</div>
        </div>
        {isSet ? (
          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--color-success)", background: "rgba(34,197,94,0.1)" }}>
            <Check size={9} /> Connected
          </span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text-muted)", background: "var(--glass)" }}>Not configured</span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5" style={{ borderTop: "1px solid var(--glass-border)" }}>
          {fields.map((f) => {
            const isEditing = f.key in editValues;
            const isSaved = savedKeys.has(f.key);
            return (
              <div key={f.key} className="flex items-center gap-1.5 pt-1.5">
                <span className="text-[10px] w-20 flex-shrink-0" style={{ color: "var(--text-muted)" }}>{f.label}</span>
                <input
                  type={f.sensitive && !isEditing ? "password" : "text"}
                  value={isEditing ? editValues[f.key] : (f.value || "")}
                  onChange={(e) => onEdit(f.key, e.target.value)}
                  onFocus={() => { if (!isEditing && f.sensitive) onEdit(f.key, ""); }}
                  placeholder={f.placeholder}
                  className="flex-1 h-6 rounded px-2 text-[10px] outline-none"
                  style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: f.key.includes("url") || f.key.includes("homeserver") ? "var(--font-mono)" : undefined }}
                />
                {isEditing && editValues[f.key] && (
                  <button onClick={() => onSave(f.key, editValues[f.key])} disabled={saving === f.key}
                    className="px-2 py-0.5 rounded text-[10px] font-medium"
                    style={{ background: "var(--color-accent)", color: "white" }}>
                    {saving === f.key ? "..." : "Save"}
                  </button>
                )}
                {isSaved && <Check size={10} style={{ color: "var(--color-success)" }} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Source Field (single-key data source) ───────────────────

function SourceField({ icon, label, desc, fieldKey, placeholder, sensitive, value, isSet, editValues, saving, savedKeys, onEdit, onSave, extra }: {
  icon: React.ReactNode;
  label: string;
  desc: string;
  fieldKey: string;
  placeholder: string;
  sensitive?: boolean;
  value: string;
  isSet: boolean;
  editValues: Record<string, string>;
  saving: string | null;
  savedKeys: Set<string>;
  onEdit: (key: string, value: string) => void;
  onSave: (key: string, value: string) => void;
  extra?: React.ReactNode;
}) {
  const isEditing = fieldKey in editValues;
  const isSaved = savedKeys.has(fieldKey);

  return (
    <div className="rounded-lg p-2.5 mb-2" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: "var(--text-secondary)" }}>{icon}</span>
        <div className="flex-1">
          <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>{label}</div>
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{desc}</div>
        </div>
        {isSet ? (
          <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--color-success)" }}>
            <Check size={9} /> Set
          </span>
        ) : (
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>Not set</span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type={sensitive && !isEditing ? "password" : "text"}
          value={isEditing ? editValues[fieldKey] : (value || "")}
          onChange={(e) => onEdit(fieldKey, e.target.value)}
          onFocus={() => { if (!isEditing && sensitive) onEdit(fieldKey, ""); }}
          placeholder={placeholder}
          className="flex-1 h-6 rounded px-2 text-[10px] outline-none"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: !sensitive ? "var(--font-mono)" : undefined }}
        />
        {extra}
        {isEditing && editValues[fieldKey] && (
          <button onClick={() => onSave(fieldKey, editValues[fieldKey])} disabled={saving === fieldKey}
            className="px-2 py-0.5 rounded text-[10px] font-medium"
            style={{ background: "var(--color-accent)", color: "white" }}>
            {saving === fieldKey ? "..." : "Save"}
          </button>
        )}
        {isSaved && <Check size={10} style={{ color: "var(--color-success)" }} />}
      </div>
    </div>
  );
}
