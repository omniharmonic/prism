import { useState } from "react";
import {
  X,
  GitFork,
  GitBranch,
  Key,
  ArrowRight,
  ArrowLeft,
  Loader2,
  Check,
} from "lucide-react";
import { githubSyncApi } from "../../lib/parachute/client";

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
  const [step, setStep] = useState(0);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [commitStrategy, setCommitStrategy] =
    useState<CommitStrategy>("per_save");
  const [conflictStrategy, setConflictStrategy] =
    useState<ConflictStrategy>("local_wins");
  const [autoSync, setAutoSync] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !loading) onClose();
  };

  const handleInit = async () => {
    setLoading(true);
    setError(null);
    try {
      await githubSyncApi.init({
        vaultPath,
        remoteUrl: repoUrl,
        branch,
        authToken: token,
        commitStrategy,
        conflictStrategy,
        autoSync,
      });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync initialization failed");
    } finally {
      setLoading(false);
    }
  };

  const canAdvance =
    step === 0 ? repoUrl.trim() !== "" && token.trim() !== "" : true;

  const commitLabels: Record<CommitStrategy, { label: string; desc: string }> = {
    per_save: {
      label: "Per Save",
      desc: "Commit and push after every save",
    },
    batched: {
      label: "Batched",
      desc: "Batch changes into a single commit on manual sync",
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

        {/* Step 0: Repository */}
        {step === 0 && (
          <div className="space-y-4">
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
            <div className="space-y-1.5">
              <label className={labelClass}>Personal Access Token</label>
              <div className="relative">
                <Key className="absolute left-3 top-2.5 w-4 h-4 text-white/30" />
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_..."
                  className={`${inputClass} pl-9`}
                />
              </div>
              <p className="text-xs text-white/30">
                Create a PAT at github.com/settings/tokens with repo scope
              </p>
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
              <span className="text-sm text-white">Enable auto-sync</span>
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
