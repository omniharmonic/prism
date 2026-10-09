import { useState, useEffect, useCallback, useRef } from "react";
import { X, Database, MessageSquare, Mail, Cloud, Bot, Sun, Moon, Monitor, Plus, Trash2, Check, Video, Mic, Cpu, FileText, Zap } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, type Theme, type WritingFont, type PageWidth } from "../../app/stores/settings";
import { useReduceMotion } from "../../lib/motion";
import { RegionSettings } from "./RegionSettings";
import { ollamaApi, localAiApi } from "../../lib/parachute/client";
import { useIsWeb } from "../../data/Platform";
import { useAccount } from "../../data/Account";
import { AccountSettings } from "./AccountSettings";
import { DesktopOnlyNotice } from "../ui/DesktopOnlyNotice";
import { useHostServices } from "../../data/HostServicesContext";
import { useVaultClient } from "../../data/VaultClientContext";
import { ServerAiModels } from "./ServerAiModels";
import { SearchIndexSettings } from "./SearchIndexSettings";
import { ServiceHealth } from "./ServiceHealth";
import { PushSettings } from "./PushSettings";
import { NotificationSettingsPanel } from "../inbox/NotificationSettingsPanel";
import { IntegrationsOverview } from "./IntegrationsOverview";
import "./settings-workspace.css";
import { askConfirm } from "../ui/ConfirmDialog";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

const FONT_OPTIONS = ["Inter", "System UI", "SF Pro", "Helvetica Neue", "Roboto", "Source Sans Pro", "IBM Plex Sans", "Lato"];
const EDITOR_FONT_OPTIONS = ["Newsreader", "Georgia", "Merriweather", "Lora", "Source Serif Pro", "Crimson Text", "Libre Baskerville"];
const MONO_FONT_OPTIONS = ["JetBrains Mono", "SF Mono", "Fira Code", "Source Code Pro", "IBM Plex Mono", "Cascadia Code", "Menlo"];


type SectionId = "account" | "appearance" | "inputs" | "ai" | "notifications" | "search" | "advanced";
const SECTION_INTRO: Record<SectionId, string> = {
  account: "Your sign-in and personal account preferences.",
  appearance: "A comfortable place to read and write. Changes apply immediately on this device.",
  inputs: "The accounts and services that bring mail, messages, meetings and tasks into your vault.",
  ai: "Which models answer, and what every agent knows about you.",
  notifications: "What reaches you outside the Inbox.",
  search: "Keep search up to date for this vault.",
  advanced: "Start-up and details of this install.",
};
const selectStyle = { background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" } as const;

export function Settings({ open, onClose }: SettingsProps) {
  const isWeb = useIsWeb();
  const vaultClient = useVaultClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [settingsError, setSettingsError] = useState("");
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  const account = useAccount();
  // Server owner on a thin client: AI model routing lives on the Prism Server.
  const host = useHostServices();
  const [tab, setTab] = useState<SectionId>("appearance");
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
    writingFont, setWritingFont,
    pageWidth, setPageWidth,
    vaults, addVault, removeVault, setActiveVault, activeVaultUrl,
    defaultSyncDirection, setDefaultSyncDirection,
    sidebarLabel, setSidebarLabel,
    startWithLastDocument, setStartWithLastDocument,
  } = useSettingsStore();

  const [newVaultName, setNewVaultName] = useState("");
  const [newVaultUrl, setNewVaultUrl] = useState("");

  // Vault description state
  const [vaultDescription, setVaultDescription] = useState("");
  const [vaultDescriptionDraft, setVaultDescriptionDraft] = useState("");
  const [vaultDescriptionLoading, setVaultDescriptionLoading] = useState(false);
  const [vaultDescriptionSaved, setVaultDescriptionSaved] = useState(false);
  const [vaultDescriptionExpanded, setVaultDescriptionExpanded] = useState(false);

  // AI Models state
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string; size: string | null }>>([]);
  const [skillModels, setSkillModels] = useState<Record<string, { provider: string; model: string }>>({});
  const { setSkillModel } = useSettingsStore();

  // The host config file exists only on the legacy desktop. A server-backed shell (web, Prism
  // Client) keeps its inputs on the Prism Server, so there is nothing to load — and no error.
  const loadConfig = useCallback(async () => {
    if (isWeb) return;
    try { setConfig(await invoke<Record<string, unknown>>("get_full_config")); }
    catch { setConfig(null); setSettingsError("Couldn't load service settings. Try again."); }
  }, [isWeb]);

  useEffect(() => {
    if (open) {
      loadConfig();
      vaultClient.getVaultInfo().then((info) => {
        const desc = info.description || "";
        setVaultDescription(desc);
        setVaultDescriptionDraft(desc);
      }).catch(() => {});
    }
  }, [open, loadConfig, vaultClient]);

  useEffect(() => {
    if (isWeb) return;
    // Guard against browser-only mode (outside Tauri webview)
    try {
      ollamaApi.listModels().then(setAvailableModels).catch(() => {});
      ollamaApi.getSkillModels().then(setSkillModels).catch(() => {});
    } catch {
      // Not running in Tauri — invoke unavailable
    }
  }, [isWeb]);

  const handleSkillModelChange = async (skill: string, provider: string, model: string) => {
    await ollamaApi.setSkillModel(skill, provider, model);
    setSkillModel(skill, provider, model);
    setSkillModels(prev => ({ ...prev, [skill]: { provider, model } }));
  };

  const handleSave = async (key: string, value: string) => {
    setSaving(key);
    setSettingsError("");
    try {
      await invoke("update_config", { updates: { [key]: value } });
      setSavedKeys((prev) => new Set(prev).add(key));
      await loadConfig();
      setEditValues((prev) => { const next = { ...prev }; delete next[key]; return next; });
      setTimeout(() => setSavedKeys((prev) => { const next = new Set(prev); next.delete(key); return next; }), 2000);
    } catch { setSettingsError("Couldn't save this setting. Your entered value is still here; try again."); }
    finally { setSaving(null); }
  };

  // Boolean/enum config (ingest switch). update_config reads real JSON bools for these.
  const handleSaveRaw = async (key: string, value: boolean | string) => {
    setSaving(key);
    try {
      await invoke("update_config", { updates: { [key]: value } });
      setSavedKeys((prev) => new Set(prev).add(key));
      await loadConfig();
    } catch { setSettingsError("Couldn’t update this setting. Try again."); } finally {
      setSaving(null);
    }
    setTimeout(() => setSavedKeys((prev) => { const n = new Set(prev); n.delete(key); return n; }), 2000);
  };

  // Write-only secrets: `null` tells update_config to CLEAR the stored value
  // (a blank string keeps it). The value itself is never read back.
  const handleClear = async (key: string) => {
    setSaving(key);
    try {
      await invoke("update_config", { updates: { [key]: null } });
      setEditValues((prev) => { const n = { ...prev }; delete n[key]; return n; });
      await loadConfig();
    } catch { setSettingsError("Couldn’t update this setting. Try again."); } finally {
      setSaving(null);
    }
  };

  if (!open) return null;

  // One list for every shell; a section a shell has nothing for is left out, never shown empty.
  const tabs: Array<{ id: SectionId; label: string }> = [
    // Account is web-session only (the shell provides an AccountClient); hidden on
    // desktop (local owner, no session).
    ...(account ? [{ id: "account" as const, label: "Account" }] : []),
    { id: "appearance", label: "Appearance" },
    { id: "inputs", label: "Inputs & integrations" },
    { id: "ai", label: "AI & agent" },
    // Notifications are delivered by the Prism Server to a signed-in account.
    ...(account ? [{ id: "notifications" as const, label: "Notifications" }] : []),
    ...(host?.searchIndex ? [{ id: "search" as const, label: "Search index" }] : []),
    { id: "advanced", label: "Advanced" },
  ];
  // Guard against a stale `tab` if the active section is hidden in this shell.
  const activeTab: SectionId = tabs.some((t) => t.id === tab) ? tab : "appearance";

  return (
    <dialog ref={dialog} aria-label="Settings" onCancel={(event) => { event.preventDefault(); onClose(); }} className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 p-3 text-[var(--text-primary)] z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="prism-settings" onClick={(e) => e.stopPropagation()}>
        <header className="prism-settings__header">
          <div><h2>Settings</h2><p>Make Prism work the way you do.</p></div>
          <button aria-label="Close settings" onClick={onClose} className="focus-ring min-h-control min-w-control grid place-items-center p-1.5 rounded hover:bg-[var(--glass-hover)]"><X size={18} /></button>
        </header>
        <div className="prism-settings__body">
          <nav aria-label="Settings sections" className="prism-settings__navigation">
            {tabs.map((t) => (
              <button key={t.id} aria-pressed={activeTab === t.id} onClick={() => setTab(t.id)} className="focus-ring">{t.label}</button>
            ))}
            <p>Appearance applies on this device. Account, inputs and AI settings say where they are kept.</p>
          </nav>
          <div className="prism-settings__content" data-settings-section={activeTab}>
            <div className="prism-settings__section-heading">
              <h3>{tabs.find((item) => item.id === activeTab)?.label}</h3>
              <p>{SECTION_INTRO[activeTab]}</p>
            </div>
          {settingsError && <p role="alert" className="text-sm">{settingsError} <button className="focus-ring underline" onClick={() => { setSettingsError(""); void loadConfig(); }}>Reload settings</button></p>}

          {activeTab === "account" && <AccountSettings />}

          {activeTab === "appearance" && (
            <>
              <Section title="Theme">
                {/* Three labels in a 250 px column (a 320 px window with a classic scrollbar) at WCAG 1.4.12 text
                    spacing: tighter side padding — the labels are centred, so nothing moves — and, narrower still,
                    the row wraps rather than cutting "Dark" off. */}
                <div className="flex flex-wrap rounded-lg overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
                  {(["system", "light", "dark"] as Theme[]).map((t) => (
                    <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs"
                      style={{ background: theme === t ? "var(--glass-active)" : "transparent", color: "var(--text-primary)" }}>
                      {t === "dark" ? <Moon size={12} /> : t === "light" ? <Sun size={12} /> : <Monitor size={12} />}
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
                {theme === "system" && (
                  <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>Follows this device’s light or dark setting.</p>
                )}
              </Section>

              <Section title="Writing">
                <Row label="Writing font" hint="For pages that have not chosen their own font (page ⋯ menu).">
                  <select aria-label="Writing font" value={writingFont} onChange={(e) => setWritingFont(e.target.value as WritingFont)} className="h-7 rounded-md px-2 text-xs outline-none" style={selectStyle}>
                    <option value="sans">Sans — the interface font</option>
                    <option value="serif">Serif — the editor font</option>
                    <option value="mono">Mono — the code font</option>
                  </select>
                </Row>
                <Row label="Page width" hint="Pages set to Full width keep it.">
                  <select aria-label="Page width" value={pageWidth === "wide" ? "wide" : "standard"} onChange={(e) => setPageWidth(e.target.value as PageWidth)} className="h-7 rounded-md px-2 text-xs outline-none" style={selectStyle}>
                    <option value="standard">Standard</option>
                    <option value="wide">Wide</option>
                  </select>
                </Row>
                <Row label="Font Size" hint="Interface and writing text together.">
                  <div className="flex items-center gap-2">
                    <input aria-label="Font Size" type="range" min={11} max={18} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="w-24" />
                    <span className="text-xs w-8" style={{ color: "var(--text-secondary)" }}>{fontSize}px</span>
                  </div>
                </Row>
              </Section>

              <Section title="Typefaces">
                <Row label="UI Font" hint="Menus, the sidebar and Sans pages.">
                  <select aria-label="UI Font" value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} className="h-7 rounded-md px-2 text-xs outline-none" style={selectStyle}>
                    {FONT_OPTIONS.map((f) => <option key={f} value={f} style={{ background: "var(--bg-elevated)" }}>{f}</option>)}
                  </select>
                </Row>
                <Row label="Editor Font" hint="Serif pages.">
                  <select aria-label="Editor Font" value={editorFontFamily} onChange={(e) => setEditorFontFamily(e.target.value)} className="h-7 rounded-md px-2 text-xs outline-none" style={selectStyle}>
                    {EDITOR_FONT_OPTIONS.map((f) => <option key={f} value={f} style={{ background: "var(--bg-elevated)" }}>{f}</option>)}
                  </select>
                </Row>
                <Row label="Code Font" hint="Code blocks and Mono pages.">
                  <select aria-label="Code Font" value={monoFontFamily} onChange={(e) => setMonoFontFamily(e.target.value)} className="h-7 rounded-md px-2 text-xs outline-none" style={selectStyle}>
                    {MONO_FONT_OPTIONS.map((f) => <option key={f} value={f} style={{ background: "var(--bg-elevated)" }}>{f}</option>)}
                  </select>
                </Row>
              </Section>

              <Section title="Sidebar">
                <Row label="Sidebar Label" hint="The name of the pages section.">
                  <input aria-label="Sidebar Label" value={sidebarLabel} onChange={(e) => setSidebarLabel(e.target.value)}
                    className="h-7 rounded-md px-2 text-xs outline-none w-32" style={selectStyle} placeholder="Projects" />
                </Row>
              </Section>

              <Section title="Motion">
                <ReduceMotionRow />
              </Section>

              <RegionSettings />
            </>
          )}

          {activeTab === "inputs" && (isWeb ? (
            <IntegrationsOverview onNavigate={onClose} />
          ) : config && (
            <>
              <Section title="Core Services">
                <p className="text-[10px] mb-3" style={{ color: "var(--text-muted)" }}>
                  Configure connections to core infrastructure. Changes take effect on restart.
                </p>
                <>
                <ServiceField
                  icon={<Database size={14} />}
                  label="Parachute"
                  desc="Knowledge graph vault"
                  fields={[
                    { key: "parachute_url", label: "URL", value: config.parachute_url as string, placeholder: "http://localhost:1940" },
                    { key: "parachute_api_key", label: "API Key", value: config.parachute_api_key as string, placeholder: "hub JWT (eyJ…) from parachute auth mint-token", sensitive: true, isSet: config.parachute_api_key_set as boolean },
                  ]}
                  isSet={!!(config.parachute_api_key_set)}
                  editValues={editValues}
                  saving={saving}
                  savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))}
                  onSave={handleSave} onClear={handleClear}
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
                  onSave={handleSave} onClear={handleClear}
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
                  icon={<Bot size={14} />}
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
                  onSave={handleSave} onClear={handleClear}
                />
                <ServiceField
                  icon={<Zap size={14} />}
                  label="Prism Server"
                  desc="Live collaboration, sharing and server integrations (the server's COLLAB_TOKEN)"
                  fields={[
                    { key: "collab_url", label: "Collab URL", value: (config.collab_url as string) || "", placeholder: "ws://localhost:8787/collab" },
                    { key: "collab_token", label: "Collab Token", value: "", placeholder: "COLLAB_TOKEN from the server .env", sensitive: true, isSet: config.collab_token_set as boolean },
                  ]}
                  isSet={!!(config.collab_token_set)}
                  editValues={editValues}
                  saving={saving}
                  savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))}
                  onSave={handleSave} onClear={handleClear}
                />
                </>
              </Section>
              <Section title="Meeting Transcripts">
                <p className="text-[10px] mb-3" style={{ color: "var(--text-muted)" }}>
                  Connect transcript services to automatically pull meeting recordings into your vault.
                  {config.ingest_mode === "client"
                    ? "Transcript ingest runs on the Prism Server (this machine is in Client mode), so nothing here starts a sync."
                    : "Transcripts are ingested every 10 minutes and enriched by the meeting processor skill."}
                </p>
                <SourceField icon={<Video size={14} />} label="Fathom" desc="Meeting recording & AI summaries"
                  fieldKey="fathom_api_key" placeholder="Fathom API key" sensitive
                  value={config.fathom_api_key as string} isSet={config.fathom_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} onClear={handleClear} />

                <SourceField icon={<Video size={14} />} label="Read.ai" desc="Meeting copilot & transcription"
                  fieldKey="readai_api_key" placeholder="Read.ai API key" sensitive
                  value={config.readai_api_key as string} isSet={config.readai_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} onClear={handleClear} />

                <SourceField icon={<Mic size={14} />} label="Otter.ai" desc="Meeting notes & transcription"
                  fieldKey="otter_api_key" placeholder="Otter API key" sensitive
                  value={config.otter_api_key as string} isSet={config.otter_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} onClear={handleClear} />

                <SourceField icon={<Mic size={14} />} label="Fireflies.ai" desc="AI meeting assistant"
                  fieldKey="fireflies_api_key" placeholder="Fireflies API key" sensitive
                  value={config.fireflies_api_key as string} isSet={config.fireflies_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} onClear={handleClear} />
              </Section>

              <Section title="Knowledge Sources">
                <SourceField icon={<Cloud size={14} />} label="Notion" desc="Workspace & knowledge base"
                  fieldKey="notion_api_key" placeholder="Notion API key" sensitive
                  value={config.notion_api_key as string} isSet={config.notion_api_key_set as boolean}
                  editValues={editValues} saving={saving} savedKeys={savedKeys}
                  onEdit={(k, v) => setEditValues((prev) => ({ ...prev, [k]: v }))} onSave={handleSave} onClear={handleClear} />
              </Section>
            </>
          ))}

          {activeTab === "ai" && (
            <>
              <Section title="AI Models">
                <p className="text-[10px] mb-3" style={{ color: "var(--text-muted)" }}>
                  Which model answers each kind of request.
                </p>
                {isWeb && host ? (
                  <ServerAiModels host={host} />
                ) : isWeb ? (
                  <DesktopOnlyNotice
                    feature="AI model routing & local models"
                    detail="Only the server owner can route AI models (they run on the Prism Server)."
                  />
                ) : (
                /* Interactive-skill model assignments (provider configured in the Local AI section below) */
                <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--glass-border)" }}>
                  <div className="grid grid-cols-[1fr_100px_1fr] gap-0 px-3 py-1.5" style={{ background: "var(--glass)", borderBottom: "1px solid var(--glass-border)" }}>
                    <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Skill</span>
                    <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Provider</span>
                    <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Model</span>
                  </div>
                  {(["edit", "chat", "transform", "generate"] as const).map((skill) => {
                    const current = skillModels[skill] || { provider: "claude", model: "" };
                    const modelsForProvider = availableModels.filter((m) => m.provider === current.provider);
                    return (
                      <div key={skill} className="grid grid-cols-[1fr_100px_1fr] gap-2 items-center px-3 py-1.5" style={{ borderBottom: "1px solid var(--glass-border)" }}>
                        <span className="text-xs capitalize" style={{ color: "var(--text-primary)" }}>{skill}</span>
                        <select
                          aria-label={`${skill} provider`}
                          value={current.provider}
                          onChange={(e) => handleSkillModelChange(skill, e.target.value, "")}
                          className="h-6 rounded px-1 text-[10px] outline-none"
                          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
                        >
                          <option value="claude" style={{ background: "var(--bg-elevated)" }}>Claude</option>
                          <option value="local" style={{ background: "var(--bg-elevated)" }}>Local</option>
                        </select>
                        <select
                          aria-label={`${skill} model`}
                          value={current.model}
                          onChange={(e) => handleSkillModelChange(skill, current.provider, e.target.value)}
                          className="h-6 rounded px-1 text-[10px] outline-none"
                          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
                        >
                          <option value="" style={{ background: "var(--bg-elevated)" }}>Default</option>
                          {modelsForProvider.map((m) => (
                            <option key={m.id} value={m.id} style={{ background: "var(--bg-elevated)" }}>
                              {m.name}{m.size ? ` (${m.size})` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
                )}
              </Section>

              {!isWeb && config && <LocalAiSettings config={config} onSave={handleSave} saving={saving} savedKeys={savedKeys} />}

              <Section title="Agent context">
                <p className="text-[10px] mb-2" style={{ color: "var(--text-muted)" }}>
                  Context sent to every AI agent session. Describe yourself, your projects, and conventions so skills produce better results.
                </p>
                <div className="rounded-lg" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
                  <button
                    onClick={() => setVaultDescriptionExpanded(!vaultDescriptionExpanded)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-[var(--glass-hover)] transition-colors rounded-lg"
                  >
                    <FileText size={14} style={{ color: "var(--text-secondary)" }} />
                    <div className="flex-1">
                      <div className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>Agent Context</div>
                      <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                        {vaultDescription ? `${vaultDescription.split("\n").length} lines configured` : "Not set — agents have no persistent context"}
                      </div>
                    </div>
                    {vaultDescription ? (
                      <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--color-success)", background: "rgba(34,197,94,0.1)" }}>
                        <Check size={9} /> Set
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text-muted)", background: "var(--glass)" }}>Not configured</span>
                    )}
                  </button>
                  {vaultDescriptionExpanded && (
                    <div className="px-3 pb-3" style={{ borderTop: "1px solid var(--glass-border)" }}>
                      <textarea
                        value={vaultDescriptionDraft}
                        onChange={(e) => setVaultDescriptionDraft(e.target.value)}
                        placeholder={"Describe your vault context for AI agents...\n\nExample:\n- Your name and role\n- Key projects and organizations\n- Important collaborators\n- Tag conventions and path structure\n- Privacy rules"}
                        rows={12}
                        className="w-full mt-2 rounded-md px-3 py-2 text-xs outline-none resize-y"
                        style={{
                          background: "var(--bg-surface)",
                          border: "1px solid var(--glass-border)",
                          color: "var(--text-primary)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "11px",
                          lineHeight: "1.5",
                        }}
                      />
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                          Stored in vault — shared across all agent sessions via MCP
                        </span>
                        <div className="flex items-center gap-2">
                          {vaultDescriptionSaved && (
                            <span className="flex items-center gap-1 text-[10px]" style={{ color: "var(--color-success)" }}>
                              <Check size={9} /> Saved
                            </span>
                          )}
                          {vaultDescriptionDraft !== vaultDescription && (
                            <button
                              onClick={async () => {
                                setVaultDescriptionLoading(true);
                                try {
                                  await vaultClient.updateVaultDescription(vaultDescriptionDraft);
                                  setVaultDescription(vaultDescriptionDraft);
                                  setVaultDescriptionSaved(true);
                                  setTimeout(() => setVaultDescriptionSaved(false), 2000);
                                } catch {
                                  // Error will show in console
                                }
                                setVaultDescriptionLoading(false);
                              }}
                              disabled={vaultDescriptionLoading}
                              className="px-3 py-1 rounded text-[10px] font-medium"
                              style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
                            >
                              {vaultDescriptionLoading ? "Saving..." : "Save"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </Section>

              {account && (
                <Section title="Your own agent">
                  <Row label="Connect Claude or another agent to this workspace" hint="Agent access tokens are kept with your account.">
                    <button type="button" className="focus-ring rounded-lg border border-[var(--glass-border)] px-3 text-sm" onClick={() => setTab("account")}>Open Account</button>
                  </Row>
                </Section>
              )}
            </>
          )}

          {activeTab === "notifications" && (
            <>
              <NotificationSettingsPanel embedded />
              <div className="mt-6"><PushSettings /></div>
            </>
          )}

          {activeTab === "search" && host?.searchIndex && <SearchIndexSettings host={host} />}

          {activeTab === "advanced" && <ServiceHealth />}
          {activeTab === "advanced" && (
            <>
              <Section title="Start-up">
                {/* The whole row is the target (a bare 16px box is too small to tap). */}
                <label className="flex min-h-control items-center justify-between gap-3 text-sm" style={{ color: "var(--text-primary)" }}>
                  <span>Start with last open document<span className="prism-settings__hint">Off: Prism opens on Home.</span></span>
                  <input type="checkbox" aria-label="Start with last open document" checked={startWithLastDocument} onChange={(e) => setStartWithLastDocument(e.target.checked)} className="h-4 w-4" />
                </label>
              </Section>

              {!isWeb && (
                <>
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
                    <input value={newVaultName} onChange={(e) => setNewVaultName(e.target.value)} placeholder="Name" aria-label="Vault name"
                      className="flex-1 h-6 rounded px-2 text-xs outline-none"
                      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
                    <input value={newVaultUrl} onChange={(e) => setNewVaultUrl(e.target.value)} placeholder="http://localhost:1940" aria-label="Vault address"
                      className="flex-1 h-6 rounded px-2 text-xs outline-none"
                      style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }} />
                    <button onClick={() => { if (newVaultName && newVaultUrl) { addVault(newVaultName, newVaultUrl); setNewVaultName(""); setNewVaultUrl(""); } }}
                      aria-label="Add vault" title="Add vault"
                      className="px-2 py-1 rounded text-xs hover:bg-[var(--glass-hover)]" style={{ color: "var(--color-accent)" }}>
                      <Plus size={11} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </Section>

              <Section title="Sync">
                <Row label="Default direction">
                  <select aria-label="Default sync direction" value={defaultSyncDirection} onChange={(e) => setDefaultSyncDirection(e.target.value as "push"|"pull"|"bidirectional")}
                    className="h-7 rounded-md px-2 text-xs outline-none"
                    style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}>
                    <option value="push" style={{ background: "var(--bg-elevated)" }}>Push</option>
                    <option value="pull" style={{ background: "var(--bg-elevated)" }}>Pull</option>
                    <option value="bidirectional" style={{ background: "var(--bg-elevated)" }}>Bidirectional</option>
                  </select>
                </Row>
              </Section>

                  {config && <IngestSettings config={config} onSave={handleSaveRaw} saving={saving} savedKeys={savedKeys} />}
                </>
              )}

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
    </dialog>
  );
}

// ─── Shared Components ──────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="prism-settings__section"><h4>{title}</h4>{children}</section>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="prism-settings__row">
      <span className="text-sm" style={{ color: "var(--text-primary)" }}>
        {label}
        {hint && <span className="prism-settings__hint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

// ─── Ingest mode (host vs client) ────────────────────────────

const INGEST_FLAGS: Array<{ key: string; label: string; desc: string }> = [
  { key: "disable_email_sync", label: "Email sync", desc: "Gmail to vault (every 3 min)" },
  { key: "disable_calendar_sync", label: "Calendar sync", desc: "Google Calendar to vault (every 5 min)" },
  { key: "disable_embedding_index", label: "Embedding index", desc: "Semantic-search indexing (the Prism server also sweeps this)" },
  { key: "disable_skill_scheduler", label: "Skill scheduler", desc: "Runs recurring agent skills on this machine" },
];

function IngestSettings({ config, onSave, saving, savedKeys }: {
  config: Record<string, unknown>;
  onSave: (key: string, value: boolean | string) => void;
  saving: string | null;
  savedKeys: Set<string>;
}) {
  const mode = config.ingest_mode === "client" ? "client" : "host";
  const isClient = mode === "client";

  return (
    <Section title="Ingest mode">
      <p className="text-[10px] mb-3" style={{ color: "var(--text-muted)" }}>
        Only one machine should run background ingest, otherwise mail, calendar and messages are
        imported twice. Changes take effect on restart.
      </p>
      <div className="flex rounded-lg overflow-hidden mb-2" style={{ border: "1px solid var(--glass-border)" }}>
        {([
          ["host", "Host", "This machine runs background sync"],
          ["client", "Client", "This machine only views and edits; background work runs on the Prism server"],
        ] as const).map(([val, label, desc]) => (
          <button
            key={val}
            onClick={() => mode !== val && onSave("ingest_mode", val)}
            disabled={saving === "ingest_mode"}
            title={desc}
            className="flex-1 px-3 py-2 text-xs text-left"
            style={{
              background: mode === val ? "var(--glass-active)" : "transparent",
              color: mode === val ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            <div className="font-medium">{label}</div>
            <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{desc}</div>
          </button>
        ))}
      </div>
      {savedKeys.has("ingest_mode") && (
        <div className="flex items-center gap-1 text-[10px] mb-2" style={{ color: "var(--color-success)" }}>
          <Check size={10} /> Saved. Restart Prism to apply.
        </div>
      )}

      <div style={{ opacity: isClient ? 0.5 : 1 }}>
        <p className="text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>
          {isClient
            ? "Client mode turns every service off here: all ingest runs on the Prism Server. The switches below only apply in Host mode."
            : "Turn individual services off on this machine (for example once the server owns them)."}
        </p>
        {INGEST_FLAGS.map((f) => {
          const disabled = config[f.key] === true;
          return (
            <Row key={f.key} label={f.label}>
              <span className="flex items-center gap-2">
                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{isClient ? "Runs on the Prism Server" : f.desc}</span>
                <button
                  onClick={() => onSave(f.key, !disabled)}
                  disabled={isClient || saving === f.key}
                  className="px-2 py-0.5 rounded text-[10px] font-medium"
                  style={{
                    background: disabled ? "transparent" : "var(--color-accent)",
                    color: disabled ? "var(--text-muted)" : "white",
                    border: "1px solid var(--glass-border)",
                  }}
                  title={disabled ? "Disabled on this machine. Click to enable." : "Runs on this machine. Click to disable."}
                >
                  {isClient ? "Server" : disabled ? "Off" : "On"}
                </button>
                {savedKeys.has(f.key) && <Check size={10} style={{ color: "var(--color-success)" }} />}
              </span>
            </Row>
          );
        })}
      </div>
    </Section>
  );
}

// ─── Local AI (recurring-skill provider) ─────────────────────

function LocalAiSettings({ config, onSave, saving, savedKeys }: {
  config: Record<string, unknown>;
  onSave: (key: string, value: string) => void;
  saving: string | null;
  savedKeys: Set<string>;
}) {
  const provider = (config.background_skill_provider as string) || "claude";
  const baseUrl = (config.local_ai_base_url as string) || "http://localhost:1234/v1";
  const model = (config.local_ai_model as string) || "";

  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [models, setModels] = useState<Array<{ id: string; name: string; size: string | null }>>([]);
  const [status, setStatus] = useState<"unknown" | "ok" | "fail">("unknown");
  const [testing, setTesting] = useState(false);

  // Keep the URL draft in sync when config reloads after a save.
  useEffect(() => { setUrlDraft(baseUrl); }, [baseUrl]);

  // Auto-probe the configured server while the local provider is active.
  useEffect(() => {
    if (provider !== "local") return;
    localAiApi.listModels(baseUrl)
      .then((m) => { setModels(m); setStatus("ok"); })
      .catch(() => setStatus("fail"));
  }, [provider, baseUrl]);

  const test = async () => {
    setTesting(true);
    try {
      const ok = await localAiApi.test(urlDraft);
      setStatus(ok ? "ok" : "fail");
      if (ok) setModels(await localAiApi.listModels(urlDraft));
    } catch {
      setStatus("fail");
    }
    setTesting(false);
  };

  // Show the configured model even if the server isn't reachable to enumerate it.
  const modelInList = models.some((m) => m.id === model);

  return (
    <Section title="Local AI">
      <p className="text-[10px] mb-3" style={{ color: "var(--text-muted)" }}>
        One OpenAI-compatible server (LM Studio, Ollama <code>/v1</code>, llama.cpp…) powers both the
        interactive skills above and recurring background skills. The toggle sets the <strong>default</strong>
        provider for recurring skills (falls back to Claude if the server is unreachable); override it
        per-skill in the Agent panel. Server URL/provider changes take effect on restart.
      </p>

      {/* Default provider toggle for recurring skills */}
      <div className="flex rounded-lg overflow-hidden mb-2" style={{ border: "1px solid var(--glass-border)" }}>
        {([["claude", "Claude (claude -p)", <Bot size={12} key="b" />], ["local", "Local AI", <Zap size={12} key="z" />]] as const).map(([val, label, icon]) => (
          <button
            key={val}
            onClick={() => provider !== val && onSave("background_skill_provider", val)}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs"
            style={{
              background: provider === val ? "var(--glass-active)" : "transparent",
              color: provider === val ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      {provider === "local" && (
        <div className="rounded-lg p-2.5 space-y-2" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)" }}>
          {/* Server URL + status + test */}
          <div className="flex items-center gap-2">
            <Cpu size={14} style={{ color: "var(--text-secondary)" }} />
            <div className="flex-1 text-xs font-medium" style={{ color: "var(--text-primary)" }}>OpenAI-compatible server</div>
            <span className="flex items-center gap-1.5 text-[10px]">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: status === "ok" ? "var(--color-success)" : status === "fail" ? "var(--color-error, #ef4444)" : "var(--text-muted)" }} />
              <span style={{ color: status === "ok" ? "var(--color-success)" : "var(--text-muted)" }}>
                {status === "ok" ? "Connected" : status === "fail" ? "Unreachable" : "Unknown"}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="http://localhost:1234/v1"
              className="flex-1 h-6 rounded px-2 text-[10px] outline-none"
              style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}
            />
            {urlDraft !== baseUrl && (
              <button onClick={() => onSave("local_ai_base_url", urlDraft)} disabled={saving === "local_ai_base_url"}
                className="px-2 py-0.5 rounded text-[10px] font-medium" style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}>
                {saving === "local_ai_base_url" ? "..." : "Save"}
              </button>
            )}
            {savedKeys.has("local_ai_base_url") && <Check size={10} style={{ color: "var(--color-success)" }} />}
            <button onClick={test} disabled={testing}
              className="px-2 py-0.5 rounded text-[10px] font-medium" style={{ color: "var(--color-accent)", border: "1px solid var(--glass-border)" }}>
              {testing ? "..." : "Test"}
            </button>
          </div>

          {/* Model selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] w-12 flex-shrink-0" style={{ color: "var(--text-muted)" }}>Model</span>
            <select
              aria-label="Local model"
              value={model}
              onChange={(e) => onSave("local_ai_model", e.target.value)}
              className="flex-1 h-6 rounded px-1 text-[10px] outline-none"
              style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
            >
              <option value="" style={{ background: "var(--bg-elevated)" }}>Select a model…</option>
              {!modelInList && model && (
                <option value={model} style={{ background: "var(--bg-elevated)" }}>{model} (configured)</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id} style={{ background: "var(--bg-elevated)" }}>
                  {m.name}{m.size ? ` (${m.size})` : ""}
                </option>
              ))}
            </select>
            {savedKeys.has("local_ai_model") && <Check size={10} style={{ color: "var(--color-success)" }} />}
          </div>
          {models.length === 0 && status !== "ok" && (
            <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              Start your local server and click Test to load available models.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

// ─── Service Field (multi-field config card) ─────────────────

/** Write-only secret input: never holds the stored value (the backend returns ""
 *  for every secret + a `<key>_set` flag), always masked, "Remove" clears it. */
function SecretInput({ fieldKey, placeholder, isSet, editValues, saving, savedKeys, onEdit, onSave, onClear, className, style }: {
  fieldKey: string;
  placeholder: string;
  isSet: boolean;
  editValues: Record<string, string>;
  saving: string | null;
  savedKeys: Set<string>;
  onEdit: (key: string, value: string) => void;
  onSave: (key: string, value: string) => void;
  onClear?: (key: string) => void;
  className: string;
  style: React.CSSProperties;
}) {
  const value = editValues[fieldKey] ?? "";
  return (
    <>
      <input
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        onChange={(e) => onEdit(fieldKey, e.target.value)}
        placeholder={isSet ? "configured — enter to replace" : placeholder}
        className={className}
        style={style}
      />
      {value.trim() && (
        <button onClick={() => onSave(fieldKey, value)} disabled={saving === fieldKey}
          className="px-2 py-0.5 rounded text-[10px] font-medium"
          style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}>
          {saving === fieldKey ? "..." : "Save"}
        </button>
      )}
      {isSet && !value && onClear && (
        <button
          onClick={() => { void askConfirm({ title: "Remove this stored credential?", body: "Anything that uses it stops until a new one is saved.", confirm: "Remove", danger: true }).then((yes) => { if (yes) onClear(fieldKey); }); }}
          disabled={saving === fieldKey}
          title="Remove the stored value"
          className="p-1 rounded hover:bg-[var(--glass-hover)]" style={{ color: "var(--text-muted)" }}>
          <Trash2 size={10} />
        </button>
      )}
      {savedKeys.has(fieldKey) && <Check size={10} style={{ color: "var(--color-success)" }} />}
    </>
  );
}

function ServiceField({ icon, label, desc, fields, isSet, editValues, saving, savedKeys, onEdit, onSave, onClear }: {
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
  onClear?: (key: string) => void;
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
            const inputClass = "flex-1 h-6 rounded px-2 text-[10px] outline-none";
            const inputStyle: React.CSSProperties = { background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: f.key.includes("url") || f.key.includes("homeserver") ? "var(--font-mono)" : undefined };
            if (f.sensitive) {
              return (
                <div key={f.key} className="flex items-center gap-1.5 pt-1.5">
                  <span className="text-[10px] w-20 flex-shrink-0" style={{ color: "var(--text-muted)" }}>{f.label}</span>
                  <SecretInput fieldKey={f.key} placeholder={f.placeholder} isSet={!!f.isSet} editValues={editValues} saving={saving}
                    savedKeys={savedKeys} onEdit={onEdit} onSave={onSave} onClear={onClear} className={inputClass} style={inputStyle} />
                </div>
              );
            }
            return (
              <div key={f.key} className="flex items-center gap-1.5 pt-1.5">
                <span className="text-[10px] w-20 flex-shrink-0" style={{ color: "var(--text-muted)" }}>{f.label}</span>
                <input
                  type="text"
                  value={isEditing ? editValues[f.key] : (f.value || "")}
                  onChange={(e) => onEdit(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className={inputClass}
                  style={inputStyle}
                />
                {isEditing && editValues[f.key] && (
                  <button onClick={() => onSave(f.key, editValues[f.key])} disabled={saving === f.key}
                    className="px-2 py-0.5 rounded text-[10px] font-medium"
                    style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}>
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

function SourceField({ icon, label, desc, fieldKey, placeholder, sensitive, value, isSet, editValues, saving, savedKeys, onEdit, onSave, onClear, extra }: {
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
  onClear?: (key: string) => void;
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
        {sensitive ? (
          <SecretInput fieldKey={fieldKey} placeholder={placeholder} isSet={isSet} editValues={editValues} saving={saving}
            savedKeys={savedKeys} onEdit={onEdit} onSave={onSave} onClear={onClear}
            className="flex-1 h-6 rounded px-2 text-[10px] outline-none"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }} />
        ) : (
        <>
        <input
          type="text"
          value={isEditing ? editValues[fieldKey] : (value || "")}
          onChange={(e) => onEdit(fieldKey, e.target.value)}
          placeholder={placeholder}
          className="flex-1 h-6 rounded px-2 text-[10px] outline-none"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--glass-border)", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}
        />
        {extra}
        {isEditing && editValues[fieldKey] && (
          <button onClick={() => onSave(fieldKey, editValues[fieldKey])} disabled={saving === fieldKey}
            className="px-2 py-0.5 rounded text-[10px] font-medium"
            style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}>
            {saving === fieldKey ? "..." : "Save"}
          </button>
        )}
        {isSaved && <Check size={10} style={{ color: "var(--color-success)" }} />}
        </>
        )}
      </div>
    </div>
  );
}

/** NP-AX-06: device-local Reduce motion, on top of the OS preference. */
function ReduceMotionRow() {
  const [reduce, setReduce] = useReduceMotion();
  return (
    <label className="flex min-h-control items-center justify-between gap-4 text-sm" style={{ color: "var(--text-primary)" }}>
      <span>
        <span className="block">Reduce motion</span>
        <span className="block text-xs" style={{ color: "var(--text-muted)", marginTop: 2 }}>Turns off menu, sheet and panel animations on this device. Your system setting is always honoured.</span>
      </span>
      <input type="checkbox" checked={reduce} onChange={(e) => setReduce(e.target.checked)} aria-label="Reduce motion" style={{ width: 16, height: 16, flexShrink: 0, accentColor: "var(--color-accent)" }} />
    </label>
  );
}
