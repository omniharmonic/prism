import AVFoundation
import OmniCore
import SwiftUI

/// A persistent Think aloud session. Only explicitly committed text goes to Hermes.
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
    @State private var device: ConversationDevice
    @State private var voice: VoiceConversation
    @State private var selected = ConversationDevice.Engine.apple
    @State private var showingVoiceSettings = false
    @State private var showingTranscript = false
    @State private var mounted = false
    @State private var action: Task<Void, Never>?
    @State private var timeout: Task<Void, Never>?
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
        _device = State(initialValue: device); _voice = State(initialValue: voice)
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
            .onChange(of: model?.completedVoiceTurnID, consume)
            .onChange(of: model?.timeline, consume)
            .onChange(of: model?.isRunning, consume)
            .onChange(of: voice.state, voiceStateChanged)
            .onChange(of: currentDraft, draftChanged)
            .onChange(of: session.pendingVoiceActivationID, consumeShortcutActivation)
            .onChange(of: device.turnPreferences.mode, endpointPreferencesChanged)
            .onChange(of: device.turnPreferences.pauseSeconds, endpointPreferencesChanged)
    }
    private var currentDraft: String { model?.draft ?? draft?.wrappedValue ?? "" }
    private func voiceStateChanged() {
        if voice.state != .off { expanded = true; showingVoiceSettings = false; device.stopPreview() }
        updateCaptureTimeout(); consume()
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
                ViewThatFits(in: .vertical) {
                    panelContent.fixedSize(horizontal: false, vertical: true)
                    ScrollView(.vertical) { panelContent.fixedSize(horizontal: false, vertical: true) }
                        .scrollBounceBehavior(.basedOnSize)
                }
                .frame(maxHeight: maximumHeight)
                .frame(maxWidth: 440)
                .modifier(VoicePanelMaterial(solid: reduceTransparency))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("voice.panel")
            }
        }
    }
    private var panelContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Label(device.turnPreferences.mode == .thinkAloud ? "Think aloud" : "Conversation", systemImage: "waveform").font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Menu {
                    // Conversation mode options share this menu with local voice settings.
                    Picker("Speech recognition", selection: $selected) {
                        ForEach(ConversationDevice.Engine.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    Button("Voice & Playback", systemImage: "speaker.wave.2") { showingVoiceSettings = true }
                } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44) }
                .accessibilityLabel("Voice options").disabled(voice.state != .off && voice.state != .paused)
                Button { cancel(); expanded = false } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }.accessibilityLabel(voice.isSessionActive ? "End voice session" : "Close Voice")
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(stateTitle).font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("voice.state")
                Text(status).font(.caption).foregroundStyle(Color.quietText)
                    .accessibilityIdentifier("voice.status")
            }.fixedSize(horizontal: false, vertical: true)
            if let problem = voice.problem {
                Text(problem).font(.caption).foregroundStyle(Color.failureText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("voice.problem")
            }
            if let notice = voice.activityNotice {
                Text(notice).font(.caption).foregroundStyle(Color.quietText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let countdown = voice.endpointCountdown {
                HStack {
                    Text("Sending in \(countdown)…").font(.caption)
                    Spacer()
                    Button("Keep listening") { voice.keepListening() }
                        .accessibilityIdentifier("voice.keepListening")
                }.fixedSize(horizontal: false, vertical: true)
            }
            controls.fixedSize(horizontal: false, vertical: true)
            if !voice.transcript.isEmpty || !device.hypothesis.isEmpty {
                DisclosureGroup("Transcript", isExpanded: $showingTranscript) {
                    Text(voice.state == .transcribing ? device.hypothesis : voice.transcript)
                        .font(.callout).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }.font(.caption)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }
    private func appeared() {
        mounted = true
        installAutomaticListeningGuard()
        endpointPreferencesChanged()
        voice.setPrivacyLocked(PrivacyLock.shared.locked)
        updateCaptureTimeout(); consume(); consumeShortcutActivation()
        #if DEBUG
        if model != nil { Task { await UITestLaunch.prepareVoiceLayoutFixture(voice) } }
        #endif
    }
    private func disappeared() {
        mounted = false
        // The first send retains the session while its new thread mounts.
        if isHandingOffToCreatedThread {
            timeout?.cancel(); timeout = nil
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
        case .off: device.turnPreferences.mode == .thinkAloud ? "Ready to think aloud" : "Ready to talk"
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
        case .off:
            if !voice.canStart { "Finishing speech preparation…" }
            else if device.turnPreferences.mode == .thinkAloud { "Start a session. Silence never sends your turn." }
            else { "Start a session. Your selected pause controls when each turn sends." }
        case .paused:
            if !(model?.draft ?? draft?.wrappedValue ?? "").isEmpty { "Microphone is off. Send your draft in chat, or clear it to resume listening." }
            else if session.approvals.pending.contains(where: { $0.approval.threadId == model?.threadID }) { "Microphone is off. An approval needs your review in chat." }
            else if model?.isUnavailable == true { "Microphone is off. This conversation is unavailable." }
            else if model?.pendingText != nil { "Microphone is off. Review the unsent message in chat before resuming." }
            else if model?.sendState == .sending || session.threads.isCreating { "Microphone is off while your message is being sent." }
            else if model?.streamProblem != nil { "Microphone is off. Check the connection issue in chat before resuming." }
            else if model?.turnEnded != nil { "Microphone is off. Review the interrupted turn in chat before resuming." }
            else if running { "Microphone and narration are off. Omni’s task continues in chat." }
            else { "Microphone is off. Resume when you’re ready." }
        case .speaking: "Microphone is off during playback. Listening resumes after the full reply."
        case .preparing: "Preparing speech on this device. Models may download on first use."
        case .listening:
            device.turnPreferences.mode == .thinkAloud
                ? "Take your time. Tap Send turn when ready. At two minutes, we pause and keep a draft."
                : "Your turn sends after a \(Int(device.turnPreferences.pauseSeconds))-second pause and a countdown. Tap Keep listening for more time."
        case .transcribing: "Recognizing your words on this device…"
        case .answering: "Microphone is off while Omni responds. Your session stays open."
        }
    }
    @ViewBuilder private var controls: some View {
        VStack(spacing: 10) {
            if voice.state == .listening {
                Button { finish() } label: { Label("Send turn", systemImage: "arrow.up").frame(minHeight: 32) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("voice.send")
            } else if voice.state == .preparing || voice.state == .transcribing {
                ProgressView().accessibilityLabel(stateTitle)
            } else {
                Button { start() } label: {
                    Label(voice.state == .paused ? "Resume" : voice.isSessionActive ? "Interrupt and speak" : "Start session", systemImage: "mic.fill")
                        .frame(minHeight: 32)
                }
                    .buttonStyle(.borderedProminent).disabled(!canSpeak)
                    .accessibilityIdentifier("voice.start")
            }
            if voice.isSessionActive {
                let secondaryLayout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 10))
                secondaryLayout {
                    if voice.state != .paused {
                        Button { pause() } label: { Label("Pause", systemImage: "pause.fill").frame(minHeight: 44) }
                            .accessibilityIdentifier("voice.pause")
                            .accessibilityHint(voice.state == .listening ? "Keeps your words as an unsent draft" : "Turns off the microphone and stops narration. Omni’s task continues in chat.")
                    }
                    Button { cancel() } label: { Text("End session").frame(minHeight: 44) }
                        .accessibilityIdentifier("voice.end")
                        .accessibilityHint("Ends microphone capture and narration. Omni’s task continues in chat.")
                }
            }
        }.controlSize(.regular).buttonBorderShape(.capsule)
        .frame(minHeight: 44)
    }
    private func consume() {
        guard let model, session.voiceThreadID == model.threadID else { return }
        if model.completedVoiceTurnID != nil {
            voice.agentDidComplete(model.takeCompletedVoiceTimeline())
        }
        if voice.state == .answering || voice.state == .speaking {
            voice.consume(model.timeline, running: model.isRunning)
        }
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
        session.claimVoice(audio: device, voice: voice, threadID: model?.threadID)
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
            updateCaptureTimeout()
        }
    }
    private func endpointPreferencesChanged() {
        guard voice.state == .off || voice.state == .paused else { return }
        configureEndpoint()
    }
    private func configureEndpoint() {
        voice.configureEndpoint(mode: device.turnPreferences.mode, pauseSeconds: device.turnPreferences.pauseSeconds)
    }
    private func installAutomaticListeningGuard() {
        let lease = session.voiceLease
        voice.automaticFinish = {
            guard mounted, phase == .active, !PrivacyLock.shared.locked, !running,
                  lease == session.voiceLease, session.ownsVoice(voice, threadID: model?.threadID),
                  voice.state == .listening, currentDraft.isEmpty else { return }
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
    private func updateCaptureTimeout() {
        timeout?.cancel(); timeout = nil
        guard voice.state == .listening, mounted, session.ownsVoice(voice, threadID: model?.threadID) else { return }
        let lease = session.voiceLease
        timeout = Task {
            do { try await Task.sleep(for: .seconds(120)) } catch { return }
            guard mounted, phase == .active, lease == session.voiceLease,
                  session.ownsVoice(voice, threadID: model?.threadID), voice.state == .listening else { return }
            finish(submit: false)
        }
    }
    private func pause() {
        if voice.state == .listening, (model?.draft ?? draft?.wrappedValue ?? "").isEmpty {
            finish(submit: false, draftReason: .pause)
            return
        }
        action?.cancel(); action = nil; timeout?.cancel(); timeout = nil
        device.stopPreview(); voice.pause()
    }
    private func cancel() {
        if model == nil { session.cancelPendingVoiceActivation() }
        showingVoiceSettings = false; device.stopPreview()
        action?.cancel(); action = nil; timeout?.cancel(); timeout = nil
        if session.conversationVoice !== voice { voice.cancel() }
        else { session.cancelVoice(voice, threadID: model?.threadID) }
    }
    private func finish(submit: Bool = true, draftReason: VoiceConversation.DraftReason = .recordingLimit) {
        timeout?.cancel(); timeout = nil
        let lease = session.voiceLease
        action = Task {
            await voice.finish(submit: submit, draftReason: draftReason) { text in
                guard !Task.isCancelled, lease == session.voiceLease, !PrivacyLock.shared.locked, mounted, phase == .active, !running, (model?.draft ?? draft?.wrappedValue ?? "").isEmpty else { return false }
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
