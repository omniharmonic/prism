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
    let speech = ConversationSpeech.shared
    static let sharedTurnPreferences = VoiceTurnPreferences()
    let turnPreferences = ConversationDevice.sharedTurnPreferences
    private var interruptionEnabled = false
    private var receiveInterruption: (@MainActor (VoiceInterruptionEvent) -> Void)?
    private var playbackSetup: Task<Void, Never>?
    private var monitoringPlayback = false
    private var nearEndDuration = 0.0
    private var activityEnabled = false
    func configureInterruption(enabled: Bool, receive: @escaping @MainActor (VoiceInterruptionEvent) -> Void) {
        interruptionEnabled = enabled; receiveInterruption = receive
    }
    private var receiveActivity: (@MainActor (VoiceActivityEvent) -> Void)?
    let speechPreferences = ConversationSpeech.preferences
    private let recordingOwner = UUID()
    private var file: URL?
    private var generation = 0
    private var transcriptionTask: Task<Void, Never>?
    private var captureDeadline: Task<Void, Never>?
    private var completedText = ""
    private var queuedChunks = 0
    private var enqueuedChunks = Set<URL>()
    private var chunkFailure = false
    private(set) var recoveryNotice: String?
    private var receiveLimit: (@MainActor () -> Void)?
    func configureRecordingLimit(_ receive: @escaping @MainActor () -> Void) { receiveLimit = receive }
    private var prepared = Set<Engine>()
    private var engine: any ConversationSTTEngine { selected == .apple ? apple : parakeet }
    func configureActivity(enabled: Bool, receive: @escaping @MainActor (VoiceActivityEvent) -> Void) {
        activityEnabled = enabled; receiveActivity = receive
    }
    func start() async throws {
        speech.beginRecording(owner: recordingOwner)
        hypothesis = ""; completedText = ""; queuedChunks = 0; enqueuedChunks = []; chunkFailure = false; recoveryNotice = nil
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
            let callback: (@Sendable (SpeechActivityEvent) -> Void)? = activityEnabled ? Self.activityCallback(for: self, request: request) : nil
            try await audio.start(url: url, chunkSeconds: 60, chunkClosed: Self.chunkCallback(for: self, request: request), activity: callback)
            captureDeadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(900)) } catch { return }
                guard let self, self.generation == request else { return }
                self.receiveLimit?()
            }
            guard request == generation, !Task.isCancelled else { throw CancellationError() }
        } catch { if request == generation { cancel() }; throw error }
    }
    nonisolated private static func chunkCallback(for device: ConversationDevice, request: Int) -> @Sendable (URL) -> Void {
        { [weak device] url in
            Task { @MainActor in
                guard let device, device.generation == request else { return }
                if !device.monitoringPlayback { device.enqueueChunk(url, request: request) }
            }
        }
    }
    private func enqueueChunk(_ url: URL, request: Int) {
        guard enqueuedChunks.insert(url).inserted else { return }
        queuedChunks += 1
        let previous = transcriptionTask
        let transcriber = engine
        transcriptionTask = Task { [weak self] in
            await previous?.value
            guard let self, self.generation == request, !Task.isCancelled else { return }
            defer { self.queuedChunks -= 1 }
            do {
                let text = try await transcriber.transcribeConversation(file: url) { _ in }
                guard self.generation == request, !Task.isCancelled else { return }
                self.completedText = ConversationTranscript.join(self.completedText, text)
                self.hypothesis = self.completedText
                try? FileManager.default.removeItem(at: url)
            } catch {
                guard self.generation == request else { return }
                self.chunkFailure = true
                self.recoveryNotice = "Transcription stopped. Recognized words are saved as an unsent draft; some recorded words could not be recognized."
                self.receiveLimit?()
            }
        }
        // Stop capture before disk/backlog grows without bound when STT falls behind.
        let bytes = audio.recordings().reduce(Int64(0)) { total, file in
            total + ((try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? 0)
        }
        if queuedChunks >= 3 || bytes >= 128 * 1024 * 1024 { receiveLimit?() }
    }
    /// This factory has no actor executor. Only the explicit Task may access the
    /// main-actor device, whether the detector calls from its worker or audio tap.
    nonisolated static func activityCallback(for device: ConversationDevice, request: Int) -> @Sendable (SpeechActivityEvent) -> Void {
        { [weak device] event in
            Task { @MainActor in
                guard let device, device.generation == request else { return }
                if device.monitoringPlayback { device.receivePlaybackActivity(event); return }
                switch event {
                case .frame(let time, let captured, let duration, let speech):
                    device.receiveActivity?(.frame(VoiceActivityFrame(audioTime: time, capturedAt: captured, duration: duration, isSpeech: speech)))
                case .unavailable(let reason): device.receiveActivity?(.unavailable(reason))
                }
            }
        }
    }
    private func receivePlaybackActivity(_ event: SpeechActivityEvent) {
        let requestGeneration = generation
        guard monitoringPlayback else { return }
        switch event {
        case .unavailable:
            receiveInterruption?(.unavailable("Acoustic interruption is unavailable. Use Interrupt and speak."))
        case .frame(_, let captured, let duration, let isSpeech):
            guard ProcessInfo.processInfo.systemUptime - captured < 0.5 else { nearEndDuration = 0; return }
            nearEndDuration = isSpeech ? nearEndDuration + duration : 0
            guard nearEndDuration >= 0.18 else { return }
            do {
                try audio.retainInterruptionLeadIn()
                speech.silence(owner: recordingOwner)
                speech.configureDuplex(nil)
                speech.beginRecording(owner: recordingOwner)
                monitoringPlayback = false; nearEndDuration = 0
                completedText = ""; hypothesis = ""; enqueuedChunks = []
                captureDeadline = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(900)) } catch { return }
                    guard let self, self.generation == requestGeneration else { return }
                    self.receiveLimit?()
                }
                receiveInterruption?(.speech)
            } catch {
                receiveInterruption?(.unavailable("Interruption audio could not be retained. Use Interrupt and speak."))
            }
        }
    }
    private func beginPlaybackMonitor(request: Int) async -> Bool {
        let url = FileManager.default.temporaryDirectory.appending(path: "omni-interruption-\(UUID().uuidString).caf")
        file = url
        do {
            try await audio.start(url: url, chunkSeconds: 60, chunkClosed: Self.chunkCallback(for: self, request: request), activity: Self.activityCallback(for: self, request: request))
            guard generation == request, !Task.isCancelled else { throw CancellationError() }
            monitoringPlayback = true; nearEndDuration = 0
            speech.configureDuplex(audio)
            return true
        } catch {
            guard generation == request else { return false }
            try? audio.stop(); audio.recordings().forEach { try? FileManager.default.removeItem(at: $0) }; file = nil
            speech.configureDuplex(nil)
            receiveInterruption?(.unavailable("Acoustic interruption could not start. Use Interrupt and speak."))
            return false
        }
    }
    func finish() async throws -> String {
        guard let file else { throw VoiceFailure.unavailable("No voice recording is active.") }
        captureDeadline?.cancel(); captureDeadline = nil
        try audio.stop()
        speech.endRecording(owner: recordingOwner)
        let recordings = audio.recordings()
        defer {
            recordings.forEach { try? FileManager.default.removeItem(at: $0) }
            if self.file == file { self.file = nil }
        }
        let request = generation
        // A rotation callback may be queued on MainActor at the same instant Stop
        // removes the tap. Yield before taking the serial transcription tail.
        for recording in recordings.dropLast() { enqueueChunk(recording, request: request) }
        await Task.yield()
        await transcriptionTask?.value
        guard request == generation, !Task.isCancelled else { throw CancellationError() }
        var result = completedText
        if !chunkFailure, let last = recordings.last, !Self.fileWasRemoved(last) {
            do {
                if try !Self.recordingIsEmpty(last) {
                    let text = try await engine.transcribeConversation(file: last) { _ in }
                    result = ConversationTranscript.join(result, text)
                }
            } catch {
                if result.isEmpty { throw error }
                recoveryNotice = "The final audio chunk could not be recognized. Earlier words are saved as an unsent draft."
            }
        }
        guard request == generation, !Task.isCancelled else { throw CancellationError() }
        hypothesis = result
        return result
    }

    nonisolated private static func fileWasRemoved(_ url: URL) -> Bool { !FileManager.default.fileExists(atPath: url.path) }
    /// A freshly resumed capture can be paused before the first microphone tap.
    /// Frame count distinguishes that case without treating quiet PCM as silence.
    nonisolated static func recordingIsEmpty(_ file: URL) throws -> Bool {
        try AVAudioFile(forReading: file).length == 0
    }
    func cancel() {
        playbackSetup?.cancel(); playbackSetup = nil
        monitoringPlayback = false; nearEndDuration = 0
        speech.configureDuplex(nil)
        captureDeadline?.cancel(); captureDeadline = nil
        transcriptionTask?.cancel(); transcriptionTask = nil
        generation += 1; receiveActivity = nil; hypothesis = ""; try? audio.stop()
        speech.endRecording(owner: recordingOwner)
        stopPreview()
        audio.recordings().forEach { try? FileManager.default.removeItem(at: $0) }
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
    }
    func speak(_ text: String) {
        let request = generation
        let previous = playbackSetup
        playbackSetup = Task { [weak self] in
            await previous?.value
            guard let self, self.generation == request, !Task.isCancelled else { return }
            if self.interruptionEnabled && !self.monitoringPlayback && self.file == nil {
                _ = await self.beginPlaybackMonitor(request: request)
            }
            guard self.generation == request, !Task.isCancelled else { return }
            let voice = AppleVoiceCatalog.resolve(self.speechPreferences, voices: AppleVoiceCatalog.installed())
            self.speech.speak(text, owner: self.recordingOwner, identifier: voice?.id, rate: self.speechPreferences.rate)
        }
    }
    func waitForPlayback() async {
        await playbackSetup?.value
        await speech.waitForPlayback(owner: recordingOwner)
        // Normal drain releases monitor audio; acoustic interruption promotes it
        // into capture and must keep the retained lead-in and microphone running.
        if monitoringPlayback && !Task.isCancelled {
            monitoringPlayback = false; speech.configureDuplex(nil)
            try? audio.stop(); audio.recordings().forEach { try? FileManager.default.removeItem(at: $0) }; file = nil
        }
    }
    func silence() { speech.silence(owner: recordingOwner) }
    func stopPreview() { speech.stopPreview(owner: recordingOwner) }
    func previewVoice(identifier: String?) { speech.preview(owner: recordingOwner, identifier: identifier, rate: speechPreferences.rate) }
}
