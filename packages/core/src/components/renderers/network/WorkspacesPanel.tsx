import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, Plus, Database, ArrowRightLeft } from "lucide-react";
import { Button } from "../../ui/Button";
import {
  useCollabSharing,
  useVaultChangeSignal,
  type WorkspaceEntity,
  type VaultSummary,
} from "../../../data/CollabSharing";
import { useAgentChatStore } from "../../../lib/agent/chatStore";

// Reset drafts and receipts when the authenticated audience or active vault changes.
export function WorkspacesPanel() {
  const scope = useAgentChatStore((state) => state.scope);
  const vaultSignal = useVaultChangeSignal();
  const sharing = useCollabSharing();
  return (
    <WorkspaceSetup
      key={JSON.stringify([scope, vaultSignal])}
      sharing={sharing}
      scope={scope}
    />
  );
}
function WorkspaceSetup({
  sharing,
  scope,
}: {
  sharing: ReturnType<typeof useCollabSharing>;
  scope: string | null;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntity[]>([]);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [newName, setNewName] = useState("");
  const [newHost, setNewHost] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [hostEdits, setHostEdits] = useState<Record<string, string>>({});
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const alive = useRef(true);
  const lock = useRef(false);
  const reads = useRef(0);
  const latestSharing = useRef(sharing);
  latestSharing.current = sharing;
  const current = useCallback(
    () =>
      alive.current &&
      latestSharing.current === sharing &&
      useAgentChatStore.getState().scope === scope,
    [sharing, scope],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reads.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!sharing?.listWorkspaceEntities) {
      setLoading(false);
      return;
    }
    const version = ++reads.current;
    setLoading(true);
    setLoadError("");
    try {
      const [nextWorkspaces, nextVaults] = await Promise.all([
        sharing.listWorkspaceEntities(),
        sharing.listVaults?.() ?? Promise.resolve([]),
      ]);
      if (!current() || version !== reads.current) return;
      setWorkspaces(nextWorkspaces);
      setVaults(nextVaults);
    } catch (error) {
      if (current() && version === reads.current)
        setLoadError(
          error instanceof Error ? error.message : "Couldn't load workspaces.",
        );
    } finally {
      if (current() && version === reads.current) setLoading(false);
    }
  }, [sharing, current]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const act = async (
    key: string,
    operation: () => Promise<unknown>,
    success: () => string,
  ) => {
    if (lock.current || !current()) return;
    lock.current = true;
    setPending(key);
    setNotice("");
    setErrors((old) => ({ ...old, [key]: "" }));
    try {
      await operation();
      if (!current()) return;
      setNotice(success());
      await refresh();
    } catch (error) {
      if (current())
        setErrors((old) => ({
          ...old,
          [key]:
            error instanceof Error
              ? error.message
              : "Couldn't save this change. Try again.",
        }));
    } finally {
      lock.current = false;
      if (current()) setPending(null);
    }
  };
  if (!sharing?.listWorkspaceEntities)
    return (
      <p role="status" className="text-sm text-[var(--text-secondary)]">
        Workspace management is available to the server owner.
      </p>
    );
  const field =
    "focus-ring min-h-11 w-full min-w-0 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-sm text-[var(--text-primary)]";
  const actionError = (key: string) =>
    errors[key] ? (
      <p role="alert" className="mt-2 text-sm text-[var(--color-error)]">
        {errors[key]}
      </p>
    ) : null;
  return (
    <div className="space-y-6">
      <header>
        <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
          <Building2 size={20} /> Your workspaces
        </h2>
        <p className="mb-0 mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
          Give each shared space a name, then choose the vaults that belong to
          it. People keep their existing access to each vault.
        </p>
      </header>
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-[var(--glass-border)] px-4 py-3 text-sm"
        >
          {notice}
        </p>
      )}
      {sharing.createWorkspaceEntity && (
        <form
          className="rounded-xl border border-[var(--glass-border)] p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newName.trim() || !sharing.createWorkspaceEntity) return;
            void act(
              "create",
              () =>
                sharing.createWorkspaceEntity!(
                  newName.trim(),
                  newHost.trim() || undefined,
                ),
              () => {
                const name = newName.trim();
                setNewName("");
                setNewHost("");
                return `${name} created. Choose a vault below to start using it.`;
              },
            );
          }}
        >
          <label
            htmlFor="workspace-name"
            className="mb-2 block text-sm font-medium"
          >
            New workspace
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="workspace-name"
              className={`${field} flex-1`}
              placeholder="Name your workspace"
              value={newName}
              disabled={!!pending}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Button
              type="submit"
              variant="primary"
              className="min-h-11 shrink-0"
              disabled={!!pending || !newName.trim()}
              loading={pending === "create"}
            >
              <Plus size={16} /> Create workspace
            </Button>
          </div>
          <details className="mt-4">
            <summary className="focus-ring cursor-pointer py-2 text-sm text-[var(--text-secondary)]">
              Custom address · optional
            </summary>
            <label
              htmlFor="new-workspace-address"
              className="mb-2 mt-2 block text-sm"
            >
              Workspace address
            </label>
            <input
              id="new-workspace-address"
              className={field}
              placeholder="team.example.com"
              value={newHost}
              disabled={!!pending}
              onChange={(event) => setNewHost(event.target.value)}
            />
            <p className="mb-0 mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
              You can add this later. An address also needs DNS and server
              routing configured before it works.
            </p>
          </details>
          {actionError("create")}
        </form>
      )}
      {loading && (
        <p role="status" className="text-sm text-[var(--text-muted)]">
          Loading workspaces…
        </p>
      )}
      {loadError && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--glass-border)] p-4"
        >
          <p className="mt-0 text-sm">{loadError}</p>
          <Button
            className="min-h-11"
            onClick={() => void refresh()}
            disabled={!!pending}
          >
            Try again
          </Button>
        </div>
      )}
      {!loading && !loadError && !workspaces.length && (
        <p className="text-sm text-[var(--text-secondary)]">
          No workspaces yet. Create one above, then choose its vaults.
        </p>
      )}
      {workspaces.map((workspace) => {
        const available = vaults.filter(
          (vault) => !workspace.vaults.some((item) => item.id === vault.id),
        );
        const selected = available.find(
          (vault) => vault.id === moves[workspace.id],
        );
        const source =
          selected &&
          workspaces.find((item) =>
            item.vaults.some((vault) => vault.id === selected.id),
          );
        const key = workspace.id;
        const host = hostEdits[key] ?? workspace.hostname ?? "";
        return (
          <section
            key={key}
            aria-label={`${workspace.name} workspace`}
            className="rounded-xl border border-[var(--glass-border)] p-4 sm:p-5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3
                className="m-0 min-w-0 break-words text-base font-semibold"
                style={{ overflowWrap: "anywhere" }}
              >
                {workspace.name}
              </h3>
              {workspace.isDefault && (
                <span className="rounded-full bg-[var(--glass)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                  Default
                </span>
              )}
            </div>
            <p className="mb-3 mt-1 text-sm text-[var(--text-muted)]">
              {workspace.vaults.length}{" "}
              {workspace.vaults.length === 1 ? "vault" : "vaults"}
            </p>
            {workspace.vaults.length ? (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {workspace.vaults.map((vault) => (
                  <li
                    key={vault.id}
                    className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--glass)] px-3 py-2 text-sm"
                  >
                    <Database size={15} className="shrink-0" />
                    <span
                      className="break-words"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {vault.label}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-[var(--text-secondary)]">
                Choose an existing vault to make this workspace useful. Creating
                a workspace does not create or copy notes.
              </p>
            )}
            {sharing.assignVaultToWorkspaceEntity && !!available.length && (
              <div className="mt-4">
                <label
                  className="mb-2 block text-sm font-medium"
                  htmlFor={`move-vault-${key}`}
                >
                  Move an existing vault here
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <select
                    id={`move-vault-${key}`}
                    className={`${field} flex-1`}
                    value={selected?.id ?? ""}
                    disabled={!!pending || loading || !!loadError}
                    onChange={(event) =>
                      setMoves((old) => ({ ...old, [key]: event.target.value }))
                    }
                  >
                    <option value="">Choose a vault…</option>
                    {available.map((vault) => (
                      <option key={vault.id} value={vault.id}>
                        {vault.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    className="min-h-11"
                    disabled={!selected || !!pending || loading || !!loadError}
                    loading={pending === `move:${key}`}
                    onClick={() => {
                      if (selected)
                        void act(
                          `move:${key}`,
                          () =>
                            sharing.assignVaultToWorkspaceEntity!(
                              key,
                              selected.id,
                            ),
                          () => {
                            setMoves((old) => ({ ...old, [key]: "" }));
                            return `${selected.label} moved to ${workspace.name}.`;
                          },
                        );
                    }}
                  >
                    <ArrowRightLeft size={15} /> Move vault
                  </Button>
                </div>
                {selected && (
                  <p className="mb-0 mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                    Move {selected.label}
                    {source
                      ? ` from ${source.name}`
                      : " from its current workspace"}{" "}
                    to {workspace.name}. Its notes and existing vault
                    permissions stay with it.
                  </p>
                )}
                {actionError(`move:${key}`)}
              </div>
            )}
            {sharing.updateWorkspaceEntity && (
              <details className="mt-4">
                <summary className="focus-ring cursor-pointer py-2 text-sm text-[var(--text-secondary)]">
                  Custom address
                  {workspace.hostname ? ` · ${workspace.hostname}` : ""}
                </summary>
                <label
                  className="mb-2 mt-2 block text-sm"
                  htmlFor={`workspace-host-${key}`}
                >
                  Workspace address
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id={`workspace-host-${key}`}
                    className={`${field} flex-1`}
                    value={host}
                    placeholder="team.example.com"
                    disabled={!!pending}
                    onChange={(event) =>
                      setHostEdits((old) => ({
                        ...old,
                        [key]: event.target.value,
                      }))
                    }
                  />
                  <Button
                    className="min-h-11"
                    disabled={!!pending || host === (workspace.hostname ?? "")}
                    loading={pending === `host:${key}`}
                    onClick={() =>
                      void act(
                        `host:${key}`,
                        () =>
                          sharing.updateWorkspaceEntity!(key, {
                            hostname: host.trim() || null,
                          }),
                        () => {
                          setHostEdits((old) => {
                            const next = { ...old };
                            delete next[key];
                            return next;
                          });
                          return `Address saved for ${workspace.name}.`;
                        },
                      )
                    }
                  >
                    Save address
                  </Button>
                </div>
                <p className="mb-0 mt-2 text-xs text-[var(--text-muted)]">
                  Saving an address does not configure DNS or server routing.
                </p>
                {actionError(`host:${key}`)}
              </details>
            )}
            {!workspace.isDefault && sharing.deleteWorkspaceEntity && (
              <div className="mt-4 border-t border-[var(--glass-border)] pt-3">
                {deleting === key ? (
                  <div>
                    <p className="text-sm">
                      Delete {workspace.name}? Its vaults return to the Default
                      workspace. Notes are kept.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        className="min-h-11"
                        disabled={!!pending}
                        onClick={() => setDeleting(null)}
                      >
                        Keep workspace
                      </Button>
                      <Button
                        className="min-h-11"
                        disabled={!!pending}
                        loading={pending === `delete:${key}`}
                        onClick={() =>
                          void act(
                            `delete:${key}`,
                            () => sharing.deleteWorkspaceEntity!(key),
                            () => {
                              setDeleting(null);
                              return `${workspace.name} deleted. Its vaults are in the Default workspace.`;
                            },
                          )
                        }
                      >
                        Delete workspace
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    disabled={!!pending}
                    onClick={() => setDeleting(key)}
                  >
                    Delete workspace…
                  </Button>
                )}
                {actionError(`delete:${key}`)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
