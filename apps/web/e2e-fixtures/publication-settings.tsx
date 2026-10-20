import React from "react";
import { createRoot } from "react-dom/client";
import {
  CollabSharingProvider,
  VaultClientProvider,
  useAgentChatStore,
  type CollabSharing,
  type PublicationInfo,
  type PublicationPreview,
  type VaultClient,
} from "@prism/core";
import { PublishPanel } from "../../../packages/core/src/components/renderers/network/PublishPanel";
let scope = "owner";
useAgentChatStore.setState({ scope });
let pubs: PublicationInfo[] = [
  {
    slug: "field-guide",
    kind: "path",
    pathPrefix: "Projects/Field guide",
    tag: "",
    vaultId: "primary",
    vaultLabel: "Personal workspace",
    isCurrentVault: true,
    title: "Prism field guide",
    template: "wiki",
    passwordRequired: true,
    url: "https://prism.example.test/p/field-guide",
    createdAt: 1,
    homeNoteId: "welcome",
    excludeNoteIds: ["reference", "old-hidden"],
    theme: { font: "sans" },
  },
];
const clone = <T,>(value: T): T => structuredClone(value);
const controls = {
  writes: [] as Array<{ slug: string; patch: object }>,
  creates: [] as Array<{ prefix: string; options: object | undefined }>,
  failSave: false,
  failPreview: false,
  failUnpublish: false,
  failPublish: false,
  holdPreview: false,
  previewRelease: null as (() => void) | null,
  vaultReads: 0,
  unpublishCalls: 0,
  switchScope: () => {
    scope = "guest";
    useAgentChatStore.setState({ scope });
  },
};
Object.assign(window, { prismPublishingFixture: controls });
const preview = async (slug: string): Promise<PublicationPreview> => {
  if (controls.failPreview) throw Error("Synthetic preview unavailable");
  const pub = pubs.find((p) => p.slug === slug)!;
  const notes =
    slug === "field-guide"
      ? [
          {
            id: "welcome",
            title: "Welcome",
            path: "Projects/Field guide/welcome.md",
            excluded: !!pub.excludeNoteIds?.includes("welcome"),
          },
          {
            id: "reference",
            title: "Reference",
            path: "Projects/Field guide/reference.md",
            excluded: !!pub.excludeNoteIds?.includes("reference"),
          },
        ]
      : [];
  const result = {
    slug,
    vaultId: "primary",
    notes,
    privateExcludedCount: 2,
    publishedCount: notes.filter((n) => !n.excluded).length,
    expired: false,
  };
  if (controls.holdPreview)
    await new Promise<void>((resolve) => {
      controls.previewRelease = resolve;
    });
  return result;
};
const sharing: CollabSharing = {
  createShareLink: async () => {
    throw Error("Not used by this fixture");
  },
  listPublications: async () => (scope === "owner" ? clone(pubs) : []),
  previewPublication: preview,
  updatePublicationSettings: async (slug, patch) => {
    controls.writes.push({ slug, patch: clone(patch) });
    if (controls.failSave)
      throw Error("Synthetic save unavailable. Your settings are still here.");
    pubs = pubs.map((p) => (p.slug === slug ? { ...p, ...patch } : p));
  },
  unpublish: async (slug) => {
    controls.unpublishCalls++;
    if (controls.failUnpublish) throw Error("Synthetic removal unavailable");
    pubs = pubs.filter((p) => p.slug !== slug);
  },
  setPublicationPassword: async (slug, password) => {
    pubs = pubs.map((p) =>
      p.slug === slug ? { ...p, passwordRequired: !!password } : p,
    );
  },
  publishPath: async (prefix, options) => {
    controls.creates.push({ prefix, options: clone(options) });
    if (controls.failPublish) throw Error("Synthetic publication unavailable");
    const slug = "new-site";
    pubs.push({
      slug,
      kind: "path",
      pathPrefix: prefix,
      tag: "",
      template: "wiki",
      title: null,
      passwordRequired: !!options?.password,
      url: "https://prism.example.test/p/" + slug,
      createdAt: 2,
    });
    return {
      slug,
      pathPrefix: prefix,
      url: "https://prism.example.test/p/" + slug,
      count: 0,
      passwordRequired: !!options?.password,
    };
  },
  publishTag: async () => {
    throw Error("Not used by this fixture");
  },
};
const vault = {
  scope: () => scope,
  getTags: async () => [{ tag: "notes", count: 900 }],
  listNotes: async () => {
    controls.vaultReads++;
    throw Error("Use the server preview");
  },
} as unknown as VaultClient;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <VaultClientProvider client={vault}>
      <CollabSharingProvider value={sharing}>
        <main style={{ maxWidth: 880, padding: 16, margin: "0 auto" }}>
          <PublishPanel />
        </main>
      </CollabSharingProvider>
    </VaultClientProvider>
  </React.StrictMode>,
);
