# Prism and Omni follow-up — 2026-10-10

## Production

Prism `prism-v2026.10.10-8` = `422ad503fa7c55a912fc7371df90e80f9cfec126` deployed through the required dry/apply workflow. Mini log `~/deploy-state/prism-20261010T182727Z.log`. Process, vault, ingest regression and desktop-independence checks passed. Required check components passed: all four application typechecks, e2e typecheck, dialog restriction, service-worker exclusions and initial-bundle lazy assertions. A fixture typing error introduced with the real-touch regression was corrected in PR86 before deployment. Skills filesystem/owner-route tests passed on integrated source.

Agent `agent-v2026.10.10-10` = `6f34b49` remains deployed. Internal autonomy is active; outbound email, Matrix, tweet and calendar paths still require owner approval. Offline boundary and executor checks passed; no real outgoing message, tweet, RSVP or email was sent for validation. The jobs API compatibility shim is enabled; a run of the existing local context job was accepted and reached terminal OK. Legacy unreviewed raw-script jobs remain restricted for Run/Resume/edit.

Skills roots were activated under `docs/runbook/omni-skills.md`, with environment backup `.env.bak-omni-skills-20261010T182719Z`. Production read-only catalog verification returned 54 active skills: 52 editable local documents and two readable linked sources. The older 107-file inventory included 55 documents under `.archive`, intentionally excluded. No production skill text was changed.

## Native verification and owner feedback

Prism v4 source `ae86adba` was installed on both devices. Owner feedback exposed incomplete sidebar gestures and awkward workspace spacing. PR82 implements consistent outer-edge open, swipe close, clearer property controls, and responsive spacing. PR84 fixes malformed compiled coarse-pointer CSS and makes wide-touch iPad settings controls at least 44px. Touch fixture/browser checks and desktop/touch sizing checks passed.

Prism v5 source `8d1432dda1cd0d4e7407a66bf4a1ccf5cec15659`: signed iOS build verified, profile covers both devices. IPA SHA256 `5ca426a85fb310b970e91328ba895a8b9c94c67b0799a7ffe2ce1e455c71e118`. iPad installed and launched. iPhone initially returned CoreDevice4016/connectivity, then became reachable and the installation succeeded. Both devices now have v5; iPad launch verified.

The first Omni v3 candidate source `f306b5b3` had the supplied icon, skills not yet included, jobs and native links, but **did not contain conversational voice**. PR77 had been merged into a supporting navigation branch instead of main. Earlier reports that this candidate included voice were incorrect; the owner could not find the absent control. PR87 explicitly integrates the reviewed voice delta into main. Release checks now verify source wiring, and the corrected release binary was checked for linked conversation voice code.

Owner confirmed View source opens native Prism. Owner notification tap testing on the first candidate failed: iPad crashed and iPhone stayed on Home. The iPad IPS faulted in UIKit snapshot/restoration from the async notification completion callback. PR87 replaces that witness with an explicit completion handler dispatched and completed on MainActor; completion is prompt even for invalid/missing URL. Phone navigation additionally reconciles destination state when an early observer update is missed. Eleven focused voice, queue and completion tests passed; these are not a substitute for physical acceptance.

Corrected Omni `omni-client-v2026.10.10-3` source `422ad503fa7c55a912fc7371df90e80f9cfec126`: Release iOS compiled, strict signature verified, profile `6035299e-8da5-4fa4-8a18-f2f1afd83348` covers both devices, sandbox APNs. Executable SHA256 `204c89b6079e9292c7600eb9c66a5901f4ff880071258a47284b2d0c10e2bed7`. Release binary has conversational voice and lacks test launch hooks. Installed and launched on iPad; physical voice and notification re-tests requested, awaiting owner. Voice is an explicit turn-by-turn exchange: conversation → Voice → Speak → Send Voice; spoken response supports Mute / Interrupt and Speak. This is not an always-listening hands-free mode.

## Mac and follow-on work

Old Omni v2 notarization accepted and stapled, but that build lacks current features/audio entitlement and should not replace newer builds. Old Prism v3 notarization remains In Progress as of 18:24 UTC. Current final Mac bundles, signing and notarization are still being completed. New Omni signature must retain `com.apple.security.device.audio-input` and must not carry debug get-task-allow.

`docs/distribution/first-run-proposal.md` is a design proposal: signed host installer, App Store clients with pairing, private/collaborative vault setup, optional Omni. Installer implementation and App Store submission have not occurred. Multi-user authorization regression checks passed, including host-only controls and tenant-scoped admin user listing; this does not assert every collaborative workflow is perfect. The week-long proactive observation gate remains pending. No new production vault cleanup was authorized or performed in this pass.

## Final server follow-up

Prism `prism-v2026.10.10-9` / Omni `omni-client-v2026.10.10-4` source `4b8c08d230dd69de0f224d6b2098972c2a30d018` adds verified M3 job management. Parent and independent Sol review found no concrete approval-boundary blocker. Five focused server tests, nine native tests and integrated `npm run check` passed. Server dry/apply deployed successfully; Mini log `~/deploy-state/prism-20261010T183433Z.log`, all health gates passed. Prior code was v8 (the identical source also has the client-v3 tag, which git describe printed).

Configured `OMNI_REVIEWED_JOB_SCRIPTS_DIR` under its named runbook after matching all three wrapper hashes. Backup `.env.bak-omni-reviewed-jobs-20261010T183425Z`. Read-only live verification: 11 jobs, exactly the three reviewed local M3 jobs manageable; eight legacy jobs retain restrictions. No live schedule edit/resume/run was performed in this verification. New guarded agent jobs remain manageable through their owner conversation.

Omni v4 signed iOS build verified both-device profile, Voice and Skills linked, and absence of test hooks. Binary SHA256 `ddb00999289e27e874141ac1aea362558b4e134e080d035ab3f732003a10dfa2`; ZIP SHA256 `663ad84151dba7f553f02d774e0b0f6bb9bce86952bc8348f79752f6e0cfedcc`. iPhone installation succeeded. iPad remains on corrected v3 while its owner voice/notification tests are pending; v4 changes only add reviewed job controls.

## Mac staging checkpoint

Final Prism v5 Mac archive SHA256 `050e1640d0db9c8b73f717d44e5db99b1febd117b650e0a3bfdf675167cc2f41` is staged at `~/release-artifacts/prism-client-v2026.10.10-5/prism-client/Prism Client.app` on the Mini. Final Omni v4 universal Mac archive SHA256 `bcf917329d99cc4d65fe1d1920d39c98a842f5c9d45614a48f5ae983cb1ad5d0` is staged at `~/release-artifacts/omni-client-v2026.10.10-4/omni/Omni.app`. Transferred hashes and main executables were verified; each bundle contains one executable. Omni reuses the existing public Developer ID provisioning profile `25c9679a-e6ed-40da-967a-b7cdee1b708c`; the new signing sidecar preserves application/team/Keychain identifiers and production APNs, adds audio-input, and excludes debug entitlements. No private key was moved.

A normal SSH signing attempt for Prism still failed with `errSecInternalComponent`. Owner was asked to run both exact codesign commands in the Mini desktop Terminal. **Final signatures, new notarization submissions, stapling and installation are pending that step.** Do not describe staged bundles as notarized or installed. Resume with strict signature and entitlement verification, then the existing notarize/install runbook; approval to notarize both apps was already supplied earlier in this session.
