import Foundation
import Observation

/// Conversation ownership spans the whole session, including playback and Pause.
/// Preemption is synchronous: wake capture has stopped before acquisition returns.
@MainActor @Observable public final class VoiceMicrophoneCoordinator {
    public static let shared = VoiceMicrophoneCoordinator()
    public private(set) var conversationOwner: UUID?
    private var wakeOwner: UUID?
    private var preemptWake: (@MainActor () -> Void)?
    public init() {}
    public func acquireConversation(owner: UUID) -> Bool {
        guard conversationOwner == nil || conversationOwner == owner else { return false }
        let stop = preemptWake
        wakeOwner = nil; preemptWake = nil
        stop?()
        conversationOwner = owner
        return true
    }
    public func releaseConversation(owner: UUID) {
        guard conversationOwner == owner else { return }
        conversationOwner = nil
    }
    public func acquireWake(owner: UUID, onPreempt: @escaping @MainActor () -> Void) -> Bool {
        guard conversationOwner == nil, wakeOwner == nil || wakeOwner == owner else { return false }
        wakeOwner = owner; preemptWake = onPreempt
        return true
    }
    public func releaseWake(owner: UUID) {
        guard wakeOwner == owner else { return }
        wakeOwner = nil; preemptWake = nil
    }
}
