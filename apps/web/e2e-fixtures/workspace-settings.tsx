import React from "react";
import { createRoot } from "react-dom/client";
import { CollabSharingProvider, VaultClientProvider, type CollabSharing, type VaultClient, type WorkspaceRole, type Note } from "@prism/core";
import NetworkRenderer from "../../../packages/core/src/components/renderers/NetworkRenderer";
const params = new URLSearchParams(location.search);
let role: WorkspaceRole = params.has("member") ? "member" : "owner";
const controls = {
  publicationReads: 0,
  demote: () => {
    role = "member";
    window.dispatchEvent(new Event("prism:vault-changed"));
  },
};
Object.assign(window, { prismSettingsFixture: controls });
const unused = async () => { throw Error("Not used by this fixture"); };
const sharing = {
  createShareLink: unused,
  getViewer: async () => ({ role, isServerOwner: role === "owner" }),
  ...(params.has("none") ? {} : {
    publishTag: unused,
    listPublications: async () => { controls.publicationReads++; return []; },
    getNodeIdentity: unused,
    listMembers: async () => [],
    listVaults: async () => [],
    listWorkspaceEntities: async () => [],
    getWorkspace: unused,
    getServerInfo: async () => new Promise(() => {}),
  }),
} as unknown as CollabSharing;
const vault = { scope: () => "settings-fixture", getTags: async () => [] } as unknown as VaultClient;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <VaultClientProvider client={vault}>
      <CollabSharingProvider value={sharing}>
        <main style={{ height: "100dvh" }}>
          <NetworkRenderer note={{} as Note} />
        </main>
      </CollabSharingProvider>
    </VaultClientProvider>
  </React.StrictMode>,
);
