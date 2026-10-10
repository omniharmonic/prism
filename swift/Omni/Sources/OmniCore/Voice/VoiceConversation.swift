import Foundation
import Observation

/// The microphone and speech engines are injected. No lifecycle callback can make a
/// pending permission request begin capture or submit a late transcript off screen.
@MainActor public protocol ConversationAudio: AnyObject {
    func start() async throws
    func finish() async throws -> String
    func cancel()
    func speak(_ text: String)
    func waitForPlayback() async
    func silence()
}

@MainActor @Observable public final class VoiceConversation {
    public enum State: Equatable { case off, preparing, listening, transcribing, answering, speaking, paused }
    public private(set) var state: State = .off
    public private(set) var problem: String?
    public private(set) var transcript = ""
    private let audio: any ConversationAudio
    public private(set) var isSessionActive = false
    public var canAutomaticallyListen: @MainActor () -> Bool = { false }
    private var pendingCompletion: [TimelineItem]?
    private var submitting = false
    private var drainTask: Task<Void, Never>?
    private var generation = 0
    private var starting = false
    private var privacyLocked = false
    public var canStart: Bool { !privacyLocked && !starting && (state == .off || state == .paused || state == .answering || state == .speaking) }
    private var spoken: [String: String] = [:]
    public init(audio: any ConversationAudio) { self.audio = audio }

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
        do {
            try await audio.start()
            guard generation == request, !Task.isCancelled else { return }
            state = .listening
        } catch {
            guard generation == request else { return }
            audio.cancel(); state = .paused
            if !(error is CancellationError) { problem = error.localizedDescription }
        }
    }

    public func finish(submit: Bool = true, send: @MainActor (String) async -> Bool) async {
        guard !privacyLocked, state == .listening else { return }
        let request = generation
        state = .transcribing
        do {
            let text = try await audio.finish().trimmingCharacters(in: .whitespacesAndNewlines)
            guard generation == request, !Task.isCancelled else { return }
            guard !text.isEmpty else { state = .paused; problem = "No speech was recognized. Try again."; return }
            transcript = text; spoken = [:]; pendingCompletion = nil
            submitting = submit
            let sent = await send(text)
            submitting = false
            guard generation == request else { return }
            if sent {
                state = submit ? .answering : .paused
                if !submit { problem = "Recording limit reached. Your words are saved as a draft." }
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
        drainTask?.cancel(); drainTask = nil
        audio.cancel(); audio.silence(); spoken = [:]; submitting = false; pendingCompletion = nil
    }

    public func cancel() {
        stopAudio(); isSessionActive = false; state = .off
    }
}
