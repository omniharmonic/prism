import Foundation

/// Recognition callbacks may arrive after cancellation. Each engine start gets one
/// epoch and at most one activation; repeated partial matches cannot reopen a session.
public struct WakeRecognitionEpoch: Sendable {
    private var current: UUID?
    public init() {}
    public mutating func begin() -> UUID { let token = UUID(); current = token; return token }
    public func isCurrent(_ token: UUID) -> Bool { current == token }
    public mutating func consumeWake(_ token: UUID) -> Bool {
        guard isCurrent(token) else { return false }
        current = nil
        return true
    }
    public mutating func invalidate() { current = nil }
}
