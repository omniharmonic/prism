import Foundation
import Observation

/// The microphone and speech engines are injected. No lifecycle callback can make a
/// pending permission request begin capture or submit a late transcript off screen.
@MainActor public protocol ConversationAudio: AnyObject {
    func start() async throws
    func finish() async throws -> String
    func cancel()
    func speak(_ text: String)
    func silence()
}

@MainActor @Observable public final class VoiceConversation {
    public enum State: Equatable { case off, preparing, listening, transcribing, answering }
    public private(set) var state: State = .off
    public private(set) var problem: String?
    public private(set) var transcript = ""
    private let audio: any ConversationAudio
    private var generation = 0
    private var starting = false
    private var privacyLocked = false
    public var canStart: Bool { !privacyLocked && !starting && (state == .off || state == .answering) }
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
        let request = generation
        state = .preparing; problem = nil; transcript = ""
        do {
            try await audio.start()
            guard generation == request, !Task.isCancelled else { return }
            state = .listening
        } catch {
            guard generation == request else { return }
            audio.cancel(); state = .off
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
            guard !text.isEmpty else { state = .off; problem = "No speech was recognized. Try again."; return }
            transcript = text; spoken = [:]
            let sent = await send(text)
            guard generation == request else { return }
            if sent { state = submit ? .answering : .off }
            else { state = .off; problem = "The voice message could not be sent. Review it and retry in this conversation." }
        } catch {
            guard generation == request else { return }
            audio.cancel(); state = .off
            if !(error is CancellationError) { problem = error.localizedDescription }
        }
    }

    /// Speak complete sentences as the real Hermes text stream grows. Remember the
    /// emitted prefix per block, so sequence replay and final replacement cannot repeat it.
    public func consume(_ timeline: [TimelineItem], running: Bool) {
        guard state == .answering else { return }
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

    public func cancel() {
        generation += 1; audio.cancel(); audio.silence(); state = .off; spoken = [:]
    }
}
