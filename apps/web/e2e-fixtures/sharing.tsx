import { webCollabSharing } from "../src/collab/grant";
import { fetchMe, setActiveVault } from "../src/config";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useAgentChatStore,
  useUIStore,
  CollabSharingProvider,
  type CollabSharing,
  type NoteAccess,
  type PublicationInfo,
} from "@prism/core";
import { ShareDialog } from "../../../packages/core/src/components/layout/ShareDialog";
import { TabBar } from "../../../packages/core/src/components/layout/TabBar";
import { SharingDialogHost } from "../../../packages/core/src/components/layout/SharingDialogHost";
import "../../../packages/core/src/styles/tokens.css";
import "../../../packages/core/src/styles/glass.css";
import "../../../packages/core/src/styles/typography.css";
const toolbar = new URLSearchParams(location.search).has("toolbar");
if (toolbar)
  useUIStore
    .getState()
    .openTab("private", "A calmer place to think", "document");
const scoped = new URLSearchParams(location.search).has("scoped");
useAgentChatStore.setState({ scope: "sharing-owner" });
const access: NoteAccess = {
  note: {
    id: "private",
    title: "A calmer place to think",
    tags: ["prism"],
    visibility: "private",
  },
  people: [{ email: "alex@example.test", level: "edit" }],
  links: scoped
    ? []
    : [
        {
          id: "existing",
          level: "view",
          expiresAt: Date.now() + 86400000,
          url: "https://prism.example.test/private?fixture=1",
        },
      ],
  tagAccess: [
    {
      tag: "prism",
      email: "team@example.test",
      level: "view",
      subjectType: "user",
    },
  ],
  canManageLinks: !scoped,
  allowedLevels: scoped ? ["view"] : ["view", "comment", "suggest", "edit"],
};
// ?page — a workspace page inside a shared parent (NP-CO-05/09): named people,
// an Owner row and access inherited from the parent page.
if (new URLSearchParams(location.search).has("page")) {
  access.note = { id: "private", title: "A calmer place to think", tags: ["prism"], visibility: "workspace", path: "Projects/Prism/A calmer place to think" };
  access.owner = { email: "alex.rivera@prism.test", name: "Alex Rivera", avatar: null };
  access.people = [
    { email: "morgan.lee@prism.test", name: "Morgan Lee", level: "edit", scope: "page" },
    { email: "sam.chen@example.test", name: "Sam Chen", level: "suggest", scope: "note" },
  ];
  access.inherited = [
    { email: "jordan.diaz@prism.test", name: "Jordan Diaz", level: "view", scope: "page", from: { id: "prism", title: "Prism" } },
  ];
  access.parent = { id: "prism", title: "Prism" };
  access.tagAccess = [];
}
if (new URLSearchParams(location.search).has("custom")) {
  access.people[0] = {
    email: "alex@example.test",
    level: "view",
    caps: ["view", "edit", "share"],
    customPermissions: true,
  };
}
let publications: PublicationInfo[] = [];
const control = {
  hostReady: () => fetchMe(),
  hostRead: () => webCollabSharing.getAccess!("same"),
  hostWrite: () =>
    webCollabSharing.setPerson!("same", "recipient@example.test", "view"),
  switchHostVault: () => setActiveVault("team-b"),
  calls: [] as Array<{ kind: string; args: unknown[] }>,
  failNext: false,
  hold: false,
  release: null as null | (() => void),
  switchScope: () => useAgentChatStore.setState({ scope: "sharing-other" }),
};
async function call(kind: string, ...args: unknown[]) {
  control.calls.push({ kind, args });
  if (control.hold)
    await new Promise<void>((r) => {
      control.release = r;
    });
  if (control.failNext) {
    control.failNext = false;
    throw Error("Fixture unavailable");
  }
}
const sharing: CollabSharing = {
  createShareLink: async () => "unused",
  getAccess: async () => {
    await call("getAccess");
    return structuredClone(access);
  },
  setPerson: async (id, email, level, options) => {
    await call("setPerson", id, email, level, ...(options ? [options] : []));
    const p = access.people.find((p) => p.email === email);
    const caps = options?.caps;
    if (p) {
      p.level = level;
      p.customPermissions = !!caps;
      if (caps) p.caps = caps;
      else delete p.caps;
      if (options?.scope) p.scope = options.scope;
    } else {
      // An inherited person changed on this page becomes a direct page grant here.
      access.inherited = (access.inherited ?? []).filter((x) => x.email !== email);
      access.people.push({ email, level, scope: options?.scope, ...(caps ? { caps, customPermissions: true } : {}) });
    }
    return { invited: false };
  },
  removePerson: async (id, email) => {
    await call("removePerson", id, email);
    access.people = access.people.filter((p) => p.email !== email);
  },
  createLink: async (id, level, days) => {
    await call("createLink", id, level, days);
    const link = {
      id: "new-link",
      level,
      expiresAt: Date.now() + (days ?? 30) * 86400000,
      url: "https://prism.example.test/private?fixture=2",
    };
    access.links.push(link);
    return link;
  },
  revokeLink: async (id, link) => {
    await call("revokeLink", id, link);
    access.links = access.links.filter((l) => l.id !== link);
  },
  setNoteVisibility: async (id, isPrivate) => {
    await call("visibility", id, isPrivate);
    access.note.visibility = isPrivate ? "private" : "workspace";
  },
  listPublications: async () => {
    await call("publications");
    return structuredClone(publications);
  },
  publishTag: async (tag, opts) => {
    await call("publish", tag, opts);
    publications = [
      {
        tag,
        slug: tag,
        url: "https://prism.example.test/wiki",
        passwordRequired: !!opts?.password,
      } as PublicationInfo,
    ];
    return {
      count: 2,
      url: publications[0]!.url,
      slug: tag,
      passwordRequired: !!opts?.password,
    };
  },
  unpublishTag: async (tag) => {
    await call("unpublish", tag);
    publications = [];
  },
  setPublishPassword: async (tag, password) => {
    await call("password", tag, password);
    publications[0]!.passwordRequired = !!password;
  },
  listPeers: async () => [
    {
      pubkey: "private-peer",
      fingerprint: "test-peer",
      label: "My other vault",
      email: null,
      pairedAt: 1,
      createdAt: 1,
    },
  ],
  mirrorNoteToPeer: async (...args) => {
    await call("sync", ...args);
    return {} as never;
  },
};
Object.assign(window, { prismSharingFixture: control });
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <main style={{ padding: 24 }}>
      {toolbar && (
        <CollabSharingProvider value={sharing}>
          <TabBar />
          <SharingDialogHost />
        </CollabSharingProvider>
      )}
      <h1>Prism workspace</h1>
      <button data-prism-share-trigger onClick={() => setOpen(true)}>Share fixture</button>
      <button>Outside action</button>
      {open && (
        <ShareDialog
          noteId="private"
          sharing={sharing}
          onClose={() => setOpen(false)}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
