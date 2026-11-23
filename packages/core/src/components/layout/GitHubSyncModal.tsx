import { useState, useEffect, useCallback } from "react";
import {
  X,
  GitFork,
  GitBranch,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Check,
  Circle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useGitHubSyncApi } from "../../lib/host/folderSync";
import { hostServiceErrorText, type GitHubSyncInfo } from "../../lib/host/services";
import { DesktopOnlyNotice } from "../ui/DesktopOnlyNotice";

import { formatDateTime as fmtDateTime } from "../../lib/datetime/format";
interface GitHubSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  vaultPath: string;
}

type CommitStrategy = "per_save" | "batched" | "manual";
type ConflictStrategy = "local_wins" | "remote_wins";

const inputClass =
  "w-full px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/20";
const labelClass = "text-xs font-medium text-white/50 uppercase tracking-wider";

export function GitHubSyncModal({
  isOpen,
  onClose,
  vaultPath,
}: GitHubSyncModalProps) {
  // Desktop → its Tauri commands; web / Prism Client → the Prism Server (owner),
  // which pushes with ITS stored GitHub token (Client parity B).
  const { api, viaServer } = useGitHubSyncApi();
  const [step, setStep] = useState(0);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [commitStrategy, setCommitStrategy] =
    useState<CommitStrategy>("per_save");
  const [conflictStrategy, setConflictStrategy] =
    useState<ConflictStrategy>("local_wins");
  const [autoSync, setAutoSync] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Auth state (gh CLI on the desktop, the stored token on the server)
  const [authChecking, setAuthChecking] = useState(false);
  const [authStatus, setAuthStatus] = useState<{
    authenticated: boolean;
    username: string | null;
    message: string;
  } | null>(null);

  // Existing syncs of THIS folder (manage: push now, auto-sync, remove).
  const [existing, setExisting] = useState<GitHubSyncInfo[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const errText = (e: unknown) => (viaServer ? hostServiceErrorText(e) : e instanceof Error ? e.message : String(e));

  const refreshExisting = useCallback(async () => {
    if (!api) return;
    try {
      const all = await api.status();
      setExisting(all.filter((c) => c.vaultPath.replace(/\/+$/, "") === vaultPath.replace(/\/+$/, "")));
    } catch {
      setExisting([]);
    }
  }, [api, vaultPath]);

  // Check auth + load existing syncs when the modal opens
  useEffect(() => {
    if (!isOpen || !api) return;
    let cancelled = false;

    async function checkAuth() {
      setAuthChecking(true);
      try {
        const status = await api!.checkAuth();
        if (!cancelled) setAuthStatus(status);
      } catch {
        if (!cancelled)
          setAuthStatus({
            authenticated: false,
            username: null,
            message: viaServer ? "Could not reach the Prism Server." : "Could not reach GitHub CLI. Is `gh` installed?",
          });
      } finally {
        if (!cancelled) setAuthChecking(false);
      }
    }

    checkAuth();
    void refreshExisting();
    return () => { cancelled = true; };
  }, [isOpen, api, viaServer, refreshExisting]);

  if (!isOpen) return null;

  if (!api) {
    return (
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="bg-[#1a1a2e]/90 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2 text-white">
              <GitFork className="w-5 h-5" />
              <span className="text-sm font-medium">Sync to GitHub</span>
            </div>
            <button onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          <DesktopOnlyNotice
            feature="GitHub sync"
            detail="Folder sync runs on the Prism Server with its stored GitHub token, so only the server owner can set it up."
          />
        </div>
      </div>
    );
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !loading) onClose();
  };

  const handleInit = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.init({
        vaultPath,
        remoteUrl: repoUrl,
        branch,
        commitStrategy,
        conflictStrategy,
        autoSync,
      });
      setSuccess(true);
      void refreshExisting();
    } catch (err) {
      setError(viaServer ? hostServiceErrorText(err) : err instanceof Error ? err.message : "Sync initialization failed");
    } finally {
      setLoading(false);
    }
  };

  const manage = async (id: string, what: "push" | "auto-on" | "auto-off" | "remove") => {
    setBusyId(id);
    setNotice(null);
    try {
      if (what === "push") {
        const r = await api.push(id);
        setNotice(
          `Pushed ${r.pushed.length} file(s)` +
            (r.unchanged !== undefined ? `, ${r.unchanged} unchanged` : "") +
            (r.conflicts.length ? `, ${r.conflicts.length} conflict(s) kept on GitHub` : "") +
            (r.errors.length ? `, ${r.errors.length} error(s): ${r.errors[0]![0]}: ${r.errors[0]![1]}` : ""),
        );
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

  const ghAuthenticated = authStatus?.authenticated ?? false;
  const canAdvance =
    step === 0 ? repoUrl.trim() !== "" && ghAuthenticated : true;

  const commitLabels: Record<CommitStrategy, { label: string; desc: string }> = {
    per_save: {
      label: "Per Save",
      desc: viaServer ? "Auto-sync pushes saved notes within ~30 s, one commit per batch" : "Commit and push after every save",
    },
    batched: {
      label: "Batched",
      desc: viaServer ? "Auto-sync batches changes into one commit per window; Push now any time" : "Batch changes into a single commit on manual sync",
    },
    manual: {
      label: "Manual",
      desc: "Only sync when you trigger it",
    },
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      <div className="bg-[#1a1a2e]/90 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl max-w-lg w-full mx-4 p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2 text-white">
            <GitFork className="w-5 h-5" />
            <span className="text-sm font-medium">Sync to GitHub</span>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-white/40 hover:text-white/80 transition-colors disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step dots */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`w-2 h-2 rounded-full transition-colors ${
                i === step ? "bg-blue-400" : i < step ? "bg-blue-400/40" : "bg-white/15"
              }`}
            />
          ))}
        </div>

        {/* Step 0: Repository + Auth */}
        {step === 0 && (
          <div className="space-y-4">
            {/* Existing syncs of this folder */}
            {existing.length > 0 && (
              <div className="rounded-lg bg-white/5 border border-white/10 p-3 space-y-2">
                <label className={`${labelClass} block`}>Already syncing</label>
                {existing.map((c) => (
                  <div key={c.id} className="text-sm text-white space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{c.remoteUrl.replace(/^https:\/\/github\.com\//, "")} @ {c.branch}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => manage(c.id, "push")}
                          disabled={busyId !== null}
                          className="px-2 py-1 rounded text-xs bg-white/10 hover:bg-white/20 disabled:opacity-40 flex items-center gap-1"
                        >
                          {busyId === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                          Push now
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
                      <span>{c.lastSynced ? `Last synced ${fmtDateTime(new Date(c.lastSynced))}` : "Never synced from here"}</span>
                      {api.update && (
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={c.autoSync}
                            disabled={busyId !== null}
                            onChange={(e) => manage(c.id, e.target.checked ? "auto-on" : "auto-off")}
                            className="accent-blue-500"
                          />
                          Auto-sync
                        </label>
                      )}
                    </div>
                    {c.repoPrivate === false && (
                      <div className="text-xs text-amber-300">
                        Public repository: every note in this folder is published.{c.allowPublic ? "" : " Auto-sync stays off unless you opt in (allowPublic)."}
                      </div>
                    )}
                    {c.lastError && <div className="text-xs text-red-300/80 truncate">{c.lastError}</div>}
                  </div>
                ))}
                {notice && <p className="text-xs text-white/60">{notice}</p>}
              </div>
            )}

            {/* Auth status: gh CLI (desktop) or the server's stored token */}
            <div className="rounded-lg bg-white/5 border border-white/10 p-3">
              <label className={`${labelClass} mb-2 block`}>{viaServer ? "GitHub token (Prism Server)" : "GitHub CLI"}</label>
              {authChecking ? (
                <div className="flex items-center gap-2 text-white/50 text-sm">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Checking authentication...
                </div>
              ) : authStatus?.authenticated ? (
                <div className="flex items-center gap-2 text-sm">
                  <Circle className="w-2.5 h-2.5 fill-emerald-400 text-emerald-400" />
                  <span className="text-emerald-400">
                    Authenticated as @{authStatus.username ?? "unknown"}
                  </span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <Circle className="w-2.5 h-2.5 fill-red-400 text-red-400" />
                    <span className="text-red-400">Not authenticated</span>
                  </div>
                  {viaServer ? (
                    <p className="text-xs text-white/40">
                      {authStatus?.message ?? "No GitHub token on the server."} Store one in Network → Server → Sync integrations, then reopen this dialog.
                    </p>
                  ) : (
                    <p className="text-xs text-white/40">
                      Run <code className="px-1.5 py-0.5 rounded bg-white/10 text-white/70 font-mono text-[11px]">gh auth login</code> in your terminal, then reopen this dialog.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className={labelClass}>Repository URL</label>
              <div className="relative">
                <GitFork className="absolute left-3 top-2.5 w-4 h-4 text-white/30" />
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/user/repo"
                  className={`${inputClass} pl-9`}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className={labelClass}>Branch</label>
              <div className="relative">
                <GitBranch className="absolute left-3 top-2.5 w-4 h-4 text-white/30" />
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className={`${inputClass} pl-9`}
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Sync Options */}
        {step === 1 && (
          <div className="space-y-5">
            <div className="space-y-2">
              <label className={labelClass}>Commit Strategy</label>
              {(Object.keys(commitLabels) as CommitStrategy[]).map((key) => (
                <label
                  key={key}
                  className="flex items-start gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer"
                >
                  <input
                    type="radio"
                    name="commit"
                    checked={commitStrategy === key}
                    onChange={() => setCommitStrategy(key)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <div>
                    <div className="text-sm text-white">{commitLabels[key].label}</div>
                    <div className="text-xs text-white/40">{commitLabels[key].desc}</div>
                  </div>
                </label>
              ))}
            </div>
            <div className="space-y-2">
              <label className={labelClass}>Conflict Strategy</label>
              {(["local_wins", "remote_wins"] as ConflictStrategy[]).map((key) => (
                <label
                  key={key}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer"
                >
                  <input
                    type="radio"
                    name="conflict"
                    checked={conflictStrategy === key}
                    onChange={() => setConflictStrategy(key)}
                    className="accent-blue-500"
                  />
                  <span className="text-sm text-white">
                    {key === "local_wins" ? "Local Wins" : "Remote Wins"}
                  </span>
                </label>
              ))}
            </div>
            <label className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer">
              <input
                type="checkbox"
                checked={autoSync}
                onChange={(e) => setAutoSync(e.target.checked)}
                className="accent-blue-500"
              />
              <span className="text-sm text-white">{viaServer ? "Enable auto-sync (the server pushes saved notes in this folder)" : "Enable auto-sync"}</span>
            </label>
          </div>
        )}

        {/* Step 2: Confirm & Sync */}
        {step === 2 && (
          <div className="space-y-4">
            {!success ? (
              <>
                <div className="rounded-lg bg-white/5 border border-white/10 p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-white/50">Repository</span>
                    <span className="text-white truncate ml-4 max-w-[250px]">{repoUrl}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/50">Branch</span>
                    <span className="text-white">{branch}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/50">Commit</span>
                    <span className="text-white">{commitLabels[commitStrategy].label}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/50">Conflicts</span>
                    <span className="text-white">
                      {conflictStrategy === "local_wins" ? "Local Wins" : "Remote Wins"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/50">Auto-sync</span>
                    <span className="text-white">{autoSync ? "Enabled" : "Disabled"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/50">Path</span>
                    <span className="text-white truncate ml-4 max-w-[250px]">{vaultPath}</span>
                  </div>
                </div>
                {error && (
                  <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}
                <button
                  onClick={handleInit}
                  disabled={loading}
                  className="w-full px-4 py-2 rounded-lg bg-blue-500/80 text-white text-sm hover:bg-blue-500 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Initializing...
                    </>
                  ) : (
                    "Initialize Sync"
                  )}
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center">
                  <Check className="w-5 h-5 text-emerald-400" />
                </div>
                <p className="text-sm text-white">Sync initialized successfully</p>
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg bg-white/10 text-white/70 text-sm hover:bg-white/20 transition-colors"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        )}

        {/* Navigation */}
        {!success && (
          <div className="flex justify-between mt-6 pt-4 border-t border-white/5">
            {step > 0 ? (
              <button
                onClick={() => setStep(step - 1)}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-white/10 text-white/70 text-sm hover:bg-white/20 transition-colors flex items-center gap-1.5 disabled:opacity-30"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
            ) : (
              <div />
            )}
            {step < 2 && (
              <button
                onClick={() => setStep(step + 1)}
                disabled={!canAdvance}
                className="px-4 py-2 rounded-lg bg-blue-500/80 text-white text-sm hover:bg-blue-500 transition-colors flex items-center gap-1.5 disabled:opacity-30"
              >
                Next
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
