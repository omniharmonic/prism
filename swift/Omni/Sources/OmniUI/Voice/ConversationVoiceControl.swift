import AVFoundation
import OmniCore
import SwiftUI

/// A persistent local voice session with explicit or opted-in automatic turn completion.
struct ConversationVoiceControl: View {
    let session: SessionModel
    let model: ThreadModel?
    let draft: Binding<String>?
    let maximumHeight: CGFloat
    @Binding var expanded: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.scenePhase) private var phase
    @Environment(\.voiceActivationSceneID) private var voiceSceneID
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var binding: VoiceControlBinding
    @State private var device: ConversationDevice
    private var voice: VoiceConversation { binding.voice }
    @State private var selected = ConversationDevice.Engine.apple
    @State private var showingVoiceSettings = false
    @State private var showingTranscript = false
    @State private var panelContentHeight: CGFloat = 280
    @State private var mounted = false
    @State private var action: Task<Void, Never>?
    init(session: SessionModel, model: ThreadModel? = nil, draft: Binding<String>? = nil, expanded: Binding<Bool>, maximumHeight: CGFloat = 280) {
        self.session = session; self.model = model; self.draft = draft; self.maximumHeight = maximumHeight; _expanded = expanded
        let sameContext = model.map { session.voiceThreadID == $0.threadID } ?? (session.newThreadUsesVoice && session.voiceThreadID == nil)
        let device = (sameContext ? session.conversationAudio as? ConversationDevice : nil) ?? ConversationDevice()
        let existingVoice = sameContext ? session.conversationVoice : nil
        #if DEBUG
        let voice = existingVoice ?? UITestLaunch.voiceLayoutFixture() ?? VoiceConversation(audio: device)
        #else
        let voice = existingVoice ?? VoiceConversation(audio: device)
        #endif
        _binding = State(initialValue: VoiceControlBinding(audio: device, voice: voice)); _device = State(initialValue: device)
        _selected = State(initialValue: device.selected)
    }
    var body: some View {
        observedPanel
            .onChange(of: phase, scenePhaseChanged)
            .onChange(of: PrivacyLock.shared.locked, privacyChanged)
            .onAppear(perform: appeared)
            .onDisappear(perform: disappeared)
            #if os(iOS)
            .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification), perform: interrupted)
            #endif
    }
    private var observedPanel: some View {
        panel
            .sheet(isPresented: $showingVoiceSettings, onDismiss: device.stopPreview) {
                ConversationVoiceSettings(device: device)
            }
            .onChange(of: model?.threadID, ownerChanged)
            .onChange(of: session.voiceThreadID, ownerChanged)
            .onChange(of: session.conversationVoice.map { ObjectIdentifier($0) }, ownerChanged)
            .onChange(of: model?.completedVoiceTurnID, consume)
            .onChange(of: model?.timeline, consume)
            .onChange(of: model?.isRunning, consume)
            .onChange(of: voice.state, voiceStateChanged)
            .onChange(of: currentDraft, draftChanged)
            .onChange(of: session.pendingVoiceActivationID, consumeShortcutActivation)
            .onChange(of: device.turnPreferences.mode, endpointPreferencesChanged)
            .onChange(of: device.turnPreferences.pauseSeconds, endpointPreferencesChanged)
            .onChange(of: device.turnPreferences.acousticInterruption, endpointPreferencesChanged)
    }
    private var currentDraft: String { model?.draft ?? draft?.wrappedValue ?? "" }
    private func voiceStateChanged() {
        if voice.state != .off { expanded = true; showingVoiceSettings = false; device.stopPreview() }
        consume()
    }
    private func draftChanged() {
        if !currentDraft.isEmpty, voice.state == .listening || voice.state == .preparing { pause() }
    }
    private func scenePhaseChanged() {
        if phase != .active { cancel() } else { consumeShortcutActivation() }
    }
    private func privacyChanged() {
        voice.setPrivacyLocked(PrivacyLock.shared.locked)
        if PrivacyLock.shared.locked { cancel() } else { consumeShortcutActivation() }
    }
    #if os(iOS)
    private func interrupted(_ notification: Notification) { cancel() }
    #endif
    private var panel: some View {
        Group {
            if (expanded || voice.state != .off) && (session.conversationVoice !== voice || session.ownsVoice(voice, threadID: model?.threadID)) {
                ScrollView(.vertical) {
                    panelContent.fixedSize(horizontal: false, vertical: true)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { panelContentHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollDismissesKeyboard(.never)
                .scrollDisabled(panelContentHeight <= maximumHeight)
                .frame(height: min(maximumHeight, panelContentHeight))
                .frame(maxWidth: 440)
                .modifier(VoicePanelMaterial(solid: reduceTransparency))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("voice.panel")
            }
        }
    }
    private var panelContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "waveform").font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color.omniAccent).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(stateTitle).font(.subheadline.weight(.semibold))
                        .accessibilityIdentifier("voice.state")
                    Text(status).font(.caption).foregroundStyle(Color.quietText)
                        .accessibilityIdentifier("voice.status")
                }.fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                Menu {
                    Picker("Speech recognition", selection: $selected) {
                        ForEach(ConversationDevice.Engine.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    Button("Voice settings", systemImage: "speaker.wave.2") { showingVoiceSettings = true }
                } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44) }
                .accessibilityLabel("Voice options").disabled(voice.state != .off && voice.state != .paused)
                Button { cancel(); expanded = false } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }
                .accessibilityLabel(voice.isSessionActive ? "End voice session" : "Close Voice")
                .accessibilityIdentifier(voice.isSessionActive ? "voice.end" : "voice.close")
                .accessibilityHint("Ends microphone capture and narration. Omni’s task continues in chat.")
            }
            if let problem = voice.problem {
                Text(problem).font(.caption).foregroundStyle(Color.failureText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("voice.problem")
            }
            if let notice = voice.activityNotice {
                Text(notice).font(.caption).foregroundStyle(Color.quietText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let notice = voice.interruptionNotice {
                Text(notice).font(.caption).foregroundStyle(Color.quietText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            controls.fixedSize(horizontal: false, vertical: true)
            if (voice.state == .paused && !voice.transcript.isEmpty) || (voice.state == .transcribing && !device.hypothesis.isEmpty) {
                DisclosureGroup("Transcript", isExpanded: $showingTranscript) {
                    Text(voice.state == .transcribing ? device.hypothesis : voice.transcript)
                        .font(.callout).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }.font(.caption)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }
    private func appeared() {
        mounted = true
        reconcileOwner()
        installAutomaticListeningGuard()
        endpointPreferencesChanged()
        voice.setPrivacyLocked(PrivacyLock.shared.locked)
        consume(); consumeShortcutActivation()
        #if DEBUG
        if model != nil { Task { await UITestLaunch.prepareVoiceLayoutFixture(voice) } }
        #endif
    }
    private func disappeared() {
        mounted = false
        // The first send retains the session while its new thread mounts.
        if isHandingOffToCreatedThread {
            return
        }
        cancel()
    }
    private var isHandingOffToCreatedThread: Bool {
        guard model == nil, let threadID = session.voiceThreadID else { return false }
        return session.destination == .thread(threadID)
    }

    private var running: Bool { model?.isRunning ?? false }
    private var stateTitle: String {
        switch voice.state {
        case .off: voice.endpointMode == .thinkAloud ? "Ready to think aloud" : "Ready to talk"
        case .paused: "Session paused"
        case .speaking: "Omni is speaking"
        case .preparing: "Preparing voice"
        case .listening: "Listening"
        case .transcribing: "Transcribing"
        case .answering: "Omni is responding"
        }
    }
    private var status: String {
        switch voice.state {
        case .off: voice.endpointMode == .thinkAloud ? "Think aloud · manual send" : "Automatic · \(Int(voice.endpointPause))s pause"
        case .paused:
            if !currentDraft.isEmpty { "Send your draft in chat, or clear it to resume." }
            else if session.approvals.pending.contains(where: { $0.approval.threadId == model?.threadID }) { "Review the approval in chat." }
            else if model?.isUnavailable == true { "This conversation is unavailable." }
            else if model?.pendingText != nil { "Review the unsent message in chat." }
            else if model?.sendState == .sending || session.threads.isCreating { "Sending your message…" }
            else if model?.streamProblem != nil { "Check the connection issue in chat." }
            else if model?.turnEnded != nil { "Review the interrupted turn in chat." }
            else if running { "Mic off · Omni’s task continues." }
            else { "Mic off · resume when ready." }
        case .speaking: voice.acousticInterruptionEnabled && voice.interruptionNotice == nil ? "Speak to interrupt · reply playing" : "Mic off · reply playing"
        case .preparing: "Preparing speech on this device…"
        case .listening:
            if running { "Listening · Omni’s task is still running." }
            else if let countdown = voice.endpointCountdown { "Sending in \(countdown)…" }
            else if voice.activityNotice != nil || voice.endpointMode == .thinkAloud { "Send when you’re ready." }
            else { "Automatic · \(Int(voice.endpointPause))s pause" }
        case .transcribing: "Recognizing your words…"
        case .answering: "Mic off while Omni responds."
        }
    }
    @ViewBuilder private var controls: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 10))
        layout {
            if voice.state == .listening {
                Button { finish() } label: {
                    Label("Send turn", systemImage: "arrow.up").frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.borderedProminent)
                .disabled(running)
                .accessibilityIdentifier("voice.send")
                .accessibilityHint("Silence never sends in Think aloud. Long recordings are kept as an unsent draft if recording reaches its limit.")
            } else if voice.state == .preparing || voice.state == .transcribing {
                ProgressView().frame(maxWidth: .infinity, minHeight: 44).accessibilityLabel(stateTitle)
            } else {
                Button { start() } label: {
                    Label(voice.state == .paused ? "Resume" : voice.isSessionActive ? "Interrupt and speak" : "Start session", systemImage: "mic.fill")
                        .frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.borderedProminent).disabled(!canSpeak)
                .accessibilityIdentifier("voice.start")
            }
            if voice.endpointCountdown != nil {
                Button("Keep listening") { voice.keepListening() }
                    .frame(minHeight: 44)
                    .fixedSize(horizontal: !typeSize.isAccessibilitySize, vertical: true)
                    .accessibilityIdentifier("voice.keepListening")
            } else if voice.isSessionActive && voice.state != .paused {
                Button { pause() } label: { Label("Pause", systemImage: "pause.fill").frame(minHeight: 44) }
                    .fixedSize(horizontal: !typeSize.isAccessibilitySize, vertical: true)
                    .accessibilityIdentifier("voice.pause")
                    .accessibilityHint(voice.state == .listening ? "Keeps your words as an unsent draft" : "Turns off the microphone and stops narration. Omni’s task continues in chat.")
            }
        }
        .font(.callout).controlSize(.regular).buttonBorderShape(.capsule)
        .frame(maxWidth: .infinity, minHeight: 44)
    }
    private func reconcileOwner() {
        guard let sharedDevice = session.conversationAudio as? ConversationDevice else { return }
        if binding.reconcile(session: session, threadID: model?.threadID) {
            device = sharedDevice; selected = sharedDevice.selected
        }
    }
    private func ownerChanged() {
        guard mounted else { return }
        reconcileOwner()
        guard session.ownsVoice(voice, threadID: model?.threadID) else { return }
        installAutomaticListeningGuard()
        consume()
    }
    private func consume() {
        guard mounted, let model else { return }
        reconcileOwner()
        guard session.ownsVoice(voice, threadID: model.threadID) else { return }
        installAutomaticListeningGuard()
        binding.consume(session: session, model: model)
    }
    private func consumeShortcutActivation() {
        guard session.pendingVoiceActivationID != nil, model == nil, mounted, phase == .active, !PrivacyLock.shared.locked else { return }
        // Never overwrite or dispatch a typed draft, or retry automatically after a failure.
        guard canSpeak else { session.cancelPendingVoiceActivation(); return }
        if VoiceActivationCoordinator.shared.consume(session: session, sceneID: voiceSceneID, threadID: model?.threadID) { start() }
    }
    private var canSpeak: Bool {
        voice.canStart && model?.isUnavailable != true && model?.sendState != .sending &&
        (running || model?.pendingText == nil) && (model?.draft ?? draft?.wrappedValue ?? "").isEmpty && !session.threads.isCreating
    }
    private func start() {
        guard canSpeak, mounted, phase == .active, !PrivacyLock.shared.locked else { return }
        cancel()
        _ = model?.takeCompletedVoiceTimeline()
        guard session.claimVoice(audio: device, voice: voice, threadID: model?.threadID) else { return }
        let lease = session.voiceLease
        installAutomaticListeningGuard()
        session.beginVoiceStart()
        action = Task {
            defer { session.endVoiceStart(lease: lease) }
            if let model, model.isRunning { await model.stop() }
            for _ in 0..<40 where running {
                if Task.isCancelled || PrivacyLock.shared.locked || !mounted || phase != .active { return }
                try? await Task.sleep(for: .milliseconds(50))
            }
            guard !Task.isCancelled, !PrivacyLock.shared.locked, mounted, !running, phase == .active, lease == session.voiceLease, session.ownsVoice(voice, threadID: model?.threadID) else { return }
            device.selected = selected
            configureEndpoint()
            await voice.start()
        }
    }
    private func endpointPreferencesChanged() {
        guard voice.state == .off || voice.state == .paused else { return }
        configureEndpoint()
    }
    private func configureEndpoint() {
        voice.acousticInterruptionEnabled = device.turnPreferences.acousticInterruption
        voice.configureEndpoint(mode: device.turnPreferences.mode, pauseSeconds: device.turnPreferences.pauseSeconds)
    }
    private func installAutomaticListeningGuard() {
        let lease = session.voiceLease
        voice.recordingLimitReached = {
            guard mounted, phase == .active, !PrivacyLock.shared.locked,
                  lease == session.voiceLease, session.ownsVoice(voice, threadID: model?.threadID),
                  voice.state == .listening else { return }
            finish(submit: false)
        }
        voice.saveRecoveredDraft = { text in
            guard mounted, phase == .active, !PrivacyLock.shared.locked,
                  lease == session.voiceLease, session.ownsVoice(voice, threadID: model?.threadID),
                  currentDraft.isEmpty else { return }
            if let model { model.draft = text } else { draft?.wrappedValue = text }
        }
        voice.automaticFinish = {
            guard mounted, phase == .active, !PrivacyLock.shared.locked,
                  lease == session.voiceLease, session.ownsVoice(voice, threadID: model?.threadID),
                  voice.state == .listening, currentDraft.isEmpty else { return }
            guard !running else { voice.keepListening(); return }
            finish()
        }
        voice.canAutomaticallyListen = {
            mounted && phase == .active && !PrivacyLock.shared.locked && !running &&
            lease == session.voiceLease && session.ownsVoice(voice, threadID: model?.threadID) &&
            model?.isUnavailable != true && model?.sendState != .sending && model?.pendingText == nil &&
            model?.turnEnded == nil && model?.streamProblem == nil &&
            !session.approvals.pending.contains(where: { $0.approval.threadId == model?.threadID }) &&
            (model?.draft ?? draft?.wrappedValue ?? "").isEmpty && !session.threads.isCreating
        }
    }
    private func pause() {
        if voice.state == .listening, (model?.draft ?? draft?.wrappedValue ?? "").isEmpty {
            finish(submit: false, draftReason: .pause)
            return
        }
        action?.cancel(); action = nil
        device.stopPreview(); voice.pause()
    }
    private func cancel() {
        if model == nil { session.cancelPendingVoiceActivation() }
        showingVoiceSettings = false; device.stopPreview()
        action?.cancel(); action = nil
        if session.conversationVoice !== voice { voice.cancel() }
        else { session.cancelVoice(voice, threadID: model?.threadID) }
    }
    private func finish(submit: Bool = true, draftReason: VoiceConversation.DraftReason = .recordingLimit) {
        let lease = session.voiceLease
        action = Task {
            await voice.finish(submit: submit, draftReason: draftReason) { text in
                guard !Task.isCancelled, lease == session.voiceLease, !PrivacyLock.shared.locked, mounted, phase == .active, (!submit || !running), (model?.draft ?? draft?.wrappedValue ?? "").isEmpty else { return false }
                if let model { model.draft = text } else { draft?.wrappedValue = text }
                if !submit { return true }
                if let model { return await model.send() }
                let sent = await session.startVoiceThread(prompt: text, voice: voice)
                if sent { draft?.wrappedValue = "" }
                return sent
            }
            consume()
        }
    }
}

/// Glass is confined to this floating control layer. Accessibility can request an opaque surface.
private struct VoicePanelMaterial: ViewModifier {
    let solid: Bool
    func body(content: Content) -> some View {
        if solid {
            content.background(.background, in: RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(.primary.opacity(0.15)))
        } else {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24))
        }
    }
}
