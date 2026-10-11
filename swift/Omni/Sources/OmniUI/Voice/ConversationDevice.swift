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
    let speech: ConversationSpeech
    static let sharedTurnPreferences = VoiceTurnPreferences()
    let turnPreferences = ConversationDevice.sharedTurnPreferences
    private var inputMuted = false
    func setInputMuted(_ muted: Bool) {
        inputMuted = muted
        nearEndDuration = 0
        audio.setInputMuted(muted)
    }
    private var interruptionEnabled = false
    private var receiveInterruption: (@MainActor (VoiceInterruptionEvent) -> Void)?
    private let narrationWork = ReplyNarrationWork()
    private var replySpeechService: (any HermesSpeechService)?
    static let sharedReplyPreferences = ReplySpeechPreferences()
    private let diagnostic: @Sendable (VoiceDiagnosticEvent) -> Void
    let replyPreferences: ReplySpeechPreferences
    init(speech: ConversationSpeech = .shared, replyPreferences: ReplySpeechPreferences = ConversationDevice.sharedReplyPreferences, diagnostic: @escaping @Sendable (VoiceDiagnosticEvent) -> Void = VoiceDiagnostics.record) {
        self.speech = speech; self.replyPreferences = replyPreferences; self.diagnostic = diagnostic
    }
    private(set) var replyProviders: [VoiceProvider] = []
    private(set) var replySpeechNotice: String?
    private var replySpeechSessionID = UUID().uuidString
    private let replyPreviewOwner = UUID()
    private var replyPreviewTask: Task<Void, Never>?
    private(set) var replyIsPreviewing = false
    private var replyServiceRevision = 0
    private var replyCatalogGeneration: Int?
    func configureReplySpeech(service: (any HermesSpeechService)?) {
        guard replySpeechService?.speechServiceIdentity != service?.speechServiceIdentity else { return }
        replyServiceRevision += 1; replySpeechService = service
        replyCatalogGeneration = nil; replyProviders = []
    }
    func refreshReplyProviders() async {
        let request = generation; let revision = replyServiceRevision
        guard let service = replySpeechService else { replyProviders = []; return }
        do {
            let providers = try await service.voiceProviders().providers
            guard !Task.isCancelled, generation == request, replyServiceRevision == revision else { return }
            replyProviders = providers; replyCatalogGeneration = request
        } catch {
            guard !Task.isCancelled, generation == request, replyServiceRevision == revision else { return }
            replyProviders = []; replyCatalogGeneration = request
        }
    }
    // Capture opens a fresh provider availability checkpoint. Deployment of the
    // optional server voice is discovered at the next turn, without PCM polling.
    func beginReplySpeechSession() {
        replySpeechNotice = nil; replySpeechSessionID = UUID().uuidString
        replyCatalogGeneration = nil; replyServiceRevision += 1
    }
    private func remoteProvider(_ preference: ReplySpeechPreferences.Provider) -> VoiceProvider? {
        replyProviders.first { $0.id == preference.rawValue && $0.available }
    }
    private func makeReplyProvider(_ preference: ReplySpeechPreferences.Provider, sessionID: String) -> (any ReplySpeechProvider)? {
        guard preference != .apple, let service = replySpeechService, let metadata = remoteProvider(preference) else { return nil }
        let saved = preference == .kokoro ? replyPreferences.kokoroVoiceID : replyPreferences.edgeVoiceID
        let voiceID = metadata.voices.first { $0.id == saved }?.id ?? metadata.defaultVoiceID
        return HermesReplySpeechProvider(service: service, sessionID: sessionID, voiceID: voiceID, providerID: metadata.id, diagnostic: diagnostic)
    }
    private func providerName(_ preference: ReplySpeechPreferences.Provider) -> String { preference == .kokoro ? "Kokoro" : "Hermes" }
    private var monitoringPlayback = false
    private var playbackMonitorReady = false
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
        beginReplySpeechSession()
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
            try await audio.startVerified(url: url, chunkSeconds: 60, chunkClosed: Self.chunkCallback(for: self, request: request), activity: callback, firstTap: Self.firstTapCallback(for: self, request: request), configurationChanged: Self.configurationCallback(for: self, request: request), retrying: { VoiceDiagnostics.record(.captureStartupRetry) })
            captureDeadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(900)) } catch { return }
                guard let self, self.generation == request else { return }
                self.receiveLimit?()
            }
            guard request == generation, !Task.isCancelled else { throw CancellationError() }
        } catch {
            if request == generation, (Task.isCancelled || !audio.hasRecordedInput) { cancel() }
            throw error
        }
    }
    nonisolated static func firstTapCallback(for device: ConversationDevice, request: Int) -> @Sendable () -> Void {
        { [weak device] in
            Task { @MainActor in
                guard let device, device.generation == request else { return }
                device.diagnostic(.microphoneFirstTap)
            }
        }
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
                guard !device.inputMuted else { return }
                if device.monitoringPlayback { device.receivePlaybackActivity(event); return }
                switch event {
                case .frame(let time, let captured, let duration, let speech):
                    device.receiveActivity?(.frame(VoiceActivityFrame(audioTime: time, capturedAt: captured, duration: duration, isSpeech: speech)))
                case .unavailable(let reason): device.receiveActivity?(.unavailable(reason))
                }
            }
        }
    }
    nonisolated private static func configurationCallback(for device: ConversationDevice, request: Int) -> @Sendable (Bool) -> Void {
        { [weak device] running in
            Task { @MainActor in
                guard let device, device.generation == request else { return }
                device.diagnostic(running ? .audioEngineConfigurationChanged : .audioEngineStoppedByConfiguration)
            }
        }
    }
    private func receivePlaybackActivity(_ event: SpeechActivityEvent) {
        let requestGeneration = generation
        guard !inputMuted, monitoringPlayback, playbackMonitorReady else { return }
        switch event {
        case .unavailable:
            receiveInterruption?(.unavailable("Acoustic interruption is unavailable. Use Interrupt and speak."))
        case .frame(let audioTime, let captured, let duration, let isSpeech):
            guard ProcessInfo.processInfo.systemUptime - captured < 0.5 else { nearEndDuration = 0; return }
            nearEndDuration = isSpeech ? nearEndDuration + duration : 0
            guard nearEndDuration >= 0.3 else { return }
            do {
                try audio.retainInterruptionLeadIn()
                diagnostic(.acousticInterruption)
                silence()
                speech.configureDuplex(nil, owner: recordingOwner)
                speech.beginRecording(owner: recordingOwner)
                let detectedDuration = nearEndDuration
                monitoringPlayback = false; playbackMonitorReady = false; nearEndDuration = 0
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
        file = url; monitoringPlayback = true; playbackMonitorReady = false
        do {
            try await audio.start(url: url, chunkSeconds: 60, chunkClosed: Self.chunkCallback(for: self, request: request), activity: Self.activityCallback(for: self, request: request), firstTap: Self.firstTapCallback(for: self, request: request), configurationChanged: Self.configurationCallback(for: self, request: request))
            try await audio.waitForFirstTap()
            guard generation == request, file == url, monitoringPlayback, !Task.isCancelled else { throw CancellationError() }
            monitoringPlayback = true; playbackMonitorReady = true; nearEndDuration = 0
            speech.configureDuplex(audio, owner: recordingOwner)
            diagnostic(.playbackMonitorReady)
            return true
        } catch {
            guard generation == request, file == url else { return false }
            diagnostic(SpeechPlaybackDiagnostic.event(for: error))
            monitoringPlayback = false; playbackMonitorReady = false
            try? audio.stop(); audio.recordings().forEach { try? FileManager.default.removeItem(at: $0) }; file = nil
            speech.configureDuplex(nil, owner: recordingOwner)
            receiveInterruption?(.unavailable("Acoustic interruption could not start. Use Interrupt and speak."))
            return false
        }
    }
    func recoverStartupDraft() async -> String? {
        guard file != nil, audio.hasRecordedInput else { return nil }
        return try? await finish()
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
        narrationWork.cancel()
        monitoringPlayback = false; playbackMonitorReady = false; nearEndDuration = 0
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
        stopPreview()
        let preference = replyPreferences.provider
        let sessionID = replySpeechSessionID
        narrationWork.enqueue { [weak self] isCurrent in
            guard let self, self.generation == request, isCurrent() else { return }
            guard let preparation = self.speech.reserveReplyPreparation(owner: self.recordingOwner) else { return }
            defer { self.speech.releaseReplyPreparation(preparation) }
            if preference != .apple, self.replyCatalogGeneration != request { await self.refreshReplyProviders() }
            guard self.generation == request, isCurrent() else { return }
            var provider: any ReplySpeechProvider
            if let remote = self.makeReplyProvider(preference, sessionID: sessionID) {
                provider = remote
            } else {
                provider = AppleReplySpeechProvider()
                if preference != .apple { self.diagnostic(.appleFallback); self.replySpeechNotice = "\(self.providerName(preference)) speech is unavailable. Using the Apple voice on this device." }
            }
            let passages = ReplySpeechPassages.split(text, maxCharacters: preference == .apple ? 4000 : min(4000, max(1, self.remoteProvider(preference)?.maxCharacters ?? 4000)))
            guard !passages.isEmpty else { self.replySpeechNotice = "This reply could not be prepared for speech. Read it in chat."; return }
            for passage in passages {
                guard self.generation == request, isCurrent() else { return }
                var rendered: ReplySpeechRendering
                do { rendered = try await provider.render(passage) }
                catch {
                    guard !Task.isCancelled, !(error is CancellationError), self.generation == request, isCurrent() else { return }
                    self.diagnostic(.appleFallback)
                    self.replySpeechNotice = "\(self.providerName(preference)) speech could not be generated. Using the Apple voice on this device."
                    provider = AppleReplySpeechProvider()
                    rendered = .systemVoice(passage)
                }
                guard self.generation == request, isCurrent() else { return }
                if self.interruptionEnabled && !self.monitoringPlayback && self.file == nil {
                    _ = await self.beginPlaybackMonitor(request: request)
                }
                guard self.generation == request, isCurrent() else { return }
                self.speech.configurePlaybackFailure(owner: self.recordingOwner) { [weak self] reason in
                    guard let self, self.generation == request else { return }
                    self.receiveInterruption?(.playbackFailed(reason))
                }
                switch rendered {
                case .systemVoice(let words): self.speakApple(words)
                case .encodedAudio(let data):
                    do { try self.speech.playAudio(data, owner: self.recordingOwner) }
                    catch {
                        self.diagnostic(.appleFallback)
                        self.replySpeechNotice = "Generated speech could not start. Using the Apple voice on this device."
                        self.speakApple(passage)
                    }
                }
                await self.speech.waitForPlayback(owner: self.recordingOwner)
            }
        }
    }
    private func speakApple(_ text: String) {
        let voice = AppleVoiceCatalog.resolve(speechPreferences, voices: AppleVoiceCatalog.installed())
        speech.speak(text, owner: recordingOwner, identifier: voice?.id, rate: speechPreferences.rate)
    }
    func waitForPlayback() async {
        await narrationWork.wait()
        await speech.waitForPlayback(owner: recordingOwner)
        // Normal drain releases monitor audio; acoustic interruption promotes it
        // into capture and must keep the retained lead-in and microphone running.
        if monitoringPlayback && !Task.isCancelled {
            monitoringPlayback = false; playbackMonitorReady = false; speech.configureDuplex(nil, owner: recordingOwner)
            try? audio.stop(); audio.recordings().forEach { try? FileManager.default.removeItem(at: $0) }; file = nil
        }
    }
    func silence() {
        narrationWork.cancel()
        speech.silence(owner: recordingOwner)
    }
    func stopPreview() {
        replyPreviewTask?.cancel(); replyPreviewTask = nil
        if replyIsPreviewing { speech.silence(owner: replyPreviewOwner); replyIsPreviewing = false }
        speech.stopPreview(owner: replyPreviewOwner)
    }
    func previewVoice(identifier: String?) {
        stopPreview()
        guard !narrationWork.isBusy else { return }
        let preference = replyPreferences.provider
        guard preference != .apple else {
            speech.preview(owner: replyPreviewOwner, identifier: identifier, rate: speechPreferences.rate); return
        }
        guard let lease = speech.reservePreview(owner: replyPreviewOwner, cancel: { [weak self] in self?.replyPreviewTask?.cancel() }) else { return }
        let request = generation
        replyIsPreviewing = true
        replyPreviewTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.generation == request { self.replyIsPreviewing = false } }
            await self.refreshReplyProviders()
            guard !Task.isCancelled, self.generation == request, self.speech.ownsPreview(lease, owner: self.replyPreviewOwner) else { return }
            guard let provider = self.makeReplyProvider(preference, sessionID: UUID().uuidString) else {
                self.replySpeechNotice = "\(self.providerName(preference)) speech is unavailable. Previewing the Apple voice."
                self.speech.preview(owner: self.replyPreviewOwner, identifier: identifier, rate: self.speechPreferences.rate); return
            }
            do {
                let rendered = try await provider.render("Hello, I'm Omni. Take your time. We can think this through together.")
                guard !Task.isCancelled, self.generation == request, self.speech.ownsPreview(lease, owner: self.replyPreviewOwner) else { return }
                if case .encodedAudio(let data) = rendered {
                    self.speech.configurePlaybackFailure(owner: self.replyPreviewOwner) { [weak self] reason in
                        self?.replySpeechNotice = reason
                    }
                    try self.speech.playPreviewAudio(data, owner: self.replyPreviewOwner, lease: lease)
                    await self.speech.waitForPlayback(owner: self.replyPreviewOwner)
                }
            } catch {
                guard !Task.isCancelled, !(error is CancellationError), self.generation == request else { return }
                self.replySpeechNotice = "\(self.providerName(preference)) speech could not be previewed. Using the Apple voice."
                self.speech.preview(owner: self.replyPreviewOwner, identifier: identifier, rate: self.speechPreferences.rate)
            }
        }
    }
}
