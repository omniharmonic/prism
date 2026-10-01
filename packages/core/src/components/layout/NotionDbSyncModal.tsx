import { useState, useEffect, useCallback } from "react";
import {
  X,
  Database,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Check,
  Search,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useNotionDbSyncApi } from "../../lib/host/folderSync";
import { hostServiceErrorText, type NotionDbSyncInfo } from "../../lib/host/services";
import { DesktopOnlyNotice } from "../ui/DesktopOnlyNotice";

interface NotionDbSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface NotionDatabase {
  id: string;
  title: string;
  propertyCount: number;
}

interface PropertyMapping {
  notionProperty: string;
  type: string;
  parachuteField: string;
  transform: string;
}

interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
  errors: string[];
}

// Suggestions for the vault-side field (any metadata key is accepted).
// "content" makes the property the note body; "(skip)" leaves it out.
const PARACHUTE_FIELDS = [
  "(skip)",
  "content",
  "status",
  "priority",
  "assignee",
  "due",
  "url",
  "category",
  "project",
];

// The adapter's transform vocabulary (Notion → vault; reversed on push).
const TRANSFORMS = [
  "identity",
  "slugify",
  "value_map",
  "date_extract",
  "people_extract",
  "relation_to_links",
];

const STEPS = ["Select Database", "Configure Mapping", "Sync Options", "Initial Sync"];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function NotionDbSyncModal({ isOpen, onClose }: NotionDbSyncModalProps) {
  // Desktop → its Tauri commands; web / Prism Client → the Prism Server (owner),
  // with the server's stored Notion token (Client parity B).
  const { api, viaServer } = useNotionDbSyncApi();
  const [step, setStep] = useState(0);
  const [databases, setDatabases] = useState<NotionDatabase[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDb, setSelectedDb] = useState<NotionDatabase | null>(null);
  const [mappings, setMappings] = useState<PropertyMapping[]>([]);
  const [tag, setTag] = useState("task");
  const [savePath, setSavePath] = useState("");
  const [titleProperty, setTitleProperty] = useState("Name");
  const [direction, setDirection] = useState<"bidirectional" | "pull" | "push">("bidirectional");
  const [conflictStrategy, setConflictStrategy] = useState<"newer-wins" | "notion-wins" | "parachute-wins">("newer-wins");
  const [autoSync, setAutoSync] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [existing, setExisting] = useState<NotionDbSyncInfo[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const errText = (e: unknown) => (viaServer ? hostServiceErrorText(e) : e instanceof Error ? e.message : String(e));

  const refreshExisting = useCallback(async () => {
    if (!api) return;
    try {
      setExisting(await api.status());
    } catch {
      setExisting([]);
    }
  }, [api]);

  // Fetch databases + existing syncs on open
  useEffect(() => {
    if (!isOpen || !api) return;
    setLoading(true);
    setLoadError(null);
    api
      .listDatabases()
      .then(setDatabases)
      .catch((e) => {
        setDatabases([]);
        setLoadError(viaServer ? hostServiceErrorText(e) : null);
      })
      .finally(() => setLoading(false));
    void refreshExisting();
  }, [isOpen, api, viaServer, refreshExisting]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setStep(0);
      setSelectedDb(null);
      setMappings([]);
      setSyncResult(null);
      setSyncing(false);
      setSearchQuery("");
      setNotice(null);
    }
  }, [isOpen]);

  async function handleSelectDatabase(db: NotionDatabase) {
    if (!api) return;
    setSelectedDb(db);
    setSavePath(`vault/tasks/${slugify(db.title)}`);
    setLoading(true);
    try {
      const schema = await api.getSchema(db.id);
      const mapped: PropertyMapping[] = schema.properties
        .filter((prop) => prop.propertyType !== "title")
        .map((prop) => {
          const suggested = schema.suggestedMappings?.find(
            (s) => s.notionProperty === prop.name
          );
          return {
            notionProperty: prop.name,
            type: prop.propertyType,
            parachuteField: suggested?.parachuteField ?? "(skip)",
            transform: suggested?.transform ?? "identity",
          };
        });
      setMappings(mapped);
      const titleProp = schema.properties.find(
        (p) => p.propertyType === "title"
      );
      if (titleProp) setTitleProperty(titleProp.name);
    } catch {
      setMappings([]);
    } finally {
      setLoading(false);
      setStep(1);
    }
  }

  function updateMapping(index: number, field: keyof PropertyMapping, value: string) {
    setMappings((prev) =>
      prev.map((m, i) => (i === index ? { ...m, [field]: value } : m))
    );
  }

  async function handleStartSync() {
    if (!selectedDb || !api) return;
    setSyncing(true);
    try {
      const content = mappings.find((m) => m.parachuteField === "content");
      const configId = await api.init({
        databaseId: selectedDb.id,
        databaseName: selectedDb.title,
        parachuteTag: tag,
        parachutePathPrefix: savePath,
        propertyMap: mappings
          .filter((m) => m.parachuteField && m.parachuteField !== "(skip)" && m.parachuteField !== "content")
          .map(m => ({
            notionProperty: m.notionProperty,
            notionType: m.type,
            parachuteField: m.parachuteField,
            transform: m.transform,
          })),
        titleProperty,
        ...(content ? { contentProperty: content.notionProperty } : {}),
        syncDirection: direction,
        conflictStrategy,
        autoSync,
      });
      const result = await api.sync(configId);
      setSyncResult(result);
      void refreshExisting();
    } catch (e) {
      setSyncResult({ created: 0, updated: 0, deleted: 0, conflicts: 0, errors: [viaServer ? errText(e) : "Sync failed. Check connection and try again."] });
    } finally {
      setSyncing(false);
    }
  }

  const manage = async (id: string, what: "sync" | "auto-on" | "auto-off" | "remove") => {
    if (!api) return;
    setBusyId(id);
    setNotice(null);
    try {
      if (what === "sync") {
        const r = await api.sync(id);
        setNotice(`Created ${r.created}, updated ${r.updated}, ${r.conflicts} conflict(s)` + (r.unchanged !== undefined ? `, ${r.unchanged} unchanged` : "") + (r.errors.length ? `; ${r.errors[0]}` : ""));
      } else if (what === "remove") {
        await api.remove(id);
      } else if (api.update) {
        await api.update(id, { autoSync: what === "auto-on" });
      }
      await refreshExisting();
    } catch (e) {
      setNotice(errText(e));
    } finally {
      setBusyId(null);
    }
  };

  const filteredDbs = databases.filter((db) =>
    db.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (!isOpen) return null;

  if (!api) {
    return (
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div className="bg-[#1a1a2e]/90 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl max-w-lg w-full p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Database className="w-5 h-5 text-purple-400" />
              <h2 className="text-lg font-semibold text-white">Notion Database Sync</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/60 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <DesktopOnlyNotice
            feature="Notion database sync"
            detail="Database sync runs on the Prism Server with its stored Notion token, so only the server owner can set it up. Per-note Notion sync works from the note's Sync panel."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#1a1a2e]/90 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <Database className="w-5 h-5 text-purple-400" />
            <h2 className="text-lg font-semibold text-white">Notion Database Sync</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 px-6 py-3 border-b border-white/5">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full transition-colors ${
                  i === step
                    ? "bg-purple-400"
                    : i < step
                      ? "bg-purple-400/50"
                      : "bg-white/20"
                }`}
              />
              <span
                className={`text-xs transition-colors ${
                  i === step ? "text-white" : "text-white/40"
                }`}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <ArrowRight className="w-3 h-3 text-white/20 mx-1" />
              )}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* Step 0: Select Database */}
          {step === 0 && (
            <div className="space-y-3">
              {existing.length > 0 && (
                <div className="p-3 rounded-lg bg-white/5 border border-white/10 space-y-2">
                  <div className="text-xs text-white/50 uppercase tracking-wider">Active database syncs</div>
                  {existing.map((c) => (
                    <div key={c.id} className="text-sm text-white space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          {c.notionDatabaseName} <span className="text-white/40">→ #{c.parachuteTag} · {c.syncedCount} rows</span>
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => manage(c.id, "sync")}
                            disabled={busyId !== null}
                            className="px-2 py-1 rounded text-xs bg-white/10 hover:bg-white/20 disabled:opacity-40 flex items-center gap-1"
                          >
                            {busyId === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Sync now
                          </button>
                          <button
                            onClick={() => manage(c.id, "remove")}
                            disabled={busyId !== null}
                            aria-label="Remove sync"
                            className="p-1 rounded text-white/50 hover:text-red-300 hover:bg-white/10 disabled:opacity-40"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-xs text-white/40">
                        <span>{c.lastSynced ? `Last synced ${new Date(c.lastSynced).toLocaleString()}` : "Never synced"}</span>
                        {api.update && (
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={c.autoSync}
                              disabled={busyId !== null}
                              onChange={(e) => manage(c.id, e.target.checked ? "auto-on" : "auto-off")}
                              className="accent-purple-500"
                            />
                            Auto-sync
                          </label>
                        )}
                      </div>
                      {c.lastError && <div className="text-xs text-red-300/80 truncate">{c.lastError}</div>}
                    </div>
                  ))}
                  {notice && <p className="text-xs text-white/60">{notice}</p>}
                </div>
              )}
              {loadError && <p className="text-xs text-red-300">{loadError}</p>}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                <input
                  type="text"
                  placeholder="Search databases..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:border-purple-400/50"
                />
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
                </div>
              ) : filteredDbs.length === 0 ? (
                <p className="text-sm text-white/40 text-center py-8">
                  {searchQuery ? "No databases match your search." : "No Notion databases found."}
                </p>
              ) : (
                <div className="space-y-2">
                  {filteredDbs.map((db) => (
                    <button
                      key={db.id}
                      onClick={() => handleSelectDatabase(db)}
                      className="w-full p-3 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 cursor-pointer transition-colors text-left flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <Database className="w-4 h-4 text-purple-400/70" />
                        <span className="text-sm text-white">{db.title}</span>
                      </div>
                      <span className="text-xs text-white/40">
                        {db.propertyCount} properties
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 1: Configure Mapping */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-white/50 mb-1">Tag</label>
                  <input
                    type="text"
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-400/50"
                  />
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">Save Path</label>
                  <input
                    type="text"
                    value={savePath}
                    onChange={(e) => setSavePath(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-400/50"
                  />
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1">Title Property</label>
                  <input
                    type="text"
                    value={titleProperty}
                    onChange={(e) => setTitleProperty(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-400/50"
                  />
                </div>
              </div>

              <div className="border border-white/10 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-white/5">
                      <th className="text-left px-3 py-2 text-white/50 font-medium">Notion Property</th>
                      <th className="text-left px-3 py-2 text-white/50 font-medium">Type</th>
                      <th className="px-2 py-2 text-white/20">&rarr;</th>
                      <th className="text-left px-3 py-2 text-white/50 font-medium">Parachute Field</th>
                      <th className="text-left px-3 py-2 text-white/50 font-medium">Transform</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map((mapping, i) => (
                      <tr key={mapping.notionProperty} className="border-t border-white/5">
                        <td className="px-3 py-2 text-white">{mapping.notionProperty}</td>
                        <td className="px-3 py-2 text-white/50">{mapping.type}</td>
                        <td className="px-2 py-2 text-center">
                          <ArrowRight className="w-3 h-3 text-white/20 inline" />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            list="notion-db-parachute-fields"
                            value={mapping.parachuteField}
                            onChange={(e) => updateMapping(i, "parachuteField", e.target.value)}
                            placeholder="(skip)"
                            className="w-full px-2 py-1 text-xs rounded bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-400/50"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={mapping.transform}
                            onChange={(e) => updateMapping(i, "transform", e.target.value)}
                            className="w-full px-2 py-1 text-xs rounded bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-400/50"
                          >
                            {TRANSFORMS.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <datalist id="notion-db-parachute-fields">
                  {PARACHUTE_FIELDS.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </div>
            </div>
          )}

          {/* Step 2: Sync Options */}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm text-white/70 mb-3">Sync Direction</label>
                <div className="space-y-2">
                  {([
                    { value: "bidirectional", label: "Bidirectional", icon: <><ArrowLeft className="w-3.5 h-3.5" /><ArrowRight className="w-3.5 h-3.5" /></> },
                    { value: "pull", label: "Notion \u2192 Prism", icon: <ArrowRight className="w-3.5 h-3.5" /> },
                    { value: "push", label: "Prism \u2192 Notion", icon: <ArrowLeft className="w-3.5 h-3.5" /> },
                  ] as const).map((opt) => (
                    <label
                      key={opt.value}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        direction === opt.value
                          ? "bg-purple-400/10 border-purple-400/30"
                          : "bg-white/5 border-white/10 hover:bg-white/10"
                      }`}
                    >
                      <input
                        type="radio"
                        name="direction"
                        value={opt.value}
                        checked={direction === opt.value}
                        onChange={() => setDirection(opt.value)}
                        className="sr-only"
                      />
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        direction === opt.value ? "border-purple-400" : "border-white/30"
                      }`}>
                        {direction === opt.value && <div className="w-2 h-2 rounded-full bg-purple-400" />}
                      </div>
                      <div className="flex items-center gap-1.5 text-white/50">{opt.icon}</div>
                      <span className="text-sm text-white">{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm text-white/70 mb-3">Conflict Resolution</label>
                <div className="space-y-2">
                  {([
                    { value: "newer-wins", label: "Newer Wins" },
                    { value: "notion-wins", label: "Notion Wins" },
                    { value: "parachute-wins", label: "Parachute Wins" },
                  ] as const).map((opt) => (
                    <label
                      key={opt.value}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        conflictStrategy === opt.value
                          ? "bg-purple-400/10 border-purple-400/30"
                          : "bg-white/5 border-white/10 hover:bg-white/10"
                      }`}
                    >
                      <input
                        type="radio"
                        name="conflict"
                        value={opt.value}
                        checked={conflictStrategy === opt.value}
                        onChange={() => setConflictStrategy(opt.value)}
                        className="sr-only"
                      />
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        conflictStrategy === opt.value ? "border-purple-400" : "border-white/30"
                      }`}>
                        {conflictStrategy === opt.value && <div className="w-2 h-2 rounded-full bg-purple-400" />}
                      </div>
                      <span className="text-sm text-white">{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10 cursor-pointer hover:bg-white/10 transition-colors">
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={(e) => setAutoSync(e.target.checked)}
                  className="sr-only"
                />
                <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                  autoSync ? "bg-purple-400 border-purple-400" : "border-white/30"
                }`}>
                  {autoSync && <Check className="w-3 h-3 text-white" />}
                </div>
                <span className="text-sm text-white">{viaServer ? "Auto-sync in the background (every 10 min, when the server has NOTION_DB_SYNC_ENABLED)" : "Auto-sync every 5 minutes"}</span>
              </label>
            </div>
          )}

          {/* Step 3: Initial Sync */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-white/5 border border-white/10 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-white/50">Database</span>
                  <span className="text-white">{selectedDb?.title}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Tag</span>
                  <span className="text-white">{tag}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Save Path</span>
                  <span className="text-white font-mono text-xs">{savePath}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Direction</span>
                  <span className="text-white capitalize">{direction.replace(/-/g, " ")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Conflicts</span>
                  <span className="text-white capitalize">{conflictStrategy.replace("-", " ")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Mappings</span>
                  <span className="text-white">
                    {mappings.filter((m) => m.parachuteField !== "(skip)").length} of {mappings.length} fields
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Auto-sync</span>
                  <span className="text-white">{autoSync ? (viaServer ? "Background" : "Every 5 min") : "Off"}</span>
                </div>
              </div>

              {syncResult ? (
                <div className="p-4 rounded-lg bg-green-400/10 border border-green-400/20 space-y-2">
                  <div className="flex items-center gap-2 text-green-400">
                    <Check className="w-4 h-4" />
                    <span className="text-sm font-medium">Sync Complete</span>
                  </div>
                  <p className="text-sm text-white/70">
                    Created {syncResult.created}, Updated {syncResult.updated}, Deleted {syncResult.deleted}, {syncResult.conflicts} conflicts
                  </p>
                  {syncResult.errors.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {syncResult.errors.map((err, i) => (
                        <p key={i} className="text-xs text-red-400">{err}</p>
                      ))}
                    </div>
                  )}
                </div>
              ) : syncing ? (
                <div className="flex items-center justify-center gap-3 py-6">
                  <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                  <span className="text-sm text-white/60">Syncing...</span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10">
          <div>
            {step > 0 && step < 3 && (
              <button
                onClick={() => setStep(step - 1)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
            )}
          </div>
          <div>
            {step === 1 && (
              <button
                onClick={() => setStep(2)}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-purple-500 hover:bg-purple-400 text-white transition-colors"
              >
                Next
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
            {step === 2 && (
              <button
                onClick={() => setStep(3)}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-purple-500 hover:bg-purple-400 text-white transition-colors"
              >
                Review
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
            {step === 3 && !syncResult && (
              <button
                onClick={handleStartSync}
                disabled={syncing}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-purple-500 hover:bg-purple-400 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {syncing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    Start Sync
                    <ArrowRight className="w-3.5 h-3.5" />
                  </>
                )}
              </button>
            )}
            {step === 3 && syncResult && (
              <button
                onClick={onClose}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-purple-500 hover:bg-purple-400 text-white transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
