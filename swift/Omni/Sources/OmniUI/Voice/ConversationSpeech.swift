@preconcurrency import AVFoundation
import Observation
import OmniCore
import OmniVoiceKit

@MainActor protocol ConversationSpeechOutput: AnyObject {
    func speak(_ text: String, identifier: String?, rate: Float, completion: @escaping @MainActor () -> Void)
    func playAudio(_ data: Data, completion: @escaping @MainActor () -> Void) throws
    func stop()
    func configureDuplex(_ audio: AudioIO?)
    func configureDiagnostic(_ receive: @escaping @Sendable (VoiceDiagnosticEvent) -> Void)
    func configureFailure(_ receive: @escaping @MainActor (String) -> Void)
}

@MainActor extension ConversationSpeechOutput {
    func playAudio(_ data: Data, completion: @escaping @MainActor () -> Void) throws {
        throw VoiceFailure.unavailable("Encoded speech playback is unavailable.")
    }
    func configureDuplex(_ audio: AudioIO?) {}
    func configureFailure(_ receive: @escaping @MainActor (String) -> Void) {}
    func configureDiagnostic(_ receive: @escaping @Sendable (VoiceDiagnosticEvent) -> Void) {}
}

/// One playback owner for all voice panels; previews cannot overlap capture or replies.
@MainActor @Observable final class ConversationSpeech {
    static let shared = ConversationSpeech(output: AppleSpeechOutput())
    static let preferences = SpeechPreferences(defaultLanguage: AVSpeechSynthesisVoice.currentLanguageCode())
    private(set) var isPreviewing = false
    private let output: any ConversationSpeechOutput
    private let diagnostic: @Sendable (VoiceDiagnosticEvent) -> Void
    private var duplexOwner: UUID?
    private var recordingOwner: UUID?
    private var playbackOwner: UUID?
    private var previewLease: UUID?
    private var cancelPreview: (@MainActor () -> Void)?
    private var replyPreparations: [UUID: UUID] = [:]
    private var generation = 0
    private var pending = 0
    private var drainWaiters: [UUID: [CheckedContinuation<Void, Never>]] = [:]
    init(output: any ConversationSpeechOutput, diagnostic: @escaping @Sendable (VoiceDiagnosticEvent) -> Void = VoiceDiagnostics.record) {
        self.output = output; self.diagnostic = diagnostic
        output.configureDiagnostic(diagnostic)
    }
    func configurePlaybackFailure(owner: UUID, receive: @escaping @MainActor (String) -> Void) {
        output.configureFailure { [weak self] reason in
            guard let self, self.playbackOwner == owner || self.duplexOwner == owner else { return }
            // Release failed ownership before invoking session callbacks. They
            // may synchronously start replacement playback or capture.
            self.diagnostic(.playbackFailed)
            self.stopAll()
            receive(reason)
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
    func reserveReplyPreparation(owner: UUID) -> UUID? {
        guard recordingOwner == nil else { return nil }
        if isPreviewing { stopAll() }
        let token = UUID(); replyPreparations[token] = owner; return token
    }
    func releaseReplyPreparation(_ token: UUID) { replyPreparations.removeValue(forKey: token) }
    func reservePreview(owner: UUID, cancel: @escaping @MainActor () -> Void) -> UUID? {
        guard recordingOwner == nil, pending == 0, replyPreparations.isEmpty else { return nil }
        stopAll(); output.configureDuplex(nil); duplexOwner = nil
        let token = UUID(); previewLease = token; cancelPreview = cancel
        playbackOwner = owner; isPreviewing = true; return token
    }
    func ownsPreview(_ token: UUID, owner: UUID) -> Bool {
        previewLease == token && playbackOwner == owner && recordingOwner == nil
    }
    func playPreviewAudio(_ data: Data, owner: UUID, lease: UUID) throws {
        guard ownsPreview(lease, owner: owner), pending == 0 else {
            throw VoiceFailure.unavailable("Voice preview is no longer available.")
        }
        try enqueueAudio(data, owner: owner)
    }
    func preview(owner: UUID, identifier: String?, rate: Float) {
        guard recordingOwner == nil, replyPreparations.isEmpty, pending == 0 || isPreviewing else { return }
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
    func playAudio(_ data: Data, owner: UUID) throws {
        guard recordingOwner == nil else { throw VoiceFailure.unavailable("Microphone capture is still active.") }
        guard pending == 0 || isPreviewing else { throw VoiceFailure.unavailable("Reply playback is still active.") }
        if isPreviewing || playbackOwner != owner { stopAll() }
        if duplexOwner != owner { output.configureDuplex(nil); duplexOwner = nil }
        playbackOwner = owner
        try enqueueAudio(data, owner: owner)
    }
    private func enqueueAudio(_ data: Data, owner: UUID) throws {
        pending += 1
        let request = generation
        do {
            try output.playAudio(data) { [weak self] in
                guard let self, self.generation == request else { return }
                self.pending -= 1
                if self.pending == 0 {
                    self.diagnostic(.playbackFinished)
                    self.isPreviewing = false; self.previewLease = nil; self.cancelPreview = nil
                    self.playbackOwner = nil; self.resolveDrain(owner: owner)
                }
            }
            diagnostic(.playbackStarted)
        } catch {
            diagnostic(.playbackFailed)
            pending -= 1
            if pending == 0 { isPreviewing = false; previewLease = nil; cancelPreview = nil; playbackOwner = nil; resolveDrain(owner: owner) }
            throw error
        }
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
        let cancel = cancelPreview; cancelPreview = nil; previewLease = nil
        generation += 1; pending = 0; isPreviewing = false
        cancel?()
        let owner = playbackOwner
        playbackOwner = nil; output.stop()
        if let owner { resolveDrain(owner: owner) }
    }
    private func enqueue(_ text: String, identifier: String?, rate: Float) {
        pending += 1
        if pending == 1 { diagnostic(.playbackStarted) }
        let request = generation
        output.speak(text, identifier: identifier, rate: rate) { [weak self] in
            guard let self, self.generation == request else { return }
            self.pending -= 1
            if self.pending == 0 {
                let owner = self.playbackOwner
                self.diagnostic(.playbackFinished)
                self.isPreviewing = false; self.playbackOwner = nil
                if let owner { self.resolveDrain(owner: owner) }
            }
        }
    }
}

@MainActor private final class AppleSpeechOutput: NSObject, ConversationSpeechOutput, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private let speaker = AVSpeechSynthesizer()
    private var duplex: AudioIO?
    private var encodedPlayer: AVAudioPlayer?
    private var encodedCompletion: (@MainActor () -> Void)?
    private var encodedTask: Task<Void, Never>?
    private var encodedGeneration = 0
    private var playbackGeneration = 0
    private var pcmDrainTask: Task<Void, Never>?
    private var pcmTasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var diagnostic: @Sendable (VoiceDiagnosticEvent) -> Void = VoiceDiagnostics.record
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
    func playAudio(_ data: Data, completion: @escaping @MainActor () -> Void) throws {
        guard !data.isEmpty, data.count <= 10 * 1024 * 1024 else { throw VoiceFailure.unavailable("Speech audio exceeded its size limit.") }
        encodedGeneration += 1
        let request = encodedGeneration
        if duplex != nil {
            // Decode in bounded frames and use the same voice-processing output
            // reference as Apple PCM. Never leave downloaded speech in a cache.
            let url = FileManager.default.temporaryDirectory.appending(path: "omni-reply-\(UUID().uuidString).mp3")
            guard FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                throw VoiceFailure.unavailable("Speech audio could not be prepared.")
            }
            let file: EncodedSpeechFile
            do { file = try EncodedSpeechFile(url: url) }
            catch { try? FileManager.default.removeItem(at: url); throw error }
            let token = NSObject()
            let id = ObjectIdentifier(token)
            completions[id] = completion
            encodedTask = Task { [weak self, token] in
                await EncodedSpeechRead.withTemporaryFile(url) {
                    guard let self else { return }
                    do {
                        while true {
                            try Task.checkCancellation()
                            guard self.encodedGeneration == request, self.completions[id] != nil else { return }
                            guard let buffer = try file.read() else { break }
                            await self.accept(buffer, id: id)
                        }
                        guard !Task.isCancelled, self.encodedGeneration == request else { return }
                        self.pcmEnded.insert(ObjectIdentifier(token)); self.completePCM(id)
                        self.encodedTask = nil
                    } catch {
                        guard !Task.isCancelled, self.encodedGeneration == request else { return }
                        self.diagnostic(.playbackDecodeFailed)
                        self.receiveFailure?("The generated reply could not be played.")
                    }
                }
            }
        } else {
            #if os(iOS)
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
            #endif
            let player = try AVAudioPlayer(data: data)
            guard player.duration <= 600 else { throw VoiceFailure.unavailable("Speech audio exceeded its playback limits.") }
            encodedPlayer = player; encodedCompletion = completion; player.delegate = self
            guard player.prepareToPlay(), player.play() else {
                encodedPlayer = nil; encodedCompletion = nil
                throw VoiceFailure.unavailable("The generated reply could not start playback.")
            }
        }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let retained = RetainedPlayer(player: player)
        Task { @MainActor [weak self] in
            guard let self, self.encodedPlayer === retained.player else { return }
            self.encodedPlayer = nil
            let completed = self.encodedCompletion; self.encodedCompletion = nil
            if flag { completed?() } else { self.receiveFailure?("The generated reply stopped before completion.") }
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let retained = RetainedPlayer(player: player)
        Task { @MainActor [weak self] in
            guard let self, self.encodedPlayer === retained.player else { return }
            self.receiveFailure?("The generated reply could not be decoded.")
        }
    }
    private struct RetainedPlayer: @unchecked Sendable { let player: AVAudioPlayer }
    nonisolated private static func pcmCallback(for bridge: SpeechPCMStream) -> @Sendable (AVAudioBuffer) -> Void {
        { buffer in bridge.accept(buffer) }
    }
    func configureDuplex(_ audio: AudioIO?) { duplex = audio }
    func configureFailure(_ receive: @escaping @MainActor (String) -> Void) { receiveFailure = receive }
    func configureDiagnostic(_ receive: @escaping @Sendable (VoiceDiagnosticEvent) -> Void) { diagnostic = receive }
    func stop() {
        playbackGeneration += 1
        encodedGeneration += 1; encodedTask?.cancel(); encodedTask = nil
        encodedPlayer?.stop(); encodedPlayer = nil; encodedCompletion = nil
        pcmTasks.values.forEach { $0.cancel() }; pcmTasks = [:]; pcmDrainTask = nil
        completions.removeAll(); pcmPending = [:]; pcmEnded = []
        duplex?.silencePlayback(); speaker.stopSpeaking(at: .immediate)
    }
    private func accept(_ buffer: AVAudioPCMBuffer, id: ObjectIdentifier) async {
        guard completions[id] != nil else { return }
        pcmPending[id, default: 0] += 1
        let playbackRequest = playbackGeneration
        do {
            guard let duplex else { throw SpeechPlaybackFailure.routeLost }
            try await duplex.play(buffer) { [weak self] in
                Task { @MainActor in
                    guard let self, self.playbackGeneration == playbackRequest, self.completions[id] != nil else { return }
                    self.pcmPending[id, default: 0] -= 1; self.completePCM(id)
                }
            }
        } catch {
            guard completions[id] != nil, !Task.isCancelled else { return }
            pcmPending[id, default: 0] -= 1
            diagnostic(SpeechPlaybackDiagnostic.event(for: error))
            receiveFailure?("The generated reply could not be played.")
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
