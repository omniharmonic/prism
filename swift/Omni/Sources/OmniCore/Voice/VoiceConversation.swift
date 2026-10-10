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
    func silence()
}

public enum VoiceInterruptionEvent: Sendable { case speech, unavailable(String) }

public extension ConversationAudio {
    func configureInterruption(enabled: Bool, receive: @escaping @MainActor (VoiceInterruptionEvent) -> Void) {}
    var recoveryNotice: String? { nil }
    func configureRecordingLimit(_ receive: @escaping @MainActor () -> Void) {}
    func configureActivity(enabled: Bool, receive: @escaping @MainActor (VoiceActivityEvent) -> Void) {
        if enabled { receive(.unavailable("Automatic speech detection is unavailable. Use Send turn.")) }
    }
}

@MainActor @Observable public final class VoiceConversation {
    public enum DraftReason { case pause, recordingLimit }
    public enum State: Equatable { case off, preparing, listening, transcribing, answering, speaking, paused }
    public private(set) var state: State = .off
    public private(set) var problem: String?
    public private(set) var transcript = ""
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
    private var pendingCompletion: [TimelineItem]?
    private var submitting = false
    private var drainTask: Task<Void, Never>?
    private var generation = 0
    private var starting = false
    private var privacyLocked = false
    public var canStart: Bool { !privacyLocked && !starting && (state == .off || state == .paused || state == .answering || state == .speaking) }
    private var spoken: [String: String] = [:]
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
        guard request == generation, isSessionActive, endpointMode == .automatic else { return }
        switch event {
        case .unavailable(let reason): disableEndpoint(reason)
        case .frame(let frame):
            guard state == .listening else { return }
            let now = ProcessInfo.processInfo.systemUptime
            lastActivityAt = frame.capturedAt
            switch endpointPolicy.accept(frame, now: now) {
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
        endpointPolicy.disable(); endpointCountdown = nil; activityNotice = reason
        activityWatchdog?.cancel(); activityWatchdog = nil
    }
    private func watchActivity(request: Int) {
        guard endpointMode == .automatic, activityNotice == nil else { return }
        lastActivityAt = ProcessInfo.processInfo.systemUptime
        activityWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                guard let self, self.generation == request, self.state == .listening else { return }
                if let last = self.lastActivityAt, ProcessInfo.processInfo.systemUptime - last > 0.75 {
                    self.disableEndpoint("Automatic detection stopped receiving audio. Use Send turn.")
                    return
                }
            }
        }
    }

    public func setPrivacyLocked(_ locked: Bool) {
        privacyLocked = locked
        if locked { cancel() }
    }

    public func start() async {
        guard canStart else { return }
        starting = true
        defer { starting = false }
        cancel()
        isSessionActive = true
        let request = generation
        state = .preparing; problem = nil; transcript = ""
        activityNotice = nil; interruptionNotice = nil; endpointCountdown = nil
        audio.configureInterruption(enabled: acousticInterruptionEnabled) { [weak self] event in
            guard let self, self.generation == request, self.isSessionActive, !self.privacyLocked else { return }
            switch event {
            case .unavailable(let reason): self.interruptionNotice = reason
            case .speech:
                guard self.state == .answering || self.state == .speaking else { return }
                self.drainTask?.cancel(); self.drainTask = nil
                self.audio.silence(); self.spoken = [:]; self.pendingCompletion = nil
                self.endpointPolicy = VoiceEndpointPolicy(pauseSeconds: self.endpointPause)
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
            guard generation == request, !Task.isCancelled else { return }
            state = .listening
            watchActivity(request: request)
        } catch {
            guard generation == request else { return }
            audio.cancel(); state = .paused
            if !(error is CancellationError) { problem = error.localizedDescription }
        }
    }

    public func finish(submit: Bool = true, draftReason: DraftReason = .recordingLimit, send: @MainActor (String) async -> Bool) async {
        guard !privacyLocked, state == .listening else { return }
        let request = generation
        activityWatchdog?.cancel(); activityWatchdog = nil; endpointCountdown = nil
        state = .transcribing
        do {
            let text = try await audio.finish().trimmingCharacters(in: .whitespacesAndNewlines)
            guard generation == request, !Task.isCancelled else { return }
            guard !text.isEmpty else {
                state = .paused
                problem = !submit && draftReason == .pause ? nil : "No speech was recognized. Try again."
                return
            }
            let recovery = audio.recoveryNotice
            transcript = text; spoken = [:]; pendingCompletion = nil
            if let recovery {
                saveRecoveredDraft(text)
                state = .paused; problem = recovery
                return
            }
            submitting = submit
            let sent = await send(text)
            guard generation == request, !Task.isCancelled else { return }
            submitting = false
            if sent {
                state = submit ? .answering : .paused
                if !submit {
                    problem = draftReason == .pause ? "Your words are saved as an unsent draft." : "Recording limit reached. Your words are saved as a draft."
                }
                if submit, let completed = pendingCompletion {
                    pendingCompletion = nil
                    agentDidComplete(completed)
                }
            }
            else { state = .paused; problem = "The voice message could not be sent. Review it and retry in this conversation." }
        } catch {
            guard generation == request else { return }
            audio.cancel(); state = .paused
            if !(error is CancellationError) { problem = error.localizedDescription }
        }
    }

    /// Speak complete sentences as the real Hermes text stream grows. Remember the
    /// emitted prefix per block, so sequence replay and final replacement cannot repeat it.
    public func consume(_ timeline: [TimelineItem], running: Bool) {
        guard isSessionActive, state == .answering || state == .speaking else { return }
        if running {
            drainTask?.cancel(); drainTask = nil
            state = .answering
        }
        for item in timeline {
            guard case .streamingText(let id, let text, let final) = item else { continue }
            let prefix = spoken[id] ?? ""
            guard text.hasPrefix(prefix) else { continue } // a revised hypothesis is never repeated
            let remainder = String(text.dropFirst(prefix.count))
            let end = final || !running ? remainder.endIndex : remainder.lastIndex(where: { ".!?\n".contains($0) }).map { remainder.index(after: $0) }
            guard let end else { continue }
            let sentence = String(remainder[..<end])
            spoken[id] = prefix + sentence
            let words = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
            if !words.isEmpty { audio.speak(words) }
        }

    }

    /// Call only for the completed voice run, including replies completed before
    /// the UI observed running=true. The supplied timeline is its final snapshot.
    public func agentDidComplete(_ timeline: [TimelineItem]) {
        guard isSessionActive else { return }
        if state == .transcribing, submitting { pendingCompletion = timeline; return }
        guard state == .answering || state == .speaking else { return }
        consume(timeline, running: false)
        beginPlaybackDrain()
    }

    private func beginPlaybackDrain() {
        if drainTask == nil {
            state = .speaking
            let request = generation
            drainTask = Task { [weak self] in
                guard let self else { return }
                await self.audio.waitForPlayback()
                guard !Task.isCancelled, self.generation == request, self.isSessionActive, !self.privacyLocked, self.state == .speaking else { return }
                self.drainTask = nil
                self.state = .paused
                guard self.canAutomaticallyListen() else {
                    self.problem = "Session paused. Review the conversation, then resume when ready."
                    return
                }
                await self.start()
            }
        }
    }

    /// Mute suspends this session; only an explicit start resumes it.
    public func pause() {
        guard isSessionActive else { return }
        stopAudio()
        state = .paused
    }

    private func stopAudio() {
        generation += 1
        activityWatchdog?.cancel(); activityWatchdog = nil; endpointCountdown = nil; lastActivityAt = nil
        drainTask?.cancel(); drainTask = nil
        audio.cancel(); audio.silence(); spoken = [:]; submitting = false; pendingCompletion = nil
    }

    public func cancel() {
        stopAudio(); isSessionActive = false; state = .off
    }
}
