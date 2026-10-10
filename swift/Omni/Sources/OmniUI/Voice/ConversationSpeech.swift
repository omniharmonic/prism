@preconcurrency import AVFoundation
import Observation
import OmniCore

@MainActor protocol ConversationSpeechOutput: AnyObject {
    func speak(_ text: String, identifier: String?, rate: Float, completion: @escaping @MainActor () -> Void)
    func stop()
}

/// One playback owner for all voice panels; previews cannot overlap capture or replies.
@MainActor @Observable final class ConversationSpeech {
    static let shared = ConversationSpeech(output: AppleSpeechOutput())
    static let preferences = SpeechPreferences(defaultLanguage: AVSpeechSynthesisVoice.currentLanguageCode())
    private(set) var isPreviewing = false
    private let output: any ConversationSpeechOutput
    private var recordingOwner: UUID?
    private var playbackOwner: UUID?
    private var generation = 0
    private var pending = 0
    init(output: any ConversationSpeechOutput) { self.output = output }
    func beginRecording(owner: UUID) { stopAll(); recordingOwner = owner }
    func endRecording(owner: UUID) { if recordingOwner == owner { recordingOwner = nil } }
    func preview(owner: UUID, identifier: String?, rate: Float) {
        guard recordingOwner == nil, pending == 0 || isPreviewing else { return }
        stopAll(); playbackOwner = owner; isPreviewing = true
        enqueue("Hello, I'm Omni. Take your time. When you're ready, we can think this through together.", identifier: identifier, rate: rate)
    }
    func speak(_ text: String, owner: UUID, identifier: String?, rate: Float) {
        guard recordingOwner == nil else { return }
        if isPreviewing || playbackOwner != owner { stopAll() }
        playbackOwner = owner
        enqueue(text, identifier: identifier, rate: rate)
    }
    func stopPreview(owner: UUID) { if isPreviewing, playbackOwner == owner { stopAll() } }
    func silence(owner: UUID) { if playbackOwner == owner { stopAll() } }
    private func stopAll() { generation += 1; pending = 0; isPreviewing = false; playbackOwner = nil; output.stop() }
    private func enqueue(_ text: String, identifier: String?, rate: Float) {
        pending += 1
        let request = generation
        output.speak(text, identifier: identifier, rate: rate) { [weak self] in
            guard let self, self.generation == request else { return }
            self.pending -= 1
            if self.pending == 0 { self.isPreviewing = false; self.playbackOwner = nil }
        }
    }
}

@MainActor private final class AppleSpeechOutput: NSObject, ConversationSpeechOutput, AVSpeechSynthesizerDelegate {
    private let speaker = AVSpeechSynthesizer()
    private var completions: [ObjectIdentifier: @MainActor () -> Void] = [:]
    override init() {
        super.init(); speaker.delegate = self
        #if os(iOS)
        // System speech owns playback after capture releases the microphone.
        speaker.usesApplicationAudioSession = false
        #endif
    }
    func speak(_ text: String, identifier: String?, rate: Float, completion: @escaping @MainActor () -> Void) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = identifier.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
        utterance.rate = rate
        completions[ObjectIdentifier(utterance)] = completion
        speaker.speak(utterance)
    }
    func stop() { completions.removeAll(); speaker.stopSpeaking(at: .immediate) }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        complete(ObjectIdentifier(utterance))
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        complete(ObjectIdentifier(utterance))
    }
    nonisolated private func complete(_ id: ObjectIdentifier) {
        Task { @MainActor [weak self] in self?.completions.removeValue(forKey: id)?() }
    }
}

@MainActor enum AppleVoiceCatalog {
    static func installed() -> [SpeechVoice] {
        AVSpeechSynthesisVoice.speechVoices().map {
            SpeechVoice(id: $0.identifier, name: $0.name, language: $0.language,
                        quality: SpeechVoice.Quality(rawValue: $0.quality.rawValue) ?? .standard)
        }
    }
    static func resolve(_ preferences: SpeechPreferences, voices: [SpeechVoice]) -> SpeechVoice? {
        SpeechVoiceSelection.resolve(voices: voices, identifier: preferences.identifier, language: preferences.language,
                                     systemIdentifier: AVSpeechSynthesisVoice(language: preferences.language)?.identifier)
    }
}
