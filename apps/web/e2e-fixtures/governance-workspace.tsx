import { createRoot } from "react-dom/client";
import { GovernancePanel } from "@prism/core";
import { setServerFetch } from "../../../packages/core/src/lib/transport/serverFetch";
import { applyTheme } from "../../../packages/core/src/app/stores/settings";
import type {
  GovState,
  MyAccess,
  Proposal,
  Policy,
} from "../../../packages/core/src/components/renderers/network/governance/api";
const params = new URLSearchParams(location.search);
applyTheme(params.has("dark") ? "dark" : "light");
const policy: Policy = {
  id: "rule-review",
  action: "edit_note",
  scopeType: "global",
  scope: "",
  thresholdN: 1,
  quorum: 1,
  distinctRequired: false,
  eligibleRole: "Steward",
  windowSeconds: 0,
  autoPublish: true,
};
const state: GovState = {
  enabled: true,
  locked: true,
  isBootstrapOwner: false,
  config: {
    enabled: true,
    bootstrapOwner: "alex@example.test",
    amendPolicy: "rule-review",
    defaultThresholdN: 1,
    defaultEligibleRole: "Steward",
  },
  myPowers: ["moderate"],
  roles: [
    {
      id: "steward",
      name: "Steward",
      powers: ["moderate"],
      scopeType: "global",
      scope: "",
      capabilities: ["view", "comment", "suggest"],
      assigns: [],
    },
  ],
  policies: [policy],
};
const me: MyAccess = {
  subject: "alex@example.test",
  workspaceRole: "member",
  powers: ["moderate"],
  memberships: [{ subject: "alex@example.test", role: "steward" }],
  grants: [
    {
      resource_type: "tag",
      resource: "handbook",
      level: "suggest",
      caps: ["view", "suggest"],
      source: "governance:steward",
      expiresAt: null,
    },
  ],
};
const proposal: Proposal = {
  id: "proposal-intro",
  action: "edit_note",
  target: "handbook",
  state: "open",
  openedBy: "morgan@example.test",
  openedAt: "2026-10-02T10:00:00Z",
};
const controls = {
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  approved: false,
  failWrite: false,
};
Object.assign(window, { governanceFixture: controls });
setServerFetch(async (path, init) => {
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  controls.calls.push({ path, method, body });
  const reply = (data: unknown, status = 200) =>
    Promise.resolve(Response.json(data, { status }));
  if (method !== "GET") {
    if (controls.failWrite)
      return reply({ error: "fixture_write_refused" }, 409);
    if (path.endsWith("/vote")) controls.approved = body.vote === "approve";
    if (path.endsWith("/apply")) proposal.state = "applied";
    return reply({ id: "new-proposal", ok: true });
  }
  if (path === "/api/governance/state") return reply(state);
  if (path === "/api/governance/me") return reply(me);
  if (path === "/api/governance/memberships")
    return reply({ memberships: me.memberships });
  if (path === "/api/governance/proposals")
    return reply({ proposals: [proposal] });
  if (path === "/api/governance/proposals/proposal-intro")
    return reply({
      proposal,
      payload: { content: "This handbook brings shared ideas into practice." },
      votes: controls.approved
        ? [
            {
              proposal: proposal.id,
              voter: me.subject,
              vote: "approve",
              at: proposal.openedAt,
              reason: "Clear and useful.",
            },
          ]
        : [],
      evaluation: {
        policy,
        satisfied: controls.approved,
        approvals: controls.approved ? 1 : 0,
        needed: 1,
        quorumMet: controls.approved,
        participation: controls.approved ? 1 : 0,
        eligibleApprovers: [me.subject],
      },
    });
  if (path === "/api/governance/audit")
    return reply({
      audit: [
        {
          id: "audit-one",
          action: "amend:add_policy",
          actor: "alex@example.test",
          before: "",
          after: "",
          at: proposal.openedAt,
        },
      ],
    });
  if (path === "/api/tags") return reply([{ tag: "handbook", count: 3 }]);
  if (path === "/acl/users") return reply([], 403);
  if (path === "/api/notes/handbook")
    return reply({
      id: "handbook",
      content: "This handbook collects our working principles.",
    });
  if (path.includes("/revisions")) return reply({ revisions: [] });
  return reply({ error: "fixture_unexpected_route" }, 404);
});
createRoot(document.getElementById("root")!).render(
  <main style={{ margin: "auto", maxWidth: 1000, padding: 16 }}>
    <GovernancePanel />
  </main>,
);
