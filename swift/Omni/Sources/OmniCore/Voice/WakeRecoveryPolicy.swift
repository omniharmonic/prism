import Foundation

/// Pure retry lifecycle: each failure replaces the pending retry, and cancellation
/// makes every previously scheduled callback stale. Five quick retries are followed
/// by a cooldown; only a stable recognition interval clears the failure budget.
public struct WakeRecoveryPolicy: Sendable {
    public struct Retry: Sendable, Equatable {
        public let token: UUID
        public let delaySeconds: Int
        public let coolingDown: Bool
    }
    private var failures = 0
    private var pending: Retry?
    public init() {}
    /// A normal utterance final after five seconds renews promptly. Instant finals
    /// behave like errors so a recognizer that repeatedly ends cannot spin.
    public mutating func ended(normally: Bool, elapsedSeconds: TimeInterval) -> Retry {
        if normally && elapsedSeconds >= 5 { stable() }
        return failed()
    }
    public mutating func failed() -> Retry {
        failures = min(6, failures + 1)
        let cooldown = failures > 5
        let retry = Retry(token: UUID(), delaySeconds: cooldown ? 60 : 1 << (failures - 1), coolingDown: cooldown)
        pending = retry
        return retry
    }
    public mutating func consume(_ retry: Retry, allowed: Bool) -> Bool {
        guard pending == retry else { return false }
        pending = nil
        return allowed
    }
    public mutating func cancel() { pending = nil }
    public mutating func stable() { failures = 0; pending = nil }
}
