import { useCallback, useEffect, useRef, useState } from "react";
import { UserPlus, Database, ShieldCheck } from "lucide-react";
import { Button } from "../../ui/Button";
import {
  useCollabSharing,
  useVaultChangeSignal,
  type WorkspaceOverview,
  type WorkspaceRole,
  type ShareLevel,
  type SetPersonResult,
} from "../../../data/CollabSharing";
import { useAgentChatStore } from "../../../lib/agent/chatStore";
import {
  ACCESS_LABELS,
  AccessHelp,
  InvitationResult,
} from "./InvitationResult";

type AccessReceipt = {
  who: string;
  vaultId: string;
  vaultLabel: string;
  level: ShareLevel;
  role: WorkspaceRole | "none";
  result: SetPersonResult;
  roleError?: string;
  roleDone: boolean;
};
export function WorkspacePanel() {
  const sharing = useCollabSharing();
  const scope = useAgentChatStore((state) => state.scope);
  const signal = useVaultChangeSignal();
  return (
    <AccessPanel
      key={JSON.stringify([scope, signal])}
      sharing={sharing}
      scope={scope}
    />
  );
}
function AccessPanel({
  sharing,
  scope,
}: {
  sharing: ReturnType<typeof useCollabSharing>;
  scope: string | null;
}) {
  const [data, setData] = useState<WorkspaceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [level, setLevel] = useState<ShareLevel>("edit");
  const [role, setRole] = useState<WorkspaceRole | "none">("none");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<AccessReceipt | null>(null);
  const [removeReceipt, setRemoveReceipt] = useState<{
    who: string;
    vaultId: string;
    vaultLabel: string;
  } | null>(null);
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
    if (!sharing?.getWorkspace) {
      setLoading(false);
      return;
    }
    const read = ++reads.current;
    setLoading(true);
    try {
      const next = await sharing.getWorkspace();
      if (!current() || read !== reads.current) return;
      setData(next);
      setVaultId((previous) =>
        next.vaults.some((vault) => vault.id === previous)
          ? previous
          : (next.vaults[0]?.id ?? ""),
      );
    } catch (cause) {
      if (current() && read === reads.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn't load people and vault access.",
        );
    } finally {
      if (current() && read === reads.current) setLoading(false);
    }
  }, [sharing, current]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (operation: () => Promise<void>) => {
    if (lock.current || !current()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error ? cause.message : "Couldn't update access.",
        );
    } finally {
      lock.current = false;
      if (current()) setBusy(false);
    }
  };
  const completeRole = async (confirmed: AccessReceipt) => {
    if (
      !sharing?.setWorkspaceMemberRole ||
      confirmed.role === "none" ||
      !current()
    )
      return;
    try {
      const result = await sharing.setWorkspaceMemberRole(
        confirmed.who,
        confirmed.vaultId,
        confirmed.role,
      );
      if (!current()) return;
      setReceipt({
        ...confirmed,
        result: result.inviteUrl ? result : confirmed.result,
        roleDone: true,
        roleError: undefined,
      });
    } catch (cause) {
      if (current())
        setReceipt({
          ...confirmed,
          roleDone: false,
          roleError:
            cause instanceof Error
              ? cause.message
              : "The management role could not be saved.",
        });
    }
  };
  const addPerson = () =>
    run(async () => {
      if (!sharing?.setWorkspaceAccess || !email.trim() || !vaultId) return;
      const who = email.trim().toLowerCase();
      const result = await sharing.setWorkspaceAccess(who, vaultId, level);
      if (!current()) return;
      const confirmed: AccessReceipt = {
        who,
        vaultId,
        vaultLabel:
          data?.vaults.find((vault) => vault.id === vaultId)?.label ?? vaultId,
        level,
        role,
        result,
        roleDone: role === "none",
      };
      setReceipt(confirmed);
      setEmail("");
      if (role !== "none") await completeRole(confirmed);
      if (current()) await refresh();
    });
  const removeRole = async (target: {
    who: string;
    vaultId: string;
    vaultLabel: string;
  }) => {
    if (!sharing?.removeWorkspaceMemberRole || !current()) return;
    try {
      await sharing.removeWorkspaceMemberRole(target.vaultId, target.who);
      if (!current()) return;
      setRemoveReceipt(null);
      setNotice(
        `Vault grant and management role removed for ${target.who} in ${target.vaultLabel}. Other document or tag grants may still provide access.`,
      );
    } catch (cause) {
      if (current()) {
        setRemoveReceipt(target);
        setError(
          `The vault-wide grant was removed, but the management role was not confirmed removed. ${cause instanceof Error ? cause.message : "Try removing the role again."}`,
        );
      }
    }
  };
  const removeAccess = (who: string, vid: string) =>
    run(async () => {
      if (!sharing?.removeWorkspaceAccess) return;
      await sharing.removeWorkspaceAccess(vid, who);
      if (!current()) return;
      setReceipt((previous) =>
        previous?.who === who && previous.vaultId === vid ? null : previous,
      );
      const target = {
        who,
        vaultId: vid,
        vaultLabel:
          data?.vaults.find((vault) => vault.id === vid)?.label ?? vid,
      };
      if (sharing.removeWorkspaceMemberRole) await removeRole(target);
      else
        setNotice(
          `Vault-wide grant removed for ${who}. Other grants or roles may still provide access.`,
        );
      if (current()) await refresh();
    });
  if (!sharing?.getWorkspace)
    return (
      <p role="status" className="text-sm text-[var(--text-secondary)]">
        Cross-vault access management is available to the server owner.
      </p>
    );
  const field =
    "focus-ring min-h-11 w-full min-w-0 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-sm";
  const vaults = data?.vaults ?? [];
  return (
    <div className="space-y-6">
      <header>
        <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck size={20} /> People &amp; vault access
        </h2>
        <p className="mb-0 mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
          Choose which vault a person can use. Document access and management
          roles are separate; these changes apply only to the vault you select.
        </p>
      </header>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--glass-border)] p-4 text-sm"
        >
          <p className="mt-0">{error}</p>
          {!removeReceipt && (
            <Button
              className="min-h-11"
              disabled={busy}
              onClick={() => {
                setError("");
                void refresh();
              }}
            >
              Refresh access
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {removeReceipt && (
        <section className="rounded-xl border border-[var(--glass-border)] p-4">
          <p className="mt-0 text-sm">
            The vault grant for {removeReceipt.who} in{" "}
            {removeReceipt.vaultLabel} is removed. Retry only the remaining
            management role.
          </p>
          <Button
            className="min-h-11"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await removeRole(removeReceipt);
                if (current()) await refresh();
              })
            }
          >
            Retry removing role
          </Button>
        </section>
      )}
      {receipt && (
        <div className="space-y-3">
          <p role="status" className="text-sm">
            {ACCESS_LABELS[receipt.level]} granted to {receipt.who} in{" "}
            {receipt.vaultLabel}.
            {receipt.role !== "none" && receipt.roleDone
              ? ` ${receipt.role} role saved.`
              : ""}
          </p>
          <InvitationResult
            key={`${receipt.who}:${receipt.result.inviteUrl ?? "existing"}`}
            who={receipt.who}
            result={receipt.result}
          />
          {receipt.roleError && (
            <section className="rounded-xl border border-[var(--glass-border)] p-4">
              <p role="alert" className="mt-0 text-sm">
                Vault access was granted. The {receipt.role} management role was
                not confirmed saved: {receipt.roleError}
              </p>
              <Button
                className="min-h-11"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await completeRole(receipt);
                    if (current()) await refresh();
                  })
                }
              >
                Retry management role
              </Button>
            </section>
          )}
        </div>
      )}
      {sharing.setWorkspaceAccess && (
        <form
          className="rounded-xl border border-[var(--glass-border)] p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void addPerson();
          }}
        >
          <h3 className="m-0 text-base font-semibold">
            Add someone to a vault
          </h3>
          <p className="mb-4 mt-2 text-sm text-[var(--text-secondary)]">
            Existing accounts receive access. New people get a private
            invitation link for you to share.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              Email
              <input
                type="email"
                required
                className={`${field} mt-2`}
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <label className="text-sm">
              Vault
              <select
                className={`${field} mt-2`}
                value={vaultId}
                disabled={busy || loading}
                onChange={(event) => setVaultId(event.target.value)}
              >
                {!vaults.length && (
                  <option value="">No available vaults</option>
                )}
                {vaults.map((vault) => (
                  <option key={vault.id} value={vault.id}>
                    {vault.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Document access
              <select
                className={`${field} mt-2`}
                value={level}
                disabled={busy}
                onChange={(event) => setLevel(event.target.value as ShareLevel)}
              >
                {Object.entries(ACCESS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {sharing.setWorkspaceMemberRole && (
              <label className="text-sm">
                Management role
                <select
                  className={`${field} mt-2`}
                  value={role}
                  disabled={busy}
                  onChange={(event) =>
                    setRole(event.target.value as WorkspaceRole | "none")
                  }
                >
                  {["none", "member", "admin", "owner"].map((value) => (
                    <option key={value} value={value}>
                      {value === "none"
                        ? "No management role"
                        : value[0].toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <AccessHelp level={level} />
          <Button
            type="submit"
            variant="primary"
            className="mt-4 min-h-11"
            disabled={busy || loading || !email.trim() || !vaultId}
            loading={busy}
          >
            <UserPlus size={16} /> Add person
          </Button>
        </form>
      )}
      {loading && (
        <p role="status" className="text-sm text-[var(--text-muted)]">
          Loading people and access…
        </p>
      )}
      <section className="rounded-xl border border-[var(--glass-border)] p-4 sm:p-5">
        <h3 className="m-0 text-base font-semibold">Current access</h3>
        {!loading && !error && !data?.people.length && (
          <p className="text-sm text-[var(--text-secondary)]">
            No people are listed yet.
          </p>
        )}
        <div className="mt-3 divide-y divide-[var(--glass-border)]">
          {data?.people.map((person) => (
            <article key={person.email} className="py-4">
              <p
                className="m-0 break-words text-sm font-medium"
                style={{ overflowWrap: "anywhere" }}
              >
                {person.name ? `${person.name} · ` : ""}
                {person.email}
                {person.isServerOwner && (
                  <span className="ml-2 text-xs text-[var(--text-muted)]">
                    Server owner
                  </span>
                )}
              </p>
              <div className="mt-2 space-y-2">
                {vaults
                  .filter(
                    (vault) =>
                      person.access[vault.id]?.level ||
                      person.access[vault.id]?.role,
                  )
                  .map((vault) => {
                    const access = person.access[vault.id];
                    return (
                      <div
                        key={vault.id}
                        className="flex flex-wrap items-center gap-2 text-sm"
                      >
                        <Database size={14} />
                        <span className="break-words">{vault.label}</span>
                        {access.level && (
                          <span className="rounded bg-[var(--glass)] px-2 py-1 text-xs">
                            {ACCESS_LABELS[access.level]}
                          </span>
                        )}
                        {access.role && (
                          <span className="text-xs text-[var(--text-muted)]">
                            {access.role} role
                          </span>
                        )}
                        {!person.isServerOwner &&
                          sharing.removeWorkspaceAccess && (
                            <Button
                              variant="ghost"
                              className="min-h-11"
                              disabled={busy}
                              onClick={() =>
                                void removeAccess(person.email, vault.id)
                              }
                              aria-label={`Remove ${person.email} from ${vault.label}`}
                            >
                              Remove access
                            </Button>
                          )}
                      </div>
                    );
                  })}
                {vaults.every(
                  (vault) =>
                    !person.access[vault.id]?.level &&
                    !person.access[vault.id]?.role,
                ) && (
                  <p className="text-xs text-[var(--text-muted)]">
                    No vault-wide grant or management role.
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
