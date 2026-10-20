import type { Note } from "@prism/core";
const person = (
  id: string,
  name: string,
  tags: string[] = [],
  metadata: Record<string, unknown> = {},
): Note => ({
  id,
  path: `People/${name}`,
  tags: ["person", ...tags],
  metadata: { name, ...metadata },
  content: "A person record.",
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
});
export const identityPeople: Note[] = [
  person("hidden-stub", "Hidden merged tag", ["merged-stub"]),
  person("hidden-superseded", "Hidden superseded tag", ["superseded"]),
  person("hidden-status", "Hidden merged status", [], {
    status: "merged_into_canonical",
  }),
  person("hidden-nonhuman", "Hidden nonhuman tag", ["non-human"]),
  person("hidden-bot", "Hidden bot tag", ["bot"]),
  person("hidden-organization", "Hidden organization tag", ["organization"]),
  person("hidden-bot-type", "Hidden bot type", [], { type: "bot" }),
  person("hidden-organization-type", "Hidden organization type", [], {
    type: "organization",
  }),
  person("pointer-snake", "Live snake pointer", [], {
    merged_into: "canonical",
  }),
  person("pointer-camel", "Live camel pointer", [], {
    mergedInto: "[[People/Canonical]]",
  }),
  person("pointer-superseded", "Live successor pointer", [], {
    superseded_by: "canonical",
  }),
  person("document-human", "Document human", [], { type: "document" }),
  person("email-recipient", "Canonical recipient"),
  person("email-reverse", "Reverse recipient"),
];
export const identityEmail: Note = {
  id: "identity-email",
  path: "Email/Recipient record",
  tags: ["email"],
  metadata: {
    type: "email",
    subject: "Recipient record",
    from: "sender@example.test",
    to: ["recipient@example.test"],
    source: "proton-bridge",
    messageId: "identity@example.test",
  },
  content:
    "# Recipient record\n\n**From:** sender@example.test\n**To:** recipient@example.test\n\n---\n\nA real linked email body.",
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
};
export const identityEdges = [
  ...identityPeople
    .filter((p) => !p.id.startsWith("email-"))
    .map((p) => ({
      source: "direct",
      target: p.id,
      relationship: "messages-with",
    })),
  {
    source: "identity-email",
    target: "email-recipient",
    relationship: "email-to",
  },
  {
    source: "identity-email",
    target: "email-recipient",
    relationship: "email-from",
  },
  {
    source: "email-recipient",
    target: "identity-email",
    relationship: "email-to",
  },
  {
    source: "email-reverse",
    target: "identity-email",
    relationship: "email-to",
  },
];
