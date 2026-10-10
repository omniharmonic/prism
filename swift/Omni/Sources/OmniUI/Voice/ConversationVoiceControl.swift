import AVFoundation
import OmniCore
import SwiftUI

/// Explicit, turn-by-turn local voice. Only recognized text goes to Hermes.
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
                        Label("Voice", systemImage: "waveform").font(.headline)
                        Spacer()
                        Menu {
                            Picker("Speech recognition", selection: $selected) {
                                ForEach(ConversationDevice.Engine.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                            }
                            Button("Voice & Playback", systemImage: "speaker.wave.2") { showingVoiceSettings = true }
                        } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44) }
                        .accessibilityLabel("Voice options").disabled(voice.state != .off)
                        Button { cancel(); expanded = false } label: {
                            Image(systemName: "xmark").frame(width: 44, height: 44)
                        }.accessibilityLabel("Close Voice")
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
        .onChange(of: model?.completedVoiceTimeline) { _, _ in consume() }
        .onChange(of: model?.timeline) { consume() }
        .onChange(of: model?.isRunning) { consume() }
        .onChange(of: voice.state) { if voice.state != .off { expanded = true; showingVoiceSettings = false; device.stopPreview() }; consume() }
        .onChange(of: session.pendingVoiceActivationID) { consumeShortcutActivation() }
        .onChange(of: phase) { if phase != .active { cancel() } else { consumeShortcutActivation() } }
        #if os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in cancel() }
        #endif
        .onChange(of: PrivacyLock.shared.locked) {
            voice.setPrivacyLocked(PrivacyLock.shared.locked)
            if PrivacyLock.shared.locked { cancel() } else { consumeShortcutActivation() }
        }
        .onAppear { mounted = true; voice.setPrivacyLocked(PrivacyLock.shared.locked); consume(); consumeShortcutActivation() }
        .onDisappear {
            mounted = false
            // The first send moves this same voice session into its newly created thread.
            if model == nil, let id = session.voiceThreadID, session.destination == .thread(id) { return }
            cancel()
        }
    }
    private var running: Bool { model?.isRunning ?? false }
    private var stateTitle: String {
        switch voice.state {
        case .off: "Ready to speak"
        case .preparing: "Preparing voice"
        case .listening: "Listening"
        case .transcribing: "Transcribing"
        case .answering: running ? "Omni is responding" : "Ready for your next turn"
        }
    }
    private var status: String {
        switch voice.state {
        case .off: voice.canStart ? "Speak naturally. Send when you’re ready." : "Finishing speech preparation…"
        case .preparing: "Preparing speech on this device. Models may download on first use."
        case .listening: "Send when you're ready. At two minutes, text is kept as a draft."
        case .transcribing: "Recognizing your words on this device…"
        case .answering: "Voice is on. You can mute or interrupt at any time."
        }
    }
    @ViewBuilder private var controls: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 10))
        layout {
            if voice.state == .listening {
                Button("Send Voice", systemImage: "arrow.up") { finish() }.buttonStyle(.borderedProminent)
                Button { cancel() } label: { Text("Cancel").frame(minHeight: 44) }
            } else if voice.state == .preparing || voice.state == .transcribing {
                ProgressView().accessibilityLabel(stateTitle)
                Button { cancel() } label: { Text("Cancel").frame(minHeight: 44) }
            } else {
                Button(running || voice.state == .answering ? "Interrupt and Speak" : "Speak", systemImage: "mic.fill") { start() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!voice.canStart || model?.isUnavailable == true || model?.sendState == .sending || (!running && model?.pendingText != nil) || !(model?.draft ?? draft?.wrappedValue ?? "").isEmpty || session.threads.isCreating)
                if voice.state == .answering { Button { cancel() } label: { Label("Mute", systemImage: "speaker.slash").frame(minHeight: 44) } }
            }
        }.controlSize(.large).buttonBorderShape(.capsule)
        .frame(minHeight: 44)
    }
    private func consume() {
        guard let model, session.voiceThreadID == model.threadID else { return }
        guard voice.state == .answering else { return }
        voice.consume(model.timeline + model.takeCompletedVoiceTimeline(), running: model.isRunning)
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
            if lease == session.voiceLease, session.ownsVoice(voice, threadID: model?.threadID), voice.state == .listening {
                timeout = Task { try? await Task.sleep(for: .seconds(120)); if !Task.isCancelled { finish(submit: false) } }
            }
        }
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
                if let model { await model.send(); return model.isRunning }
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
