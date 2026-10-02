import React from "react";
import { createRoot } from "react-dom/client";
import {
  CollabSharingProvider,
  PlatformProvider,
  type WorkspaceOverview,
  type WorkspaceMember,
  type WorkspaceGrant,
  type WorkspaceRole,
  type ShareLevel,
} from "@prism/core";
import { useAgentChatStore } from "../../../packages/core/src/lib/agent/chatStore";
import NetworkRenderer from "../../../packages/core/src/components/renderers/NetworkRenderer";
import { WorkspacePanel } from "../../../packages/core/src/components/renderers/network/WorkspacePanel";
const params = new URLSearchParams(location.search);
if (params.has("dark")) document.documentElement.classList.remove("light");
const vaults = [
  { id: "personal", label: "Personal notes", vault: "personal", active: true },
  {
    id: "research",
    label: "Shared research",
    vault: "research",
    active: false,
  },
];
let people: WorkspaceOverview["people"] = [
  {
    email: "avery@example.test",
    name: "Avery Chen",
    isServerOwner: false,
    access: { personal: { level: "edit", role: "member" } },
  },
];
let members: WorkspaceMember[] = [
  {
    email: "avery@example.test",
    name: "Avery Chen",
    role: "member",
    joinedAt: 1,
  },
];
let grants: WorkspaceGrant[] = [
  {
    id: "grant-1",
    subjectType: "user",
    subject: "avery@example.test",
    subjectName: "Avery Chen",
    resourceType: "vault",
    resource: "personal",
    level: "edit",
    grantedBy: null,
    grantedAt: 1,
  },
];
const controls = {
  writes: [] as Array<Record<string, unknown>>,
  accessReads: 0,
  memberReads: 0,
  fail: "",
  failRead: false,
  hold: "",
  release: () => {},
  scope: "access-owner",
  clipboardDenied: true,
  copied: "",
  switchScope: () => {
    controls.scope = "access-other";
    useAgentChatStore.setState({ scope: controls.scope });
  },
};
Object.assign(window, { prismAccess: controls });
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (value: string) => {
      if (controls.clipboardDenied) throw Error("Denied fixture clipboard");
      controls.copied = value;
    },
  },
});
useAgentChatStore.setState({ scope: controls.scope });
async function write(input: Record<string, unknown>) {
  controls.writes.push(input);
  if (controls.hold === input.op)
    await new Promise<void>((resolve) => {
      controls.release = resolve;
    });
  if (controls.fail === input.op) throw Error(`Fixture ${input.op} failed.`);
}
const result = (email: string) =>
  email.startsWith("new")
    ? {
        invited: true,
        inviteUrl: `https://prism.example.test/invite/${encodeURIComponent(email)}`,
      }
    : { invited: false };
const sharing = {
  createShareLink: async () => "",
  getViewer: async () => ({
    email: "owner@example.test",
    vaultId: "personal",
    role: params.has("guest")
      ? ("guest" as const)
      : params.has("members")
        ? ("admin" as const)
        : ("owner" as const),
    isServerOwner: !params.has("guest") && !params.has("members"),
  }),
  listVaults: async () => (controls.scope === "access-owner" ? vaults : []),
  getWorkspace: async () => {
    controls.accessReads++;
    if (controls.failRead) throw Error("Access list unavailable");
    return controls.scope === "access-owner"
      ? structuredClone({ vaults, people })
      : { vaults: [], people: [] };
  },
  setWorkspaceAccess: async (
    email: string,
    vaultId: string,
    level: ShareLevel,
  ) => {
    await write({ op: "access", email, vaultId, level });
    let person = people.find((person) => person.email === email);
    if (!person) {
      person = { email, name: null, isServerOwner: false, access: {} };
      people.push(person);
    }
    person.access[vaultId] = { ...person.access[vaultId], level };
    return result(email);
  },
  setWorkspaceMemberRole: async (
    email: string,
    vaultId: string,
    role: WorkspaceRole,
  ) => {
    await write({ op: "role", email, vaultId, role });
    people.find((person) => person.email === email)!.access[vaultId].role =
      role;
    return result(email);
  },
  removeWorkspaceAccess: async (vaultId: string, email: string) => {
    await write({ op: "remove-access", email, vaultId });
    delete people.find((person) => person.email === email)!.access[vaultId]
      .level;
  },
  removeWorkspaceMemberRole: async (vaultId: string, email: string) => {
    await write({ op: "remove-role", email, vaultId });
    delete people.find((person) => person.email === email)!.access[vaultId]
      .role;
  },
  listMembers: async () => {
    controls.memberReads++;
    if (controls.failRead) throw Error("Members unavailable");
    return controls.scope === "access-owner" ? structuredClone(members) : [];
  },
  listGrants: async () =>
    controls.scope === "access-owner" ? structuredClone(grants) : [],
  setMember: async (email: string, role: WorkspaceRole) => {
    await write({ op: "member", email, role });
    const member = members.find((member) => member.email === email);
    if (member) member.role = role;
    else members.push({ email, name: null, role, joinedAt: 2 });
    return result(email);
  },
  removeMember: async (email: string) => {
    await write({ op: "remove-member", email });
    members = members.filter((member) => member.email !== email);
  },
  setTagPerson: async (tag: string, email: string, level: ShareLevel) => {
    await write({ op: "tag", tag, email, level });
    return result(email);
  },
  setVaultPerson: async (email: string, level: ShareLevel) => {
    await write({ op: "vault", email, level });
    return result(email);
  },
  revokeGrant: async (id: string) => {
    await write({ op: "revoke", id });
    grants = grants.filter((grant) => grant.id !== id);
  },
};
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PlatformProvider value="web">
      <CollabSharingProvider value={params.has("no-provider") ? null : sharing}>
        <main
          style={{
            height: "100dvh",
            background: "var(--bg-base)",
            color: "var(--text-primary)",
          }}
        >
          {params.has("no-provider") ? (
            <WorkspacePanel />
          ) : (
            <NetworkRenderer
              note={{
                id: "network",
                path: null,
                content: "",
                tags: [],
                metadata: null,
                createdAt: "",
                updatedAt: "",
              }}
            />
          )}
        </main>
      </CollabSharingProvider>
    </PlatformProvider>
  </React.StrictMode>,
);
