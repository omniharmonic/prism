import React from "react";
import { createRoot } from "react-dom/client";
import {
  CollabSharingProvider,
  PlatformProvider,
  type CollabSharing,
} from "@prism/core";
import { useAgentChatStore } from "../../../packages/core/src/lib/agent/chatStore";
import NetworkRenderer from "../../../packages/core/src/components/renderers/NetworkRenderer";
import { ServerPanel } from "../../../packages/core/src/components/renderers/network/ServerPanel";
const params = new URLSearchParams(location.search);
if (params.has("dark")) document.documentElement.classList.remove("light");
const controls = {
  vault: "personal",
  writes: [] as Record<string, unknown>[],
  reads: [] as string[],
  fail: "",
  failedKinds: params.has("unavailable") ? ["matrix"] : ([] as string[]),
  hold: "",
  release: null as null | (() => void),
  switchScope() {
    controls.vault = "research";
    useAgentChatStore.setState({ scope: "connections-research" });
    window.dispatchEvent(new Event("prism:vault-changed"));
  },
};
Object.assign(window, { prismConnections: controls });
useAgentChatStore.setState({ scope: "connections-personal" });
async function write(op: string, body: Record<string, unknown> = {}) {
  controls.writes.push({ op, ...body, vault: controls.vault });
  if (controls.hold === op)
    await new Promise<void>((resolve) => (controls.release = resolve));
  if (controls.fail === op)
    throw Error(`Fixture ${op} failed; settings were not confirmed.`);
}
const sharing = {
  createShareLink: async () => "",
  getViewer: async () => ({
    email: "owner@example.test",
    role: params.has("member")
      ? "member"
      : params.has("admin")
        ? "admin"
        : "owner",
    isServerOwner: !params.has("admin") && !params.has("member"),
  }),
  getActiveVault: () => controls.vault,
  getServerInfo: async () => {
    controls.reads.push("server");
    if (params.has("admin")) throw Error("403 forbidden");
    return {
      appOrigin: "https://prism.example.test",
      port: 3000,
      ownerEmail: "owner@example.test",
      parachuteUrl: "http://127.0.0.1:3333",
      parachuteVault: controls.vault,
      vaultCount: 2,
      federationEnabled: false,
      trustLocal: false,
      secretsAvailable: true,
      emailConfigured: true,
      magicFrom: "Prism <prism@example.test>",
      integrations: { matrix: true, github: true },
      tunnel: {
        managed: true,
        name: "prism-tunnel",
        status: "online",
        hostname: "prism.example.test",
        restarts: 0,
      },
      tokens: [
        {
          id: "vault-token",
          vault: "Personal notes",
          expiresAt: "2026-12-01",
          daysLeft: 60,
          status: "ok",
          rotatable: true,
        },
      ],
    };
  },
  getIntegrationStatus: async (kind: string) => {
    const vault = controls.vault;
    controls.reads.push(`${vault}:${kind}`);
    if (controls.hold === "read:" + kind && vault === "personal")
      await new Promise<void>((resolve) => (controls.release = resolve));
    if (controls.failedKinds.includes(kind))
      throw Error("503 status_unavailable");
    return {
      configured: vault === "personal",
      secretsAvailable: true,
      ...(kind === "clickup"
        ? { teamId: "team-7", spaceIds: "space-a,space-b", assignedOnly: false }
        : {}),
      ...(kind === "proton-bridge"
        ? {
            mode: "shadow",
            username: "bridge@example.test",
            host: "127.0.0.1",
            port: 1143,
            security: "starttls",
          }
        : {}),
      ...(kind === "matrix"
        ? {
            homeserver: "https://matrix.example.test",
            accessToken: "MUST-NEVER-PREFILL",
          }
        : {}),
    };
  },
  setIntegrationCredential: async (
    kind: string,
    body: Record<string, unknown>,
  ) => {
    await write("save", { kind, body });
  },
  deleteIntegrationCredential: async (kind: string) => {
    await write("remove", { kind });
  },
  syncIntegration: async (kind: string) => {
    await write("sync", { kind });
    return { imported: 3, updated: 1 };
  },
  integrationAction: async (
    kind: string,
    action: string,
    body: Record<string, unknown>,
  ) => {
    await write("detect", { kind, action, body });
    return {
      certSha256: "a".repeat(64),
      subject: "Proton Bridge",
      issuer: "Proton Bridge",
      validTo: "2027-10-02",
    };
  },
  getWorkerHealth: async () => ({
    sources: [
      {
        name: "Transcript linking",
        kind: "server",
        vaultId: controls.vault,
        lastSuccessAt: "2026-10-02T15:50:00Z",
        lastError: null,
        failureStreak: 0,
        staleAfterMs: 900000,
        status: "ok",
      },
      {
        name: "Calendar",
        kind: "desktop",
        vaultId: controls.vault,
        lastSuccessAt: null,
        lastError: "Calendar source has not reported recent notes.",
        failureStreak: 2,
        staleAfterMs: 900000,
        status: "stale",
      },
    ],
    checkedAt: "2026-10-02T16:00:00Z",
  }),
  getTunnelIngress: async () => ({
    tunnelId: "tunnel",
    missing: ["research.example.test"],
    routeDnsCommands: [
      "cloudflared tunnel route dns tunnel research.example.test",
    ],
  }),
  applyTunnelIngress: async () => {
    await write("ingress");
    return { added: ["research.example.test"] };
  },
  controlTunnel: async (action: string) => {
    await write("tunnel", { action });
    return {
      tunnel: {
        managed: true,
        name: "prism-tunnel",
        status: action === "stop" ? "stopped" : "online",
        hostname: "prism.example.test",
      },
    };
  },
  setServerConfig: async (key: string, value: string) => {
    await write("config", { key, value });
    return { restartRequired: true };
  },
  setVaultToken: async (id: string, token: string) => {
    await write("token", { id, token });
  },
  getLegacyMcpTokens: async () => ({
    tokens: [
      {
        jti: "old-token-id",
        email: "guest@example.test",
        vaultLabel: "Personal notes",
        scope: "vault:personal:write",
        createdAt: 1,
        expiresAt: 1999999999999,
      },
    ],
  }),
  revokeLegacyMcpTokens: async (body: Record<string, unknown>) => {
    await write("legacy", { body });
    return {
      wouldRevoke: 1,
      affected: [{ email: "guest@example.test", tokens: ["old-token-id"] }],
      revoked: ["old-token-id"],
      failed: [],
      notified: body.notify ? ["guest@example.test"] : [],
    };
  },
} as unknown as CollabSharing;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.origin,
  );
  if (
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/acl/") ||
    url.pathname.startsWith("/auth/")
  )
    throw Error("External access disabled in fixture");
  return originalFetch(input, init);
};
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PlatformProvider value="web">
      <CollabSharingProvider value={params.has("absent") ? null : sharing}>
        {params.has("admin") ? (
          <main style={{ maxWidth: 880, margin: "0 auto", padding: 20 }}>
            <ServerPanel />
          </main>
        ) : (
          <div style={{ height: "100dvh" }}>
            <NetworkRenderer
              note={{
                id: "network",
                path: "Network",
                content: "",
                tags: [],
                metadata: {},
                createdAt: "",
                updatedAt: "",
              }}
            />
          </div>
        )}
      </CollabSharingProvider>
    </PlatformProvider>
  </React.StrictMode>,
);
