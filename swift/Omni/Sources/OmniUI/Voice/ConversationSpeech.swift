@preconcurrency import AVFoundation
import Observation
import OmniCore
import OmniVoiceKit

@MainActor protocol ConversationSpeechOutput: AnyObject {
    func speak(_ text: String, identifier: String?, rate: Float, completion: @escaping @MainActor () -> Void)
    func stop()
    func configureDuplex(_ audio: AudioIO?)
    func configureFailure(_ receive: @escaping @MainActor (String) -> Void)
}

@MainActor extension ConversationSpeechOutput {
    func configureDuplex(_ audio: AudioIO?) {}
    func configureFailure(_ receive: @escaping @MainActor (String) -> Void) {}
}

/// One playback owner for all voice panels; previews cannot overlap capture or replies.
@MainActor @Observable final class ConversationSpeech {
    static let shared = ConversationSpeech(output: AppleSpeechOutput())
    static let preferences = SpeechPreferences(defaultLanguage: AVSpeechSynthesisVoice.currentLanguageCode())
    private(set) var isPreviewing = false
    private let output: any ConversationSpeechOutput
    private var duplexOwner: UUID?
    private var recordingOwner: UUID?
    private var playbackOwner: UUID?
    private var generation = 0
    private var pending = 0
    private var drainWaiters: [UUID: [CheckedContinuation<Void, Never>]] = [:]
    init(output: any ConversationSpeechOutput) { self.output = output }
    func configurePlaybackFailure(owner: UUID, receive: @escaping @MainActor (String) -> Void) {
        output.configureFailure { [weak self] reason in
            guard let self, self.playbackOwner == owner || self.duplexOwner == owner else { return }
            receive(reason)
            self.stopAll()
        }
    }
    func configureDuplex(_ audio: AudioIO?, owner: UUID) {
        if audio == nil {
            guard duplexOwner == owner else { return }
            duplexOwner = nil
        } else {
            guard playbackOwner == nil || playbackOwner == owner else { return }
            duplexOwner = owner
        }
        output.configureDuplex(audio)
    }
    func beginRecording(owner: UUID) { stopAll(); output.configureDuplex(nil); duplexOwner = nil; recordingOwner = owner }
    func endRecording(owner: UUID) { if recordingOwner == owner { recordingOwner = nil } }
    func preview(owner: UUID, identifier: String?, rate: Float) {
        guard recordingOwner == nil, pending == 0 || isPreviewing else { return }
        stopAll(); output.configureDuplex(nil); duplexOwner = nil; playbackOwner = owner; isPreviewing = true
        enqueue("Hello, I'm Omni. Take your time. When you're ready, we can think this through together.", identifier: identifier, rate: rate)
    }
    func speak(_ text: String, owner: UUID, identifier: String?, rate: Float) {
        guard recordingOwner == nil else { return }
        if isPreviewing || playbackOwner != owner { stopAll() }
        if duplexOwner != owner { output.configureDuplex(nil); duplexOwner = nil }
        playbackOwner = owner
        let segments = duplexOwner == owner ? SpeechUtteranceSegments.split(text) : [text]
        for segment in segments { enqueue(segment, identifier: identifier, rate: rate) }
    }
    func waitForPlayback(owner: UUID) async {
        guard playbackOwner == owner, pending > 0 else { return }
        await withCheckedContinuation { continuation in
            drainWaiters[owner, default: []].append(continuation)
        }
    }
    private func resolveDrain(owner: UUID) {
        drainWaiters.removeValue(forKey: owner)?.forEach { $0.resume() }
    }
    func stopPreview(owner: UUID) { if isPreviewing, playbackOwner == owner { stopAll() } }
    func silence(owner: UUID) { if playbackOwner == owner { stopAll() } }
    private func stopAll() {
        generation += 1; pending = 0; isPreviewing = false
        let owner = playbackOwner
        playbackOwner = nil; output.stop()
        if let owner { resolveDrain(owner: owner) }
    }
    private func enqueue(_ text: String, identifier: String?, rate: Float) {
        pending += 1
        let request = generation
        output.speak(text, identifier: identifier, rate: rate) { [weak self] in
            guard let self, self.generation == request else { return }
            self.pending -= 1
            if self.pending == 0 {
                let owner = self.playbackOwner
                self.isPreviewing = false; self.playbackOwner = nil
                if let owner { self.resolveDrain(owner: owner) }
            }
        }
    }
}

@MainActor private final class AppleSpeechOutput: NSObject, ConversationSpeechOutput, AVSpeechSynthesizerDelegate {
    private let speaker = AVSpeechSynthesizer()
    private var duplex: AudioIO?
    private var pcmDrainTask: Task<Void, Never>?
    private var pcmTasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var receiveFailure: (@MainActor (String) -> Void)?
    private var pcmPending: [ObjectIdentifier: Int] = [:]
    private var pcmEnded = Set<ObjectIdentifier>()
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
        if duplex != nil {
            #if os(iOS)
            speaker.usesApplicationAudioSession = true
            #endif
            let bridge = SpeechPCMStream()
            let id = ObjectIdentifier(utterance)
            let previous = pcmDrainTask
            let drain = Task { [weak self, utterance] in
                await previous?.value
                guard !Task.isCancelled, self?.completions[id] != nil else { return }
                self?.speaker.write(utterance, toBufferCallback: Self.pcmCallback(for: bridge))
                do {
                    for try await owned in bridge.stream {
                        bridge.release(owned)
                        guard !Task.isCancelled else { return }
                        await self?.accept(owned.buffer, id: id)
                    }
                    guard !Task.isCancelled else { return }
                    self?.pcmEnded.insert(ObjectIdentifier(utterance)); self?.completePCM(id)
                } catch {
                    guard !Task.isCancelled else { return }
                    self?.receiveFailure?(error.localizedDescription)
                }
                self?.pcmTasks.removeValue(forKey: id)
            }
            pcmTasks[id] = drain; pcmDrainTask = drain
        } else {
            #if os(iOS)
            speaker.usesApplicationAudioSession = false
            #endif
            speaker.speak(utterance)
        }
    }
    nonisolated private static func pcmCallback(for bridge: SpeechPCMStream) -> @Sendable (AVAudioBuffer) -> Void {
        { buffer in bridge.accept(buffer) }
    }
    func configureDuplex(_ audio: AudioIO?) { duplex = audio }
    func configureFailure(_ receive: @escaping @MainActor (String) -> Void) { receiveFailure = receive }
    func stop() {
        pcmTasks.values.forEach { $0.cancel() }; pcmTasks = [:]; pcmDrainTask = nil
        completions.removeAll(); pcmPending = [:]; pcmEnded = []
        duplex?.silencePlayback(); speaker.stopSpeaking(at: .immediate)
    }
    private func accept(_ buffer: AVAudioPCMBuffer, id: ObjectIdentifier) async {
        guard completions[id] != nil else { return }
        pcmPending[id, default: 0] += 1
        do {
            guard let duplex else { throw VoiceFailure.unavailable("The speech playback route was lost.") }
            try await duplex.play(buffer) { [weak self] in
                Task { @MainActor in
                    guard let self, self.completions[id] != nil else { return }
                    self.pcmPending[id, default: 0] -= 1; self.completePCM(id)
                }
            }
        } catch {
            guard completions[id] != nil, !Task.isCancelled else { return }
            pcmPending[id, default: 0] -= 1
            receiveFailure?(error.localizedDescription)
        }
    }
    private func completePCM(_ id: ObjectIdentifier) {
        guard pcmEnded.contains(id), pcmPending[id, default: 0] == 0 else { return }
        pcmEnded.remove(id); pcmPending.removeValue(forKey: id)
        completions.removeValue(forKey: id)?()
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        complete(utterance)
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        complete(utterance)
    }
    nonisolated private func complete(_ utterance: AVSpeechUtterance) {
        // Retain the utterance until the actor handles it. Its identity cannot be
        // reused by a new preview while a cancelled delegate callback is queued.
        let retained = RetainedUtterance(utterance: utterance)
        Task { @MainActor [weak self] in
            guard self?.duplex == nil else { return }
            self?.completions.removeValue(forKey: ObjectIdentifier(retained.utterance))?()
        }
    }
    // Only identity is read across the actor hop; speech state stays on MainActor.
    private struct RetainedUtterance: @unchecked Sendable { let utterance: AVSpeechUtterance }
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
