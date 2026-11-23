import React from "react";
import { createRoot } from "react-dom/client";
import {
  CollabSharingProvider,
  PlatformProvider,
  type WorkspaceEntity,
} from "@prism/core";
import { useAgentChatStore } from "../../../packages/core/src/lib/agent/chatStore";
import NetworkRenderer from "../../../packages/core/src/components/renderers/NetworkRenderer";
import { WorkspacesPanel } from "../../../packages/core/src/components/renderers/network/WorkspacesPanel";
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
let workspaces: WorkspaceEntity[] = [
  {
    id: "default",
    name: "Personal workspace",
    hostname: null,
    isDefault: true,
    vaults,
  },
  {
    id: "team",
    name: "Field research collective and collaborative planning",
    hostname: null,
    isDefault: false,
    vaults: [],
  },
];
const controls = {
  writes: [] as unknown[],
  reads: 0,
  fail: false,
  failList: params.has("load-error"),
  hold: false,
  release: () => {},
  scope: "setup-owner",
  switchScope: () => {
    controls.scope = "setup-other";
    useAgentChatStore.setState({ scope: controls.scope });
  },
  snapshot: () => workspaces,
};
Object.assign(window, { prismSetup: controls });
useAgentChatStore.setState({ scope: controls.scope });
async function write(input: unknown) {
  controls.writes.push(input);
  if (controls.hold)
    await new Promise<void>((resolve) => {
      controls.release = resolve;
    });
  if (controls.fail) throw Error("The fixture could not save this change.");
}
const sharing = {
  createShareLink: async () => "",
  getViewer: async () => ({
    email: "owner@example.test",
    vaultId: "personal",
    role: params.has("guest") ? ("guest" as const) : ("owner" as const),
    isServerOwner: !params.has("guest"),
  }),
  listWorkspaceEntities: async () => {
    controls.reads++;
    if (controls.failList) throw Error("Workspaces unavailable. Try again.");
    return controls.scope === "setup-owner"
      ? structuredClone(workspaces)
      : [
          {
            id: "new",
            name: "Another audience",
            hostname: null,
            isDefault: true,
            vaults: [],
          },
        ];
  },
  listVaults: async () => (controls.scope === "setup-owner" ? vaults : []),
  createWorkspaceEntity: async (name: string, hostname?: string) => {
    await write({ op: "create", name, hostname: hostname ?? null });
    const workspace = {
      id: `workspace-${workspaces.length}`,
      name,
      hostname: hostname ?? null,
      isDefault: false,
      vaults: [],
    };
    workspaces = [...workspaces, workspace];
    return workspace;
  },
  updateWorkspaceEntity: async (
    id: string,
    patch: { name?: string; hostname?: string | null },
  ) => {
    await write({ op: "update", id, patch });
    const workspace = workspaces.find((item) => item.id === id)!;
    Object.assign(workspace, patch);
    return workspace;
  },
  assignVaultToWorkspaceEntity: async (id: string, vaultId: string) => {
    await write({ op: "move", id, vaultId });
    for (const workspace of workspaces)
      workspace.vaults = workspace.vaults.filter(
        (vault) => vault.id !== vaultId,
      );
    workspaces
      .find((item) => item.id === id)!
      .vaults.push(vaults.find((vault) => vault.id === vaultId)!);
  },
  deleteWorkspaceEntity: async (id: string) => {
    await write({ op: "delete", id });
    workspaces[0].vaults.push(
      ...workspaces.find((item) => item.id === id)!.vaults,
    );
    workspaces = workspaces.filter((item) => item.id !== id);
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
            <WorkspacesPanel />
          ) : (
            <NetworkRenderer
              note={{
                id: "network",
                content: "",
                path: null,
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
