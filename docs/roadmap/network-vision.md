# Prism as a Knowledge Network Node — Vision & UX Spec

> Status: design exploration (v0). Branch `claude/network-ux-multivault`.
> Premise: the *machinery* for publishing (public Wiki) and federation (peer CRDT
> sync) is built and tested. What's missing is the **product** — the in-Prism UX
> that lets a person enable, configure, and live-operate these without a CLI. And
> the missing architectural piece for scale: **multiple vaults**.

---

## 1. The reframe — from "vault viewer" to "network node"

Today Prism is a beautiful single-player interface over *one* Parachute vault.
The vision is that your vault stops being an island:

- **Outward (publish):** take a slice of your knowledge and serve it to the world
  as a read-only Wiki at a URL you control.
- **Sideways (federate):** take a slice and keep it continuously, bidirectionally
  in sync with a *peer's* vault — their Prism, their Parachute, their machine —
  with no central server and no shared credentials.
- **Plural (multi-vault):** run more than one vault through one Prism — a private
  daily vault, a "bioregional knowledge commons" vault, a project vault — each
  with its own publications and federations.

The throughline: **a vault is a node in a personal/peer knowledge network.** Prism
is the control surface for that node.

## 2. First principles

1. **The slice is the unit of sharing.** People don't share "a note" when they
   publish or federate — they share a *coherent subset*: a topic, a directory, a
   tag. Parachute already makes tags ≈ directories ≈ typed collections. So the
   primitive the UX must make tangible is the **slice** = a saved query over the
   vault (tag(s), path prefix, maybe a filter), with a stable name.
2. **Sharing has a mode, not a feature.** "Publish" and "Federate" are two
   *modes* applied to the same slice, plus "Private" (the default). One mental
   model, three modes — not two unrelated features buried in different menus.
3. **Configuration is progressive.** Publishing a slice should be one click to a
   working URL; *then* you can refine (title, home page, password, theme, custom
   path). Federating should be: pair once, then "share this slice with this peer
   at this level" — the rest is automatic.
4. **The network is legible.** At any moment I can see: what I publish (and its
   live URL + count), who I'm paired with (and their verified fingerprint), what
   spaces sync with whom (and whether they're synced / syncing / offline /
   conflicted), and what's waiting for my approval (incoming mirror requests).
5. **Secure by construction, not by discipline.** A peer can never silently write
   to my vault (owner-reviewed mirror). A published slice can never leak a note
   outside it (the effectiveLevel guard). Multi-vault never crosses tokens. The
   UX must make the *safe* path the *easy* path — and surface the trust decisions
   (fingerprint verification, "this will publish N notes including future ones").
6. **Dynamic, not a snapshot.** A slice is a *filter*. New notes that match
   auto-join; notes that leave the slice stop syncing/publishing. The UX must say
   this out loud (it's the #1 surprise risk) and show the live membership count.

## 3. Success criteria (what "done enough to test + scale" means)

A motivated non-engineer, inside Prism, can:

- **SC-1 Publish:** select a tag/directory, click Publish, and get a live public
  Wiki URL in under a minute; then set a title, a home page, a password, and a
  custom path, and see "publishing N notes (dynamic)". Unpublish instantly.
- **SC-2 Pair:** see their own node identity + fingerprint; generate a pairing
  code (or link/QR) to hand a peer; redeem a peer's code; end with both nodes
  listing each other with **matching verified fingerprints**.
- **SC-3 Federate a slice:** pick a slice, share it with a paired peer at
  view/suggest/edit, and watch a note edited on either side appear on the other
  within seconds — with a per-space status (synced / syncing / offline).
- **SC-4 Approve inbound:** when a peer shares a slice *to* me, I see a request,
  review what it includes, and accept (creating the local mirror) or reject — a
  peer never writes to my vault without this.
- **SC-5 Multi-vault:** connect a second vault to Prism and switch between them;
  each keeps its own publications + federations; switching is obvious and fast.
- **SC-6 New node:** a new person can stand up a Parachute vault + Prism and
  connect it (guided), enough to pair + federate with my node — the "someone to
  test with" bootstrap.
- **SC-7 Secure:** none of the above can leak a token, publish an out-of-slice
  note, let a peer write unapproved, or cross vaults. Verified by e2e + the
  existing security suite, with two real hubs.

## 4. The "Network" surface (UX architecture)

A new top-level surface — working name **Network** (alt: "Share & Sync") —
distinct from the per-note Share dialog (which stays for quick "share this one
doc" links). Three sections:

### 4.1 Publish (outward, public)
- A list of **Publications**: each row = slice (tag) · template · public URL
  (copy) · live note count · password state · open/preview.
- **New publication** flow: pick a tag/directory → choose template (Wiki) →
  (auto-creates, shows URL) → progressive config panel: title, home note picker,
  password toggle, custom slug/path, theme, "includes N notes (dynamic — future
  notes with this tag are included)". Unpublish.
- *Reuses:* `/acl/tags/:tag/publish` + `PUT .../publish/password` + `GET
  /acl/publications` + `DELETE`, and the public `/p/:slug` reader already built.

### 4.2 Federate (peer, private, two-way)
- **This node:** my identity card — fingerprint (the human-verifiable hash),
  collab URL, a "Pair a peer" button.
- **Peers:** list of paired peers (label · fingerprint · paired date · sync
  health) + pairing flow (generate code/link to share; redeem a peer's code;
  verify fingerprints side-by-side before trusting).
- **Spaces:** shared slices — each = slice · peers + levels · live status
  (synced/syncing/offline/conflict) · note count. Create from a slice; grant a
  peer at view/suggest/edit; revoke.
- **Inbox:** incoming mirror requests (peer · slice · N notes) → Accept (creates
  the local mirror) / Reject.
- *Reuses:* `/acl/peers/*`, `/api/federation/{identity,pair,mirror}`,
  `/acl/spaces/*`, `/acl/federation/mirrors/*`, the FederationManager bridge.
- *Gating:* requires `FEDERATION_ENABLED`; the surface should detect this and, if
  off, offer a one-click "enable federation on this node" (writes the flag +
  guides a restart) rather than silently showing nothing.

### 4.3 Vaults (plural)
- A **vault switcher** (the active vault is always visible) + **Connect a vault**
  + **Create a vault** + **Set up a new Prism node** (for a peer to join).
- Each vault scopes its own Publish/Federate. (Architecture: §5.)

A lightweight bridge from the existing per-note/per-tag UI: a "Publish this
collection" / "Federate this collection" affordance on a tag/directory deep-links
into the right Network section with the slice pre-filled.

## 5. Multi-vault architecture (the hard part — to be finalized from research)

Open question being mapped by the architecture research stream. Candidate shapes:
- **(A) Vault-aware gateway:** one Prism server fronts N vaults; the active vault
  is carried per-request (path/header), tokens held server-side in a vault
  registry. Pros: one node, one URL. Cons: publications.slug / collab
  documentName / effectiveLevel must become vault-scoped; the owner short-circuit
  + actor model need a vault dimension.
- **(B) N servers, one switcher:** Prism connects to N Prism servers (one per
  vault); the client switches the active connection. Pros: strong isolation,
  minimal server change. Cons: N processes/URLs; pairing/publishing per server.
- **(C) Hybrid:** desktop holds N vault connections (it already has a config);
  the server stays single-vault per process; multi-vault is a *client* concept
  for desktop first, with the gateway gaining vault-awareness later.

Recommendation TBD from the mapping — but the **smallest viable first step** is
likely a client-side **active-vault concept + switcher** with the data layer
made vault-parametric, even if v1 only has one configured, so the UX + seam are
ready and the server change can follow. Security invariant: **never mix two
vaults' tokens/notes/grants**; every publication/space/collab-doc is tagged with
its vault.

## 6. Build plan (phased, testable + committed at each step)

- **P0 — Spec (this doc) + seam:** finalize the model; extend the CollabSharing
  (or a new `NetworkClient`) seam with the full publish + peer + space + mirror
  methods; web impl over `/acl` + `/api/federation`. Behind it, the existing
  endpoints.
- **P1 — Publish UX:** the Publications surface end-to-end (SC-1). Highest value,
  most self-contained, testable immediately against the live server.
- **P2 — Federate UX:** identity + pairing + peers + spaces + inbox + status
  (SC-2/3/4). Needs the flag + a second hub for full e2e.
- **P3 — Multi-vault foundation:** the active-vault concept + switcher + the
  vault-parametric data layer (SC-5), per the §5 decision.
- **P4 — New-node setup UX:** guided vault+server bring-up (SC-6).
- **P5 — Two-hub e2e:** drive every flow through the browser with two real vaults
  (SC-7), then PR.

## 7b. v1 design decisions (locked from research)

**8 north-star principles** (from comparable-tool research): (1) default to
nothing-shared; (2) bake the permission INTO the artifact (a link/QR *is* "view"
or "edit"); (3) always show what's exposed + make it reversibly auditable;
(4) deliver a working URL BEFORE any config; (5) status = two words + a color
(Synced/Syncing/Offline, Public/Private); (6) never expose the plumbing (no git
verbs, device-ids, conflict files, build pipeline); (7) scope + identity
unmistakable (loud active-vault, "shared with" faces, level badges); (8) be
honest about retraction limits + dangling links.

**Placement (from UX inventory):** Network is a **virtual tab** (`"network"`,
like the existing dashboards) — not a Settings section, not a per-note dialog —
mounted via `ContentType` + `Registry` + `VIRTUAL_TAB_IDS` (Canvas + Navigation)
+ a sidebar nav row. Sub-tabs via the existing `ui/Tabs`. Reuse glass tokens +
`ui/` primitives (`Badge` status pills, `Button`, `Input`) + lucide + the inline
copy pattern. Web-owner-only (hidden when seam methods are absent — exactly how
the Publish tab gates today).

**Seam:** extend `CollabSharing` with optional federation methods (identity /
pair / peers / spaces / mirrors). Renderer consumes `useCollabSharing()`; hides
any section whose backing methods are absent → desktop + capability-viewer safe.

**Publish tab UX:** a list of live publications (auditable + reversible) + "New
publication": pick a tag → **instant public URL** + a live "publishing N notes
(dynamic — future notes with this tag included)" count → a progressive **Site
Settings** panel (title · home-note picker *constrained to in-publication notes*
so you can't leak a private home · password · visibility). v1 visibility ladder:
Public / Password (Unlisted + custom domain are later). Warn on dangling
wikilinks to unpublished notes (differentiator; v1.1 if time-boxed).

**Federate tab UX:** (a) **This node** identity card — fingerprint shown loudly
for human verification + "Pair a peer". (b) **Peers** — generate a pairing
code/link to hand over + redeem a peer's; verify fingerprints side-by-side; list
paired peers with health. (c) **Spaces** — pick a slice → share with a paired
peer AT a level (permission baked in) → two-word live status; revoke. (d)
**Inbox** — pending inbound mirror requests (peer · slice · N notes) → Accept
(at a chosen level) / Reject. Lean into CRDT auto-merge: **no conflict UI** ever.

**Vaults tab UX:** active-vault pill (loud) + recents + "Connect existing" +
"Create new"; per-value scope badges. v1 = multi-vault Phase 1 (owner switcher,
per-request `X-Prism-Vault` header, no schema migration). Cross-vault *sharing*
(the `vault_id` migration across 6 tables + `effectiveLevel` vault-scoping) is
the security-critical, gated **Phase 2** — specced, not rushed.

## 7. Non-goals (v1)
- Custom DNS/domain management for publications (URL = Prism origin + slug).
- Real-time presence/cursors across federated peers (CRDT data sync only).
- Mobile-native federation transport (web/desktop first).
- More than ~a handful of vaults / peers (correctness first, scale later).
