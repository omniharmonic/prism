// Constitution starting points. A blank governance form is a research project;
// a template is a commons you can read in one sentence and then argue with. Each
// one PRE-FILLS the builder — nothing here is applied until you have edited it and
// pressed through the wizard, and every field stays editable in step 2.
//
// The three are ordered by how much the commons trusts a crowd: one curator, a
// reviewed commons with a gardening tier, and an open commons where newcomers can
// contribute and gardeners can staff them.
import type { Policy, Role } from "./api";

export type RoleDraft = Omit<Role, "id"> & { id?: string };
export type PolicyDraft = Omit<Policy, "id"> & { id?: string };
export interface MemberDraft {
  subject: string;
  role: string;
}

export interface Template {
  id: string;
  name: string;
  summary: string;
  /** What a would-be member should expect day to day. */
  feel: string;
  roles: RoleDraft[];
  policies: PolicyDraft[];
  /** The role the bootstrap owner joins (it must be the one that can amend). */
  ownerRole: string;
}

const ALL_CAPS = ["view", "comment", "suggest", "edit", "create", "organize", "delete", "share"];
const ALL_POWERS = ["publish", "assign_roles", "manage_policy", "invite", "revoke", "amend_governance"];
const CONTRIBUTOR_CAPS = ["view", "comment", "suggest", "edit", "create"];
const NEWCOMER_CAPS = ["view", "comment", "suggest", "create"];

const steward = (): RoleDraft => ({
  name: "steward",
  powers: [...ALL_POWERS],
  scopeType: "global",
  scope: "",
  capabilities: [...ALL_CAPS],
  assigns: [],
});

const policy = (p: Partial<PolicyDraft> & { action: string; eligibleRole: string }): PolicyDraft => ({
  scopeType: "global",
  scope: "",
  thresholdN: 1,
  quorum: 0,
  distinctRequired: true,
  windowSeconds: 0,
  autoPublish: false,
  ...p,
});

export const TEMPLATES: Template[] = [
  {
    id: "solo",
    name: "Solo curator",
    summary: "One steward holds every power. Changes take effect as soon as you make them.",
    feel: "You are the commons. Good for a personal wiki you may later open up — the constitution exists, it just has one signatory.",
    roles: [steward()],
    policies: [policy({ action: "amend_governance", eligibleRole: "steward", thresholdN: 1 })],
    ownerRole: "steward",
  },
  {
    id: "reviewed",
    name: "Reviewed commons",
    summary: "Stewards govern; gardeners tend the content. One gardener's approval publishes an edit.",
    feel: "Contributors propose, a gardener signs off, the change goes live immediately. Constitutional changes still need a steward.",
    roles: [
      steward(),
      {
        name: "gardener",
        powers: ["publish"],
        scopeType: "global",
        scope: "",
        capabilities: [...CONTRIBUTOR_CAPS],
        assigns: [],
      },
    ],
    policies: [
      policy({ action: "amend_governance", eligibleRole: "steward", thresholdN: 1 }),
      policy({ action: "edit_note", eligibleRole: "gardener", thresholdN: 1, autoPublish: true }),
    ],
    ownerRole: "steward",
  },
  {
    id: "open",
    name: "Open commons",
    summary: "Newcomers contribute, two gardeners review an edit, and gardeners can staff new members themselves.",
    feel: "The most collective of the three: edits are staged until a publisher releases them, and amendments need two stewards — so add a second steward before you ratify.",
    roles: [
      steward(),
      {
        name: "gardener",
        powers: ["publish", "assign_roles"],
        scopeType: "global",
        scope: "",
        capabilities: [...CONTRIBUTOR_CAPS],
        assigns: ["member"],
      },
      {
        name: "member",
        powers: [],
        scopeType: "global",
        scope: "",
        capabilities: [...NEWCOMER_CAPS],
        assigns: [],
      },
    ],
    policies: [
      policy({ action: "amend_governance", eligibleRole: "steward", thresholdN: 2 }),
      policy({ action: "edit_note", eligibleRole: "gardener", thresholdN: 2, autoPublish: false }),
      policy({ action: "new_entry", eligibleRole: "gardener", thresholdN: 1, autoPublish: true }),
    ],
    ownerRole: "steward",
  },
];

export const CAP_CHOICES = ALL_CAPS;
export const POWER_CHOICES = ALL_POWERS;
