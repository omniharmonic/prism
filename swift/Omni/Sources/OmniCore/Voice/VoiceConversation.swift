import Foundation
import Observation

/// The microphone and speech engines are injected. No lifecycle callback can make a
/// pending permission request begin capture or submit a late transcript off screen.
@MainActor public protocol ConversationAudio: AnyObject {
    var recoveryNotice: String? { get }
    func configureInterruption(enabled: Bool, receive: @escaping @MainActor (VoiceInterruptionEvent) -> Void)
    func configureRecordingLimit(_ receive: @escaping @MainActor () -> Void)
    func start() async throws
    func finish() async throws -> String
    func cancel()
    func speak(_ text: String)
    func waitForPlayback() async
    func configureActivity(enabled: Bool, receive: @escaping @MainActor (VoiceActivityEvent) -> Void)
    func recoverStartupDraft() async -> String?
    func setInputMuted(_ muted: Bool)
    func silence()
}

public enum VoiceInterruptionEvent: Sendable { case speech, speechEvidence(VoiceActivityFrame), unavailable(String), playbackFailed(String) }

public extension ConversationAudio {
    func recoverStartupDraft() async -> String? { nil }
    func setInputMuted(_ muted: Bool) {}
    func configureInterruption(enabled: Bool, receive: @escaping @MainActor (VoiceInterruptionEvent) -> Void) {}
    var recoveryNotice: String? { nil }
    func configureRecordingLimit(_ receive: @escaping @MainActor () -> Void) {}
    func configureActivity(enabled: Bool, receive: @escaping @MainActor (VoiceActivityEvent) -> Void) {
        if enabled { receive(.unavailable("Automatic speech detection is unavailable. Use Send turn.")) }
    }
}

@MainActor @Observable public final class VoiceConversation {
    public enum DraftReason { case pause, recordingLimit, microphoneMute }
    public enum State: Equatable { case off, preparing, listening, transcribing, answering, speaking, paused }
    public private(set) var state: State = .off
    public private(set) var isMicrophoneMuted = false
    public func setMicrophoneMuted(_ muted: Bool) {
        guard isSessionActive else { return }
        isMicrophoneMuted = muted
        audio.setInputMuted(muted)
        if muted {
            activityWatchdog?.cancel(); activityWatchdog = nil; endpointCountdown = nil
        }
    }
    public private(set) var problem: String?
    public private(set) var transcript = ""
    public private(set) var continuingDraft = ""
    private var capturedText = ""
    public private(set) var captureNotice: String?
    private var emptyAutomaticAttempts = 0
    /// An explicit Resume may continue an unsent draft; a fresh voice launch must
    /// still leave unrelated composer text alone.
    public func canStart(withDraft draft: String) -> Bool {
        canStart && (draft.isEmpty || (state == .paused && isSessionActive))
    }
    public func draftAfterCapture(preserving currentDraft: String) -> String {
        currentDraft == continuingDraft ? transcript : Self.join(currentDraft, capturedText)
    }
    private static func join(_ prefix: String, _ suffix: String) -> String {
        [prefix, suffix].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " ")
    }
    private let audio: any ConversationAudio
    public private(set) var isSessionActive = false
    public var canAutomaticallyListen: @MainActor () -> Bool = { false }
    public private(set) var endpointCountdown: Int?
    public private(set) var activityNotice: String?
    public var acousticInterruptionEnabled = false
    public private(set) var interruptionNotice: String?
    public var saveRecoveredDraft: @MainActor (String) -> Void = { _ in }
    public var recordingLimitReached: @MainActor () -> Void = {}
    public var automaticFinish: @MainActor () -> Void = {}
    public private(set) var endpointMode: VoiceTurnMode = .thinkAloud
    public private(set) var endpointPause = 12.0
    private var endpointPolicy = VoiceEndpointPolicy()
    private var activityWatchdog: Task<Void, Never>?
    private var lastActivityAt: Double?
    private var activityStartedAt: Double?
    private var pendingCompletion: [TimelineItem]?
    public private(set) var isSubmitting = false
    private var drainTask: Task<Void, Never>?
    private var generation = 0
    private var starting = false
    private var privacyLocked = false
    public var canStart: Bool { !privacyLocked && !isMicrophoneMuted && !starting && (state == .off || state == .paused || state == .answering || state == .speaking) }
    private var spoken: [String: String] = [:]
    private var hasQueuedReplySpeech = false
    public init(audio: any ConversationAudio) { self.audio = audio }

    /// Preferences apply to the next capture. Changing modes requires pausing first.
    public func configureEndpoint(mode: VoiceTurnMode, pauseSeconds: Double) {
        guard state == .off || state == .paused else { return }
        endpointMode = mode
        endpointPause = VoiceTurnPreferences.pauseChoices.contains(pauseSeconds) ? pauseSeconds : 12
    }
    public func keepListening() {
        guard state == .listening else { return }
        endpointPolicy.keepListening()
        endpointCountdown = nil
    }
    private func receiveActivity(_ event: VoiceActivityEvent, request: Int) {
        guard request == generation, isSessionActive, !isMicrophoneMuted, endpointMode == .automatic else { return }
        switch event {
        case .unavailable(let reason): disableEndpoint(reason)
        case .frame(let frame):
            guard state == .listening, activityNotice == nil else { return }
            let now = ProcessInfo.processInfo.systemUptime
            let decision = endpointPolicy.accept(frame, now: now)
            if decision != .unavailable {
                if lastActivityAt == nil { VoiceDiagnostics.record(.activityFirstFrame) }
                // Delivery liveness and source freshness are different checks.
                // The endpoint policy above still rejects old or discontinuous audio.
                lastActivityAt = now
            }
            switch decision {
            case .none: endpointCountdown = nil
            case .countdown(let seconds): endpointCountdown = seconds
            case .send:
                endpointCountdown = nil
                guard !privacyLocked else { return }
                automaticFinish()
            case .unavailable: disableEndpoint("Automatic detection fell behind. Use Send turn.")
            }
        }
    }
    private func disableEndpoint(_ reason: String) {
        guard activityNotice == nil else { return }
        VoiceDiagnostics.record(.activityUnavailable)
        endpointPolicy.disable(); endpointCountdown = nil; activityNotice = reason
        activityWatchdog?.cancel(); activityWatchdog = nil
    }
    private func watchActivity(request: Int) {
        guard endpointMode == .automatic, activityNotice == nil else { return }
        activityWatchdog?.cancel()
        lastActivityAt = nil
        activityStartedAt = ProcessInfo.processInfo.systemUptime
        activityWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                guard let self, self.generation == request, self.state == .listening else { return }
                let now = ProcessInfo.processInfo.systemUptime
                if let last = self.lastActivityAt {
                    if now - last > 0.75 {
                        VoiceDiagnostics.record(.activityWatchdog)
                        self.disableEndpoint("Automatic detection stopped receiving audio. Use Send turn.")
                        return
                    }
                } else if let started = self.activityStartedAt, now - started > 2 {
                    VoiceDiagnostics.record(.activityWatchdog)
                    self.disableEndpoint("Automatic detection did not start receiving audio. Use Send turn.")
                    return
                }
            }
        }
    }

    public func setPrivacyLocked(_ locked: Bool) {
        privacyLocked = locked
        if locked { cancel() }
    }

    public func start(continuingDraft draft: String = "") async {
        VoiceDiagnostics.record(state == .paused ? .resumed : .sessionStart)
        await startCapture(continuingDraft: draft, resetEmptyAttempts: true)
    }
    private func startCapture(continuingDraft draft: String, resetEmptyAttempts: Bool) async {
        guard canStart else { return }
        if resetEmptyAttempts { emptyAutomaticAttempts = 0 }
        starting = true
        defer { starting = false }
        resetSession(recordEvent: false)
        isSessionActive = true
        let request = generation
        continuingDraft = draft; capturedText = ""
        state = .preparing; problem = nil; transcript = draft
        activityNotice = nil; interruptionNotice = nil; endpointCountdown = nil
        audio.configureInterruption(enabled: acousticInterruptionEnabled) { [weak self] event in
            guard let self, self.generation == request, self.isSessionActive, !self.privacyLocked else { return }
            switch event {
            case .unavailable(let reason): self.interruptionNotice = reason
            case .playbackFailed(let reason):
                self.pause(); self.problem = "Speech playback stopped: \(reason). Resume or review the reply in chat."
            case .speech, .speechEvidence:
                guard !self.isMicrophoneMuted else { return }
                guard self.state == .answering || self.state == .speaking else { return }
                self.drainTask?.cancel(); self.drainTask = nil
                self.audio.silence(); self.spoken = [:]; self.hasQueuedReplySpeech = false; self.pendingCompletion = nil
                self.endpointPolicy = VoiceEndpointPolicy(pauseSeconds: self.endpointPause)
                if case .speechEvidence(let evidence) = event {
                    _ = self.endpointPolicy.accept(evidence, now: ProcessInfo.processInfo.systemUptime)
                }
                // The resumed prefix belonged to the accepted previous turn.
                // Retained microphone lead-in starts a new turn, never that draft again.
                self.continuingDraft = ""; self.capturedText = ""; self.captureNotice = nil
                self.emptyAutomaticAttempts = 0
                self.state = .listening; self.transcript = ""
                self.watchActivity(request: request)
            }
        }
        endpointPolicy = VoiceEndpointPolicy(pauseSeconds: endpointPause)
        audio.configureRecordingLimit { [weak self] in
            guard let self, self.generation == request, self.state == .listening else { return }
            self.recordingLimitReached()
        }
        audio.configureActivity(enabled: endpointMode == .automatic) { [weak self] event in
            self?.receiveActivity(event, request: request)
        }
        do {
            try await audio.start()
            guard generation == request, !Task.isCancelled else { VoiceDiagnostics.record(.staleCallback); return }
            state = .listening
            VoiceDiagnostics.record(.captureReady)
            watchActivity(request: request)
        } catch {
            guard generation == request else { return }
            if !(error is CancellationError), !Task.isCancelled,
               let recovered = await audio.recoverStartupDraft(), !recovered.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                guard generation == request, !Task.isCancelled else { return }
                capturedText = recovered
                transcript = Self.join(continuingDraft, recovered)
                state = .transcribing
                saveRecoveredDraft(transcript)
                audio.cancel(); state = .paused
                problem = "Microphone startup stopped. Recognized words are saved as an unsent draft; some audio may not have been recognized."
            } else {
                guard generation == request else { return }
                audio.cancel(); state = .paused
                if !(error is CancellationError) { problem = error.localizedDescription }
            }
            VoiceDiagnostics.record(.captureFailed)
        }
    }

    public func finish(submit: Bool = true, draftReason: DraftReason = .recordingLimit, send: @MainActor (String) async -> Bool) async {
        guard !privacyLocked, (!submit || !isMicrophoneMuted), state == .listening else { return }
        let request = generation
        activityWatchdog?.cancel(); activityWatchdog = nil; endpointCountdown = nil
        state = .transcribing; captureNotice = nil
        VoiceDiagnostics.record(.transcribing)
        do {
            let captured = try await audio.finish().trimmingCharacters(in: .whitespacesAndNewlines)
            guard generation == request, !Task.isCancelled else { VoiceDiagnostics.record(.staleCallback); return }
            capturedText = captured
            let text = Self.join(continuingDraft, captured)
            guard !text.isEmpty else {
                VoiceDiagnostics.record(.emptyCapture)
                state = .paused
                if let recovery = audio.recoveryNotice {
                    problem = recovery
                } else if submit, !isMicrophoneMuted, endpointMode == .automatic, continuingDraft.isEmpty,
                          canAutomaticallyListen(), emptyAutomaticAttempts < 2 {
                    emptyAutomaticAttempts += 1
                    VoiceDiagnostics.record(.emptyRetry)
                    await startCapture(continuingDraft: "", resetEmptyAttempts: false)
                    if state == .listening { captureNotice = "Didn't catch that. Still listening." }
                } else {
                    problem = !submit && draftReason != .recordingLimit ? nil : "No speech was recognized. Resume when you're ready to try again."
                }
                return
            }
            if !captured.isEmpty { emptyAutomaticAttempts = 0 }
            let recovery = audio.recoveryNotice
            transcript = text; spoken = [:]; hasQueuedReplySpeech = false; pendingCompletion = nil
            if let recovery {
                saveRecoveredDraft(text)
                state = .paused; problem = recovery
                return
            }
            isSubmitting = submit
            if submit { VoiceDiagnostics.record(.sending) }
            let sent = await send(text)
            guard generation == request, !Task.isCancelled else { VoiceDiagnostics.record(.staleCallback); return }
            isSubmitting = false
            if sent {
                VoiceDiagnostics.record(submit ? .sendAccepted : .paused)
                state = submit ? .answering : .paused
                if !submit {
                    if draftReason == .microphoneMute {
                        problem = nil; captureNotice = "Your words are saved as an unsent draft."
                    } else {
                        problem = draftReason == .pause ? "Your words are saved as an unsent draft." : "Recording limit reached. Your words are saved as a draft."
                    }
                }
                if submit, let completed = pendingCompletion {
                    pendingCompletion = nil
                    agentDidComplete(completed)
                }
            }
            else { VoiceDiagnostics.record(.sendFailed); state = .paused; problem = "The voice message could not be sent. Review it and retry in this conversation." }
        } catch {
            guard generation == request else { return }
            audio.cancel(); state = .paused
            VoiceDiagnostics.record(.captureFailed)
            if !(error is CancellationError) { problem = error.localizedDescription }
        }
    }

    /// Narrate completed assistant blocks only. Markdown structures can span stream
    /// fragments; the complete original stays in chat while narration omits artifacts.
    public func consume(_ timeline: [TimelineItem], running: Bool) {
        guard isSessionActive, state == .answering || state == .speaking else { return }
        if running {
            drainTask?.cancel(); drainTask = nil
            state = .answering
        }
        for item in timeline {
            guard case .streamingText(let id, let text, let final) = item, final || !running else { continue }
            guard spoken[id] == nil else { continue }
            spoken[id] = text
            let words = SpeechText.narration(from: text).trimmingCharacters(in: .whitespacesAndNewlines)
            if !words.isEmpty {
                if !hasQueuedReplySpeech {
                    VoiceDiagnostics.record(.replyTextQueued)
                    hasQueuedReplySpeech = true
                }
                audio.speak(words)
            }
        }
    }

    /// Call only for the completed voice run, including replies completed before
    /// the UI observed running=true. The supplied timeline is its final snapshot.
    public func agentDidComplete(_ timeline: [TimelineItem]) {
        guard isSessionActive else { return }
        if state == .transcribing, isSubmitting { pendingCompletion = timeline; return }
        guard state == .answering || state == .speaking else { return }
        consume(timeline, running: false)
        beginPlaybackDrain()
    }

    private func beginPlaybackDrain() {
        if drainTask == nil {
            VoiceDiagnostics.record(.playbackDrain)
            state = .speaking
            let request = generation
            drainTask = Task { [weak self] in
                guard let self else { return }
                await self.audio.waitForPlayback()
                guard !Task.isCancelled, self.generation == request, self.isSessionActive, !self.privacyLocked, self.state == .speaking else { return }
                self.drainTask = nil
                self.state = .paused
                guard !self.isMicrophoneMuted, self.canAutomaticallyListen() else {
                    self.problem = self.isMicrophoneMuted ? nil : "Session paused. Review the conversation, then resume when ready."
                    return
                }
                VoiceDiagnostics.record(.listeningAgain)
                await self.start()
            }
        }
    }

    /// Pause suspends this session; only an explicit start resumes it.
    public func pause() {
        guard isSessionActive else { return }
        stopAudio()
        VoiceDiagnostics.record(.paused)
        state = .paused
    }

    private func stopAudio() {
        generation += 1
        activityWatchdog?.cancel(); activityWatchdog = nil; endpointCountdown = nil; lastActivityAt = nil; activityStartedAt = nil
        drainTask?.cancel(); drainTask = nil
        audio.cancel(); audio.silence(); spoken = [:]; hasQueuedReplySpeech = false; isSubmitting = false; pendingCompletion = nil
    }

    public func cancel() { resetSession(recordEvent: true) }
    private func resetSession(recordEvent: Bool) {
        if recordEvent, isSessionActive { VoiceDiagnostics.record(.cancelled) }
        stopAudio(); isMicrophoneMuted = false; audio.setInputMuted(false); isSessionActive = false; state = .off
        continuingDraft = ""; capturedText = ""; captureNotice = nil
    }
}
