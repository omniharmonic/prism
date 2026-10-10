import AVFoundation
import OmniCore
import SwiftUI

/// Explicit, turn-by-turn local voice. Only recognized text goes to Hermes.
struct ConversationVoiceControl: View {
    @Bindable var model: ThreadModel
    @Environment(\.scenePhase) private var phase
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var device: ConversationDevice
    @State private var voice: VoiceConversation
    @State private var selected = ConversationDevice.Engine.apple
    @State private var expanded = false
    @State private var mounted = false
    @State private var action: Task<Void, Never>?
    @State private var timeout: Task<Void, Never>?
    init(model: ThreadModel) {
        self.model = model
        let device = ConversationDevice()
        _device = State(initialValue: device)
        _voice = State(initialValue: VoiceConversation(audio: device))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if expanded || voice.state != .off {
                let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 10))
                layout {
                    Menu {
                        Picker("Local speech engine", selection: $selected) {
                            ForEach(ConversationDevice.Engine.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                    } label: { Label(selected.rawValue, systemImage: "waveform") }
                    .disabled(voice.state != .off)
                    if !typeSize.isAccessibilitySize { Spacer() }
                    if voice.state == .listening {
                        Button("Send Voice", systemImage: "arrow.up.circle.fill") { finish() }
                            .buttonStyle(.borderedProminent)
                        Button("Cancel Recording") { cancel() }
                    } else if voice.state == .preparing || voice.state == .transcribing {
                        ProgressView().accessibilityLabel(voice.state == .preparing ? "Preparing speech" : "Transcribing")
                        Button("Cancel") { cancel() }
                    } else {
                        Button(voice.state == .answering || model.isRunning ? "Interrupt and Speak" : "Speak", systemImage: "mic.fill") {
                            cancel()
                            action = Task {
                                if model.isRunning { await model.stop() }
                                for _ in 0..<40 where model.isRunning {
                                    if Task.isCancelled || PrivacyLock.shared.locked || !mounted || phase != .active { return }
                                    try? await Task.sleep(for: .milliseconds(50))
                                }
                                guard !Task.isCancelled, !PrivacyLock.shared.locked, mounted, !model.isRunning, phase == .active else { return }
                                device.selected = selected
                                await voice.start()
                                if voice.state == .listening {
                                    timeout = Task { try? await Task.sleep(for: .seconds(120)); if !Task.isCancelled { finish(submit: false) } }
                                }
                            }
                        }.disabled(!voice.canStart || model.isUnavailable || model.sendState == .sending || (!model.isRunning && model.pendingText != nil) || !model.draft.isEmpty)
                    }
                    if voice.state == .answering { Button("Mute", systemImage: "speaker.slash") { cancel() } }
                }
                .frame(minHeight: 44)
                .controlSize(.large)
                Text(status).font(.caption).foregroundStyle(Color.quietText)
                    .fixedSize(horizontal: false, vertical: true)
                if voice.state == .transcribing, !device.hypothesis.isEmpty { Text(device.hypothesis).font(.caption) }
                if !voice.transcript.isEmpty { Text(voice.transcript).font(.caption).textSelection(.enabled) }
                if voice.state == .off { Button("Close Voice") { expanded = false } }
            } else {
                HStack { Button("Voice", systemImage: "mic") { expanded = true }; Spacer() }.frame(minHeight: 44)
            }
            if let problem = voice.problem { Text(problem).font(.caption).foregroundStyle(.red) }
        }
        .padding(.horizontal).padding(.vertical, 6)
        .background(.bar)
        .onChange(of: model.timeline) { voice.consume(model.timeline, running: model.isRunning) }
        .onChange(of: model.isRunning) { voice.consume(model.timeline, running: model.isRunning) }
        .onChange(of: voice.state) { if voice.state != .off { expanded = true } }
        .onChange(of: phase) { if phase != .active { cancel() } }
        #if os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in cancel() }
        #endif
        .onChange(of: PrivacyLock.shared.locked) {
            voice.setPrivacyLocked(PrivacyLock.shared.locked)
            if PrivacyLock.shared.locked { cancel() }
        }
        .onAppear { mounted = true; voice.setPrivacyLocked(PrivacyLock.shared.locked) }
        .onDisappear { mounted = false; cancel() }
    }
    private var status: String {
        switch voice.state {
        case .off: voice.canStart ? "Voice stays local until you send the recognized text. Models may download on first use." : "Waiting for the previous speech preparation to finish…"
        case .preparing: "Preparing local speech…"
        case .listening: "Listening. Send Voice or cancel. After two minutes, recording stops and recognized text is left in the draft."
        case .transcribing: "Transcribing on this device…"
        case .answering: "Omni's answer is spoken as it arrives. Mute or interrupt at any time."
        }
    }
    private func cancel() { action?.cancel(); action = nil; timeout?.cancel(); timeout = nil; voice.cancel() }
    private func finish(submit: Bool = true) {
        timeout?.cancel(); timeout = nil
        action = Task {
            await voice.finish(submit: submit) { text in
                guard !Task.isCancelled, !PrivacyLock.shared.locked, mounted, phase == .active, !model.isRunning, model.draft.isEmpty else { return false }
                model.draft = text
                if !submit { return true }
                await model.send()
                return model.isRunning
            }
            voice.consume(model.timeline, running: model.isRunning)
        }
    }
}
