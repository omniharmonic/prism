import AVFoundation
import OmniCore
import SwiftUI

/// A persistent Think aloud session. Only explicitly committed text goes to Hermes.
struct ConversationVoiceControl: View {
    let session: SessionModel
    let model: ThreadModel?
    let draft: Binding<String>?
    @Binding var expanded: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.scenePhase) private var phase
    @Environment(\.voiceActivationSceneID) private var voiceSceneID
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var device: ConversationDevice
    @State private var voice: VoiceConversation
    @State private var selected = ConversationDevice.Engine.apple
    @State private var showingVoiceSettings = false
    @State private var mounted = false
    @State private var action: Task<Void, Never>?
    @State private var timeout: Task<Void, Never>?
    init(session: SessionModel, model: ThreadModel? = nil, draft: Binding<String>? = nil, expanded: Binding<Bool>) {
        self.session = session; self.model = model; self.draft = draft; _expanded = expanded
        let sameContext = model.map { session.voiceThreadID == $0.threadID } ?? (session.newThreadUsesVoice && session.voiceThreadID == nil)
        let device = (sameContext ? session.conversationAudio as? ConversationDevice : nil) ?? ConversationDevice()
        let voice = (sameContext ? session.conversationVoice : nil) ?? VoiceConversation(audio: device)
        _device = State(initialValue: device); _voice = State(initialValue: voice)
        _selected = State(initialValue: device.selected)
    }
    var body: some View {
        Group {
            if (expanded || voice.state != .off) && (session.conversationVoice !== voice || session.ownsVoice(voice, threadID: model?.threadID)) {
                VStack(spacing: 12) {
                    HStack {
                        Label("Think aloud", systemImage: "waveform").font(.headline)
                        Spacer()
                        Menu {
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
                    let layout = AnyLayout(VStackLayout(spacing: 12))
                    layout {
                        Image(systemName: "waveform")
                            .font(.system(size: 25, weight: .medium))
                            .foregroundStyle(Color.omniAccent)
                            .frame(width: 64, height: 64)
                            .background(Color.omniAccent.opacity(0.10), in: Circle())
                            .accessibilityHidden(true)
                        VStack(alignment: .center, spacing: 4) {
                            Text(stateTitle).font(.headline)
                            Text(status).font(.caption).foregroundStyle(Color.quietText)
                                .fixedSize(horizontal: false, vertical: true)
                        }.frame(maxWidth: .infinity, alignment: .center).multilineTextAlignment(.center)
                    }
                    controls
                    if voice.state == .transcribing, !device.hypothesis.isEmpty { Text(device.hypothesis).font(.callout) }
                    if !voice.transcript.isEmpty { Text(voice.transcript).font(.callout).textSelection(.enabled) }
                    if let problem = voice.problem { Text(problem).font(.caption).foregroundStyle(Color.failureText) }
                }
                .padding(20).frame(maxWidth: 440)
                .modifier(VoicePanelMaterial(solid: reduceTransparency))
                .padding(.horizontal).padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("voice.panel")
            }
        }
        .sheet(isPresented: $showingVoiceSettings, onDismiss: { device.stopPreview() }) {
            ConversationVoiceSettings(device: device)
        }
        .onChange(of: model?.completedVoiceTurnID) { _, _ in consume() }
        .onChange(of: model?.timeline) { consume() }
        .onChange(of: model?.isRunning) { consume() }
        .onChange(of: voice.state) {
            if voice.state != .off { expanded = true; showingVoiceSettings = false; device.stopPreview() }
            updateCaptureTimeout()
            consume()
        }
        .onChange(of: model?.draft ?? draft?.wrappedValue ?? "") {
            if !(model?.draft ?? draft?.wrappedValue ?? "").isEmpty, voice.state == .listening || voice.state == .preparing { pause() }
        }
        .onChange(of: session.pendingVoiceActivationID) { consumeShortcutActivation() }
        .onChange(of: phase) { if phase != .active { cancel() } else { consumeShortcutActivation() } }
        #if os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in cancel() }
        #endif
        .onChange(of: PrivacyLock.shared.locked) {
            voice.setPrivacyLocked(PrivacyLock.shared.locked)
            if PrivacyLock.shared.locked { cancel() } else { consumeShortcutActivation() }
        }
        .onAppear {
            mounted = true
            installAutomaticListeningGuard()
            voice.setPrivacyLocked(PrivacyLock.shared.locked)
            updateCaptureTimeout(); consume(); consumeShortcutActivation()
        }
        .onDisappear {
            mounted = false
            // The first send moves this same voice session into its newly created thread.
            if model == nil, let id = session.voiceThreadID, session.destination == .thread(id) {
                timeout?.cancel(); timeout = nil
                return
            }
            cancel()
        }
    }
    private var running: Bool { model?.isRunning ?? false }
    private var stateTitle: String {
        switch voice.state {
        case .off: "Ready to think aloud"
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
        case .off: voice.canStart ? "Start a session. Silence never sends your turn." : "Finishing speech preparation…"
        case .paused:
            if !(model?.draft ?? draft?.wrappedValue ?? "").isEmpty { "Microphone is off. Review or clear your draft before resuming." }
            else if running { "Microphone and narration are off. Omni’s task continues in chat." }
            else if model?.turnEnded != nil || model?.streamProblem != nil || session.approvals.pending.contains(where: { $0.approval.threadId == model?.threadID }) { "Microphone is off. Review the conversation before resuming." }
            else { "Microphone is off. Resume when you’re ready." }
        case .speaking: "Microphone is off during playback. Listening resumes after the full reply."
        case .preparing: "Preparing speech on this device. Models may download on first use."
        case .listening: "Take your time. Tap Send turn when ready. At two minutes, we pause and keep a draft."
        case .transcribing: "Recognizing your words on this device…"
        case .answering: "Microphone is off while Omni responds. Your session stays open."
        }
    }
    @ViewBuilder private var controls: some View {
        VStack(spacing: 10) {
            if voice.state == .listening {
                Button("Send turn", systemImage: "arrow.up") { finish() }.buttonStyle(.borderedProminent)
            } else if voice.state == .preparing || voice.state == .transcribing {
                ProgressView().accessibilityLabel(stateTitle)
            } else {
                Button(voice.state == .paused ? "Resume" : voice.isSessionActive ? "Interrupt and speak" : "Start session", systemImage: "mic.fill") { start() }
                    .buttonStyle(.borderedProminent).disabled(!canSpeak)
            }
            if voice.isSessionActive {
                let secondaryLayout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 10))
                secondaryLayout {
                    if voice.state != .paused {
                        Button { pause() } label: { Label("Pause", systemImage: "pause.fill").frame(minHeight: 44) }
                            .accessibilityHint("Turns off the microphone and stops narration. Omni’s task continues in chat.")
                    }
                    Button { cancel() } label: { Text("End session").frame(minHeight: 44) }
                        .accessibilityHint("Ends microphone capture and narration. Omni’s task continues in chat.")
                }
            }
        }.controlSize(.large).buttonBorderShape(.capsule)
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
            await voice.start()
            updateCaptureTimeout()
        }
    }
    private func installAutomaticListeningGuard() {
        let lease = session.voiceLease
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
    private func finish(submit: Bool = true) {
        timeout?.cancel(); timeout = nil
        let lease = session.voiceLease
        action = Task {
            await voice.finish(submit: submit) { text in
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
