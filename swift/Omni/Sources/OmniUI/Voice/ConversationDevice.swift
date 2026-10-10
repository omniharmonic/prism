@preconcurrency import AVFoundation
import Foundation
import Observation
import OmniCore
import OmniClient
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
    private var playbackTasks: [UUID: Task<Void, Never>] = [:]
    private var replySpeechService: (any HermesSpeechService)?
    static let sharedReplyPreferences = ReplySpeechPreferences()
    let replyPreferences = ConversationDevice.sharedReplyPreferences
    private(set) var replyProviders: [VoiceProvider] = []
    private(set) var replySpeechNotice: String?
    private var replySpeechSessionID = UUID().uuidString
    private var replyPreviewTask: Task<Void, Never>?
    private(set) var replyIsPreviewing = false
    func configureReplySpeech(service: (any HermesSpeechService)?) { replySpeechService = service }
    func refreshReplyProviders() async {
        guard let service = replySpeechService else { replyProviders = []; return }
        do { replyProviders = try await service.voiceProviders().providers }
        catch { replyProviders = [] }
    }
    private var edgeProvider: VoiceProvider? { replyProviders.first { $0.id == "hermes-edge" && $0.available } }
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
    private let chunkWork = VoiceCaptureWorkQueue()
    private var captureDeadline: Task<Void, Never>?
    private var completedText = ""
    private var chunkPartial = ""
    private var queuedChunks: Int { chunkWork.pendingCount }
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
        hypothesis = ""; completedText = ""; chunkWork.cancel(); enqueuedChunks = []; chunkFailure = false; recoveryNotice = nil
        replySpeechNotice = nil; replySpeechSessionID = UUID().uuidString
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
                if !device.monitoringPlayback && FileManager.default.fileExists(atPath: url.path) { device.enqueueChunk(url, request: request) }
            }
        }
    }
    private func enqueueChunk(_ url: URL, request: Int) {
        guard enqueuedChunks.insert(url).inserted else { return }
        let transcriber = engine
        chunkWork.enqueue { [weak self] in
            guard let self, self.generation == request, !Task.isCancelled else { return }
            let prefix = self.completedText
            self.chunkPartial = ""
            do {
                let text = try await transcriber.transcribeConversation(file: url) { event in
                    await MainActor.run {
                        guard self.generation == request else { return }
                        self.chunkPartial = [event.confirmed, event.volatile].filter { !$0.isEmpty }.joined(separator: " ")
                        self.hypothesis = ConversationTranscript.join(prefix, self.chunkPartial)
                    }
                }
                guard self.generation == request, !Task.isCancelled else { return }
                self.completedText = ConversationTranscript.join(self.completedText, text)
                self.hypothesis = self.completedText
                try? FileManager.default.removeItem(at: url)
            } catch {
                guard self.generation == request else { return }
                self.completedText = ConversationTranscript.join(self.completedText, self.chunkPartial)
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
        case .frame(let audioTime, let captured, let duration, let isSpeech):
            guard ProcessInfo.processInfo.systemUptime - captured < 0.5 else { nearEndDuration = 0; return }
            nearEndDuration = isSpeech ? nearEndDuration + duration : 0
            guard nearEndDuration >= 0.3 else { return }
            do {
                try audio.retainInterruptionLeadIn()
                speech.silence(owner: recordingOwner)
                speech.configureDuplex(nil, owner: recordingOwner)
                speech.beginRecording(owner: recordingOwner)
                let detectedDuration = nearEndDuration
                monitoringPlayback = false; nearEndDuration = 0
                completedText = ""; hypothesis = ""; enqueuedChunks = []
                captureDeadline = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(900)) } catch { return }
                    guard let self, self.generation == requestGeneration else { return }
                    self.receiveLimit?()
                }
                receiveInterruption?(.speechEvidence(VoiceActivityFrame(audioTime: audioTime, capturedAt: captured, duration: min(0.4, detectedDuration), isSpeech: true)))
            } catch {
                receiveInterruption?(.unavailable("Interruption audio could not be retained. Use Interrupt and speak."))
            }
        }
    }
    private func beginPlaybackMonitor(request: Int) async -> Bool {
        let url = FileManager.default.temporaryDirectory.appending(path: "omni-interruption-\(UUID().uuidString).caf")
        file = url; monitoringPlayback = true
        do {
            try await audio.start(url: url, chunkSeconds: 60, chunkClosed: Self.chunkCallback(for: self, request: request), activity: Self.activityCallback(for: self, request: request))
            guard generation == request, !Task.isCancelled else { throw CancellationError() }
            monitoringPlayback = true; nearEndDuration = 0
            speech.configureDuplex(audio, owner: recordingOwner)
            return true
        } catch {
            guard generation == request else { return false }
            monitoringPlayback = false
            try? audio.stop(); audio.recordings().forEach { try? FileManager.default.removeItem(at: $0) }; file = nil
            speech.configureDuplex(nil, owner: recordingOwner)
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
        await chunkWork.drain()
        guard request == generation, !Task.isCancelled else { throw CancellationError() }
        var result = completedText
        if !chunkFailure, let last = recordings.last, !Self.fileWasRemoved(last) {
            do {
                if try !Self.recordingIsEmpty(last) {
                    chunkPartial = ""
                    let prefix = result
                    let text = try await engine.transcribeConversation(file: last) { event in
                        await MainActor.run {
                            guard self.generation == request else { return }
                            self.chunkPartial = [event.confirmed, event.volatile].filter { !$0.isEmpty }.joined(separator: " ")
                            self.hypothesis = ConversationTranscript.join(prefix, self.chunkPartial)
                        }
                    }
                    result = ConversationTranscript.join(result, text)
                }
            } catch {
                result = ConversationTranscript.join(result, chunkPartial)
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
        playbackTasks.values.forEach { $0.cancel() }; playbackTasks = [:]
        playbackSetup?.cancel(); playbackSetup = nil
        monitoringPlayback = false; nearEndDuration = 0
        speech.configureDuplex(nil, owner: recordingOwner)
        captureDeadline?.cancel(); captureDeadline = nil
        chunkWork.cancel()
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
        let taskID = UUID()
        let preference = replyPreferences.provider
        let sessionID = replySpeechSessionID
        let task = Task { [weak self] in
            await previous?.value
            guard let self, self.generation == request, !Task.isCancelled else { return }
            defer { self.playbackTasks.removeValue(forKey: taskID) }
            if preference == .hermesEdge, self.replyProviders.isEmpty { await self.refreshReplyProviders() }
            guard self.generation == request, !Task.isCancelled else { return }
            let provider: any ReplySpeechProvider
            if preference == .hermesEdge, let service = self.replySpeechService, let metadata = self.edgeProvider {
                let voiceID = metadata.voices.contains(where: { $0.id == self.replyPreferences.edgeVoiceID }) ? self.replyPreferences.edgeVoiceID! : metadata.defaultVoiceID
                provider = HermesEdgeReplySpeechProvider(service: service, sessionID: sessionID, voiceID: voiceID)
            } else {
                provider = AppleReplySpeechProvider()
                if preference == .hermesEdge { self.replySpeechNotice = "Hermes speech is unavailable. Using the Apple voice on this device." }
            }
            let passages = ReplySpeechPassages.split(text)
            guard !passages.isEmpty else { self.replySpeechNotice = "This reply could not be prepared for speech. Read it in chat."; return }
            for passage in passages {
                guard self.generation == request, !Task.isCancelled else { return }
                var rendered: ReplySpeechRendering
                do { rendered = try await provider.render(passage) }
                catch {
                    guard self.generation == request, !Task.isCancelled else { return }
                    self.replySpeechNotice = "Hermes speech could not be generated. Using the Apple voice on this device."
                    rendered = .systemVoice(passage)
                }
                guard self.generation == request, !Task.isCancelled else { return }
                if self.interruptionEnabled && !self.monitoringPlayback && self.file == nil {
                    _ = await self.beginPlaybackMonitor(request: request)
                }
                guard self.generation == request, !Task.isCancelled else { return }
                self.speech.configurePlaybackFailure(owner: self.recordingOwner) { [weak self] reason in
                    guard let self, self.generation == request else { return }
                    self.receiveInterruption?(.playbackFailed(reason))
                }
                switch rendered {
                case .systemVoice(let words): self.speakApple(words)
                case .encodedAudio(let data):
                    do { try self.speech.playAudio(data, owner: self.recordingOwner) }
                    catch {
                        self.replySpeechNotice = "Generated speech could not start. Using the Apple voice on this device."
                        self.speakApple(passage)
                    }
                }
                await self.speech.waitForPlayback(owner: self.recordingOwner)
            }
        }
        playbackTasks[taskID] = task; playbackSetup = task
    }
    private func speakApple(_ text: String) {
        let voice = AppleVoiceCatalog.resolve(speechPreferences, voices: AppleVoiceCatalog.installed())
        speech.speak(text, owner: recordingOwner, identifier: voice?.id, rate: speechPreferences.rate)
    }
    func waitForPlayback() async {
        await playbackSetup?.value
        await speech.waitForPlayback(owner: recordingOwner)
        // Normal drain releases monitor audio; acoustic interruption promotes it
        // into capture and must keep the retained lead-in and microphone running.
        if monitoringPlayback && !Task.isCancelled {
            monitoringPlayback = false; speech.configureDuplex(nil, owner: recordingOwner)
            try? audio.stop(); audio.recordings().forEach { try? FileManager.default.removeItem(at: $0) }; file = nil
        }
    }
    func silence() { speech.silence(owner: recordingOwner) }
    func stopPreview() {
        replyPreviewTask?.cancel(); replyPreviewTask = nil
        if replyIsPreviewing { speech.silence(owner: recordingOwner); replyIsPreviewing = false }
        speech.stopPreview(owner: recordingOwner)
    }
    func previewVoice(identifier: String?) {
        stopPreview()
        guard replyPreferences.provider == .hermesEdge else {
            speech.preview(owner: recordingOwner, identifier: identifier, rate: speechPreferences.rate); return
        }
        let request = generation
        replyIsPreviewing = true
        replyPreviewTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.generation == request { self.replyIsPreviewing = false } }
            await self.refreshReplyProviders()
            guard !Task.isCancelled, self.generation == request else { return }
            guard let service = self.replySpeechService, let metadata = self.edgeProvider else {
                self.replySpeechNotice = "Hermes speech is unavailable. Previewing the Apple voice."
                self.speech.preview(owner: self.recordingOwner, identifier: identifier, rate: self.speechPreferences.rate); return
            }
            let voiceID = metadata.voices.first { $0.id == self.replyPreferences.edgeVoiceID }?.id ?? metadata.defaultVoiceID
            let provider = HermesEdgeReplySpeechProvider(service: service, sessionID: UUID().uuidString, voiceID: voiceID)
            do {
                let rendered = try await provider.render("Hello, I'm Omni. Take your time. We can think this through together.")
                guard !Task.isCancelled, self.generation == request else { return }
                if case .encodedAudio(let data) = rendered {
                    try self.speech.playAudio(data, owner: self.recordingOwner)
                    await self.speech.waitForPlayback(owner: self.recordingOwner)
                }
            } catch {
                guard !Task.isCancelled, self.generation == request else { return }
                self.replySpeechNotice = "Hermes speech could not be previewed. Using the Apple voice."
                self.speech.preview(owner: self.recordingOwner, identifier: identifier, rate: self.speechPreferences.rate)
            }
        }
    }
}
