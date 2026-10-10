import AVFoundation
import OmniCore
import SwiftUI

/// Explicit, turn-by-turn local voice. Only recognized text goes to Hermes.
struct ConversationVoiceControl: View {
    @Bindable var model: ThreadModel
    @Environment(\.scenePhase) private var phase
    @State private var device: ConversationDevice
    @State private var voice: VoiceConversation
    @State private var selected = ConversationDevice.Engine.apple
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
            HStack {
                Menu {
                    Picker("Local speech engine", selection: $selected) {
                        ForEach(ConversationDevice.Engine.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                } label: { Label(selected.rawValue, systemImage: "waveform") }
                .disabled(voice.state != .off)
                Spacer()
                if voice.state == .listening {
                    Button("Send Voice", systemImage: "arrow.up.circle.fill") { finish() }
                        .buttonStyle(.borderedProminent)
                } else if voice.state == .preparing || voice.state == .transcribing {
                    ProgressView().accessibilityLabel(voice.state == .preparing ? "Preparing speech" : "Transcribing")
                    Button("Cancel") { cancel() }
                } else {
                    Button(voice.state == .answering || model.isRunning ? "Interrupt and Speak" : "Speak", systemImage: "mic.fill") {
                        cancel()
                        action = Task {
                            if model.isRunning { await model.stop() }
                            for _ in 0..<40 where model.isRunning {
                                if Task.isCancelled || !mounted || phase != .active { return }
                                try? await Task.sleep(for: .milliseconds(50))
                            }
                            guard !Task.isCancelled, mounted, !model.isRunning, phase == .active else { return }
                            device.selected = selected
                            await voice.start()
                            if voice.state == .listening {
                                timeout = Task { try? await Task.sleep(for: .seconds(120)); if !Task.isCancelled { finish() } }
                            }
                        }
                    }.disabled(model.isUnavailable || model.sendState == .sending || (!model.isRunning && model.pendingText != nil) || !model.draft.isEmpty)
                }
                if voice.state == .answering { Button("Mute", systemImage: "speaker.slash") { cancel() } }
            }
            .frame(minHeight: 44)
            Text(status).font(.caption).foregroundStyle(Color.quietText)
                .fixedSize(horizontal: false, vertical: true)
            if voice.state == .transcribing, !device.hypothesis.isEmpty { Text(device.hypothesis).font(.caption) }
            if let problem = voice.problem { Text(problem).font(.caption).foregroundStyle(.red) }
            if !voice.transcript.isEmpty { Text(voice.transcript).font(.caption).textSelection(.enabled) }
        }
        .padding(.horizontal).padding(.vertical, 6)
        .background(.bar)
        .onChange(of: model.timeline) { voice.consume(model.timeline, running: model.isRunning) }
        .onChange(of: model.isRunning) { voice.consume(model.timeline, running: model.isRunning) }
        .onChange(of: phase) { if phase != .active { cancel() } }
        #if os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in cancel() }
        #endif
        .onAppear { mounted = true }
        .onDisappear { mounted = false; cancel() }
    }
    private var status: String {
        switch voice.state {
        case .off: "Voice stays local until you send the recognized text. Models may download on first use."
        case .preparing: "Preparing local speech…"
        case .listening: "Listening. Send Voice when finished; stops automatically after two minutes."
        case .transcribing: "Transcribing on this device…"
        case .answering: "Omni's answer is spoken as it arrives. Mute or interrupt at any time."
        }
    }
    private func cancel() { action?.cancel(); action = nil; timeout?.cancel(); timeout = nil; voice.cancel() }
    private func finish() {
        timeout?.cancel(); timeout = nil
        action = Task {
            await voice.finish { text in
            guard !Task.isCancelled, mounted, phase == .active, !model.isRunning, model.draft.isEmpty else { return false }
            model.draft = text
            await model.send()
            return model.isRunning
            }
            voice.consume(model.timeline, running: model.isRunning)
        }
    }
}
