# Prism + Omni product roadmap

Updated 2026-10-10. Canonical checklist for Benjamin’s 11:04 a.m. feedback and subsequent device reports. This is the entry point for the current product pass; release logs provide evidence, not the backlog. Earlier architectural roadmaps remain historical context.

## Product vision

Prism is a polished, native-feeling personal and collaborative knowledge environment across iPhone, iPad, Mac and web. Omni is a fully capable Hermes executive assistant connected to that knowledge, replacing the previous Telegram/Claude workflow without losing capabilities. Owner internal work should run freely; outbound communications require approval. Collaboration must keep people and vaults isolated correctly. A new user should install, choose a server host, pair devices and optionally add Omni without our current developer setup process.

## Status and completion rules

- **Accepted**: the owner confirmed the named behavior. This does not certify adjacent behavior or every platform.
- **Released; acceptance pending**: code shipped to the relevant server/mobile builds, but the complete requested experience still needs device verification. Mac rollout is tracked separately below.
- **Partial**: useful implementation exists, with explicit remaining scope.
- **Planned**: design/backlog only; not delivered.

Do not close an item solely because tests pass, a PR merged, or a bundle installed. Record the platform, observed result and release. Failed acceptance reopens the item. Parent owns design, integration, review and this ledger; GPT-6.1 Sol workers implement focused assignments. Update this document when feedback, scope or acceptance changes; keep detailed command receipts in the release log.

## Original feedback: complete request inventory

| ID | Request | Current status and evidence | Remaining work / acceptance |
| --- | --- | --- | --- |
| O01 | Omni unrestricted internal abilities; approval only for outbound communications | **Partial.** Internal autonomy is live on agent v10; internal tool smoke passed. Exact outbound approval remains. | Audit remaining refusal paths and legacy job restrictions against this policy; preserve user/vault isolation. Prove ordinary internal tasks do not need repeated approval. |
| P01 | Sidebar bottom fade aligned with notes tray | **Released; acceptance pending.** PR75 layout repair. | Verify bottom alignment on iPhone, iPad and Mac with scrolling and safe areas. |
| O02 | Chat buttons and keyboard dismissal refined | **Partial.** PR91 removes floating Done overlap; owner confirmed Return sends. | Confirm dismiss/Send spacing, focus and Shift-Return on all three devices; include accessibility sizes. |
| P02 | Change message status from opened detail | **Released; acceptance pending.** PR75 email/message-detail status controls. | Confirm intended status changes persist in detail and list. Clarify any additional message types not covered by this implementation. |
| P03 | Native sidebar open, close and back gestures | **Released; acceptance pending.** PR82 expands edge gestures across renderers and adds close; PR84 fixes touch sizing. | Retest notes, lists and graph on both devices, including scroll/selection conflicts and back behavior. Earlier owner acceptance failed outside notes and for close. |
| P04 | Smooth transitions and animations | **Partial.** Interface/gesture polish shipped in the UI pass. | Cross-surface motion review remains; verify interruptions, reduced motion and absence of jank. No blanket smoothness sign-off yet. |
| P05 | Modern Apple minimalism/glass across mobile, web and desktop | **Partial.** Shared UI polish and Omni voice glass panel shipped. | Review each platform for consistent hierarchy, restrained layers, contrast and touch targets; finish Mac rollout. |
| P06 | Workspace settings look designed; fix padding/layout | **Released; acceptance pending.** PR78/82/84 responsive settings and coarse-pointer fixes. | Owner previously found awkward spacing on both devices. Verify latest narrow/wide layouts before closing. |
| P07 | Easier sidebar drag-to-Trash | **Released; acceptance pending.** PR75 Trash interaction repair. | Confirm discoverability, drop target and recovery on pointer and supported touch interactions. |
| P08 | Graph close X stays in viewport | **Released; acceptance pending.** PR75 graph layout repair. | Verify narrow/wide graph and page-panel combinations, keyboard and safe-area changes. |
| P09 | Collapsible properties; choose always-visible fields | **Released; acceptance pending.** PR75 visibility preferences, PR78/82 clearer property chrome. | Owner said properties generally looked good but formatting was unclear; verify updated labels, collapse behavior and saved preferences. |
| C01 | Reliable multi-vault/multi-user permissions and setup | **Partial.** PR74 authorization repairs and focused isolation/sharing tests passed. | Run a real two-user/two-vault pilot: invitations, roles, revocation, switching, offline caches, files, search, graph and realtime. Passing route tests is not collaboration acceptance. |
| D01 | Simple onboarding, App Store distribution and server installation on chosen machine | **Planned.** First-run proposal written; no installer or App Store submission. | Build signed host installer, pairing, account setup, remote access, updates, backups/recovery and supported-host matrix; then TestFlight/App Store readiness. |
| D02 | Optional Omni bundled into Prism setup | **Planned.** Included in first-run proposal. | Implement optional component/provider/integration setup. Collaborative per-user Omni requires separate identities and access boundaries; current owner-only agent is not that feature. |
| O03 | Conversational voice with Hermes | **Partial; basic exchange accepted.** Owner reports voice works after v6; speech quality and natural conversation remain open. PR95/96 shipped on both devices. | Owner did not specify per-device coverage; Interrupt/cancellation/reconnect still need acceptance. Track better TTS, patient continuous conversation, mobile activation and Mac wake word as V01–V05 in the [voice plan](omni-conversational-voice-plan.md). |
| O04 | Clean up old Hermes conversations incorrectly Waiting | **Partial.** PR85 treats imported unpersisted history as neutral conversation; preserves explicit owner status. | Inspect remaining stale Waiting examples and distinguish active/intentional states from stale ones before changing stored history. No blanket cleanup claim. |
| O05 | View source opens native Prism | **Accepted.** Owner confirmed native Prism opening. | Keep as regression check across source/vault links and platform releases. |
| O06 | Notification tap opens exact conversation | **Released; acceptance pending.** Completion delivery owner-confirmed; PR87 fixes callback crash and early navigation reconciliation. | Retest tap from locked/background/cold-start states on both devices. Earlier iPad crash/iPhone Home failure is not closed by delivery success. |
| O07 | Create, edit and manage recurring jobs in app | **Partial.** PR80/88 CRUD/run controls; three reviewed M3 jobs manageable. | Eight legacy raw-script jobs remain restricted. Migrate/review their execution and approval behavior, then verify create/edit/pause/resume/delete/run end to end. |
| O08 | View and edit skills in app | **Released; acceptance pending.** PR83 catalog/editor; 54 active skills: 52 editable local, two linked read-only. | Owner verifies discovery/edit/save/conflict handling; explain linked source ownership without exposing irrelevant implementation details. |
| O09 | Use supplied Omni logo | **Partial.** PR81 native/web assets compiled from supplied image. | App icon assets verified; owner confirms notification logo remains missing on installed mobile build. Investigate packaged icons/system presentation; finish current Mac release. |
| O10 | More capable than Claude -p: tweets, email, Matrix, RSVP and other existing abilities | **Partial.** Capability audit, approved executors and internal autonomy shipped; approved tweet adapter added. | Maintain capability-by-capability acceptance against prior workflow, including drafts and approved sends/RSVP. Offline executor tests are not proof of successful real sends. Never send test communications without exact owner authorization. |

## Subsequent feedback and inherited release obligations

| ID | Follow-up | State / next step |
| --- | --- | --- |
| F01 | Old comments/backlinks/suggested-edit chrome on iPad/Mac | PR92 fixes source breakpoint discrepancy; Prism v6 installed on both mobile devices. Mac v6 is notarized and installed on the Mini; verify wide UI. |
| F02 | Prism replies disabled on server | Direct owner replies enabled/configured and SMTP readiness verified; no email sent. Owner reply acceptance remains; Omni approval boundary is separate. |
| F03 | Add Folder cancel/exit overflow | PR92 responsive repair shipped in Prism v6; physical acceptance pending. |
| F04 | Return sends everywhere; Shift-Return adds a line | PR91 shipped. Owner confirmed Return; retain explicit Shift-Return, IME and paste regression coverage. See O02. |
| F05 | Done overlaps Send | PR91 replaces floating control with inline dismissal. Physical spacing acceptance pending. See O02. |
| F06 | Notification missing icon | Owner confirms the notification logo is still missing after v7. Sol investigation active; see O09. Do not assume a cache cause. |
| F07 | Voice crashes after models download | Actual crash was audio callback actor isolation; PR95 repair shipped in Omni v6. Owner reports voice now works; per-device coverage not specified. See O03. |
| F08 | Voice easy to launch, main toolbar entry, contemporary centered Apple-style UX | PR96 toolbar entry and glass panel shipped in v6; simulator light/dark reviewed. Owner usability acceptance pending. |
| F09 | Voice beside New Chat in Threads | Released in build 8 on both mobile devices; retains Today access. Physical acceptance pending. |
| F10 | Dispatch Omni from Today tasks | Released in build 8: explicit task-context handoff with existing outbound approval requirements. Physical acceptance pending. |
| F11 | Expand Today to all tasks | Released in build 8 and server v11: paginated assigned open tasks. Physical acceptance pending. |
| R01 | Working current Mac apps | Prism v6 notarized, installed and launched on the Mini; interactive acceptance and laptop installation pending. Omni v8 universal build staged for owner signing; acceptance/staple/install pending. V7 submission is separate. Do not install known-bad Omni v5. |
| R02 | Proactive assistant reliability | Three reviewed M3 jobs active; smoke checks passed. Week-long observation gate remains pending; retain existing fallbacks until accepted. |

## Sequence and exit criteria

1. **Reliable everyday Omni.** Finish O03/F07/F08 physical voice acceptance, O06 notification destination/icon checks, O02 composer checks, and R01 current Mac installations. A working session on one device is not proof for the others.
2. **Close the UI feedback loop.** Verify P01–P09 and F01–F05 on installed builds, repair observed failures, and complete a concise cross-platform design/accessibility pass. Avoid broad refactoring.
3. **Assistant capability parity.** Close O01/O04/O07/O08/O10 and R02 gaps: restrictions, stale statuses, jobs, skills, approved outbound workflows and proactive reliability. Maintain a visible parity checklist; do not quietly redefine “fully functional” around current limitations.
4. **Collaborative pilot.** Complete C01 with real separate identities and vaults, both allowed and denied workflows, then a small invited-user pilot. Owner-only Omni must remain distinct from future per-user agent support.
5. **First-time setup and distribution.** Implement D01/D02 from the proposal, test a clean machine with no development tools, then beta/distribution gates. Public release requires reliable upgrades/recovery and a documented host support matrix, not merely signed clients.

This order is the default; a regression can interrupt it without removing downstream commitments. No feature here is silently dropped when attention moves to a crash or release.

## Evidence and related plans

- [Conversational voice plan: V01–V05](omni-conversational-voice-plan.md) — researched follow-on, including patient listening and activation.

- [Current release and device evidence](../../qa/omni-prism-device-followup-2026-10-10.md) — chronological; later entries supersede earlier states.
- [Mobile gesture/settings follow-up](../../qa/mobile-followup-2026-10-10.md).
- [Responsive editor follow-up](../../qa/responsive-editor-followup-2026-10-10.md).
- [First-run and distribution proposal](../distribution/first-run-proposal.md).
- [Earlier architectural implementation progress](PROGRESS.md) — historical milestones, not completion of this product checklist.

Snapshot: Prism server v10, agent v10, Prism mobile v6 and Omni mobile v7. V01 Apple voices and V04 foreground shortcut are installed on both mobile devices, with owner acceptance pending; V02/V03/V05 remain planned. These are recorded release states, not a fresh production health check. Full hashes, signatures and deployment receipts belong in the evidence log.
