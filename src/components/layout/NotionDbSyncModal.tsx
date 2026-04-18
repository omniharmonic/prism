import { useState, useEffect } from "react";
import {
  X,
  Database,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Check,
  Search,
} from "lucide-react";
import { notionDbSyncApi } from "../../lib/parachute/client";

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

const PARACHUTE_FIELDS = [
  "title",
  "content",
  "metadata.status",
  "metadata.priority",
  "metadata.assignee",
  "metadata.due_date",
  "metadata.url",
  "metadata.tags",
  "metadata.custom",
  "(skip)",
];

const TRANSFORMS = [
  "none",
  "lowercase",
  "date-iso",
  "markdown",
  "csv-to-array",
  "slug",
];

const STEPS = ["Select Database", "Configure Mapping", "Sync Options", "Initial Sync"];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function NotionDbSyncModal({ isOpen, onClose }: NotionDbSyncModalProps) {
  const [step, setStep] = useState(0);
  const [databases, setDatabases] = useState<NotionDatabase[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDb, setSelectedDb] = useState<NotionDatabase | null>(null);
  const [mappings, setMappings] = useState<PropertyMapping[]>([]);
  const [tag, setTag] = useState("task");
  const [savePath, setSavePath] = useState("");
  const [titleProperty, setTitleProperty] = useState("Name");
  const [direction, setDirection] = useState<"bidirectional" | "notion-to-prism" | "prism-to-notion">("bidirectional");
  const [conflictStrategy, setConflictStrategy] = useState<"newer" | "notion" | "parachute">("newer");
  const [autoSync, setAutoSync] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Fetch databases on mount
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    notionDbSyncApi
      .listDatabases()
      .then(setDatabases)
      .catch(() => setDatabases([]))
      .finally(() => setLoading(false));
  }, [isOpen]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setStep(0);
      setSelectedDb(null);
      setMappings([]);
      setSyncResult(null);
      setSyncing(false);
      setSearchQuery("");
    }
  }, [isOpen]);

  async function handleSelectDatabase(db: NotionDatabase) {
    setSelectedDb(db);
    setSavePath(`vault/tasks/${slugify(db.title)}`);
    setLoading(true);
    try {
      const schema = await notionDbSyncApi.getSchema(db.id);
      const mapped: PropertyMapping[] = schema.properties.map(
        (prop) => {
          const suggested = schema.suggestedMappings?.find(
            (s) => s.notionProperty === prop.name
          );
          return {
            notionProperty: prop.name,
            type: prop.propertyType,
            parachuteField: suggested?.parachuteField ?? "(skip)",
            transform: suggested?.transform ?? "identity",
          };
        }
      );
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
    if (!selectedDb) return;
    setSyncing(true);
    try {
      const configId = await notionDbSyncApi.init({
        databaseId: selectedDb.id,
        databaseName: selectedDb.title,
        parachuteTag: tag,
        parachutePathPrefix: savePath,
        propertyMap: mappings.map(m => ({
          notionProperty: m.notionProperty,
          notionType: m.type,
          parachuteField: m.parachuteField,
          transform: m.transform,
        })),
        titleProperty,
        syncDirection: direction,
        conflictStrategy,
        autoSync,
      });
      const result = await notionDbSyncApi.sync(configId);
      setSyncResult(result);
    } catch {
      setSyncResult({ created: 0, updated: 0, deleted: 0, conflicts: 0, errors: ["Sync failed. Check connection and try again."] });
    } finally {
      setSyncing(false);
    }
  }

  const filteredDbs = databases.filter((db) =>
    db.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (!isOpen) return null;

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
                          <select
                            value={mapping.parachuteField}
                            onChange={(e) => updateMapping(i, "parachuteField", e.target.value)}
                            className="w-full px-2 py-1 text-xs rounded bg-white/5 border border-white/10 text-white focus:outline-none focus:border-purple-400/50"
                          >
                            {PARACHUTE_FIELDS.map((f) => (
                              <option key={f} value={f}>{f}</option>
                            ))}
                          </select>
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
                    { value: "notion-to-prism", label: "Notion \u2192 Prism", icon: <ArrowRight className="w-3.5 h-3.5" /> },
                    { value: "prism-to-notion", label: "Prism \u2192 Notion", icon: <ArrowLeft className="w-3.5 h-3.5" /> },
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
                    { value: "newer", label: "Newer Wins" },
                    { value: "notion", label: "Notion Wins" },
                    { value: "parachute", label: "Parachute Wins" },
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
                <span className="text-sm text-white">Auto-sync every 5 minutes</span>
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
                  <span className="text-white capitalize">{conflictStrategy} wins</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Mappings</span>
                  <span className="text-white">
                    {mappings.filter((m) => m.parachuteField !== "(skip)").length} of {mappings.length} fields
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Auto-sync</span>
                  <span className="text-white">{autoSync ? "Every 5 min" : "Off"}</span>
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
