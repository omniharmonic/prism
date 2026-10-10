@preconcurrency import AVFoundation
import Foundation
import Observation
import OmniCore
import OmniVoiceKit

@MainActor @Observable final class ConversationDevice: ConversationAudio {
    enum Engine: String, CaseIterable, Hashable { case apple = "Apple", parakeet = "Parakeet" }
    var hypothesis = ""
    var selected = Engine.apple
    private let apple = AppleTranscriber()
    private let parakeet = ParakeetTranscriber()
    private let audio = AudioIO()
    private let speaker = AVSpeechSynthesizer()
    private var file: URL?
    private var generation = 0
    private var prepared = Set<Engine>()
    private var engine: any ConversationSTTEngine { selected == .apple ? apple : parakeet }
    init() {
        #if os(iOS)
        // System speech owns its playback session after capture releases the microphone.
        speaker.usesApplicationAudioSession = false
        #endif
    }
    func start() async throws {
        hypothesis = ""
        let request = generation
        let selected = self.selected
        let current = engine
        if let reason = await current.availability() { throw VoiceFailure.unavailable(reason) }
        if !prepared.contains(selected) {
            try await current.prepare(vocabulary: ["Benjamin Life", "Omniharmonic", "Prism", "Hermes", "Parachute"])
            prepared.insert(selected)
        }
        guard request == generation, !Task.isCancelled else { throw CancellationError() }
        let url = FileManager.default.temporaryDirectory.appending(path: "omni-voice-\(UUID().uuidString).caf")
        file = url
        do {
            try await audio.start(url: url)
            guard request == generation, !Task.isCancelled else { throw CancellationError() }
        } catch { cancel(); throw error }
    }
    func finish() async throws -> String {
        guard let file else { throw VoiceFailure.unavailable("No voice recording is active.") }
        try audio.stop()
        defer { try? FileManager.default.removeItem(at: file); if self.file == file { self.file = nil } }
        let request = generation
        return try await engine.transcribeConversation(file: file) { event in
            await MainActor.run {
                if self.generation == request { self.hypothesis = [event.confirmed, event.volatile].filter { !$0.isEmpty }.joined(separator: " ") }
            }
        }
    }
    func cancel() {
        generation += 1; hypothesis = ""; try? audio.stop()
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
    }
    func speak(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        speaker.speak(utterance)
    }
    func silence() { speaker.stopSpeaking(at: .immediate) }
}
