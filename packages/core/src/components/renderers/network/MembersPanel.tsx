import { useCallback, useEffect, useRef, useState } from "react";
import { Users, UserPlus, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "../../ui/Button";
import {
  useCollabSharing,
  useVaultChangeSignal,
  type WorkspaceMember,
  type WorkspaceGrant,
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
const ROLES: WorkspaceRole[] = ["guest", "member", "admin", "owner"];

/** Existing tree/tag deep links still prefill the tag form. */
export function MembersPanel({ initialTag = "" }: { initialTag?: string }) {
  const sharing = useCollabSharing();
  const scope = useAgentChatStore((state) => state.scope);
  const signal = useVaultChangeSignal();
  return (
    <VaultMembers
      key={JSON.stringify([scope, signal])}
      sharing={sharing}
      scope={scope}
      initialTag={initialTag}
    />
  );
}
function VaultMembers({
  sharing,
  scope,
  initialTag,
}: {
  sharing: ReturnType<typeof useCollabSharing>;
  scope: string | null;
  initialTag: string;
}) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [grants, setGrants] = useState<WorkspaceGrant[]>([]);
  const [vaultLabel, setVaultLabel] = useState("the active vault");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invitation, setInvitation] = useState<{
    who: string;
    result: SetPersonResult;
  } | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [tag, setTag] = useState(initialTag);
  const [tagEmail, setTagEmail] = useState("");
  const [tagLevel, setTagLevel] = useState<ShareLevel>("edit");
  const [vaultEmail, setVaultEmail] = useState("");
  const [vaultLevel, setVaultLevel] = useState<ShareLevel>("edit");
  const [pending, setPending] = useState<string | null>(null);
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
  useEffect(() => {
    if (initialTag) setTag(initialTag);
  }, [initialTag]);
  const refresh = useCallback(async () => {
    if (!sharing?.listMembers) {
      setLoading(false);
      return;
    }
    const read = ++reads.current;
    setLoading(true);
    try {
      const [nextMembers, nextGrants, vaults] = await Promise.all([
        sharing.listMembers(),
        sharing.listGrants?.() ?? Promise.resolve([]),
        sharing.listVaults?.().catch(() => []) ?? Promise.resolve([]),
      ]);
      if (!current() || read !== reads.current) return;
      setMembers(nextMembers);
      setGrants(nextGrants);
      setVaultLabel(
        vaults.find((vault) => vault.active)?.label ?? "the active vault",
      );
    } catch (cause) {
      if (current() && read === reads.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn't load members and grants.",
        );
    } finally {
      if (current() && read === reads.current) setLoading(false);
    }
  }, [sharing, current]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const act = async (
    key: string,
    operation: () => Promise<SetPersonResult | void>,
    success: () => string,
    who?: string,
  ) => {
    if (lock.current || !current()) return;
    lock.current = true;
    setPending(key);
    setError("");
    setNotice("");
    try {
      const result = await operation();
      if (!current()) return;
      if (who && result) setInvitation({ who, result });
      setNotice(success());
      await refresh();
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn't save this change. Your draft is kept.",
        );
    } finally {
      lock.current = false;
      if (current()) setPending(null);
    }
  };
  if (!sharing?.listMembers)
    return (
      <p role="status" className="text-sm text-[var(--text-secondary)]">
        Member management is available to vault owners and administrators.
      </p>
    );
  const field =
    "focus-ring min-h-control w-full min-w-0 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-sm";
  const card = "rounded-xl border border-[var(--glass-border)] p-4 sm:p-5";
  const levels = Object.entries(ACCESS_LABELS).map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
  return (
    <div className="space-y-6">
      <header>
        <h2 className="m-0 flex items-center gap-2 text-lg font-semibold">
          <Users size={20} /> Members &amp; sharing
        </h2>
        <p className="mb-0 mt-2 break-words text-sm text-[var(--text-secondary)]">
          Manage people and grants for {vaultLabel}. Roles, tag grants and
          vault-wide access are separate.
        </p>
      </header>
      {error && (
        <div role="alert" className={card}>
          <p className="mt-0 text-sm">{error}</p>
          <Button
            className="min-h-control"
            disabled={!!pending}
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            Refresh access
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {invitation && (
        <InvitationResult
          key={`${invitation.who}:${invitation.result.inviteUrl ?? "existing"}`}
          who={invitation.who}
          result={invitation.result}
        />
      )}
      {sharing.setMember && (
        <form
          className={card}
          onSubmit={(event) => {
            event.preventDefault();
            const who = email.trim().toLowerCase();
            if (!who) return;
            void act(
              "invite",
              () => sharing.setMember!(who, role),
              () => {
                setEmail("");
                return `${role} membership saved for ${who} in ${vaultLabel}.`;
              },
              who,
            );
          }}
        >
          <h3 className="m-0 text-base font-semibold">Invite a member</h3>
          <p className="mb-4 mt-2 text-sm text-[var(--text-secondary)]">
            Choose their role in this vault. New accounts receive an invitation
            link for you to share.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              Member email
              <input
                type="email"
                required
                className={`${field} mt-2`}
                value={email}
                disabled={!!pending}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <label className="text-sm">
              Member role
              <select
                className={`${field} mt-2`}
                value={role}
                disabled={!!pending}
                onChange={(event) =>
                  setRole(event.target.value as WorkspaceRole)
                }
              >
                {ROLES.filter((value) => value !== "owner").map((value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button
            type="submit"
            variant="primary"
            className="mt-4 min-h-control"
            disabled={!!pending || !email.trim()}
            loading={pending === "invite"}
          >
            <UserPlus size={16} /> Invite member
          </Button>
        </form>
      )}
      <section className={card}>
        <h3 className="m-0 text-base font-semibold">Current members</h3>
        {loading && (
          <p role="status" className="text-sm text-[var(--text-muted)]">
            Loading members…
          </p>
        )}
        {!loading && !error && !members.length && (
          <p className="text-sm text-[var(--text-secondary)]">
            No members listed for this vault.
          </p>
        )}
        <div className="mt-3 divide-y divide-[var(--glass-border)]">
          {members.map((member) => (
            <div
              key={member.email}
              className="flex flex-wrap items-center gap-3 py-3"
            >
              <p
                className="m-0 min-w-0 flex-1 break-words text-sm"
                style={{ minWidth: 140, overflowWrap: "anywhere" }}
              >
                {member.name ? `${member.name} · ` : ""}
                {member.email}
              </p>
              <select
                className={`${field} sm:max-w-36`}
                value={member.role}
                disabled={!!pending || !sharing.setMember}
                aria-label={`Role for ${member.email}`}
                onChange={(event) => {
                  const nextRole = event.target.value as WorkspaceRole;
                  void act(
                    `role:${member.email}`,
                    () => sharing.setMember!(member.email, nextRole),
                    () => `Role updated for ${member.email}.`,
                  );
                }}
              >
                {ROLES.map((value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
              {sharing.removeMember && (
                <Button
                  variant="ghost"
                  className="min-h-control"
                  disabled={!!pending}
                  aria-label={`Remove member ${member.email}`}
                  onClick={() =>
                    void act(
                      `remove:${member.email}`,
                      () => sharing.removeMember!(member.email),
                      () =>
                        `Membership removed for ${member.email}. Other grants may still provide access.`,
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>
      {sharing.setTagPerson && (
        <form
          className={card}
          onSubmit={(event) => {
            event.preventDefault();
            const who = tagEmail.trim().toLowerCase();
            if (!who || !tag.trim()) return;
            void act(
              "tag",
              () => sharing.setTagPerson!(tag.trim(), who, tagLevel),
              () => {
                setTagEmail("");
                return `Tag #${tag.trim()} shared with ${who}.`;
              },
              who,
            );
          }}
        >
          <h3 className="m-0 text-base font-semibold">
            Share notes with a tag
          </h3>
          <p className="mb-4 mt-2 text-sm text-[var(--text-secondary)]">
            This grant applies to notes carrying the tag, including future
            notes. It does not grant access to an untagged folder path;
            private-note rules still apply.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm">
              Tag
              <input
                className={`${field} mt-2`}
                value={tag}
                required
                disabled={!!pending}
                onChange={(event) => setTag(event.target.value)}
                placeholder="projects"
              />
            </label>
            <label className="text-sm">
              Recipient email
              <input
                type="email"
                required
                className={`${field} mt-2`}
                value={tagEmail}
                disabled={!!pending}
                onChange={(event) => setTagEmail(event.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <label className="text-sm">
              Tag access
              <select
                className={`${field} mt-2`}
                value={tagLevel}
                disabled={!!pending}
                onChange={(event) =>
                  setTagLevel(event.target.value as ShareLevel)
                }
              >
                {levels}
              </select>
            </label>
          </div>
          <AccessHelp level={tagLevel} />
          <Button
            type="submit"
            className="mt-4 min-h-control"
            disabled={!!pending || !tag.trim() || !tagEmail.trim()}
            loading={pending === "tag"}
          >
            <KeyRound size={16} /> Share tagged notes
          </Button>
        </form>
      )}
      {sharing.setVaultPerson && (
        <form
          className={card}
          onSubmit={(event) => {
            event.preventDefault();
            const who = vaultEmail.trim().toLowerCase();
            if (!who) return;
            void act(
              "vault",
              () => sharing.setVaultPerson!(who, vaultLevel),
              () => {
                setVaultEmail("");
                return `Vault-wide grant saved for ${who} in ${vaultLabel}.`;
              },
              who,
            );
          }}
        >
          <h3 className="m-0 text-base font-semibold">
            Grant vault-wide access
          </h3>
          <p className="mb-4 mt-2 text-sm text-[var(--text-secondary)]">
            Grant document access across {vaultLabel} without adding a
            management role. Private-note rules still apply.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              Vault recipient email
              <input
                type="email"
                required
                className={`${field} mt-2`}
                value={vaultEmail}
                disabled={!!pending}
                onChange={(event) => setVaultEmail(event.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <label className="text-sm">
              Vault access
              <select
                className={`${field} mt-2`}
                value={vaultLevel}
                disabled={!!pending}
                onChange={(event) =>
                  setVaultLevel(event.target.value as ShareLevel)
                }
              >
                {levels}
              </select>
            </label>
          </div>
          <AccessHelp level={vaultLevel} />
          <Button
            type="submit"
            className="mt-4 min-h-control"
            disabled={!!pending || !vaultEmail.trim()}
            loading={pending === "vault"}
          >
            <ShieldCheck size={16} /> Grant vault access
          </Button>
        </form>
      )}
      {sharing.listGrants && (
        <section className={card}>
          <h3 className="m-0 text-base font-semibold">Current grants</h3>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Removing one grant may leave access through other grants or
            management roles.
          </p>
          {!loading && !error && !grants.length && (
            <p className="text-sm text-[var(--text-muted)]">
              No grants listed for this vault.
            </p>
          )}
          <div className="divide-y divide-[var(--glass-border)]">
            {grants.map((grant) => (
              <div
                key={grant.id}
                className="flex flex-wrap items-center gap-3 py-3 text-sm"
              >
                <div
                  className="min-w-0 flex-1 break-words"
                  style={{ minWidth: 140, overflowWrap: "anywhere" }}
                >
                  <p className="m-0">
                    {grant.subjectType === "user"
                      ? `${grant.subjectName ? `${grant.subjectName} · ` : ""}${grant.subject}`
                      : `${grant.subjectType}${grant.subject && grant.subject !== "*" ? ` · ${grant.subject.slice(0, 10)}` : ""}`}
                  </p>
                  <p className="mb-0 mt-1 text-xs text-[var(--text-secondary)]">
                    {grant.resourceType === "vault"
                      ? "This vault"
                      : `${grant.resourceType} · ${grant.resource}`}{" "}
                    · {ACCESS_LABELS[grant.level]}
                  </p>
                </div>
                {sharing.revokeGrant && (
                  <Button
                    variant="ghost"
                    className="min-h-control"
                    disabled={!!pending}
                    aria-label={`Revoke grant for ${grant.subject}`}
                    onClick={() =>
                      void act(
                        `revoke:${grant.id}`,
                        () => sharing.revokeGrant!(grant.id),
                        () =>
                          "Grant removed. Other grants or roles may still provide access.",
                      )
                    }
                  >
                    Revoke grant
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
