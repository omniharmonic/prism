import Foundation

/// A permission result is valid only for the exact opt-in/readiness generation that
/// requested it. Audio adapters must check this immediately before taking the microphone.
public struct WakeListeningGate: Sendable {
    public private(set) var enabled = false
    public private(set) var ready = false
    public private(set) var sleeping = false
    public private(set) var conversationActive = false
    private var generation = UUID()
    public init() {}
    public var canListen: Bool { enabled && ready && !sleeping && !conversationActive }
    public mutating func update(enabled: Bool, ready: Bool, sleeping: Bool, conversationActive: Bool) {
        if self.enabled != enabled || self.ready != ready || self.sleeping != sleeping || self.conversationActive != conversationActive {
            generation = UUID()
        }
        self.enabled = enabled; self.ready = ready; self.sleeping = sleeping; self.conversationActive = conversationActive
    }
    public mutating func permissionRequest() -> UUID {
        generation = UUID()
        return generation
    }
    public func acceptsPermission(_ token: UUID) -> Bool { canListen && token == generation }
}
